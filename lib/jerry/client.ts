// Thin HTTP adapter to the **Jerry adapter** running on jerry-app.
//
// Architecture (per the canonical design):
//   Traction (Vercel)
//     → HTTPS to Jerry adapter on jerry-app  (this client)
//        → http://127.0.0.1:8900/v1/jerry/query  (real /opt/jerry, loopback)
//
// Raw Jerry is never exposed publicly. The adapter is the ONLY thing
// the app talks to; if Jerry's wire shape changes, only the adapter
// changes. This client knows nothing about real Jerry's internals.
//
// Wire contract this client expects from the adapter:
//   POST {JERRY_ADAPTER_URL}/jerry/query
//   Authorization: Bearer {JERRY_ADAPTER_KEY}
//   body:    JerryRequest                       (lib/jerry/types.ts)
//   200 OK:  JerryResponse                      (lib/jerry/types.ts)
//
// Env (with backwards-compatible aliases for the previous slice):
//   JERRY_ADAPTER_URL   (preferred) or JERRY_BASE_URL
//   JERRY_ADAPTER_KEY   (preferred) or JERRY_API_KEY
//   JERRY_PATH          optional; defaults to "/jerry/query"
//   JERRY_TIMEOUT_MS    optional; defaults to 30000

import { optionalEnv } from "@/lib/env";
import type { JerryRequest, JerryResponse } from "./types";

export class JerryNotConfiguredError extends Error {
  constructor() {
    super(
      "Jerry adapter not configured. Set JERRY_ADAPTER_URL and JERRY_ADAPTER_KEY (or the legacy JERRY_BASE_URL / JERRY_API_KEY).",
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

function adapterUrl(): string | undefined {
  return optionalEnv("JERRY_ADAPTER_URL") ?? optionalEnv("JERRY_BASE_URL");
}

function adapterKey(): string | undefined {
  return optionalEnv("JERRY_ADAPTER_KEY") ?? optionalEnv("JERRY_API_KEY");
}

export function isJerryConfigured(): boolean {
  return !!(adapterUrl() && adapterKey());
}

export async function askJerry(req: JerryRequest): Promise<JerryResponse> {
  const baseUrl = adapterUrl();
  const apiKey = adapterKey();
  if (!baseUrl || !apiKey) throw new JerryNotConfiguredError();

  const path = optionalEnv("JERRY_PATH") ?? "/jerry/query";
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
    throw new JerryRequestError(`Jerry adapter request failed: ${msg}`);
  }
  clearTimeout(t);

  const text = await res.text();
  if (!res.ok) {
    throw new JerryRequestError(
      `Jerry adapter responded ${res.status}`,
      res.status,
      text.slice(0, 500),
    );
  }

  // The adapter is responsible for normalizing real Jerry's
  // {answer, citations, tool_calls, hops} into the JerryResponse
  // shape. We're tolerant of minor field-name drift here only as a
  // safety net.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { reply: text };
  }
  return normalize(parsed);
}

function normalize(raw: unknown): JerryResponse {
  if (!raw || typeof raw !== "object") return { reply: String(raw ?? "") };
  const obj = raw as Record<string, unknown>;

  const reply =
    typeof obj.reply === "string"
      ? obj.reply
      : typeof obj.answer === "string"
        ? (obj.answer as string)
        : typeof obj.message === "string"
          ? (obj.message as string)
          : typeof obj.text === "string"
            ? (obj.text as string)
            : "";

  const citations = Array.isArray(obj.citations)
    ? (obj.citations as JerryResponse["citations"])
    : undefined;

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

  return { reply, citations, actionIntents, jerryVersion };
}
