import { randomUUID } from "node:crypto";
import {
  appendAuditEvent,
  canonicalJson,
  sha256,
} from "@operating-layer/audit";
import {
  withOrganizationScope,
  type DatabaseClient,
  type DatabasePool,
} from "@operating-layer/db";
import {
  manualIssueInputSchema,
  type IssueIntakeResponse,
  type ManualIssueInput,
} from "@operating-layer/schemas";
import { DomainError } from "./errors.js";
import {
  requireOrganizationPermission,
  type ApplicationPrincipal,
} from "./identity.js";

export interface RequestContext {
  traceId: string;
  requestId: string;
}

export interface CreateManualIssueCommand {
  principal: ApplicationPrincipal;
  input: ManualIssueInput;
  idempotencyKey: string;
  context: RequestContext;
}

function ensureIdempotencyKey(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 200) {
    throw new DomainError(
      400,
      "invalid_idempotency_key",
      "Idempotency-Key must contain 8 to 200 characters",
    );
  }
  return normalized;
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

export async function createManualIssue(
  pool: DatabasePool,
  command: CreateManualIssueCommand,
): Promise<IssueIntakeResponse> {
  const input = manualIssueInputSchema.parse(command.input);
  requireOrganizationPermission(
    command.principal,
    input.organizationId,
    "issues.create",
  );
  const idempotencyKey = ensureIdempotencyKey(command.idempotencyKey);
  const requestHash = sha256(input);

  return withOrganizationScope(
    pool,
    {
      userId: command.principal.userId,
      organizationIds: [input.organizationId],
    },
    async (client) => {
      const claim = await client.query(
        `INSERT INTO idempotency_keys (
           organization_id,
           scope,
           idempotency_key,
           request_hash,
           status
         )
         VALUES ($1, 'manual_issue_intake', $2, $3, 'claimed')
         ON CONFLICT DO NOTHING
         RETURNING idempotency_key`,
        [input.organizationId, idempotencyKey, requestHash],
      );

      if (claim.rowCount === 0) {
        const existingResult = await client.query<{
          request_hash: string;
          status: string;
          response_reference: string | null;
        }>(
          `SELECT request_hash, status, response_reference
           FROM idempotency_keys
           WHERE organization_id = $1
             AND scope = 'manual_issue_intake'
             AND idempotency_key = $2
           FOR UPDATE`,
          [input.organizationId, idempotencyKey],
        );
        const existing = existingResult.rows[0];
        if (!existing || existing.request_hash !== requestHash) {
          throw new DomainError(
            409,
            "idempotency_key_conflict",
            "The idempotency key was already used with a different request",
          );
        }
        if (existing.status === "completed" && existing.response_reference) {
          const response = JSON.parse(
            existing.response_reference,
          ) as IssueIntakeResponse;
          return {
            ...response,
            duplicate: true,
            traceId: command.context.traceId,
          };
        }
        throw new DomainError(
          409,
          "request_in_progress",
          "A request with this idempotency key is already in progress",
        );
      }

      const sourceSystemResult = await client.query<{ id: string }>(
        `SELECT id
         FROM source_systems
         WHERE organization_id = $1
           AND type = 'manual'
           AND connection_status = 'healthy'
         LIMIT 1`,
        [input.organizationId],
      );
      const sourceSystemId = sourceSystemResult.rows[0]?.id;
      if (!sourceSystemId) {
        throw new DomainError(
          503,
          "manual_source_unavailable",
          "Manual intake is not configured for this organization",
        );
      }

      const sourceRecordId = randomUUID();
      const sourceVersionId = randomUUID();
      const taskId = randomUUID();
      const workflowId = randomUUID();
      const externalId = `manual:${sha256(
        `${input.organizationId}:${idempotencyKey}`,
      ).slice(0, 40)}`;
      const now = new Date().toISOString();
      const rawPayload = {
        schemaVersion: "manual-issue.v1",
        submittedBy: command.principal.userId,
        submittedAt: now,
        input,
      };
      const contentHash = sha256(rawPayload);

      await client.query(
        `INSERT INTO source_records (
           id,
           source_system_id,
           organization_id,
           external_id,
           record_type,
           last_synced_at
         )
         VALUES ($1, $2, $3, $4, 'manual_issue', $5)`,
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
           $1, $2, $3, $4, $5, $6::jsonb, $7, $7, 'sha256', $8::jsonb,
           'manual-issue.v1', $9, $7
         )`,
        [
          sourceVersionId,
          sourceRecordId,
          input.organizationId,
          contentHash,
          `postgresql://operating_layer/source_record_versions/${sourceVersionId}`,
          JSON.stringify(rawPayload),
          now,
          JSON.stringify({
            sourceSystemId,
            externalId,
            submittedByUserId: command.principal.userId,
          }),
          input.retentionClassification,
        ],
      );

      await client.query(
        `UPDATE source_records
         SET latest_version_id = $2, source_updated_at = $3, updated_at = $3
         WHERE id = $1 AND organization_id = $4`,
        [sourceRecordId, sourceVersionId, now, input.organizationId],
      );

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
          command.principal.userId,
          input.dueDate ?? null,
          input.financialExposure ?? null,
          input.financialExposureCurrency ?? null,
          command.principal.userId,
        ],
      );

      await client.query(
        `INSERT INTO task_source_records (
           organization_id,
           task_id,
           source_record_id,
           relationship_type
         )
         VALUES ($1, $2, $3, 'intake_source')`,
        [input.organizationId, taskId, sourceRecordId],
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
        actorId: command.principal.userId,
        eventType: "issue.intake.accepted",
        workflowId,
        sourceRecordIds: [sourceRecordId],
        inputHash: requestHash,
        outputHash: contentHash,
        traceId: command.context.traceId,
        requestId: command.context.requestId,
        metadata: {
          taskId,
          sourceVersionId,
          retentionClassification: input.retentionClassification,
        },
        occurredAt: now,
      });

      const transition = await transitionWorkflow(client, {
        workflowId,
        organizationId: input.organizationId,
        commandId: `${idempotencyKey}:normalize`,
        expectedVersion: 1,
        toState: "normalized",
        actorId: command.principal.userId,
        inputHash: contentHash,
        outputHash: sha256({ taskId, status: "normalized" }),
        traceId: command.context.traceId,
        metadata: { taskId, sourceRecordId },
      });

      await appendAuditEvent(client, {
        organizationId: input.organizationId,
        actorType: "user",
        actorId: command.principal.userId,
        eventType: "task.normalized",
        workflowId,
        sourceRecordIds: [sourceRecordId],
        inputHash: contentHash,
        outputHash: sha256({
          taskId,
          workflowState: transition.workflowState,
        }),
        traceId: command.context.traceId,
        requestId: command.context.requestId,
        metadata: {
          taskId,
          workflowVersion: transition.workflowVersion,
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
          `${idempotencyKey}:classify`,
          command.context.traceId,
          command.principal.userId,
          command.context.requestId,
        ],
      );

      const response: IssueIntakeResponse = {
        taskId,
        workflowId,
        workflowState: transition.workflowState,
        duplicate: false,
        traceId: command.context.traceId,
      };

      await client.query(
        `UPDATE idempotency_keys
         SET status = 'completed', response_reference = $4, updated_at = now()
         WHERE organization_id = $1
           AND scope = 'manual_issue_intake'
           AND idempotency_key = $2
           AND request_hash = $3`,
        [
          input.organizationId,
          idempotencyKey,
          requestHash,
          canonicalJson(response),
        ],
      );

      return response;
    },
  );
}

