"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

interface Organization {
  id: string;
  name: string;
  code: string;
}

export function CsvBatchUploadForm({
  organizations,
  initialOrganizationId,
}: {
  organizations: Organization[];
  initialOrganizationId: string;
}) {
  const router = useRouter();
  const idempotencyKey = useRef<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    const organizationId = String(data.get("organizationId"));
    const file = data.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setError("Choose a non-empty CSV file.");
      setSubmitting(false);
      return;
    }
    if (file.size > 1_000_000) {
      setError("CSV files are limited to 1 MB in this controlled slice.");
      setSubmitting(false);
      return;
    }
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setError("The uploaded file must use a .csv extension.");
      setSubmitting(false);
      return;
    }
    idempotencyKey.current ??= crypto.randomUUID();

    try {
      const response = await fetch("/api/csv-batches", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey.current,
        },
        body: JSON.stringify({
          organizationId,
          fileName: file.name,
          content: await file.text(),
          sourceTimestamp: new Date(file.lastModified).toISOString(),
          schemaVersion: "csv-issue.v1",
          retentionClassification: String(data.get("retentionClassification")),
        }),
      });
      const result = (await response.json()) as {
        batchId?: string;
        message?: string;
      };
      if (!response.ok || !result.batchId) {
        throw new Error(result.message ?? "CSV batch upload failed");
      }
      router.push(
        `/csv-batches/${result.batchId}?organizationId=${encodeURIComponent(
          organizationId,
        )}`,
      );
      router.refresh();
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "CSV batch upload failed",
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
              {organization.code} - {organization.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        CSV file
        <input
          accept=".csv,text/csv"
          name="file"
          onChange={() => {
            idempotencyKey.current = null;
          }}
          required
          type="file"
        />
      </label>
      <div className="csvSchema">
        <strong>Required columns</strong>
        <code>title,description</code>
        <strong>Optional columns</strong>
        <code>
          task_type,due_date,financial_exposure, financial_exposure_currency
        </code>
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
        <strong>Internal upload only</strong>
        <p>
          This stores an immutable raw CSV and creates internal tasks. It is not
          a connector and cannot write to an external system.
        </p>
      </div>
      {error ? <p className="formError">{error}</p> : null}
      <div className="formActions">
        <button className="button" disabled={submitting} type="submit">
          {submitting ? "Validating and queuing..." : "Upload controlled batch"}
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
