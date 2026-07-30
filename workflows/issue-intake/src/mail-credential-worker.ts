import { appendAuditEvent, sha256 } from "@operating-layer/audit";
import {
  EphemeralConnectorCredential,
  assertExactMailCredentialScopes,
  type ConnectorCredentialDecryptor,
  type EncryptedCredentialEnvelope,
} from "@operating-layer/connectors";
import {
  withWorkerOrganizationScope,
  type DatabasePool,
} from "@operating-layer/db";
import type { OutboxJob } from "./worker.js";

/**
 * What actually happened when we tried to revoke remotely.
 *
 * This is a result rather than a bare void because the honest answer differs by
 * provider, and reporting "revoked" for something that did not happen would
 * misrepresent a safety control in the audit trail.
 */
export interface TokenRevocationOutcome {
  remote: "revoked" | "unsupported_by_provider";
  detail: string;
}

export interface OAuthTokenRevoker {
  readonly enabled: boolean;
  revoke(accessToken: string): Promise<TokenRevocationOutcome>;
}

export class DisabledOAuthTokenRevoker implements OAuthTokenRevoker {
  readonly enabled = false;
  async revoke(_accessToken: string): Promise<TokenRevocationOutcome> {
    throw new Error("OAuth revocation network access is disabled");
  }
}

/**
 * Microsoft Graph revocation — and the honest limits of it.
 *
 * There is no per-token revocation endpoint. A Graph access token is a signed
 * JWT that stays valid until it expires (about an hour); nothing can call it
 * back. The two things that genuinely revoke access both sit outside this
 * worker's permission set on purpose:
 *
 *  - rotating or removing the app registration's secret in Entra (admin action)
 *  - `POST /users/{id}/revokeSignInSessions`, which needs a scope we
 *    deliberately do not hold — the grant is pinned to Mail.ReadWrite alone.
 *
 * So this reports `unsupported_by_provider` rather than claiming a revoke it did
 * not perform. The controls that DO take effect immediately are local: the
 * credential is marked invalid so the worker stops using it, and the kill switch
 * stops the connector outright. Both are enforced by the database, not by a
 * remote service being reachable.
 */
export class GraphOAuthTokenRevoker implements OAuthTokenRevoker {
  readonly enabled = true;
  async revoke(_accessToken: string): Promise<TokenRevocationOutcome> {
    return {
      remote: "unsupported_by_provider",
      detail:
        "Microsoft Graph has no per-token revocation endpoint; the token expires on its own. Access was stopped locally (credential invalidated). To revoke for real, rotate the app registration secret in Entra.",
    };
  }
}

export interface MailCredentialRuntime {
  decryptor: ConnectorCredentialDecryptor;
  revoker: OAuthTokenRevoker;
}

export async function assertMailCredentialStartup(
  pool: DatabasePool,
  runtime: MailCredentialRuntime,
): Promise<void> {
  if (!runtime.decryptor || !runtime.revoker) {
    throw new Error("Outlook credential runtime dependencies are required");
  }
  const result = await pool.query<{
    unsafe_legacy_references: string;
    enabled_without_active_credential: string;
  }>(
    "SELECT * FROM operating_layer.assert_mail_credential_storage_invariants()",
  );
  const row = result.rows[0];
  if (
    !row ||
    Number(row.unsafe_legacy_references) > 0 ||
    Number(row.enabled_without_active_credential) > 0
  ) {
    throw new Error(
      "Connector credential startup invariant failed: plaintext/legacy references or enabled connector without an active encrypted credential",
    );
  }
}

interface CredentialEnvelopeRow {
  credential_version_id: string;
  algorithm: EncryptedCredentialEnvelope["algorithm"];
  ciphertext: string;
  nonce: string;
  authentication_tag: string;
  wrapped_data_key: string;
  token_fingerprint: string;
  granted_scopes: string[];
}