export async function getExecutiveQueue(
  pool: DatabasePool,
  principal: ApplicationPrincipal,
  organizationId: string,
): Promise<Record<string, unknown>> {
  requireOrganizationPermission(principal, organizationId, "queue.read");

  return withOrganizationScope(
    pool,
    { userId: principal.userId, organizationIds: [organizationId] },
    async (client) => {
      const organizationResult = await client.query<{
        id: string;
        name: string;
        code: string;
      }>(
        `SELECT id, name, code
         FROM organizations
         WHERE id = $1`,
        [organizationId],
      );
      const tasksResult = await client.query(
        `SELECT
           task.id,
           task.title,
           task.task_type AS "taskType",
           task.status,
           task.priority,
           task.due_date AS "dueDate",
           task.financial_exposure AS "financialExposure",
           task.financial_exposure_currency AS "financialExposureCurrency",
           task.confidence,
           owner.name AS "ownerName",
           workflow.id AS "workflowId",
           workflow.current_state AS "workflowState",
           workflow.approval_status AS "approvalStatus",
           recommendation.summary AS "recommendationSummary",
           recommendation.risk_level AS "riskLevel",
           task.created_at AS "createdAt",
           task.updated_at AS "updatedAt"
         FROM tasks task
         LEFT JOIN users owner ON owner.id = task.owner_user_id
         LEFT JOIN LATERAL (
           SELECT candidate.*
           FROM workflows candidate
           WHERE candidate.task_id = task.id
             AND candidate.organization_id = task.organization_id
           ORDER BY candidate.created_at DESC
           LIMIT 1
         ) workflow ON true
         LEFT JOIN LATERAL (
           SELECT candidate.*
           FROM recommendations candidate
           WHERE candidate.task_id = task.id
             AND candidate.organization_id = task.organization_id
           ORDER BY candidate.created_at DESC
           LIMIT 1
         ) recommendation ON true
         WHERE task.organization_id = $1
           AND task.status NOT IN ('completed', 'cancelled')
         ORDER BY
           CASE task.priority
             WHEN 'P0' THEN 0
             WHEN 'P1' THEN 1
             WHEN 'P2' THEN 2
             ELSE 3
           END,
           task.due_date NULLS LAST,
           task.created_at`,
        [organizationId],
      );
      const failuresResult = await client.query(
        `SELECT
           id,
           topic,
           aggregate_id AS "aggregateId",
           status,
           attempts,
           max_attempts AS "maxAttempts",
           safe_error_message AS "safeErrorMessage",
           last_attempt_at AS "lastAttemptAt"
         FROM outbox_events
         WHERE organization_id = $1
           AND status IN ('failed', 'dead_letter')
         ORDER BY created_at DESC
         LIMIT 20`,
        [organizationId],
      );

      const tasks = tasksResult.rows as Array<Record<string, unknown>>;
      const overdue = tasks.filter((task) => {
        const dueDate =
          task.dueDate instanceof Date
            ? task.dueDate.toISOString().slice(0, 10)
            : typeof task.dueDate === "string"
              ? task.dueDate.slice(0, 10)
              : null;
        return (
          dueDate !== null && dueDate < new Date().toISOString().slice(0, 10)
        );
      });
      const blocked = tasks.filter(
        (task) => task.status === "blocked" || task.workflowState === "blocked",
      );
      const approvalPending = tasks.filter(
        (task) => task.approvalStatus === "pending",
      );

      return {
        organization: organizationResult.rows[0],
        generatedAt: new Date().toISOString(),
        counts: {
          open: tasks.length,
          overdue: overdue.length,
          blocked: blocked.length,
          approvalPending: approvalPending.length,
          failedJobs: failuresResult.rows.length,
        },
        tasks,
        overdue,
        blocked,
        approvalPending,
        jobFailures: failuresResult.rows,
      };
    },
  );
}

