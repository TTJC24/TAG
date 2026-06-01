// POST /api/jerry/ask
//
// Body: { prompt: string }
// Auth: signed-in (Clerk).
//
// Resolves the active org context, builds the structured Jerry payload
// (full board + transcripts + readiness), forwards to the existing
// Jerry service via lib/jerry/client, and returns Jerry's response
// verbatim. Action intents are NOT applied here — the dock surfaces
// them and the user calls /api/jerry/apply per intent.

import { NextResponse } from "next/server";
import { AuthContextError, getAuthContext } from "@/lib/auth/context";
import {
  brainHitToCitation,
  brainSearch,
  isBrainConfigured,
} from "@/lib/brain/client";
import { askJerry, JerryNotConfiguredError, JerryRequestError } from "@/lib/jerry/client";
import { buildJerryContext } from "@/lib/jerry/context";
import type { JerryResponse } from "@/lib/jerry/types";

// Best-effort enrichment: query the company brain with the same prompt and
// fold its hits into Jerry's citations so vault + operational-system
// provenance surface together. NEVER fail the Jerry path for this — if the
// brain is unconfigured or errors, Jerry's response is returned unchanged.
async function withBrainCitations(
  prompt: string,
  response: JerryResponse,
): Promise<JerryResponse> {
  if (!isBrainConfigured()) return response;
  try {
    const { hits } = await brainSearch({ query: prompt, limit: 8 });
    if (hits.length === 0) return response;
    const brainCitations = hits.map(brainHitToCitation);
    return {
      ...response,
      citations: [...(response.citations ?? []), ...brainCitations],
    };
  } catch {
    return response;
  }
}

export async function POST(request: Request): Promise<Response> {
  let ctx;
  try {
    ctx = await getAuthContext();
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
  const prompt =
    body && typeof body === "object" && typeof (body as { prompt?: unknown }).prompt === "string"
      ? ((body as { prompt: string }).prompt as string).trim()
      : "";
  if (!prompt) {
    return NextResponse.json({ error: "prompt required" }, { status: 400 });
  }

  try {
    const payload = await buildJerryContext(ctx, prompt);
    const response = await askJerry(payload);
    const enriched = await withBrainCitations(prompt, response);
    return NextResponse.json(enriched);
  } catch (err) {
    if (err instanceof JerryNotConfiguredError) {
      return NextResponse.json({ error: err.message, code: "not_configured" }, { status: 503 });
    }
    if (err instanceof JerryRequestError) {
      return NextResponse.json(
        { error: err.message, status: err.status, body: err.body, code: "upstream_error" },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
