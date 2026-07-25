import type { DatabasePool } from "@operating-layer/db";
import type { ExternalIdentity } from "@operating-layer/auth";
import { DomainError } from "./errors.js";

export interface ApplicationPrincipal {
  userId: string;
  email: string;
  name: string;
  organizationIds: readonly string[];
  permissionsByOrganization: Readonly<Record<string, readonly string[]>>;
}

interface PrincipalRow {
  user_id: string;
  email: string;
  name: string;
  organization_id: string;
  permissions: string[];
}

export async function resolveApplicationPrincipal(
  pool: DatabasePool,
  identity: ExternalIdentity,
): Promise<ApplicationPrincipal> {
  const result = await pool.query<PrincipalRow>(
    `SELECT
       app_user.id AS user_id,
       app_user.email,
       app_user.name,
       membership.organization_id,
       COALESCE(
         array_agg(grant_row.permission ORDER BY grant_row.permission)
           FILTER (WHERE grant_row.permission IS NOT NULL),
         '{}'::text[]
       ) AS permissions
     FROM operating_layer.users app_user
     JOIN operating_layer.organization_memberships membership
       ON membership.user_id = app_user.id
      AND membership.status = 'active'
     JOIN operating_layer.permission_sets permission_set
       ON permission_set.id = membership.permission_set_id
     LEFT JOIN operating_layer.permission_set_grants grant_row
       ON grant_row.permission_set_id = permission_set.id
     WHERE lower(app_user.email) = lower($1)
       AND app_user.status = 'active'
     GROUP BY
       app_user.id,
       app_user.email,
       app_user.name,
       membership.organization_id
     ORDER BY membership.organization_id`,
    [identity.email],
  );

  const first = result.rows[0];
  if (!first) {
    throw new DomainError(
      403,
      "identity_not_provisioned",
      "The authenticated identity is not an active operating-layer user",
    );
  }

  return {
    userId: first.user_id,
    email: first.email,
    name: first.name,
    organizationIds: result.rows.map((row) => row.organization_id),
    permissionsByOrganization: Object.fromEntries(
      result.rows.map((row) => [row.organization_id, row.permissions]),
    ),
  };
}

export function requireOrganizationPermission(
  principal: ApplicationPrincipal,
  organizationId: string,
  permission: string,
): void {
  if (!principal.organizationIds.includes(organizationId)) {
    throw new DomainError(
      403,
      "organization_access_denied",
      "The requested organization is outside the explicit authorization scope",
    );
  }

  if (
    !principal.permissionsByOrganization[organizationId]?.includes(permission)
  ) {
    throw new DomainError(
      403,
      "permission_denied",
      `Permission ${permission} is required`,
    );
  }
}
