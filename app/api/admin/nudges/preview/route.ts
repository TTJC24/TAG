// Admin-only dry-run preview for the nudges layer. Returns the list of
// nudges that would fire right now for the active org, plus the channel
// states. No side effects — `dispatchNudges` is invoked with dryRun: true
// regardless of query params, so this endpoint cannot accidentally send.
//
// Query:
//   GET /api/admin/nudges/preview?window=sunday_evening
//
// `window` accepts: sunday_evening | monday_morning | pre_meeting.
// Defaults to sunday_evening.

import { NextResponse } from "next/server";
import { AuthContextError, getAuthContext } from "@/lib/auth/context";
import { dispatchNudges } from "@/lib/nudges/dispatch";
import type { NudgeWindow } from "@/lib/nudges/types";

const VALID_WINDOWS: ReadonlyArray<NudgeWindow> = [
  "sunday_evening",
  "monday_morning",
  "pre_meeting",
];

export async function GET(request: Request): Promise<Response> {
  let ctx;
  try {
    ctx = await getAuthContext();
  } catch (err) {
    if (err instanceof AuthContextError) {
      return NextResponse.json({ error: err.reason }, { status: 401 });
    }
    throw err;
  }
  if (ctx.role !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }

  const url = new URL(request.url);
  const requested = url.searchParams.get("window") ?? "sunday_evening";
  if (!VALID_WINDOWS.includes(requested as NudgeWindow)) {
    return NextResponse.json(
      { error: `invalid window. expected one of: ${VALID_WINDOWS.join(", ")}` },
      { status: 400 },
    );
  }

  const result = await dispatchNudges({
    orgId: ctx.orgId,
    orgSlug: ctx.orgSlug,
    window: requested as NudgeWindow,
    dryRun: true,
  });

  return NextResponse.json(result);
}
