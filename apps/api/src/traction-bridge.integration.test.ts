import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevelopmentHeaderIdentityProvider } from "@operating-layer/auth";
import {
  assertSafeRuntimeDatabaseIdentity,
  createDatabasePool,
  type DatabasePool,
} from "@operating-layer/db";
import {
  drainOutbox,
  loadOrganizationIdsByCode,
  resolveTractionBridgeConfig,
  syncTractionIssues,
  type TractionBridgeConfig,
} from "@operating-layer/issue-intake";
import { buildApi } from "./server.js";

const blcsId = "10000000-0000-4000-8000-000000000001";
const fsiId = "10000000-0000-4000-8000-000000000002";
const adminEmail = "admin@local.operating-layer";

// Deterministic fixture ids for the stub Traction database.
const tractionFsOrg = "aa000000-0000-4000-8000-000000000001";
const tractionBlOrg = "aa000000-0000-4000-8000-000000000002";
const tractionMysteryOrg = "aa000000-0000-4000-8000-000000000003";
const tractionOwner = "bb000000-0000-4000-8000-000000000001";
const tabledFsIssue = "cc000000-0000-4000-8000-000000000001";
const tabledBlIssue = "cc000000-0000-4000-8000-000000000002";
const openFsIssue = "cc000000-0000-4000-8000-000000000003";
const tabledMysteryIssue = "cc000000-0000-4000-8000-000000000004";

