import { randomUUID } from "node:crypto";
import { appendAuditEvent, sha256 } from "@operating-layer/audit";
import {
  withOrganizationScope,
  type DatabaseClient,
  type DatabasePool,
} from "@operating-layer/db";
import {
  csvBatchResultSchema,
  csvBatchUploadInputSchema,
  csvIssueRowSchema,
  manualIssueInputSchema,
  type CsvBatchResult,
  type CsvBatchUploadInput,
  type ManualIssueInput,
} from "@operating-layer/schemas";
import { DomainError } from "./errors.js";
import {
  claimIdempotentCommand,
  completeIdempotentCommand,
  ensureIdempotencyKey,
} from "./idempotency.js";
import {
  requireOrganizationPermission,
  type ApplicationPrincipal,
} from "./identity.js";
import { createNormalizedIssueFromSource } from "./intake.js";
import type { RequestContext } from "./service.js";

const REQUIRED_HEADERS = ["title", "description"] as const;
const ALLOWED_HEADERS = [
  ...REQUIRED_HEADERS,
  "task_type",
  "due_date",
  "financial_exposure",
  "financial_exposure_currency",
] as const;
const ALLOWED_HEADER_SET = new Set<string>(ALLOWED_HEADERS);

interface ParsedRecord {
  rowNumber: number;
  fields: string[];
  syntaxErrors: string[];
}

export interface ParsedCsvIssueRow {
  rowNumber: number;
  rawValues: Record<string, string | string[]>;
  normalizedInput: ManualIssueInput | null;
  rejectionReasons: string[];
  inputHash: string;
}

export interface ParsedCsvBatch {
  headers: string[];
  rows: ParsedCsvIssueRow[];
}

function tokenizeCsv(content: string): ParsedRecord[] {
  const input = content.replace(/^\uFEFF/, "");
  const records: ParsedRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let recordStartLine = 1;
  let line = 1;
  let syntaxErrors: string[] = [];

  function finishRecord(): void {
    fields.push(field);
    const isEmpty = fields.every((value) => value === "");
    if (!isEmpty || records.length === 0) {
      records.push({
        rowNumber: recordStartLine,
        fields,
        syntaxErrors,
      });
    }
    fields = [];
    field = "";
    syntaxErrors = [];
    recordStartLine = line + 1;
  }

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (character === '"') {
      if (inQuotes && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (inQuotes) {
        inQuotes = false;
      } else if (field.length === 0) {
        inQuotes = true;
      } else {
        syntaxErrors.push("Unexpected quote in an unquoted field");
        field += character;
      }
      continue;
    }

    if (!inQuotes && character === ",") {
      fields.push(field);
      field = "";
      continue;
    }

    if (character === "\n") {
      if (inQuotes) {
        field += "\n";
        line += 1;
      } else {
        finishRecord();
        line += 1;
      }
      continue;
    }

    if (character === "\r") {
      if (inQuotes) {
        field += "\r";
      } else if (input[index + 1] !== "\n") {
        finishRecord();
        line += 1;
      }
      continue;
    }

    field += character;
  }

  if (inQuotes) {
    syntaxErrors.push("Unclosed quoted field");
  }
  if (field.length > 0 || fields.length > 0 || records.length === 0) {
    finishRecord();
  }
  return records;
}

function issueMessages(
  issues: readonly { path: PropertyKey[]; message: string }[],
): string[] {
  return issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return `${path}${issue.message}`;
  });
}

