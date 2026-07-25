"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

export function GmailDraftPreviewForm({
  approvalId,
  organizationId,
}: {
  approvalId: string;
  organizationId: string;
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
      <label>
        Recipient
        <input name="to" required type="email" />
      </label>
      <label>
        Subject
        <input name="subject" required />
      </label>
      <label>
        Body
        <textarea name="body" required rows={8} />
      </label>
      {error ? <p className="formError">{error}</p> : null}
      <button className="button" disabled={pending} type="submit">
        {pending ? "Rendering preview…" : "Render exact draft preview"}
      </button>
    </form>
  );
}
