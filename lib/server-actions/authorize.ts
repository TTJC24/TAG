// Permission enforcer. Server actions call `authorizeWrite()` before any DB
// mutation and `authorizeWrite()` again with the resolved target (after
// loading the row) to confirm ownership. See docs/permissions.md.

import type { AuthContext } from "@/lib/auth/context";

export class AuthorizationError extends Error {
  constructor(
    message: string,
    public readonly reason: "wrong_org" | "not_owner" | "viewer_readonly" | "no_active_org",
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

/** Enforces "the actor can write something in this org". Viewers fail
 *  immediately. Admins always succeed. Members succeed only when `ownerId`
 *  matches the actor's personId (when given). Cross-org rows are always
 *  rejected. */
export function authorizeWrite(
  ctx: AuthContext,
  target: { orgId: string; ownerId?: string | null },
): void {
  if (target.orgId !== ctx.orgId) {
    throw new AuthorizationError(
      "target belongs to a different org",
      "wrong_org",
    );
  }
  if (ctx.role === "viewer") {
    throw new AuthorizationError("viewer cannot write", "viewer_readonly");
  }
  if (ctx.role === "admin") return;
  // role === "member"
  if (target.ownerId && target.ownerId !== ctx.personId) {
    throw new AuthorizationError(
      "members may only edit their own rows",
      "not_owner",
    );
  }
}
