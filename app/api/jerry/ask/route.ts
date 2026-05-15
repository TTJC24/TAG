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
import { askJerry, JerryNotConfiguredError, JerryRequestError } from "@/lib/jerry/client";
import { buildJerryContext } from "@/lib/jerry/context";

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
    return NextResponse.json(response);
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
