"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

interface Organization {
  id: string;
  name: string;
  code: string;
}

export function IssueForm({
  organizations,
  initialOrganizationId,
}: {
  organizations: Organization[];
  initialOrganizationId: string;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    const organizationId = String(data.get("organizationId"));
    const exposureText = String(data.get("financialExposure") ?? "").trim();
    const body = {
      organizationId,
      title: String(data.get("title")),
      description: String(data.get("description")),
      dueDate: String(data.get("dueDate") ?? "") || undefined,
      financialExposure: exposureText
        ? Number.parseFloat(exposureText)
        : undefined,
      financialExposureCurrency: exposureText ? "USD" : undefined,
      retentionClassification: String(data.get("retentionClassification")),
    };

    try {
      const response = await fetch("/api/issues", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as {
        taskId?: string;
        message?: string;
      };
      if (!response.ok || !result.taskId) {
        throw new Error(result.message ?? "Issue intake failed");
      }
      router.push(
        `/tasks/${result.taskId}?organizationId=${encodeURIComponent(
          organizationId,
        )}`,
      );
      router.refresh();
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "Issue intake failed",
      );
      setSubmitting(false);
    }
  }

  return (
    <form className="issueForm panel" onSubmit={submit}>
      <label>
        Organization
        <select
          defaultValue={initialOrganizationId}
          name="organizationId"
          required
        >
          {organizations.map((organization) => (
            <option key={organization.id} value={organization.id}>
              {organization.code} — {organization.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Issue title
        <input
          maxLength={200}
          minLength={3}
          name="title"
          placeholder="High-value receivable needs follow-up"
          required
        />
      </label>
      <label>
        What is happening?
        <textarea
          maxLength={10_000}
          minLength={3}
          name="description"
          placeholder="Include the known facts, blocker, prior follow-up, and desired outcome."
          required
          rows={7}
        />
      </label>
      <div className="formGrid">
        <label>
          Due date
          <input name="dueDate" type="date" />
        </label>
        <label>
          Financial exposure (USD)
          <input min="0" name="financialExposure" step="0.01" type="number" />
        </label>
      </div>
      <label>
        Retention classification
        <select defaultValue="operational" name="retentionClassification">
          <option value="operational">Operational</option>
          <option value="financial_support">Financial support</option>
          <option value="transient">Transient</option>
          <option value="legal_hold">Legal hold</option>
        </select>
      </label>
      <div className="controlNotice">
        <strong>Control boundary</strong>
        <p>
          This creates internal operating-layer records only. It cannot write to
          ERP, accounting, CRM, email, or external systems.
        </p>
      </div>
      {error ? <p className="formError">{error}</p> : null}
      <div className="formActions">
        <button className="button" disabled={submitting} type="submit">
          {submitting ? "Creating controlled workflow…" : "Create issue"}
        </button>
        <button
          className="button secondary"
          onClick={() => router.back()}
          type="button"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
