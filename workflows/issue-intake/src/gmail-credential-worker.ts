import { appendAuditEvent, sha256 } from "@operating-layer/audit";
import {
  EphemeralConnectorCredential,
  assertExactGmailCredentialScopes,
  type ConnectorCredentialDecryptor,
  type EncryptedCredentialEnvelope,
} from "@operating-layer/connectors";
import {
  withWorkerOrganizationScope,
  type DatabasePool,
} from "@operating-layer/db";
import type { OutboxJob } from "./worker.js";

export interface OAuthTokenRevoker {
  readonly enabled: boolean;
  revoke(accessToken: string): Promise<void>;
}

export class DisabledOAuthTokenRevoker implements OAuthTokenRevoker {
  readonly enabled = false;
  async revoke(_accessToken: string): Promise<void> {
    throw new Error("OAuth revocation network access is disabled");
  }
}

export class GoogleOAuthTokenRevoker implements OAuthTokenRevoker {
  readonly enabled = true;
  async revoke(accessToken: string): Promise<void> {
    const response = await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: accessToken }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`OAuth revocation failed with HTTP ${response.status}`);
    }
  }
}

export interface GmailCredentialRuntime {
  decryptor: ConnectorCredentialDecryptor;
  revoker: OAuthTokenRevoker;
}

export async function assertGmailCredentialStartup(
  pool: DatabasePool,
  runtime: GmailCredentialRuntime,
): Promise<void> {
  if (!runtime.decryptor || !runtime.revoker) {
    throw new Error("Gmail credential runtime dependencies are required");
  }
  const result = await pool.query<{
    unsafe_legacy_references: string;
    enabled_without_active_credential: string;
  }>(
    "SELECT * FROM operating_layer.assert_gmail_credential_storage_invariants()",
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
  runtime: GmailCredentialRuntime,
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
        "SELECT * FROM load_gmail_draft_credential($1, $2, $3, $4)",
        [
          input.credentialVersionId,
          input.organizationId,
          "gmail_draft_create",
          input.traceId,
        ],
      );
      const row = loaded.rows[0];
      if (!row) {
        throw new Error("Active Gmail credential was not available");
      }
      assertExactGmailCredentialScopes(row.granted_scopes);
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
        actorId: "gmail-credential-worker",
        eventType: "gmail_draft.credential_loaded",
        sourceRecordIds: [],
        inputHash: sha256({
          credentialVersionId: input.credentialVersionId,
          purpose: "gmail_draft_create",
        }),
        outputHash: sha256({ fingerprint: row.token_fingerprint }),
        traceId: input.traceId,
        requestId: input.requestId,
        metadata: {
          credentialVersionId: input.credentialVersionId,
          tokenFingerprint: row.token_fingerprint,
          grantedScopes: row.granted_scopes,
          purpose: "gmail_draft_create",
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
        "SELECT record_gmail_credential_use($1, $2, 'used', $3, $4, $5::jsonb)",
        [
          input.credentialVersionId,
          input.organizationId,
          "gmail_draft_create",
          input.traceId,
          JSON.stringify({ outcome: input.outcome }),
        ],
      );
      await appendAuditEvent(client, {
        organizationId: input.organizationId,
        actorType: "service",
        actorId: "gmail-credential-worker",
        eventType: "gmail_draft.credential_used",
        sourceRecordIds: [],
        inputHash: sha256({
          credentialVersionId: input.credentialVersionId,
          purpose: "gmail_draft_create",
        }),
        outputHash: sha256({ outcome: input.outcome }),
        traceId: input.traceId,
        requestId: input.requestId,
        metadata: {
          credentialVersionId: input.credentialVersionId,
          purpose: "gmail_draft_create",
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
  runtime: GmailCredentialRuntime,
): Promise<void> {
  await withWorkerOrganizationScope(
    pool,
    {
      userId: job.requested_by_user_id,
      organizationIds: [job.organization_id],
    },
    async (client) => {
      const loaded = await client.query<CredentialEnvelopeRow>(
        "SELECT * FROM load_gmail_draft_credential($1, $2, $3, $4)",
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
        try {
          await runtime.revoker.revoke(token);
        } catch {
          throw new Error("OAuth credential revocation failed");
        }
        await client.query(
          "SELECT record_gmail_credential_use($1, $2, 'revoked', $3, $4, $5::jsonb)",
          [
            job.aggregate_id,
            job.organization_id,
            "oauth_revocation",
            job.trace_id,
            JSON.stringify({ revokerEnabled: runtime.revoker.enabled }),
          ],
        );
        await appendAuditEvent(client, {
          organizationId: job.organization_id,
          actorType: "service",
          actorId: "gmail-credential-worker",
          eventType: "gmail_draft.credential_revoked",
          sourceRecordIds: [],
          inputHash: sha256({
            credentialVersionId: job.aggregate_id,
            purpose: "oauth_revocation",
          }),
          outputHash: sha256({ revoked: true }),
          traceId: job.trace_id,
          requestId: job.request_id,
          metadata: {
            credentialVersionId: job.aggregate_id,
            tokenFingerprint: row.token_fingerprint,
            purpose: "oauth_revocation",
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
        "SELECT record_gmail_credential_use($1, $2, 'revocation_failed', $3, $4, $5::jsonb)",
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
        actorId: "gmail-credential-worker",
        eventType: "gmail_draft.credential_revocation_failed",
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
