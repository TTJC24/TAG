import { randomUUID } from "node:crypto";
import { appendAuditEvent, sha256 } from "@operating-layer/audit";
import { withOrganizationScope, type DatabasePool } from "@operating-layer/db";
import {
  executionTriggerInputSchema,
  type ExecutionTriggerInput,
  type ExecutionTriggerResponse,
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

export interface RequestInternalExecutionCommand {
  principal: ApplicationPrincipal;
  approvalId: string;
  input: ExecutionTriggerInput;
  idempotencyKey: string;
  context: RequestContext;
}

export async function requestInternalExecution(
  pool: DatabasePool,
  command: RequestInternalExecutionCommand,
): Promise<ExecutionTriggerResponse> {
  const input = executionTriggerInputSchema.parse(command.input);
  requireOrganizationPermission(
    command.principal,
    input.organizationId,
    "executions.trigger",
  );
  const idempotencyKey = ensureIdempotencyKey(command.idempotencyKey);
  const requestHash = sha256({
    approvalId: command.approvalId,
    organizationId: input.organizationId,
    provider: "deterministic_internal",
  });
  const scope = `execution_trigger:${command.approvalId}`;

  return withOrganizationScope(
    pool,
    {
      userId: command.principal.userId,
      organizationIds: [input.organizationId],
    },
    async (client) => {
      const claim = await claimIdempotentCommand<ExecutionTriggerResponse>(
        client,
        {
          organizationId: input.organizationId,
          scope,
          idempotencyKey,
          requestHash,
        },
      );
      if (claim.kind === "replay") {
        return {
          ...claim.response,
          duplicate: true,
          traceId: claim.response.traceId,
        };
      }

      const approvalResult = await client.query<{
        workflow_id: string;
        task_id: string;
        approval_status: string;
        workflow_state: string;
        root_trace_id: string | null;
        existing_execution_command_id: string | null;
      }>(
        `SELECT
           approval.workflow_id,
           workflow.task_id,
           approval.status AS approval_status,
           workflow.current_state AS workflow_state,
           approval.decision_trace_id AS root_trace_id,
           active_command.id AS existing_execution_command_id
         FROM approvals approval
         JOIN workflows workflow
           ON workflow.id = approval.workflow_id
          AND workflow.organization_id = approval.organization_id
         LEFT JOIN LATERAL (
           SELECT command.id
           FROM execution_commands command
           LEFT JOIN mail_draft_execution_abandonments abandonment
             ON abandonment.execution_command_id = command.id
            AND abandonment.organization_id = command.organization_id
           WHERE command.approval_id = approval.id
             AND command.organization_id = approval.organization_id
             AND abandonment.id IS NULL
           ORDER BY command.created_at DESC
           LIMIT 1
         ) active_command ON true
         WHERE approval.id = $1
           AND approval.organization_id = $2`,
        [command.approvalId, input.organizationId],
      );
      const approval = approvalResult.rows[0];
      if (!approval) {
        throw new DomainError(404, "approval_not_found", "Approval not found");
      }
      if (approval.existing_execution_command_id) {
        throw new DomainError(
          409,
          "execution_already_requested",
          "This approval already has an execution command",
        );
      }
      if (
        approval.approval_status !== "approved" ||
        approval.workflow_state !== "approved"
      ) {
        throw new DomainError(
          409,
          "workflow_not_approved",
          "Only an approved workflow can be executed",
        );
      }
      if (!approval.root_trace_id) {
        throw new Error("Approved workflow has no root trace");
      }

      const executionCommandId = randomUUID();
      const enqueued = await client.query<{
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
         FROM enqueue_internal_execution($1, $2, $3, $4, $5, $6, $7)`,
        [
          executionCommandId,
          command.approvalId,
          input.organizationId,
          "deterministic_internal",
          idempotencyKey,
          approval.root_trace_id,
          command.context.requestId,
        ],
      );
      const row = enqueued.rows[0];
      if (!row) {
        throw new Error("Execution enqueue did not return a command");
      }

      const outputHash = sha256({
        executionCommandId: row.execution_command_id,
        outboxEventId: row.outbox_event_id,
        status: "queued",
      });
      await appendAuditEvent(client, {
        organizationId: input.organizationId,
        actorType: "user",
        actorId: command.principal.userId,
        eventType: "execution.requested",
        workflowId: row.workflow_id,
        sourceRecordIds: [],
        inputHash: requestHash,
        outputHash,
        traceId: approval.root_trace_id,
        requestId: command.context.requestId,
        metadata: {
          taskId: row.task_id,
          approvalId: row.approval_id,
          recommendationId: row.recommendation_id,
          executionCommandId: row.execution_command_id,
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

      const response: ExecutionTriggerResponse = {
        executionCommandId: row.execution_command_id,
        outboxEventId: row.outbox_event_id,
        taskId: row.task_id,
        workflowId: row.workflow_id,
        approvalId: row.approval_id,
        recommendationId: row.recommendation_id,
        actionType: row.action_type,
        status: "queued",
        duplicate: false,
        traceId: approval.root_trace_id,
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
