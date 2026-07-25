import { randomUUID } from "node:crypto";
import { appendAuditEvent, sha256 } from "@operating-layer/audit";
import type { DatabaseClient } from "@operating-layer/db";
import type {
  IssueIntakeResponse,
  ManualIssueInput,
} from "@operating-layer/schemas";

export interface RequestContext {
  traceId: string;
  requestId: string;
}

export interface IssueIntakeSource {
  sourceRecordId: string;
  sourceVersionId: string;
  contentHash: string;
  relationshipType: "intake_source" | "batch_source";
  locator: string;
  intakeMode: "manual" | "csv_batch";
  metadata?: Readonly<Record<string, unknown>>;
}

export interface CreateNormalizedIssueInput {
  client: DatabaseClient;
  input: ManualIssueInput;
  principalUserId: string;
  idempotencyKey: string;
  requestHash: string;
  context: RequestContext;
  source: IssueIntakeSource;
}

async function transitionWorkflow(
  client: DatabaseClient,
  input: {
    workflowId: string;
    organizationId: string;
    commandId: string;
    expectedVersion: number;
    toState: string;
    actorId: string;
    inputHash: string;
    outputHash: string;
    traceId: string;
    metadata: Record<string, unknown>;
  },
): Promise<{ workflowState: string; workflowVersion: number }> {
  const result = await client.query<{
    current_state: string;
    workflow_version: number;
  }>(
    `SELECT current_state, workflow_version
     FROM transition_workflow(
       $1, $2, $3, $4, $5, 'user', $6, $7, $8, $9, $10::jsonb
     )`,
    [
      input.workflowId,
      input.organizationId,
      input.commandId,
      input.expectedVersion,
      input.toState,
      input.actorId,
      input.inputHash,
      input.outputHash,
      input.traceId,
      JSON.stringify(input.metadata),
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Workflow transition did not return state");
  }
  return {
    workflowState: row.current_state,
    workflowVersion: row.workflow_version,
  };
}

export async function createNormalizedIssueFromSource(
  command: CreateNormalizedIssueInput,
): Promise<IssueIntakeResponse> {
  const {
    client,
    input,
    principalUserId,
    idempotencyKey,
    requestHash,
    context,
    source,
  } = command;
  const taskId = randomUUID();
  const workflowId = randomUUID();
  const now = new Date().toISOString();

  await client.query(
    `INSERT INTO tasks (
       id,
       organization_id,
       title,
       description,
       task_type,
       status,
       priority,
       owner_user_id,
       due_date,
       financial_exposure,
       financial_exposure_currency,
       created_by_actor_type,
       created_by_actor_id
     )
     VALUES (
       $1, $2, $3, $4, $5, 'received', 'P3', $6, $7, $8, $9,
       'user', $10
     )`,
    [
      taskId,
      input.organizationId,
      input.title,
      input.description,
      input.taskType ?? "unclassified",
      principalUserId,
      input.dueDate ?? null,
      input.financialExposure ?? null,
      input.financialExposureCurrency ?? null,
      principalUserId,
    ],
  );

  await client.query(
    `INSERT INTO task_source_records (
       organization_id,
       task_id,
       source_record_id,
       relationship_type
     )
     VALUES ($1, $2, $3, $4)`,
    [
      input.organizationId,
      taskId,
      source.sourceRecordId,
      source.relationshipType,
    ],
  );

  await client.query(
    `INSERT INTO workflows (
       id,
       workflow_type,
       organization_id,
       task_id,
       current_state
     )
     VALUES ($1, 'issue_intake', $2, $3, 'received')`,
    [workflowId, input.organizationId, taskId],
  );

  await appendAuditEvent(client, {
    organizationId: input.organizationId,
    actorType: "user",
    actorId: principalUserId,
    eventType: "issue.intake.accepted",
    workflowId,
    sourceRecordIds: [source.sourceRecordId],
    inputHash: requestHash,
    outputHash: source.contentHash,
    traceId: context.traceId,
    requestId: context.requestId,
    metadata: {
      taskId,
      sourceVersionId: source.sourceVersionId,
      sourceLocator: source.locator,
      intakeMode: source.intakeMode,
      retentionClassification: input.retentionClassification,
      ...source.metadata,
    },
    occurredAt: now,
  });

  const transition = await transitionWorkflow(client, {
    workflowId,
    organizationId: input.organizationId,
    commandId: `${idempotencyKey}:normalize`,
    expectedVersion: 1,
    toState: "normalized",
    actorId: principalUserId,
    inputHash: source.contentHash,
    outputHash: sha256({ taskId, status: "normalized" }),
    traceId: context.traceId,
    metadata: {
      taskId,
      sourceRecordId: source.sourceRecordId,
      sourceVersionId: source.sourceVersionId,
      sourceLocator: source.locator,
      intakeMode: source.intakeMode,
      ...source.metadata,
    },
  });

  await appendAuditEvent(client, {
    organizationId: input.organizationId,
    actorType: "user",
    actorId: principalUserId,
    eventType: "task.normalized",
    workflowId,
    sourceRecordIds: [source.sourceRecordId],
    inputHash: source.contentHash,
    outputHash: sha256({
      taskId,
      workflowState: transition.workflowState,
    }),
    traceId: context.traceId,
    requestId: context.requestId,
    metadata: {
      taskId,
      workflowVersion: transition.workflowVersion,
      sourceLocator: source.locator,
      intakeMode: source.intakeMode,
      ...source.metadata,
    },
    occurredAt: now,
  });

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
       $1, 'issue.classify', 'workflow', $2, $3, $4, $5, $6, $7, $8, 3
     )`,
    [
      input.organizationId,
      workflowId,
      `postgresql://operating_layer/workflows/${workflowId}`,
      sha256({ workflowId, command: "classify" }),
      `${taskId}:classify`,
      context.traceId,
      principalUserId,
      context.requestId,
    ],
  );

  return {
    taskId,
    workflowId,
    workflowState: transition.workflowState,
    duplicate: false,
    traceId: context.traceId,
  };
}