export async function getTaskDetail(
  pool: DatabasePool,
  principal: ApplicationPrincipal,
  organizationId: string,
  taskId: string,
): Promise<Record<string, unknown>> {
  requireOrganizationPermission(principal, organizationId, "tasks.read");

  return withOrganizationScope(
    pool,
    { userId: principal.userId, organizationIds: [organizationId] },
    async (client) => {
      const taskResult = await client.query(
        `SELECT
           task.*,
           owner.name AS owner_name,
           organization.name AS organization_name,
           organization.code AS organization_code
         FROM tasks task
         JOIN organizations organization
           ON organization.id = task.organization_id
         LEFT JOIN users owner ON owner.id = task.owner_user_id
         WHERE task.id = $1
           AND task.organization_id = $2`,
        [taskId, organizationId],
      );
      const task = taskResult.rows[0];
      if (!task) {
        throw new DomainError(404, "task_not_found", "Task not found");
      }

      const sources = await client.query(
        `SELECT
           source.id,
           source.external_id AS "externalId",
           source.record_type AS "recordType",
           source.canonical_url AS "canonicalUrl",
           version.id AS "versionId",
           version.content_hash AS checksum,
           version.checksum_algorithm AS "checksumAlgorithm",
           version.source_updated_at AS "sourceTimestamp",
           version.ingested_at AS "ingestedAt",
           version.schema_version AS "schemaVersion",
           version.retention_classification AS "retentionClassification"
         FROM task_source_records link
         JOIN source_records source
           ON source.id = link.source_record_id
          AND source.organization_id = link.organization_id
         JOIN source_record_versions version
           ON version.id = source.latest_version_id
          AND version.organization_id = source.organization_id
         WHERE link.task_id = $1
           AND link.organization_id = $2
         ORDER BY version.ingested_at`,
        [taskId, organizationId],
      );
      const workflows = await client.query(
        `SELECT *
         FROM workflows
         WHERE task_id = $1 AND organization_id = $2
         ORDER BY started_at`,
        [taskId, organizationId],
      );
      const transitions = await client.query(
        `SELECT transition.*
         FROM workflow_transitions transition
         JOIN workflows workflow
           ON workflow.id = transition.workflow_id
          AND workflow.organization_id = transition.organization_id
         WHERE workflow.task_id = $1
           AND transition.organization_id = $2
         ORDER BY transition.occurred_at`,
        [taskId, organizationId],
      );
      const recommendations = await client.query(
        `SELECT *
         FROM recommendations
         WHERE task_id = $1 AND organization_id = $2
         ORDER BY created_at`,
        [taskId, organizationId],
      );
      const approvals = await client.query(
        `SELECT approval.*
         FROM approvals approval
         JOIN workflows workflow
           ON workflow.id = approval.workflow_id
          AND workflow.organization_id = approval.organization_id
         WHERE workflow.task_id = $1
           AND approval.organization_id = $2
         ORDER BY approval.requested_at`,
        [taskId, organizationId],
      );
      const audits = await client.query(
        `SELECT
           id,
           stream_sequence AS "streamSequence",
           actor_type AS "actorType",
           actor_id AS "actorId",
           event_type AS "eventType",
           input_hash AS "inputHash",
           output_hash AS "outputHash",
           trace_id AS "traceId",
           event_hash AS "eventHash",
           metadata,
           occurred_at AS "occurredAt"
         FROM audit_events
         WHERE organization_id = $2
           AND (
             metadata ->> 'taskId' = $3
             OR workflow_id IN (
               SELECT id FROM workflows
               WHERE task_id = $1 AND organization_id = $2
             )
           )
         ORDER BY stream_sequence`,
        [taskId, organizationId, taskId],
      );

      return {
        task,
        sources: sources.rows,
        workflows: workflows.rows,
        transitions: transitions.rows,
        recommendations: recommendations.rows,
        approvals: approvals.rows,
        auditHistory: audits.rows,
      };
    },
  );
}
