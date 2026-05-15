// POST /api/jerry/apply
//
// Body: { intent: JerryActionIntent }
// Auth: signed-in (Clerk). The applyIntent function permission-checks
//   each call against the active org + actor's role/ownership; viewers
//   are blocked, members may apply for items they own, admins may
//   apply for anything in the active org.
//
// Audit: every applied write lands with source="jerry" + personId set
//   to the actor who clicked Approve (Jerry is opaque; the human is
//   the audited actor).

import { NextResponse } from "next/server";
import { AuthContextError, getAuthContext } from "@/lib/auth/context";
import { applyIntent } from "@/lib/jerry/apply";
import type { JerryActionIntent } from "@/lib/jerry/types";

const VALID_KINDS: JerryActionIntent["kind"][] = [
  "update_actual",
  "update_rock_status",
  "set_todo_done",
  "update_issue_status",
  "create_todo",
  "create_issue",
];

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
  const intent =
    body && typeof body === "object"
      ? ((body as { intent?: unknown }).intent as JerryActionIntent | undefined)
      : undefined;
  if (!intent || !VALID_KINDS.includes(intent.kind)) {
    return NextResponse.json({ error: "invalid intent" }, { status: 400 });
  }

  const result = await applyIntent(intent);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true, entityId: result.entityId });
}
