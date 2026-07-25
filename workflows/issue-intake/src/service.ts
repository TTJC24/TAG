import { randomUUID } from "node:crypto";
import { sha256 } from "@operating-layer/audit";
import { withOrganizationScope, type DatabasePool } from "@operating-layer/db";
import {
  manualIssueInputSchema,
  type IssueIntakeResponse,
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
import {
  createNormalizedIssueFromSource,
  type RequestContext,
} from "./intake.js";

export type { RequestContext } from "./intake.js";

export interface CreateManualIssueCommand {
  principal: ApplicationPrincipal;
  input: ManualIssueInput;
  idempotencyKey: string;
  context: RequestContext;
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
      const claim = await claimIdempotentCommand<IssueIntakeResponse>(client, {
        organizationId: input.organizationId,
        scope: "manual_issue_intake",
        idempotencyKey,
        requestHash,
      });
      if (claim.kind === "replay") {
        return {
          ...claim.response,
          duplicate: true,
          traceId: claim.response.traceId,
        };
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
      const externalId = `manual:${sourceRecordId}`;
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

      const response = await createNormalizedIssueFromSource({
        client,
        input,
        principalUserId: command.principal.userId,
        idempotencyKey,
        requestHash,
        context: command.context,
        source: {
          sourceRecordId,
          sourceVersionId,
          contentHash,
          relationshipType: "intake_source",
          locator: "manual_issue.input",
          intakeMode: "manual",
        },
      });

      await completeIdempotentCommand(client, {
        organizationId: input.organizationId,
        scope: "manual_issue_intake",
        idempotencyKey,
        requestHash,
        response,
      });

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
           AND task.status NOT IN ('completed', 'rejected', 'cancelled')
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
      const recentResolutionsResult = await client.query(
        `SELECT
           resolution.id,
           resolution.decision,
           resolution.reason,
           resolution.resulting_workflow_state AS "resultingWorkflowState",
           resolution.policy_version_id AS "policyVersionId",
           resolution.resolved_at AS "resolvedAt",
           resolution.task_id AS "taskId",
           task.title AS "taskTitle",
           resolver.name AS "resolverName"
         FROM approval_resolutions resolution
         JOIN tasks task
           ON task.id = resolution.task_id
          AND task.organization_id = resolution.organization_id
         JOIN users resolver ON resolver.id = resolution.resolved_by_user_id
         WHERE resolution.organization_id = $1
         ORDER BY resolution.resolved_at DESC
         LIMIT 20`,
        [organizationId],
      );
      const recentExecutionsResult = await client.query(
        `SELECT
           result.id,
           result.execution_command_id AS "executionCommandId",
           result.task_id AS "taskId",
           task.title AS "taskTitle",
           result.action_type AS "actionType",
           result.outcome,
           result.outcome_summary AS "outcomeSummary",
           result.executor_provider AS "executorProvider",
           result.executor_id AS "executorId",
           result.resulting_workflow_state AS "resultingWorkflowState",
           result.completed_at AS "completedAt"
         FROM execution_results result
         JOIN tasks task
           ON task.id = result.task_id
          AND task.organization_id = result.organization_id
         WHERE result.organization_id = $1
         ORDER BY result.completed_at DESC
         LIMIT 20`,
        [organizationId],
      );

      const tasks = tasksResult.rows as Array<Record<string, unknown>>;
      const recentExecutions = recentExecutionsResult.rows as Array<
        Record<string, unknown>
      >;
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
      const awaitingExternalAuthorization = tasks.filter(
        (task) =>
          task.status === "awaiting_external_authorization" ||
          task.workflowState === "awaiting_external_authorization",
      );
      const inExecution = tasks.filter(
        (task) =>
          task.status === "executing" || task.workflowState === "executing",
      );
      const executionFailed = tasks.filter(
        (task) =>
          task.status === "execution_failed" ||
          task.workflowState === "execution_failed",
      );
      const completedExecutions = recentExecutions.filter(
        (result) => result.outcome === "succeeded",
      );

      return {
        organization: organizationResult.rows[0],
        generatedAt: new Date().toISOString(),
        counts: {
          open: tasks.length,
          overdue: overdue.length,
          blocked: blocked.length,
          approvalPending: approvalPending.length,
          awaitingExternalAuthorization: awaitingExternalAuthorization.length,
          inExecution: inExecution.length,
          executionFailed: executionFailed.length,
          completedExecutions: completedExecutions.length,
          failedJobs: failuresResult.rows.length,
        },
        tasks,
        overdue,
        blocked,
        approvalPending,
        awaitingExternalAuthorization,
        inExecution,
        executionFailed,
        completedExecutions,
        recentResolutions: recentResolutionsResult.rows,
        recentExecutions,
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
      const approvalResolutions = await client.query(
        `SELECT
           resolution.*,
           resolver.name AS resolver_name,
           resolver.email AS resolver_email
         FROM approval_resolutions resolution
         JOIN users resolver ON resolver.id = resolution.resolved_by_user_id
         WHERE resolution.task_id = $1
           AND resolution.organization_id = $2
         ORDER BY resolution.resolved_at`,
        [taskId, organizationId],
      );
      const executionCommands = await client.query(
        `SELECT
           command.*,
           requester.name AS requester_name,
           requester.email AS requester_email
         FROM execution_commands command
         JOIN users requester ON requester.id = command.requested_by_user_id
         WHERE command.task_id = $1
           AND command.organization_id = $2
         ORDER BY command.created_at`,
        [taskId, organizationId],
      );
      const executionResults = await client.query(
        `SELECT *
         FROM execution_results
         WHERE task_id = $1
           AND organization_id = $2
         ORDER BY completed_at`,
        [taskId, organizationId],
      );
      const gmailDraftConnector = await client.query(
        `SELECT
           config.id AS "configVersionId",
           config.version_number AS "versionNumber",
           config.enabled,
           config.allowed_recipient_addresses AS "allowedRecipientAddresses",
           config.allowed_recipient_domains AS "allowedRecipientDomains",
           config.oauth_scopes AS "oauthScopes"
         FROM gmail_draft_connector_bindings binding
         JOIN gmail_draft_connector_config_versions config
           ON config.id = binding.active_config_version_id
          AND config.organization_id = binding.organization_id
         WHERE binding.organization_id = $1`,
        [organizationId],
      );
      const gmailDraftPreviews = await client.query(
        `SELECT
           preview.*,
           requester.name AS requester_name,
           requester.email AS requester_email
         FROM gmail_draft_previews preview
         JOIN users requester ON requester.id = preview.requested_by_user_id
         WHERE preview.task_id = $1
           AND preview.organization_id = $2
         ORDER BY preview.created_at`,
        [taskId, organizationId],
      );
      const gmailDraftAuthorizations = await client.query(
        `SELECT
           draft_authorization.*,
           authorizer.name AS authorizer_name,
           authorizer.email AS authorizer_email
         FROM gmail_draft_authorizations draft_authorization
         JOIN users authorizer
           ON authorizer.id = draft_authorization.authorized_by_user_id
         WHERE draft_authorization.task_id = $1
           AND draft_authorization.organization_id = $2
         ORDER BY draft_authorization.authorized_at`,
        [taskId, organizationId],
      );
      const gmailDraftAbandonments = await client.query(
        `SELECT *
         FROM gmail_draft_execution_abandonments
         WHERE task_id = $1
           AND organization_id = $2
         ORDER BY abandoned_at`,
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
        approvalResolutions: approvalResolutions.rows,
        executionCommands: executionCommands.rows,
        executionResults: executionResults.rows,
        gmailDraftConnector: gmailDraftConnector.rows[0] ?? {
          enabled: false,
          defaultState: "disabled",
        },
        gmailDraftPreviews: gmailDraftPreviews.rows,
        gmailDraftAuthorizations: gmailDraftAuthorizations.rows,
        gmailDraftAbandonments: gmailDraftAbandonments.rows,
        auditHistory: audits.rows,
      };
    },
  );
}
