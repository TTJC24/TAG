// Nudge orchestrator. Given an org + a notification window, it:
//   1. Pulls the org-readiness rows (same primitive /admin/readiness uses).
//   2. Composes a Nudge per not-ready person.
//   3. Sends through every enabled channel.
//
// Two modes:
//   - dryRun = true  → composes only, never calls send(). Returns the
//                      proposed nudges + the channels that *would* fire.
//                      Safe for the admin preview endpoint.
//   - dryRun = false → composes and sends through enabled channels.
//                      In this slice the only enabled channel is in_app.
//                      Outbound channels (Teams, Resend) stay disabled
//                      until their env flags are set.

import { getNextMeeting } from "@/lib/queries/me";
import { getOrgReadiness } from "@/lib/queries/org-readiness";
import { InAppChannel } from "./channels/in-app";
import { ResendChannel } from "./channels/resend";
import { TeamsChannel } from "./channels/teams";
import { composeNudge } from "./compose-nudge";
import type { Nudge, NudgeChannel, NudgeReceipt, NudgeWindow } from "./types";

export interface DispatchOptions {
  orgId: string;
  orgSlug: string;
  window: NudgeWindow;
  dryRun?: boolean;
  /** Override "today" so callers (preview endpoint, tests) can render a
   *  consistent view without depending on the wall clock. */
  today?: string;
  /** Override the channel set (tests). */
  channels?: NudgeChannel[];
}

export interface DispatchResultRow {
  nudge: Nudge;
  receipts: NudgeReceipt[];
}

export interface DispatchResult {
  window: NudgeWindow;
  dryRun: boolean;
  /** Channel names + enabled flags, snapshotted at dispatch time. */
  channels: { name: string; enabled: boolean }[];
  nudges: DispatchResultRow[];
  /** People who were considered but didn't need a nudge. */
  skipped: { personId: string; personName: string; reason: string }[];
}

const DEFAULT_CHANNELS: () => NudgeChannel[] = () => [
  new InAppChannel(),
  new TeamsChannel(),
  new ResendChannel(),
];

export async function dispatchNudges(
  opts: DispatchOptions,
): Promise<DispatchResult> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const channels = opts.channels ?? DEFAULT_CHANNELS();
  const dryRun = opts.dryRun ?? false;

  const [readinessRows, nextMeeting] = await Promise.all([
    getOrgReadinessForCurrentWeek(opts.orgId, today),
    getNextMeeting(opts.orgId),
  ]);

  const meetingScheduledFor = nextMeeting?.scheduledFor.toISOString() ?? null;

  const nudges: DispatchResultRow[] = [];
  const skipped: DispatchResult["skipped"] = [];

  for (const row of readinessRows) {
    const nudge = composeNudge({
      recipientPersonId: row.person.id,
      recipientName: row.person.name,
      recipientEmail: row.person.email,
      orgId: opts.orgId,
      orgSlug: opts.orgSlug,
      window: opts.window,
      readiness: row.readiness,
      meetingScheduledFor,
    });
    if (!nudge) {
      skipped.push({
        personId: row.person.id,
        personName: row.person.name,
        reason: "already ready",
      });
      continue;
    }

    const receipts: NudgeReceipt[] = [];
    for (const ch of channels) {
      if (!ch.isEnabled()) {
        receipts.push({
          channel: ch.name,
          delivered: false,
          reason: "channel disabled",
        });
        continue;
      }
      if (dryRun) {
        receipts.push({
          channel: ch.name,
          delivered: false,
          reason: "dry run",
        });
        continue;
      }
      try {
        receipts.push(await ch.send(nudge));
      } catch (err) {
        receipts.push({
          channel: ch.name,
          delivered: false,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    nudges.push({ nudge, receipts });
  }

  return {
    window: opts.window,
    dryRun,
    channels: channels.map((c) => ({ name: c.name, enabled: c.isEnabled() })),
    nudges,
    skipped,
  };
}

// Pulls the same readiness rows /admin/readiness uses, but anchored on the
// current week. Local helper so callers don't have to wire up week lookup.
async function getOrgReadinessForCurrentWeek(orgId: string, today: string) {
  const { db } = await import("@/lib/db/client");
  const { weeks } = await import("@/lib/db/schema");
  const { desc } = await import("drizzle-orm");
  const recent = await db
    .select()
    .from(weeks)
    .orderBy(desc(weeks.weekEndingDate))
    .limit(1);
  const currentWeek = recent[0] ?? null;
  return getOrgReadiness(orgId, currentWeek?.id ?? null, today);
}
