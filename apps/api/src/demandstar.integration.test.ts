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
  parseDemandstarMessage,
  resolveDemandstarBridgeConfig,
  syncDemandstarBids,
  type DemandstarMessage,
} from "@operating-layer/issue-intake";
import { buildApi } from "./server.js";

const usaId = "10000000-0000-4000-8000-000000000003";
const adminEmail = "admin@local.operating-layer";

// Modeled on the real 2026-07-24 Oakland Park announcement, including the
// "you may also be interested" block whose embedded bids must NOT be parsed.
const announcement: DemandstarMessage = {
  id: "msg-announce-1",
  subject: "Announcing Bid ITB-091026-0-2026/KAF from City of Oakland Park",
  from: "supplierservices@demandstar.com",
  date: "2026-07-24T21:15:42Z",
  body: `
    <table><tr><td>Dear Tim Clark,</td></tr>
    <tr><td>City of Oakland Park has posted a bid announcement!</td></tr>
    <tr><td>Bid Name: </td><td>General Services - Gravity Pipe Lining and Associated Work</td></tr>
    <tr><td>Scope of work: </td><td>TV Inspection, Cleaning, and Cured-In-Place (CIPP) Rehabilitation Services for existing sanitary sewer lines.</td></tr>
    <tr><td>Responses due by: </td><td>September 10, 2026 3:00 PM (Eastern)</td></tr>
    <tr><td>Agency: </td><td>City of Oakland Park</td></tr>
    <tr><td>Agency Location: </td><td>Florida</td></tr>
    <tr><td>Bid Identifier: </td><td>ITB-091026-0-2026/KAF</td></tr>
    <tr><td>You may also be interested in these bids:</td></tr>
    <tr><td>City of Everglades City:</td><td><b>Gravity Sewer System Improvements</b>
      <b>Scope of Work: </b> rehabilitation of gravity sewer pipe.
      Bid Identifier: SHOULD-NOT-BE-PARSED</td></tr></table>`,
};

// Modeled on the real 2026-07-24 Everglades City deadline reminder.
const reminder: DemandstarMessage = {
  id: "msg-reminder-1",
  subject: "Response deadline is approaching for a bid on DemandStar",
  from: "supplierservices@demandstar.com",
  date: "2026-07-24T07:46:00Z",
  body: `
    <table><tr><td>Dear Tim Clark,</td></tr>
    <tr><td>This is a reminder that 07/28/2026 1:45 PM Eastern is the deadline for the following bid. Electronic responses are accepted for this project.</td></tr>
    <tr><td>Bid Identifier: </td><td>ITB-ITB-26-3-1-2026/KB</td></tr>
    <tr><td>Bid Name: </td><td>Gravity Sewer System Improvements</td></tr>
    <tr><td>Agency: </td><td>City of Everglades City</td></tr></table>`,
};

const award: DemandstarMessage = {
  id: "msg-award-1",
  subject: "Award Documents Uploaded for East Regional Force Main Part B-1",
  from: "supplierservices@demandstar.com",
  date: "2026-07-22T16:00:05Z",
  body: "<p>City of DeLand has uploaded award information.</p>",
};

const impostor: DemandstarMessage = {
  id: "msg-impostor-1",
  subject: "Announcing Bid FAKE-1 from Nowhere",
  from: "phisher@example.com",
  date: "2026-07-24T00:00:00Z",
  body: "<p>Bid Identifier: FAKE-1</p>",
};

describe("DemandStar bid doorway", () => {
  let adminPool: DatabasePool;
  let pool: DatabasePool;
  let app: Awaited<ReturnType<typeof buildApi>>;
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
    organizationIdsByCode = await loadOrganizationIdsByCode(pool);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await adminPool.end();
  });

  it("parses real message shapes deterministically", () => {
    const parsedAnnouncement = parseDemandstarMessage(announcement);
    expect(parsedAnnouncement).toMatchObject({
      kind: "announcement",
      bidNumber: "ITB-091026-0-2026/KAF", // not the recommended bid
      agency: "City of Oakland Park",
      dueDate: "2026-09-10",
    });
    const parsedReminder = parseDemandstarMessage(reminder);
    expect(parsedReminder).toMatchObject({
      kind: "deadline_reminder",
      bidNumber: "ITB-ITB-26-3-1-2026/KB",
      agency: "City of Everglades City",
      dueDate: "2026-07-28",
    });
    expect(parseDemandstarMessage(award)).toBeNull();
  });

  it("is disabled by default", () => {
    expect(() => resolveDemandstarBridgeConfig({})).toThrow(/disabled/);
    expect(() =>
      resolveDemandstarBridgeConfig({ DEMANDSTAR_BRIDGE_ENABLED: "true" }),
    ).toThrow(/USER_EMAIL/);
  });

  it("turns bids into governed USA issues with deadlines, idempotently, rejecting impostors", async () => {
    const config = resolveDemandstarBridgeConfig({
      DEMANDSTAR_BRIDGE_ENABLED: "true",
      DEMANDSTAR_BRIDGE_USER_EMAIL: adminEmail,
    });
    const messages = [announcement, reminder, award, impostor];

    const first = await syncDemandstarBids(
      pool,
      messages,
      config,
      organizationIdsByCode,
    );
    expect(first.scanned).toBe(4);
    expect(first.created).toBe(2);
    expect(first.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          messageId: "msg-award-1",
          reason: expect.stringContaining("not a bid"),
        }),
        expect.objectContaining({
          messageId: "msg-impostor-1",
          reason: expect.stringContaining("demandstar.com"),
        }),
      ]),
    );

    const second = await syncDemandstarBids(
      pool,
      messages,
      config,
      organizationIdsByCode,
    );
    expect(second.created).toBe(0);
    expect(second.replayed).toBe(2);

    const drained = await drainOutbox(pool, "demandstar-test-worker");
    expect(drained.failed).toBe(0);
    expect(drained.deadLetter).toBe(0);

    const tasks = await adminPool.query<{
      title: string;
      due_date: Date | string | null;
      description: string;
      status: string;
    }>(
      `SELECT task.title, task.due_date, task.description, task.status
       FROM operating_layer.tasks task
       WHERE task.organization_id = $1
         AND task.description LIKE '%SRC-USA-DEMANDSTAR-001%'
       ORDER BY task.title`,
      [usaId],
    );
    expect(tasks.rows).toHaveLength(2);

    const everglades = tasks.rows.find((row) =>
      row.title.includes("ITB-ITB-26-3-1-2026/KB"),
    );
    const isoDate = (value: Date | string | null): string =>
      value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
    expect(everglades).toBeDefined();
    expect(everglades!.title).toContain("City of Everglades City");
    expect(isoDate(everglades!.due_date)).toBe("2026-07-28");
    expect(everglades!.description).toContain("Bid number:");

    const oakland = tasks.rows.find((row) =>
      row.title.includes("ITB-091026-0-2026/KAF"),
    );
    expect(oakland).toBeDefined();
    expect(isoDate(oakland!.due_date)).toBe("2026-09-10");
    expect(oakland!.description).toContain("CIPP");

    // Both flowed through the governed pipeline, not a raw dump.
    for (const task of tasks.rows) {
      expect(["awaiting_approval", "approved", "completed"]).toContain(
        task.status,
      );
    }
  });
});
