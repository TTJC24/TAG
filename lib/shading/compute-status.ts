// Shading engine.
//
// Pure function: given one entry, its measurable, and the chronological
// history of prior entries, returns the status color + intensity + reason
// that drive the cell's fill. Scenarios in compute-status.test.ts pin every
// branch — change the tests first, then bring this back to green.

import type {
  ShadingEntry,
  ShadingMeasurable,
  ShadingResult,
  StatusColor,
} from "./types";

// ── Tunables ─────────────────────────────────────────────────────────────────

/** Goal-relative band: misses inside this fraction stay yellow, not red. */
const YELLOW_BAND = 0.05;

/** Trend slope normalized by mean — anything inside this is "flat". */
const FLAT_SLOPE_TOL = 0.02;

/** How many prior weeks the streak heuristic considers. */
const STREAK_WINDOW = 2;

/** Window for forecast slope (history's tail + the current entry). */
const FORECAST_WINDOW = 4;

/** How many weeks to project for the forecast tint. */
const FORECAST_HORIZON = 2;

/** Note classification → intensity adjustment (status unchanged). */
const NOTE_INTENSITY_DELTA: Record<string, number> = {
  explained_one_off: -20,
  on_plan_to_recover: -15,
  structural_issue: +20,
  no_context: 0,
};

// ── Public ──────────────────────────────────────────────────────────────────

export function computeStatus(
  entry: ShadingEntry,
  measurable: ShadingMeasurable,
  history: ShadingEntry[],
): ShadingResult {
  // 1) Manual override short-circuits everything.
  if (entry.statusOverride) {
    return {
      status: entry.statusOverride,
      intensity: 80,
      reason: "manual status override",
      forecast: null,
    };
  }

  // 2) No actual yet — pale yellow placeholder.
  if (entry.actual === null) {
    return {
      status: "yellow",
      intensity: 30,
      reason: "no actual entered yet",
      forecast: null,
    };
  }

  // 3) Base status from threshold or trend rules.
  const base = baseStatus(entry, measurable, history);
  const { status } = base;
  let { intensity, reason } = base;

  // 4) Note classification adjusts intensity by ±1 step.
  const noteAdj = entry.noteClassification
    ? NOTE_INTENSITY_DELTA[entry.noteClassification] ?? 0
    : 0;
  if (noteAdj !== 0) {
    intensity += noteAdj;
    reason = `${reason} · ${noteReason(entry.noteClassification!)}`;
  }

  // 5) Streak adjustment — only for threshold-style goals. Trend goals are
  //    already a slope readout; piling streak heuristics on top is noise.
  if (isThresholdDirection(measurable.goalDirection)) {
    const adj = streakAdjustment(status, history, measurable);
    if (adj) {
      intensity += adj.delta;
      reason = `${reason} · ${adj.label}`;
    }
  }

  // 6) Forecast tint — green now but the trend predicts a breach in
  //    `FORECAST_HORIZON` weeks. Only applicable when the goal has a numeric
  //    threshold to breach.
  const forecast =
    status === "green" && hasNumericGoal(measurable)
      ? forecastTint(entry, measurable, history)
      : null;

  intensity = clamp(intensity, 0, 100);

  return { status, intensity, reason, forecast };
}

// ── Base status (threshold + variance, or trend slope) ──────────────────────

interface BaseResult {
  status: StatusColor;
  intensity: number;
  reason: string;
}

function baseStatus(
  entry: ShadingEntry,
  measurable: ShadingMeasurable,
  history: ShadingEntry[],
): BaseResult {
  const actual = entry.actual as number; // null already short-circuited
  const dir = measurable.goalDirection;

  switch (dir) {
    case "gte":
      return thresholdGte(actual, requireGoal(measurable, "goalValue"));
    case "lte":
      return thresholdLte(actual, requireGoal(measurable, "goalValue"));
    case "eq":
      return thresholdEq(actual, requireGoal(measurable, "goalValue"));
    case "between":
      return thresholdBetween(
        actual,
        requireGoal(measurable, "goalValue"),
        requireGoal(measurable, "goalSecondary"),
      );
    case "trend_down":
    case "trend_up":
      return trendBase(entry, dir, history);
  }
}

