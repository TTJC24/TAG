import { describe, expect, it } from "vitest";
import { composeNudge } from "./compose-nudge";
import type { ReadinessResult } from "@/lib/readiness/compute-readiness";

const baseInput = {
  recipientPersonId: "p1",
  recipientName: "Daniel Cruz",
  recipientEmail: "daniel@example.com",
  orgId: "org-fs",
  orgSlug: "fs",
  meetingScheduledFor: "2026-05-19T15:00:00.000Z",
};

const RED: ReadinessResult = {
  status: "red",
  label: "2 measurables missing",
  totalMeasurables: 4,
  missingMeasurables: 2,
  overdueTodos: 1,
};

const YELLOW: ReadinessResult = {
  status: "yellow",
  label: "1 overdue to-do",
  totalMeasurables: 3,
  missingMeasurables: 0,
  overdueTodos: 1,
};

const GREEN: ReadinessResult = {
  status: "green",
  label: "Ready for L10",
  totalMeasurables: 3,
  missingMeasurables: 0,
  overdueTodos: 0,
};

describe("composeNudge", () => {
  it("returns null when the recipient is already green", () => {
    const n = composeNudge({ ...baseInput, window: "sunday_evening", readiness: GREEN });
    expect(n).toBeNull();
  });

  it("composes a Sunday-evening red nudge", () => {
    const n = composeNudge({ ...baseInput, window: "sunday_evening", readiness: RED });
    expect(n).not.toBeNull();
    expect(n!.window).toBe("sunday_evening");
    expect(n!.headline).toContain("L10 prep");
    expect(n!.body).toContain("Daniel");
    expect(n!.body).toContain("2 of 4 measurables");
    expect(n!.body).toContain("1 overdue to-do");
    expect(n!.body).toContain("/me");
    expect(n!.meetingDate).toBe("2026-05-19");
  });

  it("composes a Monday-morning yellow nudge with overdue copy only", () => {
    const n = composeNudge({ ...baseInput, window: "monday_morning", readiness: YELLOW });
    expect(n).not.toBeNull();
    expect(n!.headline).toContain("Reminder");
    expect(n!.body).not.toContain("measurable");
    expect(n!.body).toContain("1 overdue to-do");
  });

  it("composes a pre-meeting nudge", () => {
    const n = composeNudge({ ...baseInput, window: "pre_meeting", readiness: RED });
    expect(n!.headline).toContain("L10 starts soon");
  });

  it("uses first name from full name", () => {
    const n = composeNudge({
      ...baseInput,
      recipientName: "Anna-Maria Lopez",
      window: "sunday_evening",
      readiness: RED,
    });
    expect(n!.body).toMatch(/^Hi Anna-Maria/);
  });

  it("handles single-name recipients", () => {
    const n = composeNudge({
      ...baseInput,
      recipientName: "Tim",
      window: "monday_morning",
      readiness: RED,
    });
    expect(n!.body).toMatch(/^Hi Tim/);
  });

  it("meetingDate is null when no meeting scheduled", () => {
    const n = composeNudge({
      ...baseInput,
      meetingScheduledFor: null,
      window: "sunday_evening",
      readiness: RED,
    });
    expect(n!.meetingDate).toBeNull();
  });

  it("singular pluralization for one missing measurable", () => {
    const n = composeNudge({
      ...baseInput,
      window: "sunday_evening",
      readiness: {
        status: "red",
        label: "1 measurable missing",
        totalMeasurables: 1,
        missingMeasurables: 1,
        overdueTodos: 0,
      },
    });
    expect(n!.body).toContain("1 of 1 measurable still needs");
  });

  it("snapshots the readiness it was composed from", () => {
    const n = composeNudge({ ...baseInput, window: "monday_morning", readiness: RED });
    expect(n!.readinessAtCompose).toEqual(RED);
  });
});
