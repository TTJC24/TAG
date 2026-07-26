import { randomUUID } from "node:crypto";
import { appendAuditEvent, sha256 } from "@operating-layer/audit";
import { withOrganizationScope, type DatabasePool } from "@operating-layer/db";
import {
  gmailDraftAuthorizationInputSchema,
  gmailDraftAuthorizationResponseSchema,
  gmailDraftConnectorConfigInputSchema,
  gmailDraftConnectorConfigResponseSchema,
  gmailDraftPreviewInputSchema,
  gmailDraftPreviewResponseSchema,
  type GmailDraftAuthorizationInput,
  type GmailDraftAuthorizationResponse,
  type GmailDraftConnectorConfigInput,
  type GmailDraftConnectorConfigResponse,
  type GmailDraftPreviewInput,
  type GmailDraftPreviewResponse,
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

const GMAIL_COMPOSE_SCOPE =
  "https://www.googleapis.com/auth/gmail.compose" as const;

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()))].sort();
}

export interface ConfigureGmailDraftConnectorCommand {
  principal: ApplicationPrincipal;
  input: GmailDraftConnectorConfigInput;
  idempotencyKey: string;
  context: RequestContext;
}

export async function configureGmailDraftConnector(
  pool: DatabasePool,
  command: ConfigureGmailDraftConnectorCommand,
): Promise<GmailDraftConnectorConfigResponse> {
  const input = gmailDraftConnectorConfigInputSchema.parse(command.input);
  requireOrganizationPermission(
    command.principal,
    input.organizationId,
    "connectors.admin",
  );
  const idempotencyKey = ensureIdempotencyKey(command.idempotencyKey);
  const addresses = uniqueSorted(input.allowedRecipientAddresses);
  const domains = uniqueSorted(input.allowedRecipientDomains);
  const requestHash = sha256({
    organizationId: input.organizationId,
    enabled: input.enabled,
    allowedRecipientAddresses: addresses,
    allowedRecipientDomains: domains,
    oauthScopes: [GMAIL_COMPOSE_SCOPE],
    reason: input.reason,
  });
  const scope = "gmail_draft_connector_config";

  return withOrganizationScope(
    pool,
    {
      userId: command.principal.userId,
      organizationIds: [input.organizationId],
    },
    async (client) => {
      const claim =
        await claimIdempotentCommand<GmailDraftConnectorConfigResponse>(
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

      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('gmail-draft-global-kill'))",
      );
      const credentialState = await client.query<{
        active_credential_version_id: string | null;
        killed: boolean;
      }>(
        `SELECT binding.active_credential_version_id, kill.killed
         FROM gmail_draft_global_kill_switch kill
         LEFT JOIN gmail_draft_credential_bindings binding
           ON binding.organization_id = $1
         WHERE kill.singleton`,
        [input.organizationId],
      );
      const credential = credentialState.rows[0];
      if (
        input.enabled &&
        (!credential?.active_credential_version_id || credential.killed)
      ) {
        throw new DomainError(
          409,
          "gmail_draft_credential_unavailable",
          "An active, scope-constrained Gmail credential is required",
        );
      }
      const configVersionId = randomUUID();
      const configured = await client.query<{
        config_version_id: string;
        version_number: number;
        binding_version: number;
        enabled: boolean;
      }>(
        `SELECT *
         FROM set_gmail_draft_connector_config(
           $1, $2, $3, $4::text[], $5::text[], $6, $7, $8
         )`,
        [
          configVersionId,
          input.organizationId,
          input.enabled,
          addresses,
          domains,
          input.enabled ? "credential://gmail-draft/active" : null,
          requestHash,
          input.reason,
        ],
      );
      const row = configured.rows[0];
      if (!row) {
        throw new Error("Gmail draft configuration was not persisted");
      }
      let invalidatedCredentialVersionId: string | null = null;
      let revocationOutboxEventId: string | null = null;
      if (!input.enabled) {
        const invalidated = await client.query<{
          invalidated_credential_version_id: string | null;
          revocation_outbox_event_id: string | null;
        }>("SELECT * FROM invalidate_gmail_draft_credential($1, $2, $3, $4)", [
          input.organizationId,
          input.reason,
          command.context.traceId,
          command.context.requestId,
        ]);
        invalidatedCredentialVersionId =
          invalidated.rows[0]?.invalidated_credential_version_id ?? null;
        revocationOutboxEventId =
          invalidated.rows[0]?.revocation_outbox_event_id ?? null;
      }

      await appendAuditEvent(client, {
        organizationId: input.organizationId,
        actorType: "user",
        actorId: command.principal.userId,
        eventType: "gmail_draft.connector_configured",
        sourceRecordIds: [],
        inputHash: requestHash,
        outputHash: sha256({
          configVersionId,
          versionNumber: row.version_number,
          bindingVersion: row.binding_version,
          enabled: row.enabled,
        }),
        traceId: command.context.traceId,
        requestId: command.context.requestId,
        metadata: {
          configVersionId,
          versionNumber: row.version_number,
          bindingVersion: row.binding_version,
          enabled: row.enabled,
          allowedRecipientAddresses: addresses,
          allowedRecipientDomains: domains,
          oauthScopes: [GMAIL_COMPOSE_SCOPE],
          invalidatedCredentialVersionId,
          revocationOutboxEventId,
          reason: input.reason,
        },
        occurredAt: new Date().toISOString(),
      });
      await appendAuditEvent(client, {
        organizationId: input.organizationId,
        actorType: "user",
        actorId: command.principal.userId,
        eventType: input.enabled
          ? "gmail_draft.connector_enabled"
          : "gmail_draft.connector_disabled",
        sourceRecordIds: [],
        inputHash: requestHash,
        outputHash: sha256({
          configVersionId,
          enabled: row.enabled,
          invalidatedCredentialVersionId,
        }),
        traceId: command.context.traceId,
        requestId: command.context.requestId,
        metadata: {
          configVersionId,
          enabled: row.enabled,
          invalidatedCredentialVersionId,
          revocationOutboxEventId,
          reason: input.reason,
        },
        occurredAt: new Date().toISOString(),
      });

      const response = gmailDraftConnectorConfigResponseSchema.parse({
        configVersionId,
        organizationId: input.organizationId,
        versionNumber: row.version_number,
        bindingVersion: row.binding_version,
        enabled: row.enabled,
        allowedRecipientAddresses: addresses,
        allowedRecipientDomains: domains,
        oauthScopes: [GMAIL_COMPOSE_SCOPE],
        reason: input.reason,
        duplicate: false,
        traceId: command.context.traceId,
      });
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

export interface CreateGmailDraftPreviewCommand {
  principal: ApplicationPrincipal;
  approvalId: string;
  input: GmailDraftPreviewInput;
  idempotencyKey: string;
  context: RequestContext;
}

export async function createGmailDraftPreview(
  pool: DatabasePool,
  command: CreateGmailDraftPreviewCommand,
): Promise<GmailDraftPreviewResponse> {
  const input = gmailDraftPreviewInputSchema.parse(command.input);
  requireOrganizationPermission(
    command.principal,
    input.organizationId,
    "external_actions.preview",
  );
  const idempotencyKey = ensureIdempotencyKey(command.idempotencyKey);
  const renderedPayload = {
    to: input.to,
    subject: input.subject,
    body: input.body,
  };
  const renderedPayloadHash = sha256(renderedPayload);
  const requestHash = sha256({
    organizationId: input.organizationId,
    approvalId: command.approvalId,
    renderedPayload,
  });
  const scope = `gmail_draft_preview:${command.approvalId}`;

  return withOrganizationScope(
    pool,
    {
      userId: command.principal.userId,
      organizationIds: [input.organizationId],
    },
    async (client) => {
      const claim = await claimIdempotentCommand<GmailDraftPreviewResponse>(
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

      const contextResult = await client.query<{
        workflow_id: string;
        workflow_version: number;
        task_id: string;
        recommendation_id: string;
        policy_version_id: string;
        policy_content_hash: string;
        root_trace_id: string;
        connector_config_version_id: string | null;
        connector_enabled: boolean | null;
        allowed_recipient_addresses: string[] | null;
        allowed_recipient_domains: string[] | null;
        active_credential_version_id: string | null;
        globally_killed: boolean;
      }>(
        `SELECT
           workflow.id AS workflow_id,
           workflow.version AS workflow_version,
           workflow.task_id,
           recommendation.id AS recommendation_id,
           approval.policy_version_id,
           approval.policy_content_hash,
           approval.decision_trace_id AS root_trace_id,
           binding.active_config_version_id AS connector_config_version_id,
           config.enabled AS connector_enabled,
           config.allowed_recipient_addresses,
           config.allowed_recipient_domains,
           credential_binding.active_credential_version_id,
           kill.killed AS globally_killed
         FROM approvals approval
         JOIN workflows workflow
           ON workflow.id = approval.workflow_id
          AND workflow.organization_id = approval.organization_id
         JOIN recommendations recommendation
           ON approval.payload_reference =
             'recommendation:' || recommendation.id::text
          AND recommendation.organization_id = approval.organization_id
         LEFT JOIN gmail_draft_connector_bindings binding
           ON binding.organization_id = approval.organization_id
         LEFT JOIN gmail_draft_connector_config_versions config
           ON config.id = binding.active_config_version_id
          AND config.organization_id = binding.organization_id
         LEFT JOIN gmail_draft_credential_bindings credential_binding
           ON credential_binding.organization_id = approval.organization_id
         JOIN gmail_draft_global_kill_switch kill ON kill.singleton
         WHERE approval.id = $1
           AND approval.organization_id = $2
           AND approval.status = 'approved'
           AND approval.action_type = 'draft_external_follow_up'
           AND workflow.current_state = 'approved'`,
        [command.approvalId, input.organizationId],
      );
      const context = contextResult.rows[0];
      if (!context) {
        throw new DomainError(
          409,
          "gmail_draft_not_approved",
          "An approved external-draft recommendation is required",
        );
      }
      if (
        !context.connector_enabled ||
        !context.connector_config_version_id ||
        !context.active_credential_version_id ||
        context.globally_killed
      ) {
        throw new DomainError(
          409,
          "gmail_draft_connector_disabled",
          "The Gmail draft connector is disabled for this organization",
        );
      }
      const recipientDomain = input.to.split("@")[1]!;
      if (
        !context.allowed_recipient_addresses?.includes(input.to) &&
        !context.allowed_recipient_domains?.includes(recipientDomain)
      ) {
        throw new DomainError(
          422,
          "gmail_draft_recipient_not_allowed",
          "The draft recipient is not on the organization allowlist",
        );
      }

      const previewId = randomUUID();
      await client.query(
        `INSERT INTO gmail_draft_previews (
           id,
           organization_id,
           workflow_id,
           task_id,
           approval_id,
           recommendation_id,
           connector_config_version_id,
           recipient,
           subject,
           body,
           rendered_payload_hash,
           requested_by_user_id,
           policy_version_id,
           policy_content_hash,
           idempotency_key,
           trace_id,
           request_id
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
           $15, $16, $17
         )`,
        [
          previewId,
          input.organizationId,
          context.workflow_id,
          context.task_id,
          command.approvalId,
          context.recommendation_id,
          context.connector_config_version_id,
          input.to,
          input.subject,
          input.body,
          renderedPayloadHash,
          command.principal.userId,
          context.policy_version_id,
          context.policy_content_hash,
          idempotencyKey,
          context.root_trace_id,
          command.context.requestId,
        ],
      );

      const transitioned = await client.query<{
        current_state: string;
        workflow_version: number;
      }>(
        `SELECT current_state, workflow_version
         FROM transition_workflow(
           $1, $2, $3, $4, 'awaiting_external_authorization',
           'user', $5, $6, $7, $8, $9::jsonb
         )`,
        [
          context.workflow_id,
          input.organizationId,
          `${idempotencyKey}:awaiting-external-authorization`,
          context.workflow_version,
          command.principal.userId,
          requestHash,
          renderedPayloadHash,
          context.root_trace_id,
          JSON.stringify({
            previewId,
            approvalId: command.approvalId,
            taskId: context.task_id,
          }),
        ],
      );
      const transition = transitioned.rows[0];
      if (!transition) {
        throw new Error("Preview transition did not return state");
      }

      await appendAuditEvent(client, {
        organizationId: input.organizationId,
        actorType: "user",
        actorId: command.principal.userId,
        eventType: "gmail_draft.previewed",
        workflowId: context.workflow_id,
        sourceRecordIds: [],
        inputHash: requestHash,
        outputHash: renderedPayloadHash,
        traceId: context.root_trace_id,
        requestId: command.context.requestId,
        metadata: {
          previewId,
          taskId: context.task_id,
          approvalId: command.approvalId,
          connectorConfigVersionId: context.connector_config_version_id,
          policyVersionId: context.policy_version_id,
          renderedPayloadHash,
          recipient: input.to,
          subject: input.subject,
          requestTraceId: command.context.traceId,
          workflowVersion: transition.workflow_version,
        },
        occurredAt: new Date().toISOString(),
      });

      const response = gmailDraftPreviewResponseSchema.parse({
        previewId,
        taskId: context.task_id,
        workflowId: context.workflow_id,
        approvalId: command.approvalId,
        connectorConfigVersionId: context.connector_config_version_id,
        policyVersionId: context.policy_version_id,
        renderedPayload,
        renderedPayloadHash,
        workflowState: transition.current_state,
        duplicate: false,
        traceId: context.root_trace_id,
      });
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

export interface AuthorizeGmailDraftCommand {
  principal: ApplicationPrincipal;
  previewId: string;
  input: GmailDraftAuthorizationInput;
  idempotencyKey: string;
  context: RequestContext;
}

export async function authorizeGmailDraft(
  pool: DatabasePool,
  command: AuthorizeGmailDraftCommand,
): Promise<GmailDraftAuthorizationResponse> {
  const input = gmailDraftAuthorizationInputSchema.parse(command.input);
  requireOrganizationPermission(
    command.principal,
    input.organizationId,
    "external_actions.authorize",
  );
  const idempotencyKey = ensureIdempotencyKey(command.idempotencyKey);
  const requestHash = sha256({
    organizationId: input.organizationId,
    previewId: command.previewId,
    reason: input.reason,
  });
  const scope = `gmail_draft_authorize:${command.previewId}`;

  return withOrganizationScope(
    pool,
    {
      userId: command.principal.userId,
      organizationIds: [input.organizationId],
    },
    async (client) => {
      const claim =
        await claimIdempotentCommand<GmailDraftAuthorizationResponse>(client, {
          organizationId: input.organizationId,
          scope,
          idempotencyKey,
          requestHash,
        });
      if (claim.kind === "replay") {
        return { ...claim.response, duplicate: true };
      }

      const previewResult = await client.query<{
        workflow_id: string;
        workflow_version: number;
        task_id: string;
        approval_id: string;
        connector_config_version_id: string;
        rendered_payload_hash: string;
        trace_id: string;
      }>(
        `SELECT
           preview.workflow_id,
           workflow.version AS workflow_version,
           preview.task_id,
           preview.approval_id,
           preview.connector_config_version_id,
           preview.rendered_payload_hash,
           preview.trace_id
         FROM gmail_draft_previews preview
         JOIN workflows workflow
           ON workflow.id = preview.workflow_id
          AND workflow.organization_id = preview.organization_id
         WHERE preview.id = $1
           AND preview.organization_id = $2`,
        [command.previewId, input.organizationId],
      );
      const preview = previewResult.rows[0];
      if (!preview) {
        throw new DomainError(
          404,
          "gmail_draft_preview_not_found",
          "Gmail draft preview not found",
        );
      }

      const authorizationId = randomUUID();
      await client.query(
        `INSERT INTO gmail_draft_authorizations (
           id,
           organization_id,
           preview_id,
           workflow_id,
           task_id,
           approval_id,
           connector_config_version_id,
           rendered_payload_hash,
           authorized_by_user_id,
           reason,
           idempotency_key,
           trace_id,
           request_id
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
         )`,
        [
          authorizationId,
          input.organizationId,
          command.previewId,
          preview.workflow_id,
          preview.task_id,
          preview.approval_id,
          preview.connector_config_version_id,
          preview.rendered_payload_hash,
          command.principal.userId,
          input.reason,
          idempotencyKey,
          preview.trace_id,
          command.context.requestId,
        ],
      );

      const transitioned = await client.query<{
        current_state: string;
        workflow_version: number;
      }>(
        `SELECT current_state, workflow_version
         FROM transition_workflow(
           $1, $2, $3, $4, 'external_authorized',
           'user', $5, $6, $7, $8, $9::jsonb
         )`,
        [
          preview.workflow_id,
          input.organizationId,
          `${idempotencyKey}:external-authorized`,
          preview.workflow_version,
          command.principal.userId,
          requestHash,
          preview.rendered_payload_hash,
          preview.trace_id,
          JSON.stringify({
            previewId: command.previewId,
            authorizationId,
            approvalId: preview.approval_id,
          }),
        ],
      );
      const transition = transitioned.rows[0];
      if (!transition) {
        throw new Error("Authorization transition did not return state");
      }

      const executionCommandId = randomUUID();
      const outboxEventId = randomUUID();
      const enqueued = await client.query<{
        execution_command_id: string;
        outbox_event_id: string;
      }>(
        `SELECT execution_command_id, outbox_event_id
         FROM enqueue_gmail_draft_execution(
           $1, $2, $3, $4, $5, $6, $7
         )`,
        [
          executionCommandId,
          outboxEventId,
          authorizationId,
          input.organizationId,
          idempotencyKey,
          preview.trace_id,
          command.context.requestId,
        ],
      );
      if (!enqueued.rows[0]) {
        throw new Error("Gmail draft execution was not queued");
      }

      const now = new Date().toISOString();
      await appendAuditEvent(client, {
        organizationId: input.organizationId,
        actorType: "user",
        actorId: command.principal.userId,
        eventType: "gmail_draft.authorized",
        workflowId: preview.workflow_id,
        sourceRecordIds: [],
        inputHash: requestHash,
        outputHash: sha256({
          authorizationId,
          executionCommandId,
          outboxEventId,
        }),
        traceId: preview.trace_id,
        requestId: command.context.requestId,
        metadata: {
          authorizationId,
          previewId: command.previewId,
          approvalId: preview.approval_id,
          taskId: preview.task_id,
          connectorConfigVersionId: preview.connector_config_version_id,
          renderedPayloadHash: preview.rendered_payload_hash,
          reason: input.reason,
          executionCommandId,
          outboxEventId,
          workflowVersion: transition.workflow_version,
          requestTraceId: command.context.traceId,
        },
        occurredAt: now,
      });
      await appendAuditEvent(client, {
        organizationId: input.organizationId,
        actorType: "user",
        actorId: command.principal.userId,
        eventType: "execution.requested",
        workflowId: preview.workflow_id,
        sourceRecordIds: [],
        inputHash: preview.rendered_payload_hash,
        outputHash: sha256({
          executionCommandId,
          outboxEventId,
          provider: "gmail_draft",
        }),
        traceId: preview.trace_id,
        requestId: command.context.requestId,
        metadata: {
          taskId: preview.task_id,
          approvalId: preview.approval_id,
          executionCommandId,
          outboxEventId,
          externalAuthorizationId: authorizationId,
          actionType: "gmail_draft_create",
          actionPayloadHash: preview.rendered_payload_hash,
          provider: "gmail_draft",
        },
        occurredAt: now,
      });

      const response = gmailDraftAuthorizationResponseSchema.parse({
        authorizationId,
        previewId: command.previewId,
        executionCommandId,
        outboxEventId,
        taskId: preview.task_id,
        workflowId: preview.workflow_id,
        approvalId: preview.approval_id,
        renderedPayloadHash: preview.rendered_payload_hash,
        workflowState: transition.current_state,
        duplicate: false,
        traceId: preview.trace_id,
      });
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
