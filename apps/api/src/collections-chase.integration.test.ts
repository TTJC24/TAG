import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertSafeRuntimeDatabaseIdentity,
  createDatabasePool,
  withOrganizationScope,
  type DatabasePool,
} from "@operating-layer/db";
import {
  getChaseProposal,
  loadOrganizationIdsByCode,
  resolveApplicationPrincipal,
  syncArAging,
  type CollectionsConfig,
  type ParsedAging,
} from "@operating-layer/issue-intake";

/**
 * The collections chase loop, end to end against a real database: past-due AR
 * becomes a governed issue AND a recorded chase proposal that the approver's
 * draft form can prefill.
 *
 * The point of these assertions is the safety posture, not just the happy path:
 * a customer with no email on file must still raise a chase, must NOT get a
 * guessed recipient, and must say why it is unaddressable.
 */

const adminEmail = "admin@local.operating-layer";

const zero = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, over90: 0 };

function agingFixture(agedOn: string): ParsedAging {
  return {
    company: "FS",
    agedOn,
    customers: [
      {
        customerId: "ADDRESSABLE",
        customerName: "Addressable Co",
        email: "ap@addressable.example",
        buckets: { ...zero, d31_60: 2_500, balance: 2_500 },
        lines: [
          {
            docType: "Invoice",
            refNbr: "AR100",
            customerRef: "",
            branch: "FS",
            docDate: "2026-05-01",
            dueDate: "2026-05-15",
            buckets: { ...zero, d31_60: 2_500, balance: 2_500 },
          },
        ],
      },
      {
        customerId: "NOEMAIL",
        customerName: "No Email Co",
        buckets: { ...zero, over90: 9_000, balance: 9_000 },
        lines: [
          {
            docType: "Invoice",
            refNbr: "AR200",
            customerRef: "",
            branch: "FS",
            docDate: "2026-01-01",
            dueDate: "2026-01-15",
            buckets: { ...zero, over90: 9_000, balance: 9_000 },
          },
        ],
      },
      {
        customerId: "CURRENT",
        customerName: "Paid Up Co",
        email: "ap@paidup.example",
        buckets: { ...zero, current: 4_000, balance: 4_000 },
        lines: [
          {
            docType: "Invoice",
            refNbr: "AR300",
            customerRef: "",
            branch: "FS",
            docDate: "2026-07-01",
            dueDate: "2026-08-30",
            buckets: { ...zero, current: 4_000, balance: 4_000 },
          },
        ],
      },
    ],
  };
}

const config: CollectionsConfig = {
  serviceUserEmail: adminEmail,
  minPastDue: 0,
  senderName: "Pat Rivera",
  senderContact: "ar@fasteningspecialists.example",
};