export async function loadExecutionCredential(
  pool: DatabasePool,
  runtime: MailCredentialRuntime,
  input: {
    organizationId: string;
    userId: string;
    credentialVersionId: string;
    traceId: string;
    requestId: string;
  },
): Promise<EphemeralConnectorCredential> {
  return withWorkerOrganizationScope(
    pool,
    { userId: input.userId, organizationIds: [input.organizationId] },
    async (client) => {
      const loaded = await client.query<CredentialEnvelopeRow>(
        "SELECT * FROM load_mail_draft_credential($1, $2, $3, $4)",
        [
          input.credentialVersionId,
          input.organizationId,
          "mail_draft_create",
          input.traceId,
        ],
      );
      const row = loaded.rows[0];
      if (!row) {
        throw new Error("Active Outlook credential was not available");
      }
      assertExactMailCredentialScopes(row.granted_scopes);
      const plaintext = runtime.decryptor.decrypt(
        {
          algorithm: row.algorithm,
          ciphertext: row.ciphertext,
          nonce: row.nonce,
          authenticationTag: row.authentication_tag,
          wrappedDataKey: row.wrapped_data_key,
          fingerprint: row.token_fingerprint,
        },
        {
          organizationId: input.organizationId,
          credentialVersionId: input.credentialVersionId,
        },
      );
      await appendAuditEvent(client, {
        organizationId: input.organizationId,
        actorType: "service",
        actorId: "mail-credential-worker",
        eventType: "mail_draft.credential_loaded",
        sourceRecordIds: [],
        inputHash: sha256({
          credentialVersionId: input.credentialVersionId,
          purpose: "mail_draft_create",
        }),
        outputHash: sha256({ fingerprint: row.token_fingerprint }),
        traceId: input.traceId,
        requestId: input.requestId,
        metadata: {
          credentialVersionId: input.credentialVersionId,
          tokenFingerprint: row.token_fingerprint,
          grantedScopes: row.granted_scopes,
          purpose: "mail_draft_create",
        },
        occurredAt: new Date().toISOString(),
      });
      return new EphemeralConnectorCredential(plaintext);
    },
  );
}

export async function recordExecutionCredentialUse(
  pool: DatabasePool,
  input: {
    organizationId: string;
    userId: string;
    credentialVersionId: string;
    traceId: string;
    requestId: string;
    outcome: string;
  },
): Promise<void> {
  await withWorkerOrganizationScope(
    pool,
    { userId: input.userId, organizationIds: [input.organizationId] },
    async (client) => {
      await client.query(
        "SELECT record_mail_credential_use($1, $2, 'used', $3, $4, $5::jsonb)",
        [
          input.credentialVersionId,
          input.organizationId,
          "mail_draft_create",
          input.traceId,
          JSON.stringify({ outcome: input.outcome }),
        ],
      );
      await appendAuditEvent(client, {
        organizationId: input.organizationId,
        actorType: "service",
        actorId: "mail-credential-worker",
        eventType: "mail_draft.credential_used",
        sourceRecordIds: [],
        inputHash: sha256({
          credentialVersionId: input.credentialVersionId,
          purpose: "mail_draft_create",
        }),
        outputHash: sha256({ outcome: input.outcome }),
        traceId: input.traceId,
        requestId: input.requestId,
        metadata: {
          credentialVersionId: input.credentialVersionId,
          purpose: "mail_draft_create",
          outcome: input.outcome,
        },
        occurredAt: new Date().toISOString(),
      });
    },
  );
}

