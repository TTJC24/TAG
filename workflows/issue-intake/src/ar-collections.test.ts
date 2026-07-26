import { describe, expect, it } from "vitest";
import {
  buildCollectionsDrafts,
  resolveCollectionsConfig,
  rungFor,
  DEFAULT_LADDER,
} from "./ar-collections.js";
import type { ParsedAging } from "./ar-aging.js";

const bkt = (o: Partial<Record<string, number>> = {}) => ({
  current: o.current ?? 0,
  d1_30: o.d1_30 ?? 0,
  d31_60: o.d31_60 ?? 0,
  d61_90: o.d61_90 ?? 0,
  over90: o.over90 ?? 0,
  balance: o.balance ?? 0,
});

const aging: ParsedAging = {
  company: "FS",
  agedOn: "2026-07-06",
  customers: [
    {
      customerId: "ACME001",
      customerName: "Acme Corp",
      buckets: bkt({ d1_30: 80, d31_60: 50, balance: 130 }),
      lines: [
        { docType: "Invoice", refNbr: "INV1", customerRef: "r1", branch: "FS", docDate: "2026-06-01", dueDate: "2026-06-08", buckets: bkt({ d1_30: 80, balance: 80 }) },
        { docType: "Invoice", refNbr: "INV2", customerRef: "r2", branch: "FS", docDate: "2026-05-01", dueDate: "2026-05-31", buckets: bkt({ d31_60: 50, balance: 50 }) },
      ],
    },
    {
      customerId: "OLD002",
      customerName: "Old Debt LLC",
      buckets: bkt({ over90: 500, balance: 500 }),
      lines: [
        { docType: "Invoice", refNbr: "INV9", customerRef: "r9", branch: "FS", docDate: "2026-01-01", dueDate: "2026-02-01", buckets: bkt({ over90: 500, balance: 500 }) },
      ],
    },
    {
      customerId: "CUR003",
      customerName: "Current Co",
      buckets: bkt({ current: 900, balance: 900 }),
      lines: [
        { docType: "Invoice", refNbr: "INV5", customerRef: "r5", branch: "FS", docDate: "2026-07-01", dueDate: "2026-07-31", buckets: bkt({ current: 900, balance: 900 }) },
      ],
    },
  ],
};

describe("Collections doorway", () => {
  it("is disabled by default and demands a service user", () => {
    expect(() => resolveCollectionsConfig({})).toThrow(/disabled/);
    expect(() => resolveCollectionsConfig({ COLLECTIONS_ENABLED: "true" })).toThrow(/USER_EMAIL/);
  });

  it("picks the ladder rung from the worst bucket; current customers get none", () => {
    expect(rungFor(bkt({ d1_30: 10, balance: 10 }))).toEqual(DEFAULT_LADDER.d1_30);
    expect(rungFor(bkt({ over90: 10, d1_30: 5, balance: 15 }))).toEqual(DEFAULT_LADDER.over90);
    expect(rungFor(bkt({ current: 10, balance: 10 }))).toBeNull();
  });

  it("drafts one chase per past-due customer, never the current ones", () => {
    const drafts = buildCollectionsDrafts(aging);
    expect(drafts.map((d) => d.customerId).sort()).toEqual(["ACME001", "OLD002"]);
    // Current Co is skipped entirely.
    expect(drafts.find((d) => d.customerId === "CUR003")).toBeUndefined();
  });

  it("routes FS -> org code, sets step, due date, and idempotency key", () => {
    const drafts = buildCollectionsDrafts(aging);
    const acme = drafts.find((d) => d.customerId === "ACME001")!;
    expect(acme.orgCode).toBe("FSI"); // FS -> seeded code (FSI); rename pending
    expect(acme.pastDue).toBe(130);
    expect(acme.step).toBe(2); // worst bucket 31-60 -> step 2
    expect(acme.dueDate).toBe("2026-05-31"); // oldest overdue invoice
    expect(acme.idempotencyKey).toBe("collections:FSI:2026-07-06:ACME001");
    expect(acme.title).toContain("past due");

    const old = drafts.find((d) => d.customerId === "OLD002")!;
    expect(old.step).toBe(4); // over-90 -> escalation
  });

  it("itemizes the overdue invoices in the description", () => {
    const acme = buildCollectionsDrafts(aging).find((d) => d.customerId === "ACME001")!;
    expect(acme.description).toContain("INV1");
    expect(acme.description).toContain("INV2");
    expect(acme.description).toContain("Draft only; nothing sends without approval.");
  });

  it("honors a minimum past-due floor", () => {
    const drafts = buildCollectionsDrafts(aging, { minPastDue: 200 });
    // Acme ($130 past due) drops out; Old Debt ($500) stays.
    expect(drafts.map((d) => d.customerId)).toEqual(["OLD002"]);
  });

  it("returns nothing when the company doesn't map to an org", () => {
    expect(buildCollectionsDrafts({ ...aging, company: "USA" })).toEqual([]);
  });
});
