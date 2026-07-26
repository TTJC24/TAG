import { randomUUID } from "node:crypto";
import { appendAuditEvent, sha256 } from "@operating-layer/audit";
import {
  assertExactGmailCredentialScopes,
  GMAIL_CREDENTIAL_SCOPE_ALLOWLIST,
  type ConnectorCredentialEncryptor,
} from "@operating-layer/connectors";
import { withOrganizationScope, type DatabasePool } from "@operating-layer/db";
import {
  gmailCredentialInputSchema,
  gmailCredentialResponseSchema,
  gmailCredentialRevokeInputSchema,
  gmailCredentialRevokeResponseSchema,
  gmailGlobalKillInputSchema,
  type GmailCredentialInput,
  type GmailCredentialResponse,
  type GmailCredentialRevokeInput,
  type GmailCredentialRevokeResponse,
} from "@operating-layer/schemas";
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
import { DomainError } from "./errors.js";

export interface StoreGmailCredentialCommand {
  principal: ApplicationPrincipal;
  input: GmailCredentialInput;
  idempotencyKey: string;
  context: RequestContext;
}

export async function storeGmailCredential(
  pool: DatabasePool,
  encryptor: ConnectorCredentialEncryptor,
  command: StoreGmailCredentialCommand,
): Promise<GmailCredentialResponse> {
  const input = gmailCredentialInputSchema.parse(command.input);
  requireOrganizationPermission(
    command.principal,
    input.organizationId,
    "connectors.admin",
  );
  try {
    assertExactGmailCredentialScopes(input.grantedScopes);
  } catch {
    throw new DomainError(
      400,
      "gmail_credential_scope_rejected",
      "Gmail credential scopes must match the exact approved allowlist",
    );
  }
  const idempotencyKey = ensureIdempotencyKey(command.idempotencyKey);
  const credentialVersionId = randomUUID();
  const envelope = encryptor.encrypt(input.accessToken, {
    organizationId: input.organizationId,
    credentialVersionId,
  });
  const requestHash = sha256({
    organizationId: input.organizationId,
    fingerprint: envelope.fingerprint,
    grantedScopes: input.grantedScopes,
    reason: input.reason,
  });
  const scope = "gmail_draft_credential_store";

  return withOrganizationScope(
    pool,
    {
      userId: command.principal.userId,
      organizationIds: [input.organizationId],
    },
    async (client) => {
      const claim = await claimIdempotentCommand<GmailCredentialResponse>(
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
      const stored = await client.query<{
        credential_version_id: string;
        version_number: number;
        replaced_credential_version_id: string | null;
        revocation_outbox_event_id: string | null;
      }>(
        `SELECT * FROM store_gmail_draft_credential(
           $1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11, $12
         )`,
        [
          credentialVersionId,
          input.organizationId,
          envelope.algorithm,
          envelope.ciphertext,
          envelope.nonce,
          envelope.authenticationTag,
          envelope.wrappedDataKey,
          envelope.fingerprint,
          input.grantedScopes,
          input.reason,
          command.context.traceId,
          command.context.requestId,
        ],
      );
      const row = stored.rows[0]!;
      const eventType = row.replaced_credential_version_id
        ? "gmail_draft.credential_rotated"
        : "gmail_draft.credential_enabled";
      await appendAuditEvent(client, {
        organizationId: input.organizationId,
        actorType: "user",
        actorId: command.principal.userId,
        eventType,
        sourceRecordIds: [],
        inputHash: requestHash,
        outputHash: sha256({
          credentialVersionId,
          versionNumber: row.version_number,
          fingerprint: envelope.fingerprint,
        }),
        traceId: command.context.traceId,
        requestId: command.context.requestId,
        metadata: {
          credentialVersionId,
          versionNumber: row.version_number,
          replacedCredentialVersionId: row.replaced_credential_version_id,
          revocationOutboxEventId: row.revocation_outbox_event_id,
          tokenFingerprint: envelope.fingerprint,
          algorithm: envelope.algorithm,
          grantedScopes: input.grantedScopes,
          reason: input.reason,
        },
        occurredAt: new Date().toISOString(),
      });
      const response = gmailCredentialResponseSchema.parse({
        credentialVersionId,
        organizationId: input.organizationId,
        versionNumber: row.version_number,
        replacedCredentialVersionId: row.replaced_credential_version_id,
        revocationOutboxEventId: row.revocation_outbox_event_id,
        grantedScopes: input.grantedScopes,
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

export interface RevokeGmailCredentialCommand {
  principal: ApplicationPrincipal;
  input: GmailCredentialRevokeInput;
  idempotencyKey: string;
  context: RequestContext;
}

export async function revokeGmailCredential(
  pool: DatabasePool,
  command: RevokeGmailCredentialCommand,
): Promise<GmailCredentialRevokeResponse> {
  const input = gmailCredentialRevokeInputSchema.parse(command.input);
  requireOrganizationPermission(
    command.principal,
    input.organizationId,
    "connectors.admin",
  );
  const idempotencyKey = ensureIdempotencyKey(command.idempotencyKey);
  const requestHash = sha256(input);
  const scope = "gmail_draft_credential_revoke";
  return withOrganizationScope(
    pool,
    {
      userId: command.principal.userId,
      organizationIds: [input.organizationId],
    },
    async (client) => {
      const claim = await claimIdempotentCommand<GmailCredentialRevokeResponse>(
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
      const result = await client.query<{
        invalidated_credential_version_id: string | null;
        revocation_outbox_event_id: string | null;
      }>("SELECT * FROM invalidate_gmail_draft_credential($1, $2, $3, $4)", [
        input.organizationId,
        input.reason,
        command.context.traceId,
        command.context.requestId,
      ]);
      const row = result.rows[0]!;
      await appendAuditEvent(client, {
        organizationId: input.organizationId,
        actorType: "user",
        actorId: command.principal.userId,
        eventType: "gmail_draft.credential_revocation_requested",
        sourceRecordIds: [],
        inputHash: requestHash,
        outputHash: sha256(row),
        traceId: command.context.traceId,
        requestId: command.context.requestId,
        metadata: {
          credentialVersionId: row.invalidated_credential_version_id,
          revocationOutboxEventId: row.revocation_outbox_event_id,
          reason: input.reason,
        },
        occurredAt: new Date().toISOString(),
      });
      const response = gmailCredentialRevokeResponseSchema.parse({
        organizationId: input.organizationId,
        invalidatedCredentialVersionId: row.invalidated_credential_version_id,
        revocationOutboxEventId: row.revocation_outbox_event_id,
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

export async function setGmailGlobalKill(
  pool: DatabasePool,
  command: {
    principal: ApplicationPrincipal;
    input: unknown;
    context: RequestContext;
  },
): Promise<{
  killed: boolean;
  affectedOrganizations: number;
  traceId: string;
}> {
  const input = gmailGlobalKillInputSchema.parse(command.input);
  const organizationIds = command.principal.organizationIds.filter(
    (organizationId) =>
      command.principal.permissionsByOrganization[organizationId]?.includes(
        "admin.manage",
      ),
  );
  if (organizationIds.length === 0) {
    throw new Error("Global connector kill requires admin.manage");
  }
  return withOrganizationScope(
    pool,
    { userId: command.principal.userId, organizationIds },
    async (client) => {
      const changed = await client.query<{
        organization_id: string;
        invalidated_credential_version_id: string;
        revocation_outbox_event_id: string;
      }>("SELECT * FROM set_gmail_draft_global_kill($1, $2, $3, $4)", [
        input.killed,
        command.context.traceId,
        command.context.requestId,
        input.reason,
      ]);
      const auditRows = input.killed
        ? changed.rows
        : organizationIds.map((organization_id) => ({
            organization_id,
            invalidated_credential_version_id: null,
            revocation_outbox_event_id: null,
          }));
      for (const row of auditRows) {
        await appendAuditEvent(client, {
          organizationId: row.organization_id,
          actorType: "user",
          actorId: command.principal.userId,
          eventType: input.killed
            ? "gmail_draft.global_kill_enabled"
            : "gmail_draft.global_kill_cleared",
          sourceRecordIds: [],
          inputHash: sha256(input),
          outputHash: sha256(row),
          traceId: command.context.traceId,
          requestId: command.context.requestId,
          metadata: {
            credentialVersionId: row.invalidated_credential_version_id,
            revocationOutboxEventId: row.revocation_outbox_event_id,
            reason: input.reason,
          },
          occurredAt: new Date().toISOString(),
        });
      }
      return {
        killed: input.killed,
        affectedOrganizations: changed.rowCount ?? 0,
        traceId: command.context.traceId,
      };
    },
  );
}

export { GMAIL_CREDENTIAL_SCOPE_ALLOWLIST };
