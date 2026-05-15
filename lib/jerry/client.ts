// Thin HTTP adapter to the existing Jerry service running on the
// shared droplet. Treat Jerry as opaque — this file is the only place
// the app knows the wire protocol. If Jerry's actual API differs from
// the assumption below (POST {JERRY_BASE_URL}{JERRY_PATH} with bearer
// auth + JSON body), update *only* this file.
//
// Env:
//   JERRY_BASE_URL — required; e.g. https://jerry.example.com
//   JERRY_API_KEY  — required; sent as Authorization: Bearer <key>
//   JERRY_PATH     — optional; defaults to "/chat"
//   JERRY_TIMEOUT_MS — optional; defaults to 30000

import { optionalEnv } from "@/lib/env";
import type { JerryRequest, JerryResponse } from "./types";

export class JerryNotConfiguredError extends Error {
  constructor() {
    super(
      "Jerry is not configured. Set JERRY_BASE_URL and JERRY_API_KEY to point at the existing Jerry service.",
    );
    this.name = "JerryNotConfiguredError";
  }
}

export class JerryRequestError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "JerryRequestError";
  }
}

export function isJerryConfigured(): boolean {
  return !!(optionalEnv("JERRY_BASE_URL") && optionalEnv("JERRY_API_KEY"));
}

export async function askJerry(req: JerryRequest): Promise<JerryResponse> {
  const baseUrl = optionalEnv("JERRY_BASE_URL");
  const apiKey = optionalEnv("JERRY_API_KEY");
  if (!baseUrl || !apiKey) throw new JerryNotConfiguredError();

  const path = optionalEnv("JERRY_PATH") ?? "/chat";
  const timeoutMs = Number(optionalEnv("JERRY_TIMEOUT_MS") ?? "30000");
  const url = baseUrl.replace(/\/+$/, "") + path;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(req),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(t);
    const msg = err instanceof Error ? err.message : String(err);
    throw new JerryRequestError(`Jerry request failed: ${msg}`);
  }
  clearTimeout(t);

  const text = await res.text();
  if (!res.ok) {
    throw new JerryRequestError(
      `Jerry responded ${res.status}`,
      res.status,
      text.slice(0, 500),
    );
  }
  // Jerry is expected to return application/json with the JerryResponse
  // shape. If your existing Jerry returns a different shape (e.g.
  // { message, suggestions } instead of { reply, actionIntents }), map
  // it here.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Fall back: if Jerry returns plain text, treat the whole body as
    // `reply` with no intents. Keeps the dock usable while the API
    // surface gets formalized.
    return { reply: text };
  }
  return normalize(parsed);
}

function normalize(raw: unknown): JerryResponse {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const reply =
      typeof obj.reply === "string"
        ? obj.reply
        : typeof obj.message === "string"
          ? (obj.message as string)
          : typeof obj.text === "string"
            ? (obj.text as string)
            : "";
    const actionIntents = Array.isArray(obj.actionIntents)
      ? (obj.actionIntents as JerryResponse["actionIntents"])
      : Array.isArray(obj.intents)
        ? (obj.intents as JerryResponse["actionIntents"])
        : undefined;
    const jerryVersion =
      typeof obj.jerryVersion === "string"
        ? (obj.jerryVersion as string)
        : typeof obj.version === "string"
          ? (obj.version as string)
          : undefined;
    return { reply, actionIntents, jerryVersion };
  }
  return { reply: String(raw ?? "") };
}
