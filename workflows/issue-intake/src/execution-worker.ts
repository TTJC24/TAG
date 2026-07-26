import { randomUUID } from "node:crypto";
import { appendAuditEvent, sha256 } from "@operating-layer/audit";
import { withOrganizationScope, type DatabasePool } from "@operating-layer/db";
import type {
  ExecutionAction,
  ExecutionProvider,
} from "@operating-layer/executors";
import {
  executionProviderOutputSchema,
  gmailDraftProviderOutputSchema,
  type ExecutionProviderOutput,
} from "@operating-layer/schemas";
import { redactSensitiveText } from "@operating-layer/connectors";
import type { OutboxJob } from "./worker.js";
import {
  loadExecutionCredential,
  recordExecutionCredentialUse,
  type GmailCredentialRuntime,
} from "./gmail-credential-worker.js";

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
  external_authorization_id: string | null;
  result_id: string | null;
  abandonment_id: string | null;
  preview_id: string | null;
  recipient: string | null;
  subject: string | null;
  body: string | null;
  rendered_payload_hash: string | null;
  connector_config_version_id: string | null;
  active_config_version_id: string | null;
  connector_enabled: boolean | null;
  allowed_recipient_addresses: string[] | null;
  allowed_recipient_domains: string[] | null;
  active_credential_version_id: string | null;
  globally_killed: boolean;
  authorized_by_user_id: string | null;
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

