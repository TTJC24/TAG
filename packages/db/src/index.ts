import pg from "pg";

const { Pool } = pg;

export const databaseContract = {
  engine: "postgresql",
  minimumMajorVersion: 16,
  migrationDirectory: "infrastructure/migrations",
  workflowTruth: "postgresql",
} as const;

export type DatabasePool = pg.Pool;
export type DatabaseClient = pg.PoolClient;

export function createDatabasePool(databaseUrl: string): DatabasePool {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });
}

export interface RuntimeDatabaseIdentity {
  roleName: string;
  superuser: boolean;
  bypassRls: boolean;
  ownedRlsTables: readonly string[];
}

export class UnsafeRuntimeDatabaseIdentityError extends Error {
  readonly identity: RuntimeDatabaseIdentity;

  constructor(identity: RuntimeDatabaseIdentity) {
    const reasons = [
      ...(identity.superuser ? ["role is a superuser"] : []),
      ...(identity.bypassRls ? ["role has BYPASSRLS"] : []),
      ...(identity.ownedRlsTables.length > 0
        ? [
            `role owns RLS-protected tables: ${identity.ownedRlsTables.join(", ")}`,
          ]
        : []),
    ];
    super(
      `Unsafe runtime database identity "${identity.roleName}": ${reasons.join(
        "; ",
      )}. API and worker processes require a non-owner, non-bypass role.`,
    );
    this.name = "UnsafeRuntimeDatabaseIdentityError";
    this.identity = identity;
  }
}

export async function assertSafeRuntimeDatabaseIdentity(
  pool: DatabasePool,
): Promise<RuntimeDatabaseIdentity> {
  const identityResult = await pool.query<{
    role_name: string;
    superuser: boolean;
    bypass_rls: boolean;
  }>(
    `SELECT
       role.rolname AS role_name,
       role.rolsuper AS superuser,
       role.rolbypassrls AS bypass_rls
     FROM pg_roles role
     WHERE role.rolname = current_user`,
  );
  const identityRow = identityResult.rows[0];
  if (!identityRow) {
    throw new Error("Current PostgreSQL identity could not be resolved");
  }

  const ownershipResult = await pool.query<{ table_name: string }>(
    `SELECT class.relname AS table_name
     FROM pg_class class
     JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
     JOIN pg_roles owner_role ON owner_role.oid = class.relowner
     WHERE namespace.nspname = 'operating_layer'
       AND class.relkind IN ('r', 'p')
       AND class.relrowsecurity
       AND owner_role.rolname = current_user
     ORDER BY class.relname`,
  );
  const identity: RuntimeDatabaseIdentity = {
    roleName: identityRow.role_name,
    superuser: identityRow.superuser,
    bypassRls: identityRow.bypass_rls,
    ownedRlsTables: ownershipResult.rows.map((row) => row.table_name),
  };
  if (
    identity.superuser ||
    identity.bypassRls ||
    identity.ownedRlsTables.length > 0
  ) {
    throw new UnsafeRuntimeDatabaseIdentityError(identity);
  }
  return identity;
}

export interface OrganizationScope {
  userId: string;
  organizationIds: readonly string[];
}

function toPostgresUuidArray(values: readonly string[]): string {
  return `{${values.join(",")}}`;
}

export async function withOrganizationScope<T>(
  pool: DatabasePool,
  scope: OrganizationScope,
  operation: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  if (scope.organizationIds.length === 0) {
    throw new Error("At least one explicit organization is required");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE operating_layer_app");
    await client.query("SELECT set_config('app.organization_ids', $1, true)", [
      toPostgresUuidArray(scope.organizationIds),
    ]);
    await client.query("SELECT set_config('app.user_id', $1, true)", [
      scope.userId,
    ]);
    await client.query("SET LOCAL search_path TO operating_layer, public");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
