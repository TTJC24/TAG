import { describe, expect, it } from "vitest";
import {
  buildSalesFollowups,
  reasonsFor,
  resolvePipedriveSalesConfig,
  resolvePipedriveSources,
  type PipedriveDeal,
} from "./pipedrive-sales.js";

const ASOF = "2026-07-26";

const deal = (over: Partial<PipedriveDeal>): PipedriveDeal => ({
  id: 1,
  title: "Deal",
  status: "open",
  pipeline_id: 10,
  ...over,
});

const pastClose = deal({
  id: 1,
  title: "Oakland Park CIPP",
  status: "open",
  pipeline_id: 10,
  value: 250000,
  currency: "USD",
  expected_close_date: "2026-07-01", // past
  last_activity_date: "2026-07-25", // recent
  next_activity_date: "2026-07-28", // has next step
});

const quietNoNext = deal({
  id: 2,
  title: "Everglades Sewer",
  status: "open",
  pipeline_id: 10,
  last_activity_date: "2026-07-01", // 25 days quiet
  // no next_activity_date, no expected_close
});

const healthy = deal({
  id: 3,
  title: "Fresh Deal",
  status: "open",
  pipeline_id: 10,
  expected_close_date: "2026-08-15",
  last_activity_date: "2026-07-25",
  next_activity_date: "2026-07-30",
});

const won = deal({ id: 4, title: "Closed Won", status: "won", pipeline_id: 10 });

const unmapped = deal({
  id: 5,
  title: "Other Pipeline",
  status: "open",
  pipeline_id: 99, // not in the map
  last_activity_date: "2026-06-01",
});

describe("Sales doorway (Pipedrive)", () => {
  it("is disabled by default and demands a service user", () => {
    expect(() => resolvePipedriveSalesConfig({})).toThrow(/disabled/);
    expect(() => resolvePipedriveSalesConfig({ PIPEDRIVE_SALES_ENABLED: "true" })).toThrow(
      /USER_EMAIL/,
    );
  });

  it("flags the right reasons per deal; healthy and won deals trip nothing", () => {
    expect(reasonsFor(pastClose, ASOF).map((r) => r.reason)).toEqual([
      "past_expected_close",
    ]);
    expect(reasonsFor(quietNoNext, ASOF).map((r) => r.reason)).toEqual([
      "no_activity",
      "no_next_step",
    ]);
    expect(reasonsFor(healthy, ASOF)).toEqual([]);
    expect(reasonsFor(won, ASOF)).toEqual([]); // not open
  });

  it("raises one governed follow-up per flagged deal, routed by pipeline", () => {
    const followups = buildSalesFollowups([pastClose, quietNoNext, healthy, won], {
      asOf: ASOF,
      pipelineToOrgCode: { "10": "FS" },
    });
    expect(followups.map((f) => f.dealId).sort()).toEqual([1, 2]);

    const f1 = followups.find((f) => f.dealId === 1)!;
    expect(f1.orgCode).toBe("FS");
    expect(f1.headline).toBe("past_expected_close");
    expect(f1.dueDate).toBe("2026-07-01");
    expect(f1.idempotencyKey).toBe("pipedrive:FS:1:2026-07-26");
    expect(f1.title).toContain("past its expected close");

    const f2 = followups.find((f) => f.dealId === 2)!;
    expect(f2.headline).toBe("no_activity"); // higher priority than no_next_step
    expect(f2.dueDate).toBeNull();
    expect(f2.description).toContain("no next step");
  });

  it("skips deals whose pipeline isn't mapped, rather than misrouting", () => {
    expect(buildSalesFollowups([unmapped], { asOf: ASOF, pipelineToOrgCode: { "10": "FS" } })).toEqual([]);
    // an explicit org override routes it
    const forced = buildSalesFollowups([unmapped], { asOf: ASOF, orgCode: "BLCS" });
    expect(forced).toHaveLength(1);
    expect(forced[0]!.orgCode).toBe("BLCS");
  });

  it("resolves two Pipedrive accounts, tokens from their own env vars", () => {
    const env = {
      PIPEDRIVE_SOURCES: JSON.stringify([
        { name: "FS", apiBase: "https://fs.pipedrive.com", tokenEnv: "TOK_FS", orgCode: "FS" },
        {
          name: "BL-USA",
          apiBase: "https://blusa.pipedrive.com",
          tokenEnv: "TOK_BLUSA",
          pipelineToOrgCode: { "1": "BLCS", "2": "USA" },
        },
      ]),
      TOK_FS: "fs-secret",
      TOK_BLUSA: "blusa-secret",
    };
    const sources = resolvePipedriveSources(env);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({ name: "FS", token: "fs-secret", orgCode: "FS" });
    expect(sources[1]).toMatchObject({
      name: "BL-USA",
      token: "blusa-secret",
      pipelineToOrgCode: { "1": "BLCS", "2": "USA" },
    });
  });

  it("rejects a missing token env and a source that routes nowhere", () => {
    expect(() => resolvePipedriveSources({})).toThrow(/PIPEDRIVE_SOURCES/);
    expect(() =>
      resolvePipedriveSources({
        PIPEDRIVE_SOURCES: JSON.stringify([
          { name: "FS", apiBase: "https://fs.pipedrive.com", tokenEnv: "TOK_FS", orgCode: "FS" },
        ]),
        // TOK_FS not set
      }),
    ).toThrow(/TOK_FS/);
    expect(() =>
      resolvePipedriveSources({
        PIPEDRIVE_SOURCES: JSON.stringify([
          { name: "X", apiBase: "https://x.pipedrive.com", tokenEnv: "T" },
        ]),
        T: "t",
      }),
    ).toThrow(/orgCode or a pipelineToOrgCode/);
  });

  it("respects a custom stale-day threshold", () => {
    const borderline = deal({ id: 7, last_activity_date: "2026-07-16", next_activity_date: "2026-08-01" }); // 10 days quiet
    expect(reasonsFor(borderline, ASOF, { staleDays: 14 })).toEqual([]);
    expect(reasonsFor(borderline, ASOF, { staleDays: 7 }).map((r) => r.reason)).toEqual([
      "no_activity",
    ]);
  });
});
