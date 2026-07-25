"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

export function ApprovalResolutionForm({
  approvalId,
  organizationId,
}: {
  approvalId: string;
  organizationId: string;
}) {
  const router = useRouter();
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);
  const [reason, setReason] = useState("");
  const [pendingDecision, setPendingDecision] = useState<
    "approved" | "rejected" | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  async function resolve(decision: "approved" | "rejected") {
    if (reason.trim().length < 3) {
      setError("Record a reason of at least three characters.");
      return;
    }
    setPendingDecision(decision);
    setError(null);
    try {
      const response = await fetch(
        `/api/approvals/${encodeURIComponent(approvalId)}/resolution`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `${idempotencyKey}:${decision}`,
          },
          body: JSON.stringify({
            organizationId,
            decision,
            reason: reason.trim(),
          }),
        },
      );
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(detail?.message ?? "Approval resolution failed.");
      }
      router.refresh();
    } catch (resolutionError) {
      setError(
        resolutionError instanceof Error
          ? resolutionError.message
          : "Approval resolution failed.",
      );
    } finally {
      setPendingDecision(null);
    }
  }

  return (
    <div className="approvalResolutionForm">
      <label htmlFor={`approval-reason-${approvalId}`}>Decision reason</label>
      <textarea
        id={`approval-reason-${approvalId}`}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        rows={3}
        maxLength={2000}
        placeholder="Record the facts supporting this decision."
      />
      {error ? <p className="formError">{error}</p> : null}
      <div className="formActions">
        <button
          className="button"
          disabled={pendingDecision !== null}
          onClick={() => void resolve("approved")}
          type="button"
        >
          {pendingDecision === "approved" ? "Approving…" : "Approve internally"}
        </button>
        <button
          className="button secondary"
          disabled={pendingDecision !== null}
          onClick={() => void resolve("rejected")}
          type="button"
        >
          {pendingDecision === "rejected" ? "Rejecting…" : "Reject"}
        </button>
      </div>
    </div>
  );
}
