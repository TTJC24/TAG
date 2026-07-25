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
