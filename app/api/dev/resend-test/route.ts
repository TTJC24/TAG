// Dev-only smoke endpoint. Sends a hello email to the signed-in user. Used
// to verify the Resend wiring without launching a real meeting flow.
//
// Always protected by Clerk middleware — anonymous callers can't trigger it.

import { auth, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { sendEmail } from "@/lib/email/client";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const user = await currentUser();
  const to = user?.primaryEmailAddress?.emailAddress;
  if (!to) {
    return NextResponse.json(
      { ok: false, error: "no primary email on this user" },
      { status: 400 },
    );
  }
  try {
    const { id } = await sendEmail({
      to,
      subject: "TractionOS — Resend smoke test",
      text: [
        "Hello from TractionOS.",
        "",
        "If you got this email, the Resend integration (Phase 1 step 7) works.",
        "",
        `Sent to: ${to}`,
        `Recipient Clerk user: ${userId}`,
      ].join("\n"),
    });
    return NextResponse.json({ ok: true, messageId: id, to });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: message },
      { status: 502 },
    );
  }
}
