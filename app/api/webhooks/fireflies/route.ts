// Fireflies webhook receiver. Accepts `Transcription completed` events,
// verifies the signature when FIREFLIES_WEBHOOK_SECRET is configured, and
// logs a one-liner per event. Phase 6 replaces the body of `processEvent`
// with the real LLM extraction pipeline (`TranscriptSource(fireflies)` →
// LLM router → diff review).
//
// Webhook callers are unauthenticated by design (Clerk auth doesn't apply);
// auth must come from the signature header. The Clerk middleware bypasses
// /api/webhooks/* via the public matcher set in middleware.ts.

import { NextResponse, type NextRequest } from "next/server";
import { optionalEnv } from "@/lib/env";
import { verifyFirefliesSignature } from "@/lib/fireflies/verify-signature";

export const dynamic = "force-dynamic";

interface FirefliesEvent {
  meetingId?: string;
  eventType?: string;
  [key: string]: unknown;
}

async function processEvent(event: FirefliesEvent): Promise<void> {
  // Phase 6 will: 1) load the meeting from Postgres by meetingId or by the
  // calendar event linked in our records; 2) fetch the full transcript via
  // the Fireflies GraphQL API; 3) hand it to the LLM router (batch path);
  // 4) write a diff-review row that surfaces to the operator. For Phase 1
  // we only acknowledge receipt.
  console.log(
    `[fireflies-webhook] event=${event.eventType ?? "?"} meeting=${event.meetingId ?? "?"}`,
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  const raw = await request.text();

  // Signature verification — required when configured. When the workspace
  // secret hasn't been provisioned yet (dev), accept but warn so the path
  // still exercises end-to-end.
  const secret = optionalEnv("FIREFLIES_WEBHOOK_SECRET");
  if (secret) {
    const sig = request.headers.get("x-fireflies-signature");
    if (!verifyFirefliesSignature(raw, sig, secret)) {
      return new NextResponse("invalid signature", { status: 401 });
    }
  } else {
    console.warn(
      "[fireflies-webhook] FIREFLIES_WEBHOOK_SECRET not set — accepting unsigned event (dev only)",
    );
  }

  let event: FirefliesEvent;
  try {
    event = JSON.parse(raw) as FirefliesEvent;
  } catch {
    return new NextResponse("invalid json", { status: 400 });
  }

  await processEvent(event);
  return NextResponse.json({ ok: true });
}
