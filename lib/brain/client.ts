// Thin HTTP client for the **company-brain** knowledge base.
//
// Architecture mirrors lib/jerry/client.ts: Traction talks ONLY to the brain
// HTTP API; the brain's internals (gbrain, embeddings, source connectors) are
// opaque. If the brain's wire shape changes, only this client changes.
//
// Wire contract this client expects:
//   GET  {COMPANY_BRAIN_API_URL}/health   -> { ok, time }
//   GET  {COMPANY_BRAIN_API_URL}/sources  -> { sources: string[] }
//   POST {COMPANY_BRAIN_API_URL}/search   body { query, sources?, limit? }
//                                         -> { hits: BrainHit[] }
//   POST {COMPANY_BRAIN_API_URL}/ask      body { question, sources?, limit? }
//                                         -> { text, citations: BrainAskCitation[] }
//   Authorization: Bearer {COMPANY_BRAIN_API_TOKEN}
//
// Env:
//   COMPANY_BRAIN_API_URL     base URL, e.g. http://localhost:4317
//   COMPANY_BRAIN_API_TOKEN   bearer token
//   COMPANY_BRAIN_TIMEOUT_MS  optional; defaults to 15000

import { optionalEnv } from "@/lib/env";
import type { JerryCitation } from "@/lib/jerry/types";
import type {
  BrainAskResult,
  BrainHealthResult,
  BrainHit,
  BrainSearchResult,
  BrainSourcesResult,
} from "./types";

export class BrainNotConfiguredError extends Error {
  constructor() {
    super(
      "Company brain not configured. Set COMPANY_BRAIN_API_URL and COMPANY_BRAIN_API_TOKEN.",
    );
    this.name = "BrainNotConfiguredError";
  }
}

export class BrainRequestError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "BrainRequestError";
  }
}

function brainUrl(): string | undefined {
  return optionalEnv("COMPANY_BRAIN_API_URL");
}

function brainToken(): string | undefined {
  return optionalEnv("COMPANY_BRAIN_API_TOKEN");
}

export function isBrainConfigured(): boolean {
  return !!(brainUrl() && brainToken());
}

function timeoutMs(): number {
  const raw = Number(optionalEnv("COMPANY_BRAIN_TIMEOUT_MS") ?? "15000");
  return Number.isFinite(raw) && raw > 0 ? raw : 15000;
}

// Shared request helper: Bearer auth + AbortController timeout + tolerant
// JSON parse, mirroring lib/jerry/client.ts.
async function brainFetch(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
): Promise<unknown> {
  const baseUrl = brainUrl();
  const token = brainToken();
  if (!baseUrl || !token) throw new BrainNotConfiguredError();

  const url = baseUrl.replace(/\/+$/, "") + path;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs());

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method,
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(t);
    const msg = err instanceof Error ? err.message : String(err);
    throw new BrainRequestError(`Company brain request failed: ${msg}`);
  }
  clearTimeout(t);

  const text = await res.text();
  if (!res.ok) {
    throw new BrainRequestError(
      `Company brain responded ${res.status}`,
      res.status,
      text.slice(0, 500),
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new BrainRequestError(
      "Company brain returned a non-JSON response",
      res.status,
      text.slice(0, 500),
    );
  }
}

function asObject(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function normalizeHit(raw: unknown): BrainHit {
  const o = asObject(raw);
  return {
    slug: asString(o.slug),
    source_id: asString(o.source_id),
    title: asString(o.title),
    chunk_text: asString(o.chunk_text),
  };
}

export async function brainHealth(): Promise<BrainHealthResult> {
  const o = asObject(await brainFetch("/health", { method: "GET" }));
  return {
    ok: o.ok === true,
    time: typeof o.time === "string" ? o.time : undefined,
  };
}

export async function brainSources(): Promise<BrainSourcesResult> {
  const o = asObject(await brainFetch("/sources", { method: "GET" }));
  const sources = Array.isArray(o.sources)
    ? o.sources.filter((s): s is string => typeof s === "string")
    : [];
  return { sources };
}

export async function brainSearch(opts: {
  query: string;
  sources?: string[];
  limit?: number;
}): Promise<BrainSearchResult> {
  const body: Record<string, unknown> = { query: opts.query };
  if (opts.sources && opts.sources.length > 0) body.sources = opts.sources;
  if (typeof opts.limit === "number") body.limit = opts.limit;

  const o = asObject(await brainFetch("/search", { method: "POST", body }));
  const hits = Array.isArray(o.hits) ? o.hits.map(normalizeHit) : [];
  return { hits };
}

export async function brainAsk(opts: {
  question: string;
  sources?: string[];
  limit?: number;
}): Promise<BrainAskResult> {
  const body: Record<string, unknown> = { question: opts.question };
  if (opts.sources && opts.sources.length > 0) body.sources = opts.sources;
  if (typeof opts.limit === "number") body.limit = opts.limit;

  const o = asObject(await brainFetch("/ask", { method: "POST", body }));
  const citations = Array.isArray(o.citations)
    ? o.citations.map((c) => {
        const co = asObject(c);
        return {
          slug: asString(co.slug),
          source_id: asString(co.source_id),
          title: asString(co.title),
        };
      })
    : [];
  return { text: asString(o.text), citations };
}

// Map a brain hit onto the app's existing JerryCitation shape so the dock can
// render brain provenance with no new render path. `href` stays undefined —
// the brain exposes no public deep link.
export function brainHitToCitation(h: BrainHit): JerryCitation {
  return {
    source: h.title || h.slug,
    snippet: h.chunk_text,
    href: undefined,
  };
}
