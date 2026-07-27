"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

export interface ChaseProposal {
  customerName: string;
  recipient: string | null;
  blockedReason: string | null;
  subject: string;
  body: string;
  ladderStep: number;
  pastDue: number;
}

const LADDER_LABEL: Record<number, string> = {
  1: "friendly reminder",
  2: "firm follow-up",
  3: "final notice",
  4: "escalation",
};

const money = (value: number): string =>
  `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

export function GmailDraftPreviewForm({
  approvalId,
  organizationId,
  proposal = null,
}: {
  approvalId: string;
  organizationId: string;
  /**
   * Chase text composed when the task was raised. Prefills the fields so the
   * approver reviews and edits instead of retyping. Every field stays fully
   * editable, and the same two human steps still gate the draft.
   */
  proposal?: ChaseProposal | null;
}) {
  const router = useRouter();
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function preview(formData: FormData) {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/approvals/${encodeURIComponent(approvalId)}/gmail-draft-preview`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify({
            organizationId,
            to: formData.get("to"),
            subject: formData.get("subject"),
            body: formData.get("body"),
          }),
        },
      );
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(detail?.message ?? "Draft preview failed.");
      }
      router.refresh();
    } catch (previewError) {
      setError(
        previewError instanceof Error
          ? previewError.message
          : "Draft preview failed.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      action={(data) => void preview(data)}
      className="approvalResolutionForm"
    >
      <p>
        Preview is exact and creates nothing. A second human authorization is
        required before Gmail drafts.create can run.
      </p>
      {proposal ? (
        <p className="chaseProposalNote">
          Prefilled from Acumatica: <strong>{proposal.customerName}</strong>,{" "}
          {money(proposal.pastDue)} past due —{" "}
          {LADDER_LABEL[proposal.ladderStep] ?? `step ${proposal.ladderStep}`}.
          Edit anything before previewing.
        </p>
      ) : null}
      {proposal && !proposal.recipient ? (
        <p className="formError">
          No AR contact email on file in Acumatica for this customer
          {proposal.blockedReason ? ` (${proposal.blockedReason})` : ""}. The
          message is drafted below — enter a recipient to continue.
        </p>
      ) : null}
      <label>
        Recipient
        <input
          defaultValue={proposal?.recipient ?? ""}
          name="to"
          required
          type="email"
        />
      </label>
      <label>
        Subject
        <input defaultValue={proposal?.subject ?? ""} name="subject" required />
      </label>
      <label>
        Body
        <textarea
          defaultValue={proposal?.body ?? ""}
          name="body"
          required
          rows={proposal ? 16 : 8}
        />
      </label>
      {error ? <p className="formError">{error}</p> : null}
      <button className="button" disabled={pending} type="submit">
        {pending ? "Rendering preview…" : "Render exact draft preview"}
      </button>
    </form>
  );
}
