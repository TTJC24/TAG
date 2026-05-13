// Pure composer: turns a person's readiness verdict + the upcoming meeting
// + a notification window into a Nudge — or null when there's nothing
// actionable to nudge about (e.g. the person is already green).
//
// No DB access, no I/O. Easy to unit-test; the orchestrator in
// lib/nudges/dispatch.ts wraps the queries around it.

import type { ReadinessResult } from "@/lib/readiness/compute-readiness";
import type { Nudge, NudgeWindow } from "./types";

export interface ComposeNudgeInput {
  recipientPersonId: string;
  recipientName: string;
  recipientEmail: string;
  orgId: string;
  orgSlug: string;
  window: NudgeWindow;
  readiness: ReadinessResult;
  /** ISO timestamp of the next L10, or null when none scheduled. */
  meetingScheduledFor: string | null;
}

export function composeNudge(input: ComposeNudgeInput): Nudge | null {
  // Green = nothing to nudge. Skip silently.
  if (input.readiness.status === "green") return null;

  const headline = headlineFor(input.window, input.readiness);
  const body = bodyFor(input.window, input.recipientName, input.readiness);

  return {
    recipientPersonId: input.recipientPersonId,
    recipientName: input.recipientName,
    recipientEmail: input.recipientEmail,
    orgId: input.orgId,
    orgSlug: input.orgSlug,
    window: input.window,
    headline,
    body,
    meetingDate: input.meetingScheduledFor
      ? input.meetingScheduledFor.slice(0, 10)
      : null,
    readinessAtCompose: input.readiness,
  };
}

function headlineFor(window: NudgeWindow, r: ReadinessResult): string {
  const tail = r.status === "red" ? "your scorecard awaits" : "almost ready";
  switch (window) {
    case "sunday_evening":
      return `L10 prep — ${tail}`;
    case "monday_morning":
      return `Reminder — ${tail}`;
    case "pre_meeting":
      return `L10 starts soon — ${tail}`;
  }
}

function bodyFor(
  window: NudgeWindow,
  name: string,
  r: ReadinessResult,
): string {
  const first = name.split(" ")[0] ?? name;
  const lines: string[] = [];

  switch (window) {
    case "sunday_evening":
      lines.push(`Hi ${first}, your L10 prep is open.`);
      break;
    case "monday_morning":
      lines.push(`Hi ${first}, this is a reminder — prep is due before tomorrow's L10.`);
      break;
    case "pre_meeting":
      lines.push(`Hi ${first}, the L10 starts shortly.`);
      break;
  }

  if (r.missingMeasurables > 0) {
    lines.push(
      `• ${r.missingMeasurables} of ${r.totalMeasurables} measurable${
        r.totalMeasurables === 1 ? "" : "s"
      } still needs this week's actual.`,
    );
  }
  if (r.overdueTodos > 0) {
    lines.push(
      `• ${r.overdueTodos} overdue to-do${r.overdueTodos === 1 ? "" : "s"}.`,
    );
  }
  lines.push("Open: /me");
  return lines.join("\n");
}
