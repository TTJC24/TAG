import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevelopmentHeaderIdentityProvider } from "@operating-layer/auth";
import {
  assertSafeRuntimeDatabaseIdentity,
  createDatabasePool,
  type DatabasePool,
} from "@operating-layer/db";
import {
  CompanyBrainQueryClient,
  CompanyBrainUnavailableError,
} from "@operating-layer/connectors";
import {
  drainOutbox,
  loadOrganizationIdsByCode,
  resolveKpiExceptionConfig,
  scanKpiExceptions,
  type KpiExceptionDefinition,
} from "@operating-layer/issue-intake";
import { buildApi } from "./server.js";

const fsiId = "10000000-0000-4000-8000-000000000002";
const adminEmail = "admin@local.operating-layer";

const certifiedDefinition: KpiExceptionDefinition = {
  id: "stale-opportunities-fs-test",
  name: "Stale opportunities (test-certified)",
  entityCode: "FSI",
  certified: true,
  promotionEvidence: "test fixture ledger entry",
  sql: "SELECT deal_id, opportunity, owner, stage, days_stale FROM stale_deals",
  recordKeyColumn: "deal_id",
  titleTemplate: "Stale opportunity needs follow-up",
  summaryColumns: ["opportunity", "owner", "stage", "days_stale"],
  rowLimit: 100,
};

const uncertifiedDefinition: KpiExceptionDefinition = {
  ...certifiedDefinition,
  id: "stuck-orders-uncertified",
  name: "Stuck orders (not yet certified)",
  certified: false,
};

describe("KPI exception scanner", () => {
  let adminPool: DatabasePool;
  let pool: DatabasePool;
  let app: Awaited<ReturnType<typeof buildApi>>;
  let server: Server;
  let queryClient: CompanyBrainQueryClient;
  let nextResponse: () => { status: number; body: unknown };
  let organizationIdsByCode: Record<string, string>;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL_TEST;
    const runtimeDatabaseUrl = process.env.DATABASE_URL_RUNTIME_TEST;
    if (!databaseUrl || !runtimeDatabaseUrl) {
      throw new Error(
        "DATABASE_URL_TEST and DATABASE_URL_RUNTIME_TEST required",
      );
    }
    adminPool = createDatabasePool(databaseUrl);
    pool = createDatabasePool(runtimeDatabaseUrl);
    await assertSafeRuntimeDatabaseIdentity(pool);
    app = await buildApi({
      pool,
      identityProvider: new DevelopmentHeaderIdentityProvider(),
      logger: false,
    });

    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
      req.on("end", () => {
        const { status, body } = nextResponse();
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("stub server did not bind a port");
    }
    queryClient = new CompanyBrainQueryClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      timeoutMs: 2_000,
    });
    organizationIdsByCode = await loadOrganizationIdsByCode(pool);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await app.close();
    await pool.end();
    await adminPool.end();
  });

  it("is disabled by default and requires full explicit configuration", () => {
    expect(() => resolveKpiExceptionConfig({})).toThrow(/disabled/);
    expect(() =>
      resolveKpiExceptionConfig({ KPI_EXCEPTIONS_ENABLED: "true" }),
    ).toThrow(/BRAIN_QUERY_URL/);
  });

  it("refuses uncertified definitions and reports them, honoring the promotion ledger", async () => {
    nextResponse = () => ({
      status: 200,
      body: { rows: [], rowCount: 0 },
    });
    const result = await scanKpiExceptions(
      pool,
      queryClient,
      [uncertifiedDefinition],
      organizationIdsByCode,
      { serviceUserEmail: adminEmail },
    );
    expect(result.definitionsRun).toBe(0);
    expect(result.created).toBe(0);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        definitionId: "stuck-orders-uncertified",
        reason: expect.stringContaining("not certified"),
      }),
    ]);
  });

  it("raises governed issues from certified definitions, idempotently, through the full pipeline", async () => {
    nextResponse = () => ({
      status: 200,
      body: {
        rows: [
          {
            deal_id: 4711,
            opportunity: "Anchor bolts program renewal",
            owner: "Sam Rep",
            stage: "Proposal",
            days_stale: 12,
          },
          {
            deal_id: 4712,
            opportunity: "Deck screw volume contract",
            owner: "Sam Rep",
            stage: "Negotiation",
            days_stale: 16,
          },
          { opportunity: "row without a key" },
        ],
        rowCount: 3,
      },
    });

    const first = await scanKpiExceptions(
      pool,
      queryClient,
      [certifiedDefinition],
      organizationIdsByCode,
      { serviceUserEmail: adminEmail },
    );
    expect(first.definitionsRun).toBe(1);
    expect(first.rowsScanned).toBe(3);
    expect(first.created).toBe(2);
    expect(first.skipped).toEqual([
      expect.objectContaining({
        definitionId: certifiedDefinition.id,
        reason: expect.stringContaining("record key"),
      }),
    ]);

    const second = await scanKpiExceptions(
      pool,
      queryClient,
      [certifiedDefinition],
      organizationIdsByCode,
      { serviceUserEmail: adminEmail },
    );
    expect(second.created).toBe(0);
    expect(second.replayed).toBe(2);

    const drained = await drainOutbox(pool, "kpi-exception-test-worker");
    expect(drained.failed).toBe(0);
    expect(drained.deadLetter).toBe(0);

    const tasks = await adminPool.query<{
      title: string;
      status: string;
      description: string;
    }>(
      `SELECT task.title, task.status, task.description
       FROM operating_layer.tasks task
       WHERE task.organization_id = $1
         AND task.description LIKE '%stale-opportunities-fs-test%'
       ORDER BY task.title`,
      [fsiId],
    );
    expect(tasks.rows).toHaveLength(2);
    expect(tasks.rows[0]!.title).toContain("Stale opportunity needs follow-up");
    expect(tasks.rows[0]!.description).toContain("owner: Sam Rep");
    expect(tasks.rows[0]!.description).toContain(
      "company-brain read-only query service",
    );
    // Governed pipeline reached a real state (classified and routed), not a
    // raw dump: every synced task is beyond 'received'.
    for (const task of tasks.rows) {
      expect(["awaiting_approval", "approved", "completed"]).toContain(
        task.status,
      );
    }
  });

  it("fails closed when the brain query service is down or answers garbage", async () => {
    nextResponse = () => ({ status: 503, body: { error: "down" } });
    await expect(
      scanKpiExceptions(
        pool,
        queryClient,
        [certifiedDefinition],
        organizationIdsByCode,
        { serviceUserEmail: adminEmail },
      ),
    ).rejects.toThrow(CompanyBrainUnavailableError);

    nextResponse = () => ({ status: 200, body: { nonsense: true } });
    await expect(
      scanKpiExceptions(
        pool,
        queryClient,
        [certifiedDefinition],
        organizationIdsByCode,
        { serviceUserEmail: adminEmail },
      ),
    ).rejects.toThrow();
  });

  it("refuses non-SELECT statements at the client boundary", async () => {
    await expect(
      queryClient.query("UPDATE deals SET stage = 'won'"),
    ).rejects.toThrow(/SELECT/);
  });
});