function thresholdGte(actual: number, goal: number): BaseResult {
  if (actual >= goal) {
    const overshoot = (actual - goal) / safe(goal);
    const intensity = clamp(45 + overshoot * 80, 40, 80);
    return {
      status: "green",
      intensity,
      reason:
        overshoot < 0.001
          ? "met goal exactly"
          : `exceeded goal by ${pct(overshoot)}`,
    };
  }
  const deviation = (goal - actual) / safe(goal);
  if (deviation <= YELLOW_BAND) {
    return {
      status: "yellow",
      intensity: clamp(20 + deviation * 600, 20, 50),
      reason: `missed by ${pct(deviation)} — within 5% band`,
    };
  }
  return {
    status: "red",
    intensity: clamp(40 + (deviation - YELLOW_BAND) * 200, 40, 90),
    reason: `missed goal by ${pct(deviation)}`,
  };
}

function thresholdLte(actual: number, goal: number): BaseResult {
  if (actual <= goal) {
    const undershoot = (goal - actual) / safe(goal);
    const intensity = clamp(45 + undershoot * 80, 40, 80);
    return {
      status: "green",
      intensity,
      reason:
        undershoot < 0.001
          ? "met goal exactly"
          : `under goal by ${pct(undershoot)}`,
    };
  }
  const deviation = (actual - goal) / safe(goal);
  if (deviation <= YELLOW_BAND) {
    return {
      status: "yellow",
      intensity: clamp(20 + deviation * 600, 20, 50),
      reason: `over by ${pct(deviation)} — within 5% band`,
    };
  }
  return {
    status: "red",
    intensity: clamp(40 + (deviation - YELLOW_BAND) * 200, 40, 90),
    reason: `over goal by ${pct(deviation)}`,
  };
}

function thresholdEq(actual: number, goal: number): BaseResult {
  const delta = Math.abs(actual - goal) / safe(goal);
  if (delta < 0.001) {
    return { status: "green", intensity: 70, reason: "hit target exactly" };
  }
  if (delta <= YELLOW_BAND) {
    return {
      status: "yellow",
      intensity: clamp(20 + delta * 600, 20, 50),
      reason: `off target by ${pct(delta)} — within 5% band`,
    };
  }
  return {
    status: "red",
    intensity: clamp(40 + (delta - YELLOW_BAND) * 200, 40, 90),
    reason: `off target by ${pct(delta)}`,
  };
}

function thresholdBetween(
  actual: number,
  low: number,
  high: number,
): BaseResult {
  if (actual >= low && actual <= high) {
    return { status: "green", intensity: 55, reason: "within target band" };
  }
  if (actual < low) {
    const span = Math.max(high - low, 1e-9);
    const deviation = (low - actual) / Math.max(Math.abs(span), 1e-9);
    if (deviation <= YELLOW_BAND) {
      return {
        status: "yellow",
        intensity: clamp(20 + deviation * 600, 20, 50),
        reason: `below band by ${pct(deviation)} — within 5%`,
      };
    }
    return {
      status: "red",
      intensity: clamp(40 + (deviation - YELLOW_BAND) * 200, 40, 90),
      reason: `below target band by ${pct(deviation)}`,
    };
  }
  // actual > high
  const span = Math.max(high - low, 1e-9);
  const deviation = (actual - high) / Math.max(Math.abs(span), 1e-9);
  if (deviation <= YELLOW_BAND) {
    return {
      status: "yellow",
      intensity: clamp(20 + deviation * 600, 20, 50),
      reason: `above band by ${pct(deviation)} — within 5%`,
    };
  }
  return {
    status: "red",
    intensity: clamp(40 + (deviation - YELLOW_BAND) * 200, 40, 90),
    reason: `above target band by ${pct(deviation)}`,
  };
}

