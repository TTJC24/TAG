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

import { auth } from "@clerk/nextjs/server";
import { Liveblocks } from "@liveblocks/node";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { people } from "@/lib/db/schema";
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

  // Display name + email come from Postgres (people row), per
  // DATA_MODEL_DECISION.md §1. Clerk does not hold names in this deployment;
  // reading from currentUser() yielded blanks.
  const [person] = await db
    .select({
      name: people.name,
      email: people.email,
      avatarUrl: people.avatarUrl,
    })
    .from(people)
    .where(eq(people.clerkUserId, userId))
    .limit(1);

  if (!person) {
    return new NextResponse("Person not seeded", { status: 403 });
  }

  const liveblocks = new Liveblocks({
    secret: requireEnv("LIVEBLOCKS_SECRET_KEY"),
  });
  const session = liveblocks.prepareSession(userId, {
    userInfo: {
      name: person.name,
      email: person.email,
      avatarUrl: person.avatarUrl ?? undefined,
      orgSlug: orgSlug ?? orgId,
    },
  });

  session.allow(ROOM.scorecard(orgId), session.FULL_ACCESS);

  const { status, body } = await session.authorize();
  return new NextResponse(body, { status });
}
