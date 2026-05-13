// Teams channel — adapter point only. Outbound delivery is intentionally
// not wired in this slice; the channel reports `isEnabled() === false`
// unless `NUDGES_TEAMS_ENABLED=true` is set, and `send()` throws if called
// while disabled so a stray dispatch can't slip through.
//
// When approved, the implementation will:
//   1. Resolve the recipient's AAD user id (people row → graph lookup).
//   2. POST a chatMessage via the existing lib/microsoft/graph wrapper.
//   3. Return { delivered: true, externalId: chatMessageId }.

import { optionalEnv } from "@/lib/env";
import type { Nudge, NudgeChannel, NudgeReceipt } from "../types";

export class TeamsChannel implements NudgeChannel {
  readonly name = "teams" as const;

  isEnabled(): boolean {
    return optionalEnv("NUDGES_TEAMS_ENABLED") === "true";
  }

  async send(_nudge: Nudge): Promise<NudgeReceipt> {
    if (!this.isEnabled()) {
      throw new Error(
        "TeamsChannel.send() called while disabled. Set NUDGES_TEAMS_ENABLED=true after the outbound rollout is approved.",
      );
    }
    throw new Error(
      "TeamsChannel delivery not yet implemented. Wire up Graph chatMessage POST when the outbound slice lands.",
    );
  }
}