async function prepareExecution(
  pool: DatabasePool,
  job: OutboxJob,
  internalProvider: ExecutionProvider,
  gmailDraftProvider: ExecutionProvider,
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
           command.external_authorization_id,
           result.id AS result_id,
           abandonment.id AS abandonment_id,
           preview.id AS preview_id,
           preview.recipient,
           preview.subject,
           preview.body,
           preview.rendered_payload_hash,
           draft_authorization.connector_config_version_id,
           binding.active_config_version_id,
           config.enabled AS connector_enabled,
           config.allowed_recipient_addresses,
           config.allowed_recipient_domains,
           credential_binding.active_credential_version_id,
           kill.killed AS globally_killed,
           draft_authorization.authorized_by_user_id
         FROM execution_commands command
         JOIN approvals approval
           ON approval.id = command.approval_id
          AND approval.organization_id = command.organization_id
         LEFT JOIN execution_results result
           ON result.execution_command_id = command.id
          AND result.organization_id = command.organization_id
         LEFT JOIN gmail_draft_execution_abandonments abandonment
           ON abandonment.execution_command_id = command.id
          AND abandonment.organization_id = command.organization_id
         LEFT JOIN gmail_draft_authorizations draft_authorization
           ON draft_authorization.id = command.external_authorization_id
          AND draft_authorization.organization_id = command.organization_id
         LEFT JOIN gmail_draft_previews preview
           ON preview.id = draft_authorization.preview_id
          AND preview.organization_id = draft_authorization.organization_id
         LEFT JOIN gmail_draft_connector_bindings binding
           ON binding.organization_id = command.organization_id
         LEFT JOIN gmail_draft_connector_config_versions config
           ON config.id = binding.active_config_version_id
          AND config.organization_id = binding.organization_id
         LEFT JOIN gmail_draft_credential_bindings credential_binding
           ON credential_binding.organization_id = command.organization_id
         JOIN gmail_draft_global_kill_switch kill ON kill.singleton
         WHERE command.id = $1
           AND command.organization_id = $2`,
        [job.aggregate_id, job.organization_id],
      );
      const command = commandResult.rows[0];
      if (!command) {
        throw new Error("Execution command was not found");
      }
      const provider =
        command.provider_name === "gmail_draft"
          ? gmailDraftProvider
          : internalProvider;
      if (
        (command.provider_name === "deterministic_internal" &&
          provider.kind !== "internal") ||
        (command.provider_name === "gmail_draft" &&
          provider.kind !== "external")
      ) {
        throw new Error(
          "The execution provider kind does not match the command",
        );
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
      if (command.abandonment_id) {
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

      if (command.provider_name === "gmail_draft") {
        const configMatches =
          command.connector_enabled === true &&
          command.globally_killed === false &&
          command.active_credential_version_id !== null &&
          command.connector_config_version_id !== null &&
          command.connector_config_version_id ===
            command.active_config_version_id;
        if (!configMatches) {
          const abandonmentId = randomUUID();
          const reasonCode =
            command.connector_enabled === true
              ? "connector_config_changed"
              : "connector_disabled";
          const abandoned = await client.query<{
            workflow_state: string;
            workflow_version: number;
          }>(
            `SELECT workflow_state, workflow_version
             FROM abandon_gmail_draft_execution($1, $2, $3, $4, $5)`,
            [
              abandonmentId,
              command.id,
              command.organization_id,
              reasonCode,
              job.trace_id,
            ],
          );
          const abandonment = abandoned.rows[0];
          if (!abandonment) {
            throw new Error("Gmail draft abandonment did not return state");
          }
          await appendAuditEvent(client, {
            organizationId: command.organization_id,
            actorType: "service",
            actorId: "gmail-draft-kill-switch",
            eventType: "gmail_draft.materialization_abandoned",
            workflowId: command.workflow_id,
            sourceRecordIds: [],
            inputHash: command.action_payload_hash,
            outputHash: sha256({
              abandonmentId,
              reasonCode,
              state: abandonment.workflow_state,
            }),
            traceId: job.trace_id,
            requestId: job.request_id,
            metadata: {
              abandonmentId,
              taskId: command.task_id,
              approvalId: command.approval_id,
              executionCommandId: command.id,
              previewId: command.preview_id,
              authorizationId: command.external_authorization_id,
              connectorConfigVersionId: command.connector_config_version_id,
              activeConfigVersionId: command.active_config_version_id,
              reasonCode,
              workflowState: abandonment.workflow_state,
              workflowVersion: abandonment.workflow_version,
            },
            occurredAt: new Date().toISOString(),
          });
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
        if (
          !command.preview_id ||
          !command.external_authorization_id ||
          !command.recipient ||
          !command.subject ||
          command.body === null ||
          !command.rendered_payload_hash ||
          !command.active_credential_version_id
        ) {
          throw new Error("Authorized Gmail draft payload is incomplete");
        }
        const domain = command.recipient.split("@")[1]!;
        if (
          !command.allowed_recipient_addresses?.includes(command.recipient) &&
          !command.allowed_recipient_domains?.includes(domain)
        ) {
          throw new Error("Authorized Gmail draft recipient is not allowed");
        }
      }
      if (!provider.enabled) {
        throw new Error("The authorized execution provider is not enabled");
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
         FROM begin_execution($1, $2, $3, $4)`,
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
          ...(command.provider_name === "gmail_draft"
            ? {
                payload: {
                  capability: "drafts.create",
                  previewId: command.preview_id,
                  authorizationId: command.external_authorization_id,
                  to: command.recipient,
                  subject: command.subject,
                  body: command.body,
                  renderedPayloadHash: command.rendered_payload_hash,
                },
              }
            : {}),
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
      if (
        prepared.command.provider_name === "gmail_draft" &&
        output.outcome === "succeeded"
      ) {
        await appendAuditEvent(client, {
          organizationId: prepared.command.organization_id,
          actorType: "service",
          actorId: provider.id,
          eventType: "gmail_draft.created",
          workflowId: row.workflow_id,
          sourceRecordIds: [],
          inputHash: prepared.command.action_payload_hash,
          outputHash,
          traceId: job.trace_id,
          requestId: job.request_id,
          metadata: {
            taskId: row.task_id,
            approvalId: row.approval_id,
            executionCommandId: prepared.command.id,
            executionResultId,
            previewId: prepared.command.preview_id,
            authorizationId: prepared.command.external_authorization_id,
            authorizerUserId: prepared.command.authorized_by_user_id,
            connectorConfigVersionId:
              prepared.command.connector_config_version_id,
            connector: "gmail",
            capability: "drafts.create",
            renderedPayloadHash: prepared.command.rendered_payload_hash,
            draftId: output.output.draftId,
            executorId: provider.id,
            workflowState: row.resulting_workflow_state,
            workflowVersion: row.workflow_version,
          },
          occurredAt: completedAt,
        });
      }

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
  internalProvider: ExecutionProvider,
  gmailDraftProvider: ExecutionProvider,
  credentialRuntime?: GmailCredentialRuntime,
): Promise<void> {
  const prepared = await prepareExecution(
    pool,
    job,
    internalProvider,
    gmailDraftProvider,
  );
  if (!prepared) {
    return;
  }
  const provider =
    prepared.command.provider_name === "gmail_draft"
      ? gmailDraftProvider
      : internalProvider;

  let untrustedOutput: unknown;
  const credential =
    prepared.command.provider_name === "gmail_draft"
      ? await loadExecutionCredential(
          pool,
          credentialRuntime ??
            (() => {
              throw new Error("Gmail credential runtime is unavailable");
            })(),
          {
            organizationId: prepared.command.organization_id,
            userId: job.requested_by_user_id,
            credentialVersionId: prepared.command.active_credential_version_id!,
            traceId: job.trace_id,
            requestId: job.request_id,
          },
        )
      : undefined;
  const redactionSecrets = credential ? [credential.reveal()] : [];
  try {
    untrustedOutput = await provider.execute(prepared.action, {
      traceId: job.trace_id,
      requestId: job.request_id,
      commandId: prepared.command.id,
      idempotencyKey: job.idempotency_key,
      ...(credential ? { connectorCredential: credential } : {}),
    });
  } catch (error) {
    if (prepared.command.provider_name === "gmail_draft") {
      await recordExecutionCredentialUse(pool, {
        organizationId: prepared.command.organization_id,
        userId: job.requested_by_user_id,
        credentialVersionId: prepared.command.active_credential_version_id!,
        traceId: job.trace_id,
        requestId: job.request_id,
        outcome: "failed",
      });
    }
    throw new ExecutionAttemptError(
      error instanceof Error
        ? redactSensitiveText(error.message, redactionSecrets)
        : "Execution provider failed",
      "executor_call_failed",
      {},
      prepared.startedAt,
    );
  } finally {
    credential?.dispose();
  }

  let output: ExecutionProviderOutput;
  try {
    output = executionProviderOutputSchema.parse(untrustedOutput);
    if (prepared.command.provider_name === "gmail_draft") {
      gmailDraftProviderOutputSchema.parse(untrustedOutput);
      if (
        output.output.renderedPayloadHash !==
        prepared.command.rendered_payload_hash
      ) {
        throw new Error("Gmail draft output payload hash did not match");
      }
    }
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

  if (prepared.command.provider_name === "gmail_draft") {
    await recordExecutionCredentialUse(pool, {
      organizationId: prepared.command.organization_id,
      userId: job.requested_by_user_id,
      credentialVersionId: prepared.command.active_credential_version_id!,
      traceId: job.trace_id,
      requestId: job.request_id,
      outcome: output.outcome,
    });
  }

  await persistExecutionOutcome(pool, job, provider, prepared, output, null);
}

export async function finalizeInternalExecutionFailure(
  pool: DatabasePool,
  job: OutboxJob,
  internalProvider: ExecutionProvider,
  gmailDraftProvider: ExecutionProvider,
  failure: unknown,
): Promise<void> {
  const prepared = await prepareExecution(
    pool,
    job,
    internalProvider,
    gmailDraftProvider,
  );
  if (!prepared) {
    return;
  }
  const provider =
    prepared.command.provider_name === "gmail_draft"
      ? gmailDraftProvider
      : internalProvider;
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