describe("TractionOS issue bridge", () => {
  let adminPool: DatabasePool;
  let pool: DatabasePool;
  let tractionPool: DatabasePool;
  let app: Awaited<ReturnType<typeof buildApi>>;
  let config: TractionBridgeConfig;

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

    // Stand up a stub of Traction's schema inside the test database, in its
    // own namespace, mirroring tractionos/lib/db/schema.ts closely enough for
    // the bridge's read query.
    await adminPool.query(`
      DROP SCHEMA IF EXISTS traction_stub CASCADE;
      CREATE SCHEMA traction_stub;
      CREATE TABLE traction_stub.organizations (
        id uuid PRIMARY KEY,
        clerk_org_id text NOT NULL,
        name text NOT NULL,
        code text NOT NULL
      );
      CREATE TABLE traction_stub.people (
        id uuid PRIMARY KEY,
        clerk_user_id text NOT NULL,
        name text NOT NULL,
        email text NOT NULL
      );
      CREATE TABLE traction_stub.issues (
        id uuid PRIMARY KEY,
        org_id uuid NOT NULL REFERENCES traction_stub.organizations(id),
        title text NOT NULL,
        priority text NOT NULL DEFAULT 'medium',
        owner_id uuid NOT NULL REFERENCES traction_stub.people(id),
        root_cause text,
        resolution text,
        status text NOT NULL DEFAULT 'open',
        created_at timestamptz NOT NULL DEFAULT now(),
        resolved_at timestamptz
      );
    `);
    await adminPool.query(
      `INSERT INTO traction_stub.organizations (id, clerk_org_id, name, code) VALUES
         ($1, 'clerk-fs', 'Fastening Specialists', 'FS'),
         ($2, 'clerk-bl', 'Big League Construction Supply', 'BL'),
         ($3, 'clerk-mystery', 'Mystery Co', 'MYSTERY')`,
      [tractionFsOrg, tractionBlOrg, tractionMysteryOrg],
    );
    await adminPool.query(
      `INSERT INTO traction_stub.people (id, clerk_user_id, name, email)
       VALUES ($1, 'clerk-owner', 'Meeting Owner', 'owner@example.test')`,
      [tractionOwner],
    );
    await adminPool.query(
      `INSERT INTO traction_stub.issues
         (id, org_id, title, priority, owner_id, root_cause, status, created_at)
       VALUES
         ($1, $2, 'Freight quotes stale for two weeks', 'high', $5,
          'Carrier portal exports broke; we must escalate with the vendor',
          'tabled', '2026-07-20T10:00:00Z'),
         ($3, $4, 'Counter restock cadence keeps slipping', 'medium', $5,
          NULL, 'tabled', '2026-07-21T10:00:00Z'),
         ($6, $2, 'Weekly demo scheduling', 'low', $5, NULL, 'open',
          '2026-07-22T10:00:00Z'),
         ($7, $8, 'Issue in an unmapped company', 'high', $5, NULL, 'tabled',
          '2026-07-23T10:00:00Z')`,
      [
        tabledFsIssue,
        tractionFsOrg,
        tabledBlIssue,
        tractionBlOrg,
        tractionOwner,
        openFsIssue,
        tabledMysteryIssue,
        tractionMysteryOrg,
      ],
    );

    // The bridge's Traction connection: same cluster, stub namespace only.
    const stubUrl = new URL(databaseUrl);
    stubUrl.searchParams.set("options", "-c search_path=traction_stub");
    tractionPool = createDatabasePool(stubUrl.toString());

    config = resolveTractionBridgeConfig({
      TRACTION_BRIDGE_ENABLED: "true",
      TRACTION_DATABASE_URL: stubUrl.toString(),
      TRACTION_BRIDGE_STATUSES: "tabled",
      TRACTION_BRIDGE_USER_EMAIL: adminEmail,
    });
  });

  afterAll(async () => {
    await adminPool.query("DROP SCHEMA IF EXISTS traction_stub CASCADE");
    await app.close();
    await tractionPool.end();
    await pool.end();
    await adminPool.end();
  });

  it("stays disabled unless explicitly and completely configured", () => {
    expect(() => resolveTractionBridgeConfig({})).toThrow(/disabled/);
    expect(() =>
      resolveTractionBridgeConfig({ TRACTION_BRIDGE_ENABLED: "true" }),
    ).toThrow(/TRACTION_DATABASE_URL/);
    expect(() =>
      resolveTractionBridgeConfig({
        TRACTION_BRIDGE_ENABLED: "true",
        TRACTION_DATABASE_URL: "postgresql://example",
        TRACTION_BRIDGE_STATUSES: "everything",
        TRACTION_BRIDGE_USER_EMAIL: adminEmail,
      }),
    ).toThrow(); // unknown status rejected
  });

  it("syncs flagged issues into governed intake, idempotently, mapped per entity, without writing to Traction", async () => {
    const before = await adminPool.query<{ count: string }>(
      `SELECT count(*) AS count FROM traction_stub.issues`,
    );

    const organizationIdsByCode = await loadOrganizationIdsByCode(pool);
    const first = await syncTractionIssues(
      pool,
      tractionPool,
      config,
      organizationIdsByCode,
    );
    expect(first.scanned).toBe(3); // three tabled; the open issue is not scanned
    expect(first.created).toBe(2); // FS + BL; the mystery org is skipped
    expect(first.replayed).toBe(0);
    expect(first.skipped).toEqual([
      expect.objectContaining({
        tractionIssueId: tabledMysteryIssue,
        reason: expect.stringContaining("MYSTERY"),
      }),
    ]);

    // Re-run: idempotency replays, never duplicates.
    const second = await syncTractionIssues(
      pool,
      tractionPool,
      config,
      organizationIdsByCode,
    );
    expect(second.created).toBe(0);
    expect(second.replayed).toBe(2);

    // The synced issues flow through the full governed pipeline.
    const drained = await drainOutbox(pool, "traction-bridge-test-worker");
    expect(drained.failed).toBe(0);
    expect(drained.deadLetter).toBe(0);

    // The FS issue (escalation wording) stops at the human approval gate and
    // is visible in FS's executive queue; the BL issue was internal-only and
    // ran the full governed pipeline to completion in BLCS.
    const fsQueue = await app.inject({
      method: "GET",
      url: `/v1/executive-queue?organizationId=${fsiId}`,
      headers: { "x-dev-user-email": adminEmail },
    });
    expect(fsQueue.statusCode, fsQueue.body).toBe(200);
    expect(JSON.stringify(fsQueue.json())).toContain("Freight quotes stale");

    const synced = await adminPool.query<{
      title: string;
      status: string;
      code: string;
      description: string;
    }>(
      `SELECT task.title, task.status, org.code, task.description
       FROM operating_layer.tasks task
       JOIN operating_layer.organizations org
         ON org.id = task.organization_id
       WHERE task.description LIKE '%Traction issue id:%'
       ORDER BY task.title`,
    );
    expect(synced.rows).toEqual([
      expect.objectContaining({
        title: "Counter restock cadence keeps slipping",
        status: "completed",
        code: "BLCS",
      }),
      expect.objectContaining({
        title: "Freight quotes stale for two weeks",
        status: "awaiting_approval",
        code: "FS",
      }),
    ]);
    const fsTask = synced.rows.find((row) => row.code === "FS");
    expect(fsTask!.description).toContain(
      `Traction issue id: ${tabledFsIssue}`,
    );
    expect(fsTask!.description).toContain("Carrier portal exports");

    // Traction was not written to: same row count, titles and statuses intact.
    const after = await adminPool.query<{ count: string }>(
      `SELECT count(*) AS count FROM traction_stub.issues`,
    );
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
    const untouched = await adminPool.query<{ status: string }>(
      `SELECT status FROM traction_stub.issues WHERE id = $1`,
      [tabledFsIssue],
    );
    expect(untouched.rows[0]!.status).toBe("tabled");
  });

  it("cannot write to Traction through its pinned read-only session", async () => {
    const client = await tractionPool.connect();
    try {
      await client.query(
        "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY",
      );
      await expect(
        client.query(`UPDATE issues SET title = 'defaced' WHERE id = $1`, [
          tabledFsIssue,
        ]),
      ).rejects.toThrow(/read-only/);
    } finally {
      client.release();
    }
  });
});
