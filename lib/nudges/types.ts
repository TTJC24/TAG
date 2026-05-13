// Shared types for the pre-meeting nudges layer.
//
// Boundaries:
//   - `Nudge` is the *intent to notify* — composed from readiness state and
//     a notification window. Channel-agnostic.
//   - `NudgeChannel` is one delivery target (in-app, Teams, Resend). Ships
//     a Nudge and returns a receipt (or no-op when the channel isn't
//     enabled — outbound channels are gated behind env flags so the
//     scaffolding can land before delivery is approved).
//
// Outbound delivery is intentionally not wired in this slice.

import type { ReadinessResult } from "@/lib/readiness/compute-readiness";

/** When in the pre-meeting cycle this nudge is being composed for. Drives
 *  the headline copy and (later) the cron schedule. */
export type NudgeWindow = "sunday_evening" | "monday_morning" | "pre_meeting";

/** Composed nudge ready to hand to a channel. */
export interface Nudge {
  recipientPersonId: string;
  recipientName: string;
  recipientEmail: string;
  /** The org this nudge is scoped to. Channels that fan-out to a workspace
   *  (Teams) must use this to pick the right tenant/team. */
  orgId: string;
  orgSlug: string;
  window: NudgeWindow;
  /** Short headline copy. Suitable for a notification title or email subject. */
  headline: string;
  /** Body copy with details. Plain text; channels that render markdown can
   *  upgrade. */
  body: string;
  /** ISO date of the L10 we're nudging about, when known. */
  meetingDate: string | null;
  /** Snapshot of readiness at compose time. Lets the receipt show *why* this
   *  nudge was sent without re-querying. */
  readinessAtCompose: ReadinessResult;
}

/** Returned by a channel after attempting delivery. `delivered: false` is
 *  expected when the channel is intentionally disabled. */
export interface NudgeReceipt {
  channel: string;
  delivered: boolean;
  /** Channel-native id (Resend message id, Teams chat id, etc.) when delivered. */
  externalId?: string;
  /** Human-readable reason when not delivered (e.g. "channel disabled"). */
  reason?: string;
}

export interface NudgeChannel {
  /** Stable identifier — `in_app` | `teams` | `resend`. */
  readonly name: string;
  /** True when wiring + secrets allow this channel to actually send.
   *  Outbound channels return false until their env flag is set. */
  isEnabled(): boolean;
  send(nudge: Nudge): Promise<NudgeReceipt>;
}
