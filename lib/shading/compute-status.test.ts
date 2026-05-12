// Shading engine — scenarios first.
//
// Per ADR-0008: this file is written before the implementation. Every branch
// of compute-status.ts is pinned here. When the rules evolve, update the
// scenarios first, watch them fail, then bring the implementation back to
// green.

import { describe, it, expect } from "vitest";
import { computeStatus } from "./compute-status";
import type {
  ShadingEntry,
  ShadingMeasurable,
  NoteClassification,
} from "./types";

// ── Builders ────────────────────────────────────────────────────────────────

function measurable(
  partial: Partial<ShadingMeasurable> & Pick<ShadingMeasurable, "goalDirection">,
): ShadingMeasurable {
  return {
    goalValue: null,
    goalSecondary: null,
    ...partial,
  };
}

function entry(
  actual: number | null,
  opts: {
    note?: NoteClassification | null;
    override?: "green" | "yellow" | "red" | null;
  } = {},
): ShadingEntry {
  return {
    actual,
    noteClassification: opts.note ?? null,
    statusOverride: opts.override ?? null,
  };
}

function actuals(...values: Array<number | null>): ShadingEntry[] {
  return values.map((a) => entry(a));
}

// ── 1) gte: hit exactly ──────────────────────────────────────────────────────
describe("computeStatus — gte", () => {
  it("hits the goal exactly → green", () => {
    const m = measurable({ goalDirection: "gte", goalValue: 250000 });
    const r = computeStatus(entry(250000), m, []);
    expect(r.status).toBe("green");
    expect(r.intensity).toBeGreaterThan(0);
    expect(r.reason).toMatch(/at|met|hit|exceed/i);
  });

  it("overshoots by 50% → green with higher intensity than a clean hit", () => {
    const m = measurable({ goalDirection: "gte", goalValue: 250000 });
    const clean = computeStatus(entry(250000), m, []);
    const big = computeStatus(entry(375000), m, []);
    expect(big.status).toBe("green");
    expect(big.intensity).toBeGreaterThanOrEqual(clean.intensity);
  });

  it("misses by 3% (within the 5% band) → yellow, not red", () => {
    const m = measurable({ goalDirection: "gte", goalValue: 250000 });
    const r = computeStatus(entry(242500), m, []);
    expect(r.status).toBe("yellow");
    expect(r.reason).toMatch(/within|band|narrow|just/i);
  });

  it("misses by 20% → red, mid-to-high intensity", () => {
    const m = measurable({ goalDirection: "gte", goalValue: 250000 });
    const r = computeStatus(entry(200000), m, []);
    expect(r.status).toBe("red");
    expect(r.intensity).toBeGreaterThan(40);
  });

  it("misses by 50% → red with higher intensity than a 20% miss", () => {
    const m = measurable({ goalDirection: "gte", goalValue: 250000 });
    const small = computeStatus(entry(200000), m, []);
    const big = computeStatus(entry(125000), m, []);
    expect(big.status).toBe("red");
    expect(big.intensity).toBeGreaterThan(small.intensity);
  });
});

// ── 2) lte: mirror of gte ────────────────────────────────────────────────────
describe("computeStatus — lte", () => {
  it("meets goal (below threshold) → green", () => {
    const m = measurable({ goalDirection: "lte", goalValue: 45 });
    const r = computeStatus(entry(38), m, []);
    expect(r.status).toBe("green");
  });

  it("exceeds by 3% (within 5% band) → yellow", () => {
    const m = measurable({ goalDirection: "lte", goalValue: 45 });
    const r = computeStatus(entry(46.35), m, []);
    expect(r.status).toBe("yellow");
  });

  it("exceeds by 50% → red", () => {
    const m = measurable({ goalDirection: "lte", goalValue: 45 });
    const r = computeStatus(entry(67.5), m, []);
    expect(r.status).toBe("red");
  });
});