export async function processCredentialRevocationJob(
  pool: DatabasePool,
  job: OutboxJob,
  runtime: MailCredentialRuntime,
): Promise<void> {
  await withWorkerOrganizationScope(
    pool,
    {
      userId: job.requested_by_user_id,
      organizationIds: [job.organization_id],
    },
    async (client) => {
      const loaded = await client.query<CredentialEnvelopeRow>(
        "SELECT * FROM load_mail_draft_credential($1, $2, $3, $4)",
        [
          job.aggregate_id,
          job.organization_id,
          "oauth_revocation",
          job.trace_id,
        ],
      );
      const row = loaded.rows[0];
      if (!row) {
        throw new Error("Credential pending revocation was not available");
      }
      const token = runtime.decryptor.decrypt(
        {
          algorithm: row.algorithm,
          ciphertext: row.ciphertext,
          nonce: row.nonce,
          authenticationTag: row.authentication_tag,
          wrappedDataKey: row.wrapped_data_key,
          fingerprint: row.token_fingerprint,
        },
        {
          organizationId: job.organization_id,
          credentialVersionId: job.aggregate_id,
        },
      );
      try {
        let outcome;
        try {
          outcome = await runtime.revoker.revoke(token);
        } catch {
          throw new Error("OAuth credential revocation failed");
        }
        await client.query(
          "SELECT record_mail_credential_use($1, $2, 'revoked', $3, $4, $5::jsonb)",
          [
            job.aggregate_id,
            job.organization_id,
            "oauth_revocation",
            job.trace_id,
            // Record what actually happened remotely. With Graph this is
            // "unsupported_by_provider": the credential is stopped locally, and
            // the audit trail must not imply a remote revoke that cannot exist.
            JSON.stringify({
              revokerEnabled: runtime.revoker.enabled,
              remoteRevocation: outcome.remote,
              remoteRevocationDetail: outcome.detail,
            }),
          ],
        );
        await appendAuditEvent(client, {
          organizationId: job.organization_id,
          actorType: "service",
          actorId: "mail-credential-worker",
          eventType: "mail_draft.credential_revoked",
          sourceRecordIds: [],
          inputHash: sha256({
            credentialVersionId: job.aggregate_id,
            purpose: "oauth_revocation",
          }),
          outputHash: sha256({
            localCredentialInvalidated: true,
            remoteRevocation: outcome.remote,
          }),
          traceId: job.trace_id,
          requestId: job.request_id,
          metadata: {
            credentialVersionId: job.aggregate_id,
            tokenFingerprint: row.token_fingerprint,
            purpose: "oauth_revocation",
            remoteRevocation: outcome.remote,
          },
          occurredAt: new Date().toISOString(),
        });
        await client.query(
          `UPDATE outbox_events SET status = 'published', published_at = now(),
             locked_at = NULL, locked_by = NULL, safe_error_message = NULL,
             last_error_code = NULL
           WHERE id = $1 AND organization_id = $2`,
          [job.id, job.organization_id],
        );
      } finally {
        // JS strings cannot be zeroed; the reference does not escape this scope.
      }
    },
  );
}

export async function recordCredentialRevocationFailure(
  pool: DatabasePool,
  job: OutboxJob,
): Promise<void> {
  await withWorkerOrganizationScope(
    pool,
    {
      userId: job.requested_by_user_id,
      organizationIds: [job.organization_id],
    },
    async (client) => {
      await client.query(
        "SELECT record_mail_credential_use($1, $2, 'revocation_failed', $3, $4, $5::jsonb)",
        [
          job.aggregate_id,
          job.organization_id,
          "oauth_revocation",
          job.trace_id,
          JSON.stringify({ attempts: job.attempts }),
        ],
      );
      await appendAuditEvent(client, {
        organizationId: job.organization_id,
        actorType: "service",
        actorId: "mail-credential-worker",
        eventType: "mail_draft.credential_revocation_failed",
        sourceRecordIds: [],
        inputHash: sha256({
          credentialVersionId: job.aggregate_id,
          purpose: "oauth_revocation",
        }),
        outputHash: sha256({ attempts: job.attempts, exhausted: true }),
        traceId: job.trace_id,
        requestId: job.request_id,
        metadata: {
          credentialVersionId: job.aggregate_id,
          purpose: "oauth_revocation",
          attempts: job.attempts,
          exhausted: true,
        },
        occurredAt: new Date().toISOString(),
      });
    },
  );
}
