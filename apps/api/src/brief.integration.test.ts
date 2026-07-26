import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevelopmentHeaderIdentityProvider } from "@operating-layer/auth";
import {
  assertSafeRuntimeDatabaseIdentity,
  createDatabasePool,
  type DatabasePool,
} from "@operating-layer/db";
import {
  drainOutbox,
  generateMorningBrief,
  resolveApplicationPrincipal,
} from "@operating-layer/issue-intake";
import { buildApi } from "./server.js";

const blcsId = "10000000-0000-4000-8000-000000000001";
const adminEmail = "admin@local.operating-layer";
const operatorEmail = "operator@local.operating-layer";

describe("machine-generated morning brief", () => {
  let adminPool: DatabasePool;
  let pool: DatabasePool;
  let app: Awaited<ReturnType<typeof buildApi>>;

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
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await adminPool.end();
  });

  it("renders live state per organization with approvals front and center", async () => {
    // One approval-gated issue (external wording + exposure) in BLCS.
    const intake = await app.inject({
      method: "POST",
      url: "/v1/issues",
      headers: {
        "x-dev-user-email": operatorEmail,
        "idempotency-key": `brief-${randomUUID()}`,
        "x-trace-id": "trace-brief-fixture",
      },
      payload: {
        organizationId: blcsId,
        title: "Escalate supplier credit hold with vendor",
        description:
          "A $75,000 order is blocked; we must escalate with the vendor contact.",
        financialExposure: 75_000,
        financialExposureCurrency: "USD",
        retentionClassification: "financial_support",
      },
    });
    expect(intake.statusCode, intake.body).toBe(202);
    const drained = await drainOutbox(pool, "brief-test-worker");
    expect(drained.deadLetter).toBe(0);

    const principal = await resolveApplicationPrincipal(pool, {
      issuer: "test",
      subject: adminEmail,
      email: adminEmail,
    });
    const brief = await generateMorningBrief(pool, principal, {
      generatedAt: "2026-07-26T06:00:00.000Z",
    });

    // Obsidian-ready envelope.
    expect(brief).toContain("source: operating-layer");
    expect(brief).toContain("generated: 2026-07-26T06:00:00.000Z");
    expect(brief).toContain("# Morning Brief");
    expect(brief).toContain("waiting on your approval");

    // The BLCS section carries the pending approval with its recommendation.
    expect(brief).toMatch(/## .*\(BLCS\)/);
    expect(brief).toContain("Needs your decision");
    expect(brief).toContain("Escalate supplier credit hold with vendor");
    expect(brief).toContain("Recommended:");

    // Every organization the admin can read gets a section.
    expect(brief).toMatch(/## .*\(FS\)/);
    expect(brief).toMatch(/## .*\(USA\)/);

    // Scoping: restricting to one organization drops the others.
    const scoped = await generateMorningBrief(pool, principal, {
      organizationIds: [blcsId],
      generatedAt: "2026-07-26T06:00:00.000Z",
    });
    expect(scoped).toMatch(/## .*\(BLCS\)/);
    expect(scoped).not.toMatch(/## .*\(FS\)/);
  });

  it("refuses organizations the user cannot read", async () => {
    const operatorPrincipal = await resolveApplicationPrincipal(pool, {
      issuer: "test",
      subject: operatorEmail,
      email: operatorEmail,
    });
    // The BLCS operator is not a member of FS; asking for it must fail, not
    // silently render.
    const fsiId = "10000000-0000-4000-8000-000000000002";
    await expect(
      generateMorningBrief(pool, operatorPrincipal, {
        organizationIds: [fsiId],
      }),
    ).rejects.toThrow();
  });
});