export function parseCsvIssueBatch(input: CsvBatchUploadInput): ParsedCsvBatch {
  const records = tokenizeCsv(input.content);
  const headerRecord = records[0];
  if (!headerRecord) {
    throw new DomainError(400, "csv_header_missing", "CSV header is required");
  }
  if (headerRecord.syntaxErrors.length > 0) {
    throw new DomainError(
      400,
      "csv_header_invalid",
      headerRecord.syntaxErrors.join("; "),
    );
  }

  const headers = headerRecord.fields.map((header) =>
    header.trim().toLowerCase(),
  );
  if (new Set(headers).size !== headers.length) {
    throw new DomainError(
      400,
      "csv_header_duplicate",
      "CSV headers must be unique",
    );
  }
  const unsupported = headers.filter(
    (header) => !ALLOWED_HEADER_SET.has(header),
  );
  if (unsupported.length > 0) {
    throw new DomainError(
      400,
      "csv_header_unsupported",
      `Unsupported CSV headers: ${unsupported.join(", ")}`,
    );
  }
  const missing = REQUIRED_HEADERS.filter(
    (header) => !headers.includes(header),
  );
  if (missing.length > 0) {
    throw new DomainError(
      400,
      "csv_header_required",
      `Missing required CSV headers: ${missing.join(", ")}`,
    );
  }

  const rows = records.slice(1).map<ParsedCsvIssueRow>((record) => {
    const rawValues: Record<string, string | string[]> = Object.fromEntries(
      headers.map((header, index) => [header, record.fields[index] ?? ""]),
    );
    if (record.fields.length > headers.length) {
      rawValues.__extra = record.fields.slice(headers.length);
    }
    const rejectionReasons = [...record.syntaxErrors];
    if (record.fields.length !== headers.length) {
      rejectionReasons.push(
        `Expected ${headers.length} columns but received ${record.fields.length}`,
      );
    }

    const candidate = {
      title: String(rawValues.title ?? ""),
      description: String(rawValues.description ?? ""),
      taskType: String(rawValues.task_type ?? ""),
      dueDate: String(rawValues.due_date ?? ""),
      financialExposure: String(rawValues.financial_exposure ?? ""),
      financialExposureCurrency: String(
        rawValues.financial_exposure_currency ?? "",
      ),
    };
    const parsed = csvIssueRowSchema.safeParse(candidate);
    if (!parsed.success) {
      rejectionReasons.push(...issueMessages(parsed.error.issues));
    }

    const normalizedInput =
      rejectionReasons.length === 0 && parsed.success
        ? manualIssueInputSchema.parse({
            organizationId: input.organizationId,
            ...parsed.data,
            retentionClassification: input.retentionClassification,
          })
        : null;

    return {
      rowNumber: record.rowNumber,
      rawValues,
      normalizedInput,
      rejectionReasons: [...new Set(rejectionReasons)],
      inputHash: sha256({
        rowNumber: record.rowNumber,
        rawValues,
      }),
    };
  });

  if (rows.length === 0) {
    throw new DomainError(
      400,
      "csv_rows_required",
      "CSV must contain at least one data row",
    );
  }
  return { headers, rows };
}

interface BatchIdentityResponse {
  batchId: string;
}

export interface UploadCsvBatchCommand {
  principal: ApplicationPrincipal;
  input: CsvBatchUploadInput;
  idempotencyKey: string;
  context: RequestContext;
}

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