// ── 3) eq ────────────────────────────────────────────────────────────────────
describe("computeStatus — eq", () => {
  it("hits target exactly → green", () => {
    const m = measurable({ goalDirection: "eq", goalValue: 100 });
    const r = computeStatus(entry(100), m, []);
    expect(r.status).toBe("green");
  });

  it("off by 4% (within 5% band) → yellow", () => {
    const m = measurable({ goalDirection: "eq", goalValue: 100 });
    const r = computeStatus(entry(96), m, []);
    expect(r.status).toBe("yellow");
  });

  it("off by 20% in either direction → red", () => {
    const m = measurable({ goalDirection: "eq", goalValue: 100 });
    expect(computeStatus(entry(80), m, []).status).toBe("red");
    expect(computeStatus(entry(120), m, []).status).toBe("red");
  });
});

// ── 4) between ───────────────────────────────────────────────────────────────
describe("computeStatus — between", () => {
  it("in range → green", () => {
    const m = measurable({
      goalDirection: "between",
      goalValue: 30,
      goalSecondary: 60,
    });
    const r = computeStatus(entry(45), m, []);
    expect(r.status).toBe("green");
  });

  it("slightly below low end (within 5% of the band) → yellow", () => {
    const m = measurable({
      goalDirection: "between",
      goalValue: 30,
      goalSecondary: 60,
    });
    const r = computeStatus(entry(28.8), m, []);
    expect(r.status).toBe("yellow");
  });

  it("way above the high end → red", () => {
    const m = measurable({
      goalDirection: "between",
      goalValue: 30,
      goalSecondary: 60,
    });
    const r = computeStatus(entry(120), m, []);
    expect(r.status).toBe("red");
  });
});

// ── 5) trend_down / trend_up ────────────────────────────────────────────────
describe("computeStatus — trend directions", () => {
  it("trend_down with a falling 4-week slope → green", () => {
    const m = measurable({ goalDirection: "trend_down" });
    const history = actuals(100, 90, 80);
    const r = computeStatus(entry(70), m, history);
    expect(r.status).toBe("green");
    expect(r.reason).toMatch(/down|fall|declin/i);
  });

  it("trend_down with a rising slope → red", () => {
    const m = measurable({ goalDirection: "trend_down" });
    const history = actuals(50, 60, 70);
    const r = computeStatus(entry(80), m, history);
    expect(r.status).toBe("red");
  });

  it("trend_up with a rising slope → green", () => {
    const m = measurable({ goalDirection: "trend_up" });
    const history = actuals(50, 60, 70);
    const r = computeStatus(entry(80), m, history);
    expect(r.status).toBe("green");
  });

  it("trend_up but flat → yellow", () => {
    const m = measurable({ goalDirection: "trend_up" });
    const history = actuals(100, 100, 100);
    const r = computeStatus(entry(100), m, history);
    expect(r.status).toBe("yellow");
  });
});

// ── 6) null actual ───────────────────────────────────────────────────────────
describe("computeStatus — null actual", () => {
  it("null actual → yellow with a 'no actual' reason", () => {
    const m = measurable({ goalDirection: "gte", goalValue: 250000 });
    const r = computeStatus(entry(null), m, []);
    expect(r.status).toBe("yellow");
    expect(r.reason).toMatch(/no actual|not entered|missing/i);
  });
});

// ── 7) statusOverride ───────────────────────────────────────────────────────
describe("computeStatus — statusOverride", () => {
  it("forces the status when an override is set", () => {
    const m = measurable({ goalDirection: "gte", goalValue: 250000 });
    const r = computeStatus(entry(300000, { override: "red" }), m, []);
    expect(r.status).toBe("red");
    expect(r.reason).toMatch(/override/i);
  });
});

