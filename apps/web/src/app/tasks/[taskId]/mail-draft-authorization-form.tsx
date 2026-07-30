"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

export function MailDraftAuthorizationForm({
  previewId,
  organizationId,
}: {
  previewId: string;
  organizationId: string;
}) {
  const router = useRouter();
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);
  const [pending, setPending] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function authorize() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/mail-draft-previews/${encodeURIComponent(previewId)}/authorization`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify({ organizationId, reason }),
        },
      );
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(detail?.message ?? "Draft authorization failed.");
      }
      router.refresh();
    } catch (authorizationError) {
      setError(
        authorizationError instanceof Error
          ? authorizationError.message
          : "Draft authorization failed.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="approvalResolutionForm">
      <label>
        Authorization reason
        <textarea
          onChange={(event) => setReason(event.target.value)}
          required
          rows={3}
          value={reason}
        />
      </label>
      {error ? <p className="formError">{error}</p> : null}
      <button
        className="button"
        disabled={pending || reason.trim().length < 3}
        onClick={() => void authorize()}
        type="button"
      >
        {pending ? "Authorizing…" : "Authorize Outlook draft creation"}
      </button>
    </div>
  );
}