async function loadCsvBatchResult(
  client: DatabaseClient,
  organizationId: string,
  batchId: string,
  duplicate: boolean,
): Promise<CsvBatchResult> {
  const batchResult = await client.query<{
    id: string;
    organization_id: string;
    original_filename: string;
    content_hash: string;
    source_timestamp: Date | string;
    ingested_at: Date | string;
    schema_version: "csv-issue.v1";
    retention_classification: string;
    source_record_id: string;
    source_record_version_id: string;
    trace_id: string;
  }>(
    `SELECT
       id,
       organization_id,
       original_filename,
       content_hash,
       source_timestamp,
       ingested_at,
       schema_version,
       retention_classification,
       source_record_id,
       source_record_version_id,
       trace_id
     FROM csv_batches
     WHERE id = $1
       AND organization_id = $2`,
    [batchId, organizationId],
  );
  const batch = batchResult.rows[0];
  if (!batch) {
    throw new DomainError(404, "csv_batch_not_found", "CSV batch not found");
  }

  const rowsResult = await client.query<{
    row_id: string;
    row_number: number;
    validation_status: "valid" | "rejected";
    rejection_reasons: unknown;
    accepted_task_id: string | null;
    accepted_workflow_id: string | null;
    accepted_attempts: number | null;
    failed_task_id: string | null;
    failed_workflow_id: string | null;
    failed_attempts: number | null;
    safe_error_message: string | null;
  }>(
    `SELECT
       row.id AS row_id,
       row.row_number,
       row.validation_status,
       row.rejection_reasons,
       accepted.task_id AS accepted_task_id,
       accepted.workflow_id AS accepted_workflow_id,
       accepted.attempts AS accepted_attempts,
       failed.task_id AS failed_task_id,
       failed.workflow_id AS failed_workflow_id,
       failed.attempts AS failed_attempts,
       failed.safe_error_message
     FROM csv_batch_rows row
     LEFT JOIN csv_batch_row_results accepted
       ON accepted.row_id = row.id
      AND accepted.organization_id = row.organization_id
      AND accepted.status = 'accepted'
     LEFT JOIN csv_batch_row_results failed
       ON failed.row_id = row.id
      AND failed.organization_id = row.organization_id
      AND failed.status = 'failed'
     WHERE row.batch_id = $1
       AND row.organization_id = $2
     ORDER BY row.row_number`,
    [batchId, organizationId],
  );

  const rows = rowsResult.rows.map((row) => {
    const status =
      row.validation_status === "rejected"
        ? ("rejected" as const)
        : row.failed_attempts !== null
          ? ("failed" as const)
          : row.accepted_attempts !== null
            ? ("accepted" as const)
            : ("pending" as const);
    return {
      rowId: row.row_id,
      rowNumber: row.row_number,
      status,
      rejectionReasons: Array.isArray(row.rejection_reasons)
        ? row.rejection_reasons.map(String)
        : [],
      taskId: row.failed_task_id ?? row.accepted_task_id,
      workflowId: row.failed_workflow_id ?? row.accepted_workflow_id,
      safeErrorMessage: row.safe_error_message,
      attempts: row.failed_attempts ?? row.accepted_attempts ?? 0,
    };
  });

  const counts = {
    total: rows.length,
    pending: rows.filter((row) => row.status === "pending").length,
    accepted: rows.filter((row) => row.status === "accepted").length,
    rejected: rows.filter((row) => row.status === "rejected").length,
    failed: rows.filter((row) => row.status === "failed").length,
  };

  return csvBatchResultSchema.parse({
    batchId: batch.id,
    organizationId: batch.organization_id,
    fileName: batch.original_filename,
    checksum: batch.content_hash,
    sourceTimestamp: toIso(batch.source_timestamp),
    ingestedAt: toIso(batch.ingested_at),
    schemaVersion: batch.schema_version,
    retentionClassification: batch.retention_classification,
    sourceRecordId: batch.source_record_id,
    sourceRecordVersionId: batch.source_record_version_id,
    duplicate,
    traceId: batch.trace_id,
    counts,
    rows,
  });
}

