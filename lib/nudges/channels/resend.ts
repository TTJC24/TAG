// Resend channel — adapter point only. Same shape as TeamsChannel: gated
// by `NUDGES_RESEND_ENABLED=true`, throws when called while disabled.
//
// When approved, the implementation will call sendEmail() from
// lib/email/client.ts with subject = nudge.headline, text = nudge.body.

import { optionalEnv } from "@/lib/env";
import type { Nudge, NudgeChannel, NudgeReceipt } from "../types";

export class ResendChannel implements NudgeChannel {
  readonly name = "resend" as const;

  isEnabled(): boolean {
    return optionalEnv("NUDGES_RESEND_ENABLED") === "true";
  }

  async send(_nudge: Nudge): Promise<NudgeReceipt> {
    if (!this.isEnabled()) {
      throw new Error(
        "ResendChannel.send() called while disabled. Set NUDGES_RESEND_ENABLED=true after the outbound rollout is approved.",
      );
    }
    throw new Error(
      "ResendChannel delivery not yet implemented. Wire up sendEmail() when the outbound slice lands.",
    );
  }
}
