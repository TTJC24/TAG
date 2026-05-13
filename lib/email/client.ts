// Resend client — single source for transactional email.
//
// Used by:
//   - Pre-meeting reminders (Sunday 6pm cron, Phase 3)
//   - Recap emails on meeting conclude (Phase 4)
//   - PDF board packets (Phase 7)
//
// All callers go through `sendEmail` so audit logging, retries, and template
// rendering can be added in one place. v1 is a thin wrapper; expand as
// downstream needs land.

import { Resend } from "resend";
import { requireEnv } from "@/lib/env";

let _client: Resend | null = null;
function client(): Resend {
  if (!_client) _client = new Resend(requireEnv("RESEND_API_KEY"));
  return _client;
}

export interface SendEmailParams {
  to: string | string[];
  subject: string;
  /** Plain text body (always required so emails are readable everywhere). */
  text: string;
  /** Optional HTML body. If omitted, the plain text is the only content. */
  html?: string;
  /** Override the default sender (`RESEND_FROM`). Rare. */
  from?: string;
}

export interface SendEmailResult {
  id: string;
}

export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const res = await client().emails.send({
    from: params.from ?? requireEnv("RESEND_FROM"),
    to: params.to,
    subject: params.subject,
    text: params.text,
    ...(params.html ? { html: params.html } : {}),
  });
  if (res.error) {
    throw new Error(
      `Resend send failed: ${res.error.name ?? "error"} — ${res.error.message ?? "(no message)"}`,
    );
  }
  if (!res.data?.id) {
    throw new Error("Resend send returned no message id");
  }
  return { id: res.data.id };
}