export async function uploadCsvBatch(
  pool: DatabasePool,
  command: UploadCsvBatchCommand,
): Promise<CsvBatchResult> {
  const input = csvBatchUploadInputSchema.parse(command.input);
  requireOrganizationPermission(
    command.principal,
    input.organizationId,
    "csv_batches.create",
  );
  const idempotencyKey = ensureIdempotencyKey(command.idempotencyKey);
  const parsed = parseCsvIssueBatch(input);
  const contentHash = sha256(input.content);
  const requestHash = sha256({
    organizationId: input.organizationId,
    fileName: input.fileName,
    contentHash,
    sourceTimestamp: input.sourceTimestamp,
    schemaVersion: input.schemaVersion,
    retentionClassification: input.retentionClassification,
  });

  return withOrganizationScope(
    pool,
    {
      userId: command.principal.userId,
      organizationIds: [input.organizationId],
    },
    async (client) => {
      const claim = await claimIdempotentCommand<BatchIdentityResponse>(
        client,
        {
          organizationId: input.organizationId,
          scope: "csv_batch_upload",
          idempotencyKey,
          requestHash,
        },
      );
      if (claim.kind === "replay") {
        return loadCsvBatchResult(
          client,
          input.organizationId,
          claim.response.batchId,
          true,
        );
      }

      const sourceSystemResult = await client.query<{ id: string }>(
        `SELECT id
         FROM source_systems
         WHERE organization_id = $1
           AND type = 'csv_upload'
           AND connection_status = 'healthy'
         LIMIT 1`,
        [input.organizationId],
      );
      const sourceSystemId = sourceSystemResult.rows[0]?.id;
      if (!sourceSystemId) {
        throw new DomainError(
          503,
          "csv_source_unavailable",
          "Controlled CSV upload is not configured for this organization",
        );
      }

      const batchId = randomUUID();
      const sourceRecordId = randomUUID();
      const sourceVersionId = randomUUID();
      const now = new Date().toISOString();
      const validRows = parsed.rows.filter(
        (row) => row.normalizedInput !== null,
      );
      const rejectedRows = parsed.rows.filter(
        (row) => row.normalizedInput === null,
      );
      const externalId = `csv-batch:${batchId}`;
      const sourceIdentity = {
        sourceSystemId,
        externalId,
        fileName: input.fileName,
        importedByUserId: command.principal.userId,
      };

      await client.query(
        `INSERT INTO source_records (
           id,
           source_system_id,
           organization_id,
           external_id,
           record_type,
           last_synced_at
         )
         VALUES ($1, $2, $3, $4, 'csv_batch', $5)`,
        [sourceRecordId, sourceSystemId, input.organizationId, externalId, now],
      );

      await client.query(
        `INSERT INTO source_record_versions (
           id,
           source_record_id,
           organization_id,
           content_hash,
           raw_payload_reference,
           normalized_payload,
           observed_at,
           source_updated_at,
           checksum_algorithm,
           source_identity,
           schema_version,
           retention_classification,
           ingested_at
         )
         VALUES (
           $1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'sha256', $9::jsonb,
           $10, $11, $7
         )`,
        [
          sourceVersionId,
          sourceRecordId,
          input.organizationId,
          contentHash,
          `postgresql://operating_layer/csv_batches/${batchId}/raw_content`,
          JSON.stringify({
            batchId,
            fileName: input.fileName,
            headers: parsed.headers,
            totalRows: parsed.rows.length,
          }),
          now,
          input.sourceTimestamp,
          JSON.stringify(sourceIdentity),
          input.schemaVersion,
          input.retentionClassification,
        ],
      );

      await client.query(
        `UPDATE source_records
         SET latest_version_id = $2, source_updated_at = $3,
             last_synced_at = $4, updated_at = $4
         WHERE id = $1
           AND organization_id = $5`,
        [
          sourceRecordId,
          sourceVersionId,
          input.sourceTimestamp,
          now,
          input.organizationId,
        ],
      );

      await client.query(
        `INSERT INTO csv_batches (
           id,
           organization_id,
           source_system_id,
           source_record_id,
           source_record_version_id,
           original_filename,
           raw_content,
           content_hash,
           source_timestamp,
           ingested_at,
           source_identity,
           schema_version,
           retention_classification,
           imported_by_user_id,
           idempotency_key,
           trace_id,
           request_id,
           total_rows,
           valid_rows,
           rejected_rows
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12,
           $13, $14, $15, $16, $17, $18, $19, $20
         )`,
        [
          batchId,
          input.organizationId,
          sourceSystemId,
          sourceRecordId,
          sourceVersionId,
          input.fileName,
          Buffer.from(input.content, "utf8"),
          contentHash,
          input.sourceTimestamp,
          now,
          JSON.stringify(sourceIdentity),
          input.schemaVersion,
          input.retentionClassification,
          command.principal.userId,
          idempotencyKey,
          command.context.traceId,
          command.context.requestId,
          parsed.rows.length,
          validRows.length,
          rejectedRows.length,
        ],
      );

      await appendAuditEvent(client, {
        organizationId: input.organizationId,
        actorType: "user",
        actorId: command.principal.userId,
        eventType: "csv.batch.imported",
        sourceRecordIds: [sourceRecordId],
        inputHash: contentHash,
        outputHash: sha256({
          batchId,
          totalRows: parsed.rows.length,
          validRows: validRows.length,
          rejectedRows: rejectedRows.length,
        }),
        traceId: command.context.traceId,
        requestId: command.context.requestId,
        metadata: {
          batchId,
          sourceRecordId,
          sourceVersionId,
          fileName: input.fileName,
          checksum: contentHash,
          sourceTimestamp: input.sourceTimestamp,
          ingestedAt: now,
          schemaVersion: input.schemaVersion,
          retentionClassification: input.retentionClassification,
          totalRows: parsed.rows.length,
          validRows: validRows.length,
          rejectedRows: rejectedRows.length,
        },
        occurredAt: now,
      });

      for (const row of parsed.rows) {
        const rowId = randomUUID();
        const rowIdempotencyKey = `${batchId}:row:${row.rowNumber}`;
        await client.query(
          `INSERT INTO csv_batch_rows (
             id,
             organization_id,
             batch_id,
             row_number,
             row_idempotency_key,
             raw_values,
             normalized_input,
             input_hash,
             validation_status,
             rejection_reasons
           )
           VALUES (
             $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10::jsonb
           )`,
          [
            rowId,
            input.organizationId,
            batchId,
            row.rowNumber,
            rowIdempotencyKey,
            JSON.stringify(row.rawValues),
            row.normalizedInput === null
              ? null
              : JSON.stringify(row.normalizedInput),
            row.inputHash,
            row.normalizedInput === null ? "rejected" : "valid",
            JSON.stringify(row.rejectionReasons),
          ],
        );

        if (row.normalizedInput === null) {
          await appendAuditEvent(client, {
            organizationId: input.organizationId,
            actorType: "user",
            actorId: command.principal.userId,
            eventType: "csv.row.rejected",
            sourceRecordIds: [sourceRecordId],
            inputHash: row.inputHash,
            outputHash: sha256(row.rejectionReasons),
            traceId: command.context.traceId,
            requestId: command.context.requestId,
            metadata: {
              batchId,
              rowId,
              rowNumber: row.rowNumber,
              rejectionReasons: row.rejectionReasons,
            },
            occurredAt: now,
          });
          continue;
        }

        await client.query(
          `INSERT INTO outbox_events (
             organization_id,
             topic,
             aggregate_type,
             aggregate_id,
             payload_reference,
             payload_hash,
             idempotency_key,
             trace_id,
             requested_by_user_id,
             request_id,
             max_attempts
           )
           VALUES (
             $1, 'issue.csv-row', 'csv_batch_row', $2, $3, $4, $5, $6,
             $7, $8, 3
           )`,
          [
            input.organizationId,
            rowId,
            `postgresql://operating_layer/csv_batch_rows/${rowId}`,
            row.inputHash,
            rowIdempotencyKey,
            command.context.traceId,
            command.principal.userId,
            command.context.requestId,
          ],
        );
      }

      await completeIdempotentCommand(client, {
        organizationId: input.organizationId,
        scope: "csv_batch_upload",
        idempotencyKey,
        requestHash,
        response: { batchId },
      });

      return loadCsvBatchResult(client, input.organizationId, batchId, false);
    },
  );
}

