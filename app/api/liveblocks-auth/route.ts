// Liveblocks authentication endpoint.
//
// - Identifies the user via Clerk (single source of identity).
// - Reads the user's active org from Clerk's session claims.
// - Issues a session that allows full access to the user's scorecard room.
// - Meeting rooms are not yet authorized here; they land when the meeting
//   runner does (Phase 4). At that point auth will look up the meeting's
//   orgId in Postgres and gate access.
//
// Sessions are short-lived per Liveblocks defaults; clients refresh via the
// same endpoint when expired.

import { auth, currentUser } from "@clerk/nextjs/server";
import { Liveblocks } from "@liveblocks/node";
import { NextResponse } from "next/server";
import { requireEnv } from "@/lib/env";
import { ROOM } from "@/liveblocks.config";

export async function POST(): Promise<Response> {
  const { userId, orgId, orgSlug } = await auth();
  if (!userId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  if (!orgId) {
    // Active org required — the user must pick one in OrganizationSwitcher.
    return new NextResponse("No active organization", { status: 403 });
  }

  const user = await currentUser();
  const name =
    user?.fullName ??
    user?.firstName ??
    user?.username ??
    user?.emailAddresses[0]?.emailAddress ??
    userId;
  const email =
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses[0]?.emailAddress ??
    "";
  const avatarUrl = user?.imageUrl;

  const liveblocks = new Liveblocks({
    secret: requireEnv("LIVEBLOCKS_SECRET_KEY"),
  });
  const session = liveblocks.prepareSession(userId, {
    userInfo: { name, email, avatarUrl, orgSlug: orgSlug ?? orgId },
  });

  session.allow(ROOM.scorecard(orgId), session.FULL_ACCESS);

  const { status, body } = await session.authorize();
  return new NextResponse(body, { status });
}
