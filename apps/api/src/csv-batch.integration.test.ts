import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256 } from "@operating-layer/audit";
import { DevelopmentHeaderIdentityProvider } from "@operating-layer/auth";
import {
  assertSafeRuntimeDatabaseIdentity,
  createDatabasePool,
  withOrganizationScope,
  type DatabasePool,
} from "@operating-layer/db";
import {
  drainOutbox,
  processNextOutboxJob,
} from "@operating-layer/issue-intake";
import { buildApi } from "./server.js";

const controlOrgId = "10000000-0000-4000-8000-000000000001";
const csvOrgId = "10000000-0000-4000-8000-000000000002";
const csvOperatorId = "20000000-0000-4000-8000-000000000004";
const controlOperatorEmail = "operator@local.operating-layer";
const csvOperatorEmail = "fsi-operator@local.operating-layer";

describe("controlled CSV batch intake", () => {
  let adminPool: DatabasePool;
  let pool: DatabasePool;
  let app: Awaited<ReturnType<typeof buildApi>>;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL_TEST;
    const runtimeDatabaseUrl = process.env.DATABASE_URL_RUNTIME_TEST;
    if (!databaseUrl || !runtimeDatabaseUrl) {
      throw new Error(
        "DATABASE_URL_TEST and DATABASE_URL_RUNTIME_TEST are required",
      );
    }
    adminPool = createDatabasePool(databaseUrl);
    pool = createDatabasePool(runtimeDatabaseUrl);
    await assertSafeRuntimeDatabaseIdentity(pool);
    app = await buildApi({
      pool,
      identityProvider: new DevelopmentHeaderIdentityProvider(),
      logger: false,
    });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await adminPool.end();
  });

  it("imports mixed rows with immutable evidence, RLS, and two idempotency layers", async () => {
    const traceId = `trace-csv-${randomUUID()}`;
    const idempotencyKey = `csv-batch-${randomUUID()}`;
    const content = [
      "title,description,task_type,due_date,financial_exposure,financial_exposure_currency",
      "CSV overdue invoice,Collect the overdue receivable,collections,2026-07-20,25000,USD",
      "CSV vendor delay,Follow up on the delayed purchase order,procurement,2026-07-29,,",
      "Invalid empty description,,operations,2026-07-30,,",
    ].join("\n");
    const payload = {
      organizationId: csvOrgId,
      fileName: "controlled-issues.csv",
      content,
      sourceTimestamp: "2026-07-25T14:00:00.000Z",
      schemaVersion: "csv-issue.v1",
      retentionClassification: "operational",
    };

    const unauthorized = await app.inject({
      method: "POST",
      url: "/v1/csv-batches",
      headers: {
        "x-dev-user-email": controlOperatorEmail,
        "idempotency-key": `unauthorized-${randomUUID()}`,
      },
      payload,
    });
    expect(unauthorized.statusCode).toBe(403);

    const first = await app.inject({
      method: "POST",
      url: "/v1/csv-batches",
      headers: {
        "x-dev-user-email": csvOperatorEmail,
        "idempotency-key": idempotencyKey,
        "x-trace-id": traceId,
      },
      payload,
    });
    expect(first.statusCode, first.body).toBe(202);
    const firstBody = first.json<{
      batchId: string;
      sourceRecordId: string;
      checksum: string;
      duplicate: boolean;
      traceId: string;
      counts: {
        total: number;
        pending: number;
        accepted: number;
        rejected: number;
        failed: number;
      };
    }>();
    expect(firstBody).toMatchObject({
      checksum: sha256(content),
      duplicate: false,
      traceId,
      counts: {
        total: 3,
        pending: 2,
        accepted: 0,
        rejected: 1,
        failed: 0,
      },
    });

    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/csv-batches",
      headers: {
        "x-dev-user-email": csvOperatorEmail,
        "idempotency-key": idempotencyKey,
      },
      payload,
    });
    expect(duplicate.statusCode, duplicate.body).toBe(200);
    expect(duplicate.json()).toMatchObject({
      batchId: firstBody.batchId,
      sourceRecordId: firstBody.sourceRecordId,
      duplicate: true,
      counts: firstBody.counts,
    });

    const rawEvidence = await adminPool.query<{
      raw_content: Buffer;
      content_hash: string;
      checksum_algorithm: string;
      source_timestamp: Date;
      ingested_at: Date;
      source_identity: {
        fileName: string;
        importedByUserId: string;
      };
      schema_version: string;
      retention_classification: string;
      row_count: string;
      task_count: string;
      batch_audit_count: string;
    }>(
      `SELECT
         batch.raw_content,
         batch.content_hash,
         batch.checksum_algorithm,
         batch.source_timestamp,
         batch.ingested_at,
         batch.source_identity,
         batch.schema_version,
         batch.retention_classification,
         (
           SELECT count(*)::text
           FROM operating_layer.csv_batch_rows row
           WHERE row.batch_id = batch.id
         ) AS row_count,
         (
           SELECT count(*)::text
           FROM operating_layer.tasks task
           JOIN operating_layer.task_source_records source
             ON source.task_id = task.id
            AND source.organization_id = task.organization_id
           WHERE source.source_record_id = batch.source_record_id
         ) AS task_count,
         (
           SELECT count(*)::text
           FROM operating_layer.audit_events event
           WHERE event.organization_id = batch.organization_id
             AND event.event_type = 'csv.batch.imported'
             AND event.metadata ->> 'batchId' = batch.id::text
             AND batch.source_record_id = ANY(event.source_record_ids)
         ) AS batch_audit_count
       FROM operating_layer.csv_batches batch
       WHERE batch.id = $1`,
      [firstBody.batchId],
    );
    expect(rawEvidence.rows[0]).toMatchObject({
      content_hash: sha256(content),
      checksum_algorithm: "sha256",
      schema_version: "csv-issue.v1",
      retention_classification: "operational",
      row_count: "3",
      task_count: "0",
      batch_audit_count: "1",
    });
    expect(rawEvidence.rows[0]!.raw_content.toString("utf8")).toBe(content);
    expect(rawEvidence.rows[0]!.source_timestamp.toISOString()).toBe(
      payload.sourceTimestamp,
    );
    expect(rawEvidence.rows[0]!.ingested_at.toISOString()).toBeTruthy();
    expect(rawEvidence.rows[0]!.source_identity).toMatchObject({
      fileName: payload.fileName,
      importedByUserId: csvOperatorId,
    });

    await expect(
      adminPool.query(
        `UPDATE operating_layer.csv_batches
         SET raw_content = convert_to('tampered', 'UTF8')
         WHERE id = $1`,
        [firstBody.batchId],
      ),
    ).rejects.toThrow("immutable");

    const controlUser = await adminPool.query<{ id: string }>(
      `SELECT id FROM operating_layer.users WHERE email = $1`,
      [controlOperatorEmail],
    );
    const hiddenByRls = await withOrganizationScope(
      pool,
      { userId: controlUser.rows[0]!.id, organizationIds: [controlOrgId] },
      async (client) =>
        client.query("SELECT id FROM csv_batches WHERE id = $1", [
          firstBody.batchId,
        ]),
    );
    expect(hiddenByRls.rowCount).toBe(0);
    const unauthorizedRead = await app.inject({
      method: "GET",
      url: `/v1/csv-batches/${firstBody.batchId}?organizationId=${csvOrgId}`,
      headers: { "x-dev-user-email": controlOperatorEmail },
    });
    expect(unauthorizedRead.statusCode).toBe(403);

    const rowJobs = await adminPool.query<{
      id: string;
      row_number: number;
    }>(
      `SELECT job.id, row.row_number
       FROM operating_layer.outbox_events job
       JOIN operating_layer.csv_batch_rows row
         ON row.id = job.aggregate_id
       WHERE row.batch_id = $1
         AND job.topic = 'issue.csv-row'
       ORDER BY row.row_number`,
      [firstBody.batchId],
    );
    expect(rowJobs.rows).toHaveLength(2);
    const firstRowJob = rowJobs.rows[0]!;
    const secondRowJob = rowJobs.rows[1]!;
    await adminPool.query(
      `UPDATE operating_layer.outbox_events
       SET available_at = now() + interval '1 hour'
       WHERE id = $1`,
      [secondRowJob.id],
    );
    expect(await processNextOutboxJob(pool, "csv-row-worker")).toBe(
      "published",
    );

    const oneAccepted = await app.inject({
      method: "GET",
      url: `/v1/csv-batches/${firstBody.batchId}?organizationId=${csvOrgId}`,
      headers: { "x-dev-user-email": csvOperatorEmail },
    });
    expect(oneAccepted.statusCode, oneAccepted.body).toBe(200);
    expect(oneAccepted.json()).toMatchObject({
      counts: {
        total: 3,
        pending: 1,
        accepted: 1,
        rejected: 1,
        failed: 0,
      },
    });

    await adminPool.query(
      `UPDATE operating_layer.outbox_events
       SET status = 'pending', published_at = NULL, available_at = now()
       WHERE id = $1`,
      [firstRowJob.id],
    );
    expect(await processNextOutboxJob(pool, "csv-row-replay-worker")).toBe(
      "published",
    );
    const rowIdempotencyProof = await adminPool.query<{
      task_count: string;
      accepted_result_count: string;
      accepted_audit_count: string;
    }>(
      `SELECT
         (
           SELECT count(*)::text
           FROM operating_layer.tasks task
           JOIN operating_layer.task_source_records source
             ON source.task_id = task.id
            AND source.organization_id = task.organization_id
           JOIN operating_layer.csv_batches batch
             ON batch.source_record_id = source.source_record_id
           WHERE batch.id = $1
         ) AS task_count,
         (
           SELECT count(*)::text
           FROM operating_layer.csv_batch_row_results result
           JOIN operating_layer.csv_batch_rows row ON row.id = result.row_id
           WHERE row.batch_id = $1 AND result.status = 'accepted'
         ) AS accepted_result_count,
         (
           SELECT count(*)::text
           FROM operating_layer.audit_events event
           WHERE event.event_type = 'csv.row.accepted'
             AND event.metadata ->> 'batchId' = $1::text
         ) AS accepted_audit_count`,
      [firstBody.batchId],
    );
    expect(rowIdempotencyProof.rows[0]).toEqual({
      task_count: "1",
      accepted_result_count: "1",
      accepted_audit_count: "1",
    });

    await adminPool.query(
      `UPDATE operating_layer.outbox_events
       SET available_at = now()
       WHERE id = $1`,
      [secondRowJob.id],
    );
    const drained = await drainOutbox(pool, "csv-feature-worker");
    expect(drained.failed).toBe(0);
    expect(drained.deadLetter).toBe(0);

    const completed = await app.inject({
      method: "GET",
      url: `/v1/csv-batches/${firstBody.batchId}?organizationId=${csvOrgId}`,
      headers: { "x-dev-user-email": csvOperatorEmail },
    });
    const completedBody = completed.json<{
      counts: {
        total: number;
        pending: number;
        accepted: number;
        rejected: number;
        failed: number;
      };
      rows: Array<{
        rowNumber: number;
        status: string;
        taskId: string | null;
      }>;
    }>();
    expect(completedBody.counts).toEqual({
      total: 3,
      pending: 0,
      accepted: 2,
      rejected: 1,
      failed: 0,
    });
    const acceptedTasks = completedBody.rows
      .filter((row) => row.status === "accepted")
      .map((row) => row.taskId!);
    expect(new Set(acceptedTasks).size).toBe(2);

    const traceProof = await adminPool.query<{
      batch_trace: string;
      row_trace: string;
      result_trace: string;
      transition_trace: string;
      audit_trace: string;
      source_count: string;
      recommendation_source_count: string;
    }>(
      `SELECT
         batch.trace_id AS batch_trace,
         row_job.trace_id AS row_trace,
         row_result.trace_id AS result_trace,
         transition.trace_id AS transition_trace,
         intake_audit.trace_id AS audit_trace,
         (
           SELECT count(*)::text
           FROM operating_layer.task_source_records source
           WHERE source.task_id = row_result.task_id
             AND source.source_record_id = batch.source_record_id
         ) AS source_count,
         (
           SELECT count(*)::text
           FROM operating_layer.recommendations recommendation
           JOIN operating_layer.recommendation_sources source
             ON source.recommendation_id = recommendation.id
           WHERE recommendation.task_id = row_result.task_id
             AND source.source_record_id = batch.source_record_id
         ) AS recommendation_source_count
       FROM operating_layer.csv_batches batch
       JOIN operating_layer.csv_batch_rows row
         ON row.batch_id = batch.id
        AND row.row_number = 2
       JOIN operating_layer.outbox_events row_job
         ON row_job.aggregate_id = row.id
        AND row_job.topic = 'issue.csv-row'
       JOIN operating_layer.csv_batch_row_results row_result
         ON row_result.row_id = row.id
        AND row_result.status = 'accepted'
       JOIN operating_layer.workflow_transitions transition
         ON transition.workflow_id = row_result.workflow_id
        AND transition.to_state = 'classified'
       JOIN operating_layer.audit_events intake_audit
         ON intake_audit.workflow_id = row_result.workflow_id
        AND intake_audit.event_type = 'issue.intake.accepted'
       WHERE batch.id = $1`,
      [firstBody.batchId],
    );
    expect(traceProof.rows[0]).toMatchObject({
      batch_trace: traceId,
      row_trace: traceId,
      result_trace: traceId,
      transition_trace: traceId,
      audit_trace: traceId,
      source_count: "1",
      recommendation_source_count: "1",
    });
  });

  it("retries a downstream row failure, dead-letters it, and exposes it", async () => {
    const traceId = `trace-csv-failure-${randomUUID()}`;
    const upload = await app.inject({
      method: "POST",
      url: "/v1/csv-batches",
      headers: {
        "x-dev-user-email": csvOperatorEmail,
        "idempotency-key": `csv-failure-${randomUUID()}`,
        "x-trace-id": traceId,
      },
      payload: {
        organizationId: csvOrgId,
        fileName: "downstream-failure.csv",
        content:
          "title,description\nCSV downstream failure,This row loses its source projection after normalization",
        sourceTimestamp: "2026-07-25T15:00:00.000Z",
        schemaVersion: "csv-issue.v1",
        retentionClassification: "operational",
      },
    });
    expect(upload.statusCode, upload.body).toBe(202);
    const batch = upload.json<{
      batchId: string;
      sourceRecordId: string;
      sourceRecordVersionId: string;
    }>();

    expect(await processNextOutboxJob(pool, "csv-failure-worker")).toBe(
      "published",
    );
    const context = await adminPool.query<{
      task_id: string;
      workflow_id: string;
      classification_job_id: string;
    }>(
      `SELECT
         result.task_id,
         result.workflow_id,
         job.id AS classification_job_id
       FROM operating_layer.csv_batch_rows row
       JOIN operating_layer.csv_batch_row_results result
         ON result.row_id = row.id
        AND result.status = 'accepted'
       JOIN operating_layer.outbox_events job
         ON job.aggregate_id = result.workflow_id
        AND job.topic = 'issue.classify'
       WHERE row.batch_id = $1`,
      [batch.batchId],
    );
    const failure = context.rows[0]!;
    await adminPool.query(
      `UPDATE operating_layer.source_records
       SET latest_version_id = NULL
       WHERE id = $1`,
      [batch.sourceRecordId],
    );

    expect(await processNextOutboxJob(pool, "csv-failure-worker")).toBe(
      "failed",
    );
    await adminPool.query(
      `UPDATE operating_layer.outbox_events
       SET available_at = now()
       WHERE id = $1`,
      [failure.classification_job_id],
    );
    expect(await processNextOutboxJob(pool, "csv-failure-worker")).toBe(
      "failed",
    );
    await adminPool.query(
      `UPDATE operating_layer.outbox_events
       SET available_at = now()
       WHERE id = $1`,
      [failure.classification_job_id],
    );
    expect(await processNextOutboxJob(pool, "csv-failure-worker")).toBe(
      "dead_letter",
    );

    await adminPool.query(
      `UPDATE operating_layer.source_records
       SET latest_version_id = $2
       WHERE id = $1`,
      [batch.sourceRecordId, batch.sourceRecordVersionId],
    );

    const result = await app.inject({
      method: "GET",
      url: `/v1/csv-batches/${batch.batchId}?organizationId=${csvOrgId}`,
      headers: { "x-dev-user-email": csvOperatorEmail },
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({
      counts: {
        total: 1,
        pending: 0,
        accepted: 0,
        rejected: 0,
        failed: 1,
      },
      rows: [
        expect.objectContaining({
          status: "failed",
          taskId: failure.task_id,
          workflowId: failure.workflow_id,
          attempts: 3,
        }),
      ],
    });

    const failureProof = await adminPool.query<{
      current_state: string;
      task_status: string;
      outbox_status: string;
      outbox_trace: string;
      result_trace: string;
      audit_trace: string;
      failure_result_count: string;
      failure_audit_count: string;
    }>(
      `SELECT
         workflow.current_state,
         task.status AS task_status,
         job.status AS outbox_status,
         job.trace_id AS outbox_trace,
         result.trace_id AS result_trace,
         event.trace_id AS audit_trace,
         (
           SELECT count(*)::text
           FROM operating_layer.csv_batch_row_results candidate
           WHERE candidate.row_id = result.row_id
             AND candidate.status = 'failed'
         ) AS failure_result_count,
         (
           SELECT count(*)::text
           FROM operating_layer.audit_events candidate
           WHERE candidate.event_type = 'csv.row.failed'
             AND candidate.metadata ->> 'rowId' = result.row_id::text
         ) AS failure_audit_count
       FROM operating_layer.workflows workflow
       JOIN operating_layer.tasks task ON task.id = workflow.task_id
       JOIN operating_layer.outbox_events job ON job.id = $1
       JOIN operating_layer.csv_batch_row_results result
         ON result.workflow_id = workflow.id
        AND result.status = 'failed'
       JOIN operating_layer.audit_events event
         ON event.event_type = 'csv.row.failed'
        AND event.metadata ->> 'resultId' = result.id::text
       WHERE workflow.id = $2`,
      [failure.classification_job_id, failure.workflow_id],
    );
    expect(failureProof.rows[0]).toMatchObject({
      current_state: "failed",
      task_status: "failed",
      outbox_status: "dead_letter",
      outbox_trace: traceId,
      result_trace: traceId,
      audit_trace: traceId,
      failure_result_count: "1",
      failure_audit_count: "1",
    });

    const queue = await app.inject({
      method: "GET",
      url: `/v1/executive-queue?organizationId=${csvOrgId}`,
      headers: { "x-dev-user-email": csvOperatorEmail },
    });
    expect(queue.statusCode, queue.body).toBe(200);
    const queueBody = queue.json<{
      jobFailures: Array<{ id: string; topic: string; status: string }>;
    }>();
    expect(queueBody.jobFailures).toContainEqual(
      expect.objectContaining({
        id: failure.classification_job_id,
        topic: "issue.classify",
        status: "dead_letter",
      }),
    );
  });
});
