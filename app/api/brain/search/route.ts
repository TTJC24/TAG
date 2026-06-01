// POST /api/brain/search
//
// Body: { query: string; sources?: string[]; limit?: number }
// Auth: signed-in (Clerk).
//
// Searches the external company-brain knowledge base (Acumatica / Pipedrive /
// M365) and returns the raw hits plus citations pre-mapped into the app's
// JerryCitation shape so the dock can render them directly. Also returns the
// available source list (best-effort) for client-side source filtering.
//
// Error envelope mirrors /api/jerry/ask:
//   503 { error, code:"not_configured" }   when the brain isn't configured
//   502 { error, code:"upstream_error", status?, body? }  on a brain HTTP error
//   400 { error }                          bad request body
//   500 { error }                          generic

import { NextResponse } from "next/server";
import { AuthContextError, getAuthContext } from "@/lib/auth/context";
import {
  brainHitToCitation,
  brainSearch,
  brainSources,
  BrainNotConfiguredError,
  BrainRequestError,
} from "@/lib/brain/client";

export async function POST(request: Request): Promise<Response> {
  try {
    await getAuthContext();
  } catch (err) {
    if (err instanceof AuthContextError) {
      return NextResponse.json({ error: err.reason }, { status: 401 });
    }
    throw err;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const obj =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};

  const query = typeof obj.query === "string" ? obj.query.trim() : "";
  if (!query) {
    return NextResponse.json({ error: "query required" }, { status: 400 });
  }

  const sources = Array.isArray(obj.sources)
    ? obj.sources.filter((s): s is string => typeof s === "string")
    : undefined;

  const limit =
    typeof obj.limit === "number" && Number.isFinite(obj.limit)
      ? obj.limit
      : undefined;

  try {
    const result = await brainSearch({ query, sources, limit });
    const citations = result.hits.map(brainHitToCitation);

    // Available source list is best-effort: a failure here must not fail the
    // search the user actually asked for.
    let availableSources: string[] = [];
    try {
      availableSources = (await brainSources()).sources;
    } catch {
      availableSources = [];
    }

    return NextResponse.json({
      hits: result.hits,
      citations,
      sources: availableSources,
    });
  } catch (err) {
    if (err instanceof BrainNotConfiguredError) {
      return NextResponse.json(
        { error: err.message, code: "not_configured" },
        { status: 503 },
      );
    }
    if (err instanceof BrainRequestError) {
      return NextResponse.json(
        {
          error: err.message,
          status: err.status,
          body: err.body,
          code: "upstream_error",
        },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
