import { randomUUID } from "node:crypto";
import { appendAuditEvent, sha256 } from "@operating-layer/audit";
import { withOrganizationScope, type DatabasePool } from "@operating-layer/db";
import type {
  ExecutionAction,
  ExecutionProvider,
} from "@operating-layer/executors";
import {
  executionProviderOutputSchema,
  type ExecutionProviderOutput,
} from "@operating-layer/schemas";
import type { OutboxJob } from "./worker.js";

interface ExecutionCommandRow {
  id: string;
  organization_id: string;
  workflow_id: string;
  task_id: string;
  approval_id: string;
  recommendation_id: string;
  action_type: string;
  action_summary: string;
  action_payload_hash: string;
  provider_name: string;
  policy_version_id: string;
  policy_content_hash: string;
  result_id: string | null;
}

interface PreparedExecution {
  command: ExecutionCommandRow;
  action: ExecutionAction;
  startedAt: string;
}

export class ExecutionAttemptError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly output: Record<string, unknown>,
    readonly startedAt: string,
  ) {
    super(message);
    this.name = "ExecutionAttemptError";
  }
}

async function prepareInternalExecution(
  pool: DatabasePool,
  job: OutboxJob,
  provider: ExecutionProvider,
): Promise<PreparedExecution | null> {
  return withOrganizationScope(
    pool,
    {
      userId: job.requested_by_user_id,
      organizationIds: [job.organization_id],
    },
    async (client) => {
      const commandResult = await client.query<ExecutionCommandRow>(
        `SELECT
           command.id,
           command.organization_id,
           command.workflow_id,
           command.task_id,
           command.approval_id,
           command.recommendation_id,
           command.action_type,
           command.action_summary,
           command.action_payload_hash,
           command.provider_name,
           approval.policy_version_id,
           approval.policy_content_hash,
           result.id AS result_id
         FROM execution_commands command
         JOIN approvals approval
           ON approval.id = command.approval_id
          AND approval.organization_id = command.organization_id
         LEFT JOIN execution_results result
           ON result.execution_command_id = command.id
          AND result.organization_id = command.organization_id
         WHERE command.id = $1
           AND command.organization_id = $2`,
        [job.aggregate_id, job.organization_id],
      );
      const command = commandResult.rows[0];
      if (!command) {
        throw new Error("Execution command was not found");
      }
      if (
        command.provider_name !== "deterministic_internal" ||
        provider.kind !== "internal" ||
        !provider.enabled
      ) {
        throw new Error("The authorized execution provider is not enabled");
      }
      if (command.result_id) {
        await client.query(
          `UPDATE outbox_events
           SET status = 'published', published_at = now(), locked_at = NULL,
               locked_by = NULL, safe_error_message = NULL,
               last_error_code = NULL
           WHERE id = $1 AND organization_id = $2`,
          [job.id, job.organization_id],
        );
        return null;
      }

      const inputHash = sha256({
        executionCommandId: command.id,
        actionType: command.action_type,
        payloadHash: command.action_payload_hash,
      });
      const begun = await client.query<{
        workflow_state: string;
        workflow_version: number;
        did_transition: boolean;
      }>(
        `SELECT workflow_state, workflow_version, did_transition
         FROM begin_internal_execution($1, $2, $3, $4)`,
        [command.id, command.organization_id, inputHash, job.trace_id],
      );
      const beginResult = begun.rows[0];
      if (!beginResult) {
        throw new Error("Execution begin did not return workflow state");
      }
      const startedAt = new Date().toISOString();
      if (beginResult.did_transition) {
        await appendAuditEvent(client, {
          organizationId: command.organization_id,
          actorType: "service",
          actorId: provider.id,
          eventType: "execution.started",
          workflowId: command.workflow_id,
          sourceRecordIds: [],
          inputHash,
          outputHash: sha256({
            state: beginResult.workflow_state,
            version: beginResult.workflow_version,
          }),
          traceId: job.trace_id,
          requestId: job.request_id,
          metadata: {
            taskId: command.task_id,
            approvalId: command.approval_id,
            recommendationId: command.recommendation_id,
            executionCommandId: command.id,
            executorProvider: command.provider_name,
            executorId: provider.id,
            workflowState: beginResult.workflow_state,
            workflowVersion: beginResult.workflow_version,
          },
          occurredAt: startedAt,
        });
      }

      return {
        command,
        action: {
          organizationId: command.organization_id,
          taskId: command.task_id,
          workflowId: command.workflow_id,
          approvalId: command.approval_id,
          recommendationId: command.recommendation_id,
          actionType: command.action_type,
          summary: command.action_summary,
          payloadHash: command.action_payload_hash,
        },
        startedAt,
      };
    },
  );
}