describe("collections chase proposals", () => {
  let pool: DatabasePool;
  let organizationIdsByCode: Record<string, string>;

  /**
   * Read proposals inside an organization scope. A bare pool.query sees
   * nothing here — row-level security requires the session to declare who is
   * asking and for which org — so the test reads the way the app does.
   */
  async function proposalRows(
    organizationId: string,
    where: string,
    params: unknown[],
  ): Promise<Record<string, unknown>[]> {
    const principal = await resolveApplicationPrincipal(pool, {
      issuer: "collections-test",
      subject: adminEmail,
      email: adminEmail,
    });
    return withOrganizationScope(
      pool,
      { userId: principal.userId, organizationIds: [organizationId] },
      async (client) => {
        const result = await client.query(
          `SELECT * FROM collections_chase_proposals
            WHERE organization_id = $1 AND ${where}`,
          [organizationId, ...params],
        );
        return result.rows as Record<string, unknown>[];
      },
    );
  }
  // A fresh aging date per run keeps the idempotency keys unique, so the suite
  // is re-runnable against a database that already holds earlier runs.
  const agedOn = `2026-${String(Math.floor(Math.random() * 12) + 1).padStart(2, "0")}-${String(
    Math.floor(Math.random() * 28) + 1,
  ).padStart(2, "0")}`;

  beforeAll(async () => {
    const runtimeDatabaseUrl = process.env.DATABASE_URL_RUNTIME_TEST;
    if (!runtimeDatabaseUrl) {
      throw new Error("DATABASE_URL_RUNTIME_TEST is required");
    }
    pool = createDatabasePool(runtimeDatabaseUrl);
    await assertSafeRuntimeDatabaseIdentity(pool);
    organizationIdsByCode = await loadOrganizationIdsByCode(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("raises chases and records prefillable draft text", async () => {
    const result = await syncArAging(
      pool,
      agingFixture(agedOn),
      config,
      organizationIdsByCode,
    );

    // Only the two past-due customers are chased; the current one is left alone.
    expect(result.scanned).toBe(3);
    expect(result.created).toBe(2);
    expect(result.skipped).toEqual([]);
    expect(result.proposed).toBe(2);
    // Exactly one of them has no address on file.
    expect(result.unaddressable).toBe(1);
  });

  it("prefills an addressable chase with real numbers and a real recipient", async () => {
    const principal = await resolveApplicationPrincipal(pool, {
      issuer: "collections-test",
      subject: adminEmail,
      email: adminEmail,
    });
    const organizationId = organizationIdsByCode.FS!;

    // Find the task the sync just created for the addressable customer.
    const rows = await proposalRows(
      organizationId,
      "customer_id = $2 AND aged_on = $3",
      ["ADDRESSABLE", agedOn],
    );
    const taskId = String(rows[0]!.task_id);

    const proposal = await getChaseProposal(
      pool,
      principal,
      organizationId,
      taskId,
    );

    expect(proposal).not.toBeNull();
    expect(proposal!.recipient).toBe("ap@addressable.example");
    expect(proposal!.blockedReason).toBeNull();
    expect(proposal!.customerName).toBe("Addressable Co");
    expect(proposal!.ladderStep).toBe(2); // 31-60 => firm follow-up
    expect(proposal!.pastDue).toBe(2_500);
    // the draft body carries the actual invoice and total, ready to review
    expect(proposal!.body).toContain("AR100");
    expect(proposal!.body).toContain("$2,500.00");
    expect(proposal!.body).toContain("Pat Rivera");
    expect(proposal!.subject).toContain("Fastening Specialists");
  });

  it("never guesses a recipient when there is no email on file", async () => {
    const principal = await resolveApplicationPrincipal(pool, {
      issuer: "collections-test",
      subject: adminEmail,
      email: adminEmail,
    });
    const organizationId = organizationIdsByCode.FS!;

    const rows = await proposalRows(
      organizationId,
      "customer_id = $2 AND aged_on = $3",
      ["NOEMAIL", agedOn],
    );
    const taskId = String(rows[0]!.task_id);

    const proposal = await getChaseProposal(
      pool,
      principal,
      organizationId,
      taskId,
    );

    expect(proposal!.recipient).toBeNull();
    expect(proposal!.blockedReason).toMatch(/no AR contact email/i);
    // the chase still exists and is still fully composed for a human to address
    expect(proposal!.ladderStep).toBe(4); // over-90 => escalation
    expect(proposal!.body).toContain("No Email Co");
  });

  it("replays instead of duplicating when the same aging runs twice", async () => {
    const second = await syncArAging(
      pool,
      agingFixture(agedOn),
      config,
      organizationIdsByCode,
    );
    expect(second.created).toBe(0);
    expect(second.replayed).toBe(2);

    const rows = await proposalRows(organizationIdsByCode.FS!, "aged_on = $2", [
      agedOn,
    ]);
    expect(rows).toHaveLength(2);
  });

  it("returns null for a task that has no recorded chase", async () => {
    const principal = await resolveApplicationPrincipal(pool, {
      issuer: "collections-test",
      subject: adminEmail,
      email: adminEmail,
    });
    const organizationId = organizationIdsByCode.FS!;
    const absent = await getChaseProposal(
      pool,
      principal,
      organizationId,
      "00000000-0000-4000-8000-0000000000ff",
    );
    expect(absent).toBeNull();
  });
});
