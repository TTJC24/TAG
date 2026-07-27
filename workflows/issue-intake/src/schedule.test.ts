import { describe, expect, it } from "vitest";
import {
  FeedRunLog,
  isFeedDue,
  parseScheduleTime,
  resolveFeedSchedules,
  runDateKey,
} from "./schedule.js";

const at = (iso: string): Date => new Date(iso);

describe("parseScheduleTime", () => {
  it("accepts HH:MM", () => {
    expect(parseScheduleTime("11:00")).toEqual({ hourUtc: 11, minuteUtc: 0 });
    expect(parseScheduleTime("6:30")).toEqual({ hourUtc: 6, minuteUtc: 30 });
    expect(parseScheduleTime(" 23:59 ")).toEqual({
      hourUtc: 23,
      minuteUtc: 59,
    });
  });

  it("treats absent or malformed values as not scheduled, never as midnight", () => {
    for (const bad of [undefined, "", "nonsense", "24:00", "11:60", "1100"]) {
      expect(parseScheduleTime(bad as string | undefined)).toBeNull();
    }
  });
});

describe("resolveFeedSchedules", () => {
  it("ships inert when nothing is configured", () => {
    expect(resolveFeedSchedules({})).toEqual([]);
  });

  it("schedules only what is explicitly set", () => {
    expect(resolveFeedSchedules({ COLLECTIONS_SCHEDULE_UTC: "11:00" })).toEqual(
      [{ name: "collections", hourUtc: 11, minuteUtc: 0 }],
    );
    expect(
      resolveFeedSchedules({
        COLLECTIONS_SCHEDULE_UTC: "11:00",
        SALES_SCHEDULE_UTC: "12:30",
      }),
    ).toHaveLength(2);
  });
});

describe("isFeedDue", () => {
  const schedule = { name: "collections", hourUtc: 11, minuteUtc: 0 };

  it("is not due before the scheduled time", () => {
    expect(isFeedDue(schedule, at("2026-07-27T10:59:00Z"), null)).toBe(false);
  });

  it("is due at the scheduled minute", () => {
    expect(isFeedDue(schedule, at("2026-07-27T11:00:00Z"), null)).toBe(true);
  });

  it("does not run twice in a day", () => {
    expect(isFeedDue(schedule, at("2026-07-27T11:30:00Z"), "2026-07-27")).toBe(
      false,
    );
  });

  it("still runs after a restart later the same day", () => {
    // yesterday's run must not satisfy today's schedule
    expect(isFeedDue(schedule, at("2026-07-27T11:05:00Z"), "2026-07-26")).toBe(
      true,
    );
  });

  it("catches up rather than skipping when the worker was down at the hour", () => {
    // down at 11:00, comes up at 13:00 — the day's pull still happens
    expect(isFeedDue(schedule, at("2026-07-27T13:00:00Z"), "2026-07-26")).toBe(
      true,
    );
  });

  it("becomes due again the next day", () => {
    expect(isFeedDue(schedule, at("2026-07-28T11:00:00Z"), "2026-07-27")).toBe(
      true,
    );
  });
});

describe("FeedRunLog", () => {
  it("makes a restart-storm pull exactly once", () => {
    const schedules = [{ name: "collections", hourUtc: 11, minuteUtc: 0 }];
    const log = new FeedRunLog();

    let runs = 0;
    // five loop ticks across 11:00-11:04
    for (const minute of ["00", "01", "02", "03", "04"]) {
      const now = at(`2026-07-27T11:${minute}:00Z`);
      for (const due of log.due(schedules, now)) {
        runs += 1;
        log.record(due.name, now);
      }
    }
    expect(runs).toBe(1);
  });

  it("runs again the following day", () => {
    const schedules = [{ name: "collections", hourUtc: 11, minuteUtc: 0 }];
    const log = new FeedRunLog();
    const day1 = at("2026-07-27T11:00:00Z");
    log.record("collections", day1);
    expect(log.due(schedules, at("2026-07-27T15:00:00Z"))).toHaveLength(0);
    expect(log.due(schedules, at("2026-07-28T11:00:00Z"))).toHaveLength(1);
  });

  it("tracks feeds independently", () => {
    const schedules = [
      { name: "collections", hourUtc: 11, minuteUtc: 0 },
      { name: "sales", hourUtc: 12, minuteUtc: 0 },
    ];
    const log = new FeedRunLog();
    const now = at("2026-07-27T12:00:00Z");
    log.record("collections", now);
    const due = log.due(schedules, now);
    expect(due.map((d) => d.name)).toEqual(["sales"]);
  });
});

describe("runDateKey", () => {
  it("keys by UTC calendar day", () => {
    expect(runDateKey(at("2026-07-27T23:59:59Z"))).toBe("2026-07-27");
    expect(runDateKey(at("2026-07-28T00:00:00Z"))).toBe("2026-07-28");
  });
});