function trendBase(
  entry: ShadingEntry,
  dir: "trend_down" | "trend_up",
  history: ShadingEntry[],
): BaseResult {
  const series = collectActuals([...history.slice(-3), entry]);
  if (series.length < 2) {
    return {
      status: "yellow",
      intensity: 30,
      reason: "not enough history to score trend yet",
    };
  }
  const s = slope(series);
  const mean = series.reduce((sum, v) => sum + v, 0) / series.length;
  const norm = mean === 0 ? 0 : s / Math.abs(mean);

  if (Math.abs(norm) < FLAT_SLOPE_TOL) {
    return { status: "yellow", intensity: 40, reason: "trend is flat" };
  }
  const desired = dir === "trend_down" ? s < 0 : s > 0;
  if (desired) {
    return {
      status: "green",
      intensity: clamp(50 + Math.abs(norm) * 200, 50, 80),
      reason:
        dir === "trend_down"
          ? "trending down as desired"
          : "trending up as desired",
    };
  }
  return {
    status: "red",
    intensity: clamp(50 + Math.abs(norm) * 200, 50, 90),
    reason:
      dir === "trend_down"
        ? "trending up against goal"
        : "trending down against goal",
  };
}

// ── Streak / recovery heuristic ──────────────────────────────────────────────

function streakAdjustment(
  currentStatus: StatusColor,
  history: ShadingEntry[],
  measurable: ShadingMeasurable,
): { delta: number; label: string } | null {
  const priors = history.slice(-STREAK_WINDOW);
  if (priors.length === 0) return null;

  const priorStatuses = priors.map(
    (h) => baseStatus(h, measurable, []).status,
  );
  const allPriorRed =
    priorStatuses.length === STREAK_WINDOW &&
    priorStatuses.every((s) => s === "red");

  if (currentStatus === "red" && allPriorRed) {
    return { delta: 15, label: "third red in a row" };
  }

  // Recovery: any prior was red and we're not red.
  const lastPrior = priorStatuses[priorStatuses.length - 1];
  if (lastPrior === "red" && currentStatus !== "red") {
    return { delta: -10, label: "recovering after red" };
  }

  return null;
}

// ── Forecast tint ────────────────────────────────────────────────────────────

function forecastTint(
  entry: ShadingEntry,
  measurable: ShadingMeasurable,
  history: ShadingEntry[],
): "warning" | null {
  const series = collectActuals(
    [...history, entry].slice(-FORECAST_WINDOW),
  );
  if (series.length < 3) return null;
  const s = slope(series);
  const lastValue = series[series.length - 1] ?? 0;
  const projected = lastValue + s * FORECAST_HORIZON;

  const dir = measurable.goalDirection;
  if (dir === "gte" && measurable.goalValue !== null) {
    return projected < measurable.goalValue ? "warning" : null;
  }
  if (dir === "lte" && measurable.goalValue !== null) {
    return projected > measurable.goalValue ? "warning" : null;
  }
  if (
    dir === "between" &&
    measurable.goalValue !== null &&
    measurable.goalSecondary !== null
  ) {
    return projected < measurable.goalValue ||
      projected > measurable.goalSecondary
      ? "warning"
      : null;
  }
  return null;
}

// ── Utilities ────────────────────────────────────────────────────────────────

function isThresholdDirection(dir: ShadingMeasurable["goalDirection"]): boolean {
  return dir === "gte" || dir === "lte" || dir === "eq" || dir === "between";
}

function hasNumericGoal(m: ShadingMeasurable): boolean {
  return m.goalValue !== null;
}

function requireGoal(
  m: ShadingMeasurable,
  field: "goalValue" | "goalSecondary",
): number {
  const v = m[field];
  if (v === null) {
    throw new Error(
      `Measurable with direction ${m.goalDirection} requires ${field} to be set.`,
    );
  }
  return v;
}

function collectActuals(entries: ShadingEntry[]): number[] {
  const out: number[] = [];
  for (const e of entries) {
    if (e.actual !== null) out.push(e.actual);
  }
  return out;
}

function slope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  for (let i = 0; i < n; i++) {
    const y = values[i] ?? 0;
    sumX += i;
    sumY += y;
    sumXY += i * y;
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

function noteReason(c: NonNullable<ShadingEntry["noteClassification"]>): string {
  switch (c) {
    case "explained_one_off":
      return "explained one-off in note";
    case "structural_issue":
      return "structural issue in note";
    case "on_plan_to_recover":
      return "on-plan to recover in note";
    case "no_context":
      return "note has no context";
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function safe(n: number): number {
  return n === 0 ? 1e-9 : Math.abs(n);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
