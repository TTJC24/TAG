// Server-side auth context. Resolves the authed Clerk user + active org into
// local DB ids so server actions and server components can run the
// permission contract without re-fetching the same data.
//
// Cached per request via React's `cache()` — single Postgres round trip per
// page load even when many components ask for the context.

import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { cache } from "react";
import { db } from "@/lib/db/client";
import { organizations, people } from "@/lib/db/schema";

export interface AuthContext {
  /** Clerk user id (`user_…`). */
  clerkUserId: string;
  /** Local people.id. */
  personId: string;
  /** Local people.role — admin | member | viewer. */
  role: "admin" | "member" | "viewer";
  /** Clerk active org id (`org_…`). */
  clerkOrgId: string;
  /** Local organizations.id. */
  orgId: string;
  /** Org slug from Clerk (fs | bl | usa). */
  orgSlug: string;
  /** Display name for the actor. */
  personName: string;
}

export class AuthContextError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | "no_session"
      | "no_active_org"
      | "person_not_seeded"
      | "org_not_seeded",
  ) {
    super(message);
    this.name = "AuthContextError";
  }
}

/** Resolves the current request's local auth context. Throws on missing
 *  pieces — callers decide whether to redirect (UI) or return an error
 *  (server actions). */
export const getAuthContext = cache(async (): Promise<AuthContext> => {
  const { userId, orgId, orgSlug } = await auth();
  if (!userId) throw new AuthContextError("not signed in", "no_session");
  if (!orgId)
    throw new AuthContextError("no active organization", "no_active_org");

  const [person] = await db
    .select()
    .from(people)
    .where(eq(people.clerkUserId, userId))
    .limit(1);
  if (!person)
    throw new AuthContextError(
      `no local person row for clerk user ${userId}`,
      "person_not_seeded",
    );

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.clerkOrgId, orgId))
    .limit(1);
  if (!org)
    throw new AuthContextError(
      `no local org row for clerk org ${orgId}`,
      "org_not_seeded",
    );

  return {
    clerkUserId: userId,
    personId: person.id,
    role: person.role,
    clerkOrgId: orgId,
    orgId: org.id,
    orgSlug: orgSlug ?? org.code.toLowerCase(),
    personName: person.name,
  };
});

/** Soft variant — returns null instead of throwing. Useful in shells that
 *  also want to render a "pick an org" affordance. */
export async function tryGetAuthContext(): Promise<AuthContext | null> {
  try {
    return await getAuthContext();
  } catch {
    return null;
  }
}