export async function getCsvBatch(
  pool: DatabasePool,
  principal: ApplicationPrincipal,
  organizationId: string,
  batchId: string,
): Promise<CsvBatchResult> {
  requireOrganizationPermission(principal, organizationId, "csv_batches.read");
  return withOrganizationScope(
    pool,
    { userId: principal.userId, organizationIds: [organizationId] },
    (client) => loadCsvBatchResult(client, organizationId, batchId, false),
  );
}

export interface CsvRowOutboxJob {
  id: string;
  organization_id: string;
  topic: string;
  aggregate_id: string;
  idempotency_key: string;
  trace_id: string;
  requested_by_user_id: string;
  request_id: string;
  attempts: number;
  max_attempts: number;
}

export async function processCsvBatchRow(
  client: DatabaseClient,
  job: CsvRowOutboxJob,
): Promise<void> {
  const rowResult = await client.query<{
    row_id: string;
    batch_id: string;
    row_number: number;
    row_idempotency_key: string;
    normalized_input: unknown;
    input_hash: string;
    source_record_id: string;
    source_record_version_id: string;
    content_hash: string;
    existing_result_id: string | null;
  }>(
    `SELECT
       row.id AS row_id,
       row.batch_id,
       row.row_number,
       row.row_idempotency_key,
       row.normalized_input,
       row.input_hash,
       batch.source_record_id,
       batch.source_record_version_id,
       batch.content_hash,
       result.id AS existing_result_id
     FROM csv_batch_rows row
     JOIN csv_batches batch
       ON batch.id = row.batch_id
      AND batch.organization_id = row.organization_id
     LEFT JOIN csv_batch_row_results result
       ON result.row_id = row.id
      AND result.organization_id = row.organization_id
     WHERE row.id = $1
       AND row.organization_id = $2
       AND row.validation_status = 'valid'`,
    [job.aggregate_id, job.organization_id],
  );
  const row = rowResult.rows[0];
  if (!row) {
    throw new Error("Valid CSV batch row was not found");
  }
  if (row.existing_result_id) {
    await client.query(
      `UPDATE outbox_events
       SET status = 'published', published_at = now(), locked_at = NULL,
           locked_by = NULL, last_error_code = NULL,
           safe_error_message = NULL
       WHERE id = $1
         AND organization_id = $2`,
      [job.id, job.organization_id],
    );
    return;
  }

  const input = manualIssueInputSchema.parse(row.normalized_input);
  const claim = await claimIdempotentCommand<{
    taskId: string;
    workflowId: string;
  }>(client, {
    organizationId: job.organization_id,
    scope: `csv_batch_row:${row.batch_id}`,
    idempotencyKey: row.row_idempotency_key,
    requestHash: row.input_hash,
  });
  if (claim.kind === "replay") {
    throw new Error("CSV row idempotency replay has no immutable row result");
  }

  const issue = await createNormalizedIssueFromSource({
    client,
    input,
    principalUserId: job.requested_by_user_id,
    idempotencyKey: row.row_idempotency_key,
    requestHash: row.input_hash,
    context: {
      traceId: job.trace_id,
      requestId: job.request_id,
    },
    source: {
      sourceRecordId: row.source_record_id,
      sourceVersionId: row.source_record_version_id,
      contentHash: row.content_hash,
      relationshipType: "batch_source",
      locator: `csv_batch.row.${row.row_number}`,
      intakeMode: "csv_batch",
      metadata: {
        batchId: row.batch_id,
        rowId: row.row_id,
        rowNumber: row.row_number,
      },
    },
  });

  const resultId = randomUUID();
  const completedAt = new Date().toISOString();
  await client.query(
    `INSERT INTO csv_batch_row_results (
       id,
       organization_id,
       batch_id,
       row_id,
       status,
       task_id,
       workflow_id,
       attempts,
       trace_id,
       completed_at
     )
     VALUES ($1, $2, $3, $4, 'accepted', $5, $6, $7, $8, $9)`,
    [
      resultId,
      job.organization_id,
      row.batch_id,
      row.row_id,
      issue.taskId,
      issue.workflowId,
      job.attempts,
      job.trace_id,
      completedAt,
    ],
  );

  await appendAuditEvent(client, {
    organizationId: job.organization_id,
    actorType: "service",
    actorId: "csv-row-worker",
    eventType: "csv.row.accepted",
    workflowId: issue.workflowId,
    sourceRecordIds: [row.source_record_id],
    inputHash: row.input_hash,
    outputHash: sha256({
      resultId,
      taskId: issue.taskId,
      workflowId: issue.workflowId,
    }),
    traceId: job.trace_id,
    requestId: job.request_id,
    metadata: {
      batchId: row.batch_id,
      rowId: row.row_id,
      rowNumber: row.row_number,
      resultId,
      taskId: issue.taskId,
      workflowId: issue.workflowId,
      sourceRecordId: row.source_record_id,
    },
    occurredAt: completedAt,
  });

  await completeIdempotentCommand(client, {
    organizationId: job.organization_id,
    scope: `csv_batch_row:${row.batch_id}`,
    idempotencyKey: row.row_idempotency_key,
    requestHash: row.input_hash,
    response: {
      taskId: issue.taskId,
      workflowId: issue.workflowId,
    },
  });

  await client.query(
    `UPDATE outbox_events
     SET status = 'published', published_at = now(), locked_at = NULL,
         locked_by = NULL, last_error_code = NULL,
         safe_error_message = NULL
     WHERE id = $1
       AND organization_id = $2`,
    [job.id, job.organization_id],
  );
}