// ── 8) noteClassification adjustments ────────────────────────────────────────
describe("computeStatus — note classification", () => {
  it("'explained_one_off' on a red entry reduces intensity", () => {
    const m = measurable({ goalDirection: "gte", goalValue: 250000 });
    const plain = computeStatus(entry(200000), m, []);
    const explained = computeStatus(
      entry(200000, { note: "explained_one_off" }),
      m,
      [],
    );
    expect(explained.status).toBe("red");
    expect(explained.intensity).toBeLessThan(plain.intensity);
    expect(explained.reason).toMatch(/explain|one[- ]off/i);
  });

  it("'structural_issue' on a yellow entry increases intensity (may flip red)", () => {
    const m = measurable({ goalDirection: "gte", goalValue: 250000 });
    const plain = computeStatus(entry(242500), m, []);
    const structural = computeStatus(
      entry(242500, { note: "structural_issue" }),
      m,
      [],
    );
    expect(structural.intensity).toBeGreaterThan(plain.intensity);
    expect(["yellow", "red"]).toContain(structural.status);
  });

  it("'on_plan_to_recover' on a red entry reduces intensity", () => {
    const m = measurable({ goalDirection: "gte", goalValue: 250000 });
    const plain = computeStatus(entry(200000), m, []);
    const recovering = computeStatus(
      entry(200000, { note: "on_plan_to_recover" }),
      m,
      [],
    );
    expect(recovering.intensity).toBeLessThan(plain.intensity);
  });

  it("'no_context' is a no-op", () => {
    const m = measurable({ goalDirection: "gte", goalValue: 250000 });
    const plain = computeStatus(entry(200000), m, []);
    const noContext = computeStatus(
      entry(200000, { note: "no_context" }),
      m,
      [],
    );
    expect(noContext.intensity).toBe(plain.intensity);
    expect(noContext.status).toBe(plain.status);
  });
});

// ── 9) Streak / trend adjustments ────────────────────────────────────────────
describe("computeStatus — streak", () => {
  it("third consecutive red bumps intensity higher than a lone red", () => {
    const m = measurable({ goalDirection: "gte", goalValue: 250000 });
    const lone = computeStatus(entry(200000), m, []);
    const history = actuals(200000, 200000); // two prior reds, same miss size
    const third = computeStatus(entry(200000), m, history);
    expect(third.status).toBe("red");
    expect(third.intensity).toBeGreaterThan(lone.intensity);
    expect(third.reason).toMatch(/third|streak|consecutive|row/i);
  });

  it("recovery week (red→red→green) reduces intensity vs a green out of the blue", () => {
    const m = measurable({ goalDirection: "gte", goalValue: 250000 });
    const lone = computeStatus(entry(260000), m, []);
    const recovering = computeStatus(
      entry(260000),
      m,
      actuals(200000, 200000),
    );
    expect(recovering.status).toBe("green");
    expect(recovering.intensity).toBeLessThanOrEqual(lone.intensity);
    expect(recovering.reason).toMatch(/recover|bounce|back/i);
  });
});

// ── 10) Forecast tint ────────────────────────────────────────────────────────
describe("computeStatus — forecast tint", () => {
  it("currently green but projected to breach gte goal → forecast='warning'", () => {
    const m = measurable({ goalDirection: "gte", goalValue: 100 });
    // Trending down sharply, current week still above goal.
    const r = computeStatus(entry(105), m, actuals(140, 130, 120));
    expect(r.status).toBe("green");
    expect(r.forecast).toBe("warning");
  });

  it("currently green and stable → forecast=null", () => {
    const m = measurable({ goalDirection: "gte", goalValue: 100 });
    const r = computeStatus(entry(120), m, actuals(118, 119, 120));
    expect(r.status).toBe("green");
    expect(r.forecast).toBeNull();
  });
});

// ── 11) Intensity bounds ─────────────────────────────────────────────────────
describe("computeStatus — intensity bounds", () => {
  it("intensity always lands in [0, 100]", () => {
    const cases: Array<[ShadingEntry, ShadingMeasurable, ShadingEntry[]]> = [
      [
        entry(0),
        measurable({ goalDirection: "gte", goalValue: 250000 }),
        [],
      ],
      [
        entry(1_000_000),
        measurable({ goalDirection: "gte", goalValue: 250000 }),
        [],
      ],
      [
        entry(200000, { note: "explained_one_off" }),
        measurable({ goalDirection: "gte", goalValue: 250000 }),
        actuals(200000, 200000),
      ],
      [
        entry(200000, { note: "structural_issue" }),
        measurable({ goalDirection: "gte", goalValue: 250000 }),
        actuals(200000, 200000),
      ],
    ];
    for (const [e, m, h] of cases) {
      const r = computeStatus(e, m, h);
      expect(r.intensity).toBeGreaterThanOrEqual(0);
      expect(r.intensity).toBeLessThanOrEqual(100);
    }
  });
});
