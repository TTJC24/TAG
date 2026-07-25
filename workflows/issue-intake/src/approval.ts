import { randomUUID } from "node:crypto";
import { appendAuditEvent, sha256 } from "@operating-layer/audit";
import { withOrganizationScope, type DatabasePool } from "@operating-layer/db";
import {
  approvalResolutionInputSchema,
  type ApprovalResolutionInput,
  type ApprovalResolutionResponse,
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

export interface ResolveApprovalCommand {
  principal: ApplicationPrincipal;
  approvalId: string;
  input: ApprovalResolutionInput;
  idempotencyKey: string;
  context: RequestContext;
}

export async function resolveApproval(
  pool: DatabasePool,
  command: ResolveApprovalCommand,
): Promise<ApprovalResolutionResponse> {
  const input = approvalResolutionInputSchema.parse(command.input);
  requireOrganizationPermission(
    command.principal,
    input.organizationId,
    "approvals.decide",
  );
  const idempotencyKey = ensureIdempotencyKey(command.idempotencyKey);
  const requestHash = sha256({
    approvalId: command.approvalId,
    ...input,
  });
  const scope = `approval_resolution:${command.approvalId}`;

  return withOrganizationScope(
    pool,
    {
      userId: command.principal.userId,
      organizationIds: [input.organizationId],
    },
    async (client) => {
      const claim = await claimIdempotentCommand<ApprovalResolutionResponse>(
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
        root_trace_id: string;
      }>(
        `SELECT
           approval.workflow_id,
           workflow.task_id,
           (
             SELECT transition.trace_id
             FROM workflow_transitions transition
             WHERE transition.workflow_id = workflow.id
               AND transition.organization_id = workflow.organization_id
             ORDER BY transition.workflow_version
             LIMIT 1
           ) AS root_trace_id
         FROM approvals approval
         JOIN workflows workflow
           ON workflow.id = approval.workflow_id
          AND workflow.organization_id = approval.organization_id
         WHERE approval.id = $1
           AND approval.organization_id = $2`,
        [command.approvalId, input.organizationId],
      );
      const approval = approvalResult.rows[0];
      if (!approval) {
        throw new DomainError(404, "approval_not_found", "Approval not found");
      }
      if (!approval.root_trace_id) {
        throw new Error("Approval workflow has no root trace");
      }

      const resolutionId = randomUUID();
      const decisionOutput = {
        approvalId: command.approvalId,
        resolutionId,
        decision: input.decision,
        reason: input.reason,
        actorId: command.principal.userId,
      };
      const resolved = await client.query<{
        resolution_id: string;
        approval_id: string;
        workflow_id: string;
        task_id: string;
        decision: "approved" | "rejected";
        resulting_workflow_state: "completed" | "rejected";
        policy_version_id: string;
        policy_content_hash: string;
        resolved_by_user_id: string;
        workflow_version: number;
      }>(
        `SELECT *
         FROM resolve_approval_workflow(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
         )`,
        [
          resolutionId,
          command.approvalId,
          input.organizationId,
          input.decision,
          input.reason,
          idempotencyKey,
          approval.root_trace_id,
          command.context.requestId,
          requestHash,
          sha256(decisionOutput),
        ],
      );
      const row = resolved.rows[0];
      if (!row) {
        throw new Error("Approval resolution did not return a result");
      }

      await appendAuditEvent(client, {
        organizationId: input.organizationId,
        actorType: "user",
        actorId: command.principal.userId,
        eventType: `approval.${row.decision}`,
        workflowId: row.workflow_id,
        sourceRecordIds: [],
        inputHash: requestHash,
        outputHash: sha256(decisionOutput),
        traceId: approval.root_trace_id,
        requestId: command.context.requestId,
        metadata: {
          taskId: row.task_id,
          approvalId: row.approval_id,
          resolutionId: row.resolution_id,
          decision: row.decision,
          reason: input.reason,
          policyVersionId: row.policy_version_id,
          policyContentHash: row.policy_content_hash,
          workflowState: row.resulting_workflow_state,
          workflowVersion: row.workflow_version,
          requestTraceId: command.context.traceId,
        },
        occurredAt: new Date().toISOString(),
      });

      const response: ApprovalResolutionResponse = {
        approvalId: row.approval_id,
        resolutionId: row.resolution_id,
        taskId: row.task_id,
        workflowId: row.workflow_id,
        decision: row.decision,
        workflowState: row.resulting_workflow_state,
        policyVersionId: row.policy_version_id,
        policyContentHash: row.policy_content_hash,
        resolvedByUserId: row.resolved_by_user_id,
        reason: input.reason,
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
