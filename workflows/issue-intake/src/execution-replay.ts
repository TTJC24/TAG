import { randomUUID } from "node:crypto";
import { appendAuditEvent, sha256 } from "@operating-layer/audit";
import { withOrganizationScope, type DatabasePool } from "@operating-layer/db";
import {
  executionReplayInputSchema,
  type ExecutionReplayInput,
  type ExecutionReplayResponse,
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
import type { RequestContext } from "./service.js";

export interface RequestInternalExecutionReplayCommand {
  principal: ApplicationPrincipal;
  approvalId: string;
  input: ExecutionReplayInput;
  idempotencyKey: string;
  context: RequestContext;
}

/**
 * Replay a deterministic-internal execution that exhausted its retries and
 * dead-lettered, leaving the workflow terminal in `execution_failed`. A fresh
 * immutable execution command is minted against the still-approved approval and
 * a new job is enqueued; the DB re-opens the terminal state under the guarded
 * `execution_failed -> executing` transition. Requires `executions.replay`.
 */
export async function requestInternalExecutionReplay(
  pool: DatabasePool,
  command: RequestInternalExecutionReplayCommand,
): Promise<ExecutionReplayResponse> {
  const input = executionReplayInputSchema.parse(command.input);
  requireOrganizationPermission(
    command.principal,
    input.organizationId,
    "executions.replay",
  );
  const idempotencyKey = ensureIdempotencyKey(command.idempotencyKey);
  const requestHash = sha256({
    approvalId: command.approvalId,
    organizationId: input.organizationId,
    operation: "execution_replay",
  });
  const scope = `execution_replay:${command.approvalId}`;

  return withOrganizationScope(
    pool,
    {
      userId: command.principal.userId,
      organizationIds: [input.organizationId],
    },
    async (client) => {
      const claim = await claimIdempotentCommand<ExecutionReplayResponse>(
        client,
        {
          organizationId: input.organizationId,
          scope,
          idempotencyKey,
          requestHash,
        },
      );
      if (claim.kind === "replay") {
        return { ...claim.response, duplicate: true };
      }

      const failedResult = await client.query<{
        workflow_id: string;
        task_id: string;
        approval_status: string;
        workflow_state: string;
        root_trace_id: string | null;
        original_execution_command_id: string | null;
        dead_letter_event_id: string | null;
      }>(
        `SELECT
           approval.workflow_id,
           workflow.task_id,
           approval.status AS approval_status,
           workflow.current_state AS workflow_state,
           approval.decision_trace_id AS root_trace_id,
           failed.command_id AS original_execution_command_id,
           failed.event_id AS dead_letter_event_id
         FROM approvals approval
         JOIN workflows workflow
           ON workflow.id = approval.workflow_id
          AND workflow.organization_id = approval.organization_id
         LEFT JOIN LATERAL (
           SELECT command.id AS command_id, event.id AS event_id
           FROM execution_commands command
           JOIN outbox_events event
             ON event.aggregate_id = command.id
            AND event.organization_id = command.organization_id
            AND event.topic = 'issue.execute'
            AND event.status = 'dead_letter'
           WHERE command.approval_id = approval.id
             AND command.organization_id = approval.organization_id
             AND command.provider_name = 'deterministic_internal'
           ORDER BY command.created_at DESC
           LIMIT 1
         ) failed ON true
         WHERE approval.id = $1
           AND approval.organization_id = $2`,
        [command.approvalId, input.organizationId],
      );
      const failed = failedResult.rows[0];
      if (!failed) {
        throw new DomainError(404, "approval_not_found", "Approval not found");
      }
      if (failed.approval_status !== "approved") {
        throw new DomainError(
          409,
          "approval_not_approved",
          "Replay requires the approval to remain approved",
        );
      }
      if (failed.workflow_state !== "execution_failed") {
        throw new DomainError(
          409,
          "execution_not_failed",
          "Only a failed execution can be replayed",
        );
      }
      if (
        !failed.original_execution_command_id ||
        !failed.dead_letter_event_id
      ) {
        throw new DomainError(
          409,
          "no_dead_lettered_execution",
          "No dead-lettered execution was found for this approval",
        );
      }
      if (!failed.root_trace_id) {
        throw new Error("Approved workflow has no root trace");
      }

      const replayId = randomUUID();
      const replayExecutionCommandId = randomUUID();
      const replayed = await client.query<{
        execution_replay_id: string;
        execution_command_id: string;
        outbox_event_id: string;
        workflow_id: string;
        task_id: string;
        approval_id: string;
        recommendation_id: string;
        action_type: string;
        action_summary: string;
        action_payload_hash: string;
        policy_version_id: string;
        policy_content_hash: string;
      }>(
        `SELECT *
         FROM replay_internal_execution($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          replayId,
          replayExecutionCommandId,
          failed.original_execution_command_id,
          failed.dead_letter_event_id,
          input.organizationId,
          "deterministic_internal",
          idempotencyKey,
          failed.root_trace_id,
          command.context.requestId,
        ],
      );
      const row = replayed.rows[0];
      if (!row) {
        throw new Error("Execution replay did not return a command");
      }

      const outputHash = sha256({
        executionReplayId: row.execution_replay_id,
        executionCommandId: row.execution_command_id,
        outboxEventId: row.outbox_event_id,
        status: "queued",
      });
      await appendAuditEvent(client, {
        organizationId: input.organizationId,
        actorType: "user",
        actorId: command.principal.userId,
        eventType: "execution.replay_requested",
        workflowId: row.workflow_id,
        sourceRecordIds: [],
        inputHash: requestHash,
        outputHash,
        traceId: failed.root_trace_id,
        requestId: command.context.requestId,
        metadata: {
          executionReplayId: row.execution_replay_id,
          taskId: row.task_id,
          approvalId: row.approval_id,
          recommendationId: row.recommendation_id,
          executionCommandId: row.execution_command_id,
          originalExecutionCommandId: failed.original_execution_command_id,
          deadLetterEventId: failed.dead_letter_event_id,
          outboxEventId: row.outbox_event_id,
          actionType: row.action_type,
          actionPayloadHash: row.action_payload_hash,
          policyVersionId: row.policy_version_id,
          policyContentHash: row.policy_content_hash,
          provider: "deterministic_internal",
          requestTraceId: command.context.traceId,
        },
        occurredAt: new Date().toISOString(),
      });

      const response: ExecutionReplayResponse = {
        executionReplayId: row.execution_replay_id,
        executionCommandId: row.execution_command_id,
        originalExecutionCommandId: failed.original_execution_command_id,
        deadLetterEventId: failed.dead_letter_event_id,
        outboxEventId: row.outbox_event_id,
        taskId: row.task_id,
        workflowId: row.workflow_id,
        approvalId: row.approval_id,
        recommendationId: row.recommendation_id,
        actionType: row.action_type,
        status: "queued",
        duplicate: false,
        traceId: failed.root_trace_id,
      };
      await completeIdempotentCommand(client, {
        organizationId: input.organizationId,
        scope,
        idempotencyKey,
        requestHash,
        response,
      });
      return response;
    },
  );
}
