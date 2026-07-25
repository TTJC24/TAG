import Link from "next/link";
import { operatingLayerApi } from "../../../lib/api";
import { BatchResultRefresh } from "./refresh";

export const dynamic = "force-dynamic";

interface CsvBatchResult {
  batchId: string;
  organizationId: string;
  fileName: string;
  checksum: string;
  sourceTimestamp: string;
  ingestedAt: string;
  schemaVersion: string;
  retentionClassification: string;
  traceId: string;
  counts: {
    total: number;
    pending: number;
    accepted: number;
    rejected: number;
    failed: number;
  };
  rows: Array<{
    rowId: string;
    rowNumber: number;
    status: "pending" | "accepted" | "rejected" | "failed";
    rejectionReasons: string[];
    taskId: string | null;
    safeErrorMessage: string | null;
    attempts: number;
  }>;
}

export default async function CsvBatchResultPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<{ organizationId?: string }>;
}) {
  const [{ batchId }, query] = await Promise.all([params, searchParams]);
  if (!query.organizationId) {
    throw new Error("organizationId is required");
  }
  const organizationId = query.organizationId;
  const batch = await operatingLayerApi<CsvBatchResult>(
    `/v1/csv-batches/${batchId}?organizationId=${encodeURIComponent(
      organizationId,
    )}`,
  );

  return (
    <div className="pageStack">
      <BatchResultRefresh pending={batch.counts.pending} />
      <nav className="breadcrumb">
        <Link href={`/?organizationId=${organizationId}`}>Executive queue</Link>
        <span>/</span>
        <Link href={`/csv-batches/new?organizationId=${organizationId}`}>
          CSV intake
        </Link>
      </nav>
      <section className="pageHeading">
        <div>
          <p className="eyebrow">CSV batch result</p>
          <h1>{batch.fileName}</h1>
          <p className="lede">
            Immutable source checksum <code>{batch.checksum}</code>
          </p>
        </div>
      </section>
      <section className="metricGrid batchMetrics">
        {Object.entries(batch.counts).map(([label, value]) => (
          <article
            className={
              label === "failed" && value > 0
                ? "danger"
                : label === "rejected" && value > 0
                  ? "warn"
                  : ""
            }
            key={label}
          >
            <span>{label}</span>
            <strong>{value}</strong>
          </article>
        ))}
      </section>
      <section className="panel">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">Immutable source</p>
            <h2>Batch metadata</h2>
          </div>
        </div>
        <dl className="batchMetadata">
          <div>
            <dt>Source timestamp</dt>
            <dd>{batch.sourceTimestamp}</dd>
          </div>
          <div>
            <dt>Ingested</dt>
            <dd>{batch.ingestedAt}</dd>
          </div>
          <div>
            <dt>Schema</dt>
            <dd>{batch.schemaVersion}</dd>
          </div>
          <div>
            <dt>Retention</dt>
            <dd>{batch.retentionClassification}</dd>
          </div>
          <div>
            <dt>Trace</dt>
            <dd>{batch.traceId}</dd>
          </div>
        </dl>
      </section>
      <section className="panel">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">Per-row outcome</p>
            <h2>Rows</h2>
          </div>
        </div>
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Row</th>
                <th>Status</th>
                <th>Result</th>
                <th>Attempts</th>
              </tr>
            </thead>
            <tbody>
              {batch.rows.map((row) => (
                <tr key={row.rowId}>
                  <td>{row.rowNumber}</td>
                  <td>
                    <span className={`status ${row.status}`}>{row.status}</span>
                  </td>
                  <td className="issueCell">
                    {row.status === "failed" && row.safeErrorMessage ? (
                      <>
                        <small>{row.safeErrorMessage}</small>
                        {row.taskId ? (
                          <>
                            {" "}
                            <Link
                              href={`/tasks/${row.taskId}?organizationId=${organizationId}`}
                            >
                              Open failed task
                            </Link>
                          </>
                        ) : null}
                      </>
                    ) : row.taskId ? (
                      <Link
                        href={`/tasks/${row.taskId}?organizationId=${organizationId}`}
                      >
                        Open created task
                      </Link>
                    ) : row.rejectionReasons.length > 0 ? (
                      <small>{row.rejectionReasons.join("; ")}</small>
                    ) : row.safeErrorMessage ? (
                      <small>{row.safeErrorMessage}</small>
                    ) : (
                      <small>Queued through the existing issue pipeline</small>
                    )}
                  </td>
                  <td>{row.attempts || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