async function persistExecutionOutcome(
  pool: DatabasePool,
  job: OutboxJob,
  provider: ExecutionProvider,
  prepared: PreparedExecution,
  output: ExecutionProviderOutput,
  error: { code: string; safeMessage: string } | null,
): Promise<void> {
  const completedAt = new Date().toISOString();
  const executionResultId = randomUUID();
  const outputHash = sha256(output);

  await withOrganizationScope(
    pool,
    {
      userId: job.requested_by_user_id,
      organizationIds: [job.organization_id],
    },
    async (client) => {
      const finalized = await client.query<{
        workflow_id: string;
        task_id: string;
        approval_id: string;
        recommendation_id: string;
        resulting_workflow_state: string;
        workflow_version: number;
        policy_version_id: string;
        policy_content_hash: string;
      }>(
        `SELECT
           workflow_id,
           task_id,
           approval_id,
           recommendation_id,
           resulting_workflow_state,
           workflow_version,
           policy_version_id,
           policy_content_hash
         FROM finalize_internal_execution(
           $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11,
           $12, $13, $14
         )`,
        [
          executionResultId,
          prepared.command.id,
          prepared.command.organization_id,
          prepared.command.provider_name,
          provider.id,
          output.outcome,
          output.summary,
          JSON.stringify(output.output),
          outputHash,
          error?.code ?? null,
          error?.safeMessage ?? null,
          prepared.startedAt,
          completedAt,
          job.trace_id,
        ],
      );
      const row = finalized.rows[0];
      if (!row) {
        throw new Error("Execution finalization did not return a result");
      }

      await appendAuditEvent(client, {
        organizationId: prepared.command.organization_id,
        actorType: "service",
        actorId: provider.id,
        eventType: `execution.${output.outcome}`,
        workflowId: row.workflow_id,
        sourceRecordIds: [],
        inputHash: prepared.command.action_payload_hash,
        outputHash,
        traceId: job.trace_id,
        requestId: job.request_id,
        metadata: {
          taskId: row.task_id,
          approvalId: row.approval_id,
          recommendationId: row.recommendation_id,
          executionCommandId: prepared.command.id,
          executionResultId,
          executorProvider: prepared.command.provider_name,
          executorId: provider.id,
          actionType: prepared.command.action_type,
          outcome: output.outcome,
          outcomeSummary: output.summary,
          policyVersionId: row.policy_version_id,
          policyContentHash: row.policy_content_hash,
          workflowState: row.resulting_workflow_state,
          workflowVersion: row.workflow_version,
          attempts: job.attempts,
        },
        occurredAt: completedAt,
      });

      await client.query(
        `UPDATE outbox_events
         SET
           status = $2,
           published_at = CASE WHEN $2 = 'published' THEN now() ELSE NULL END,
           locked_at = NULL,
           locked_by = NULL,
           last_error_code = $3,
           safe_error_message = $4
         WHERE id = $1
           AND organization_id = $5`,
        [
          job.id,
          output.outcome === "succeeded" ? "published" : "dead_letter",
          error?.code ?? null,
          error?.safeMessage ?? null,
          job.organization_id,
        ],
      );
    },
  );
}

export async function processInternalExecutionJob(
  pool: DatabasePool,
  job: OutboxJob,
  provider: ExecutionProvider,
): Promise<void> {
  const prepared = await prepareInternalExecution(pool, job, provider);
  if (!prepared) {
    return;
  }

  let untrustedOutput: unknown;
  try {
    untrustedOutput = await provider.execute(prepared.action, {
      traceId: job.trace_id,
      requestId: job.request_id,
      commandId: prepared.command.id,
      idempotencyKey: job.idempotency_key,
    });
  } catch (error) {
    throw new ExecutionAttemptError(
      error instanceof Error ? error.message : "Execution provider failed",
      "executor_call_failed",
      {},
      prepared.startedAt,
    );
  }

  let output: ExecutionProviderOutput;
  try {
    output = executionProviderOutputSchema.parse(untrustedOutput);
  } catch {
    throw new ExecutionAttemptError(
      "Execution provider returned invalid output",
      "executor_output_invalid",
      {},
      prepared.startedAt,
    );
  }
  if (output.outcome === "failed") {
    throw new ExecutionAttemptError(
      output.summary,
      typeof output.output.failureCode === "string"
        ? output.output.failureCode
        : "executor_reported_failure",
      output.output,
      prepared.startedAt,
    );
  }

  await persistExecutionOutcome(pool, job, provider, prepared, output, null);
}

export async function finalizeInternalExecutionFailure(
  pool: DatabasePool,
  job: OutboxJob,
  provider: ExecutionProvider,
  failure: unknown,
): Promise<void> {
  const prepared = await prepareInternalExecution(pool, job, provider);
  if (!prepared) {
    return;
  }
  const attempt =
    failure instanceof ExecutionAttemptError
      ? failure
      : new ExecutionAttemptError(
          failure instanceof Error ? failure.message : "Execution failed",
          "handler_failed",
          {},
          prepared.startedAt,
        );
  const output: ExecutionProviderOutput = {
    outcome: "failed",
    summary: attempt.message.slice(0, 4000),
    output: attempt.output,
  };
  await persistExecutionOutcome(pool, job, provider, prepared, output, {
    code: attempt.code.slice(0, 100),
    safeMessage: attempt.message.slice(0, 500),
  });
}