export async function finalizeCsvRowFailure(
  client: DatabaseClient,
  job: CsvRowOutboxJob,
  errorCode: string,
  safeErrorMessage: string,
): Promise<void> {
  const contextResult =
    job.topic === "issue.csv-row"
      ? await client.query<{
          row_id: string;
          batch_id: string;
          row_number: number;
          source_record_id: string;
          task_id: string | null;
          workflow_id: string | null;
          workflow_state: string | null;
          workflow_version: number | null;
        }>(
          `SELECT
             row.id AS row_id,
             row.batch_id,
             row.row_number,
             batch.source_record_id,
             accepted.task_id,
             accepted.workflow_id,
             workflow.current_state AS workflow_state,
             workflow.version AS workflow_version
           FROM csv_batch_rows row
           JOIN csv_batches batch
             ON batch.id = row.batch_id
            AND batch.organization_id = row.organization_id
           LEFT JOIN csv_batch_row_results accepted
             ON accepted.row_id = row.id
            AND accepted.organization_id = row.organization_id
            AND accepted.status = 'accepted'
           LEFT JOIN workflows workflow
             ON workflow.id = accepted.workflow_id
            AND workflow.organization_id = accepted.organization_id
           WHERE row.id = $1
             AND row.organization_id = $2`,
          [job.aggregate_id, job.organization_id],
        )
      : await client.query<{
          row_id: string;
          batch_id: string;
          row_number: number;
          source_record_id: string;
          task_id: string | null;
          workflow_id: string | null;
          workflow_state: string | null;
          workflow_version: number | null;
        }>(
          `SELECT
             row.id AS row_id,
             row.batch_id,
             row.row_number,
             batch.source_record_id,
             accepted.task_id,
             accepted.workflow_id,
             workflow.current_state AS workflow_state,
             workflow.version AS workflow_version
           FROM workflows workflow
           JOIN csv_batch_row_results accepted
             ON accepted.workflow_id = workflow.id
            AND accepted.organization_id = workflow.organization_id
            AND accepted.status = 'accepted'
           JOIN csv_batch_rows row
             ON row.id = accepted.row_id
            AND row.organization_id = accepted.organization_id
           JOIN csv_batches batch
             ON batch.id = row.batch_id
            AND batch.organization_id = row.organization_id
           WHERE workflow.id = $1
             AND workflow.organization_id = $2`,
          [job.aggregate_id, job.organization_id],
        );
  const context = contextResult.rows[0];
  if (!context) {
    return;
  }

  const existingFailure = await client.query(
    `SELECT id
     FROM csv_batch_row_results
     WHERE row_id = $1
       AND organization_id = $2
       AND status = 'failed'`,
    [context.row_id, job.organization_id],
  );
  if ((existingFailure.rowCount ?? 0) > 0) {
    return;
  }

  if (
    context.workflow_id &&
    context.workflow_state &&
    context.workflow_version !== null
  ) {
    const allowed = await client.query(
      `SELECT 1
       FROM workflow_allowed_transitions
       WHERE workflow_type = 'issue_intake'
         AND from_state = $1
         AND to_state = 'failed'`,
      [context.workflow_state],
    );
    if ((allowed.rowCount ?? 0) > 0) {
      await client.query(
        `SELECT *
         FROM transition_workflow(
           $1, $2, $3, $4, 'failed', 'service', 'csv-row-worker',
           NULL, $5, $6, $7::jsonb
         )`,
        [
          context.workflow_id,
          job.organization_id,
          `${job.id}:csv-downstream-failed`,
          context.workflow_version,
          sha256({ errorCode, safeErrorMessage }),
          job.trace_id,
          JSON.stringify({
            batchId: context.batch_id,
            rowId: context.row_id,
            outboxEventId: job.id,
          }),
        ],
      );
    }
  }

  const resultId = randomUUID();
  const completedAt = new Date().toISOString();
  await client.query(
    `INSERT INTO csv_batch_row_results (
       id,
       organization_id,
       batch_id,
       row_id,
       status,
       task_id,
       workflow_id,
       error_code,
       safe_error_message,
       attempts,
       trace_id,
       completed_at
     )
     VALUES ($1, $2, $3, $4, 'failed', $5, $6, $7, $8, $9, $10, $11)`,
    [
      resultId,
      job.organization_id,
      context.batch_id,
      context.row_id,
      context.task_id,
      context.workflow_id,
      errorCode,
      safeErrorMessage,
      job.attempts,
      job.trace_id,
      completedAt,
    ],
  );

  await appendAuditEvent(client, {
    organizationId: job.organization_id,
    actorType: "service",
    actorId: "csv-row-worker",
    eventType: "csv.row.failed",
    ...(context.workflow_id ? { workflowId: context.workflow_id } : {}),
    sourceRecordIds: [context.source_record_id],
    inputHash: sha256({
      batchId: context.batch_id,
      rowId: context.row_id,
      outboxEventId: job.id,
    }),
    outputHash: sha256({
      resultId,
      errorCode,
      safeErrorMessage,
    }),
    traceId: job.trace_id,
    requestId: job.request_id,
    metadata: {
      batchId: context.batch_id,
      rowId: context.row_id,
      rowNumber: context.row_number,
      resultId,
      taskId: context.task_id,
      workflowId: context.workflow_id,
      outboxEventId: job.id,
      attempts: job.attempts,
      errorCode,
    },
    occurredAt: completedAt,
  });
}
