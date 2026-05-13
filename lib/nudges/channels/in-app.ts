// In-app channel — the only channel the first nudges slice actually
// "delivers" through. Until a notifications inbox lands, "delivery" means
// writing an audit_log row so the action is observable. The /me readiness
// banner is the user-facing surface.

import { writeAuditEntry } from "@/lib/audit/log";
import type { Nudge, NudgeChannel, NudgeReceipt } from "../types";

export class InAppChannel implements NudgeChannel {
  readonly name = "in_app" as const;

  isEnabled(): boolean {
    return true;
  }

  async send(nudge: Nudge): Promise<NudgeReceipt> {
    await writeAuditEntry({
      orgId: nudge.orgId,
      personId: nudge.recipientPersonId,
      action: "nudge_sent",
      entityType: "nudge",
      entityId: null,
      before: null,
      after: {
        window: nudge.window,
        headline: nudge.headline,
        body: nudge.body,
        channel: this.name,
        readinessAtCompose: nudge.readinessAtCompose,
      },
      source: "system",
    });

    return {
      channel: this.name,
      delivered: true,
    };
  }
}
