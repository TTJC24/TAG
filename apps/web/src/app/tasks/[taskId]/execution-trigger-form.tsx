"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

export function ExecutionTriggerForm({
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

  async function triggerExecution() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/approvals/${encodeURIComponent(approvalId)}/executions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify({ organizationId }),
        },
      );
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(detail?.message ?? "Execution request failed.");
      }
      router.refresh();
    } catch (executionError) {
      setError(
        executionError instanceof Error
          ? executionError.message
          : "Execution request failed.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="executionTriggerForm">
      <p>
        This records the recommended action internally. It cannot contact an
        external system.
      </p>
      {error ? <p className="formError">{error}</p> : null}
      <button
        className="button"
        disabled={pending}
        onClick={() => void triggerExecution()}
        type="button"
      >
        {pending ? "Queueing execution…" : "Execute internally"}
      </button>
    </div>
  );
}
