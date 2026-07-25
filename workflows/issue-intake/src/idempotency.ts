import { canonicalJson } from "@operating-layer/audit";
import type { DatabaseClient, DatabasePool } from "@operating-layer/db";
import { DomainError } from "./errors.js";

export const DEFAULT_IDEMPOTENCY_RETENTION_SECONDS = 7 * 24 * 60 * 60;
export const IDEMPOTENCY_REAPER_INTERVAL_MS = 15 * 60 * 1000;
export const IDEMPOTENCY_REAPER_BATCH_SIZE = 100;

export function ensureIdempotencyKey(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 200) {
    throw new DomainError(
      400,
      "invalid_idempotency_key",
      "Idempotency-Key must contain 8 to 200 characters",
    );
  }
  return normalized;
}

export type IdempotencyClaim<TResponse> =
  | {
      kind: "claimed";
      retentionPolicyVersionId: string;
      retentionSeconds: number;
    }
  | {
      kind: "replay";
      response: TResponse;
    };

export async function claimIdempotentCommand<TResponse>(
  client: DatabaseClient,
  input: {
    organizationId: string;
    scope: string;
    idempotencyKey: string;
    requestHash: string;
  },
): Promise<IdempotencyClaim<TResponse>> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const retentionResult = await client.query<{
      policy_version_id: string;
      retention_seconds: number;
    }>(
      `SELECT
         version.id AS policy_version_id,
         version.retention_seconds
       FROM idempotency_retention_policy_bindings binding
       JOIN idempotency_retention_policy_versions version
         ON version.id = binding.active_policy_version_id
        AND version.organization_id = binding.organization_id
       WHERE binding.organization_id = $1`,
      [input.organizationId],
    );
    const retention = retentionResult.rows[0];
    if (!retention) {
      throw new DomainError(
        503,
        "idempotency_retention_unavailable",
        "Idempotency retention is not configured for this organization",
      );
    }

    const inserted = await client.query(
      `INSERT INTO idempotency_keys (
         organization_id,
         scope,
         idempotency_key,
         request_hash,
         status,
         retention_policy_version_id,
         retention_seconds_snapshot
       )
       VALUES ($1, $2, $3, $4, 'claimed', $5, $6)
       ON CONFLICT DO NOTHING
       RETURNING idempotency_key`,
      [
        input.organizationId,
        input.scope,
        input.idempotencyKey,
        input.requestHash,
        retention.policy_version_id,
        retention.retention_seconds,
      ],
    );
    if (inserted.rowCount === 1) {
      return {
        kind: "claimed",
        retentionPolicyVersionId: retention.policy_version_id,
        retentionSeconds: retention.retention_seconds,
      };
    }

    const existingResult = await client.query<{
      request_hash: string;
      status: string;
      response_reference: string | null;
      expires_at: Date | string | null;
    }>(
      `SELECT request_hash, status, response_reference, expires_at
       FROM idempotency_keys
       WHERE organization_id = $1
         AND scope = $2
         AND idempotency_key = $3
       FOR UPDATE`,
      [input.organizationId, input.scope, input.idempotencyKey],
    );
    const existing = existingResult.rows[0];
    if (!existing) {
      continue;
    }

    const expired =
      existing.status !== "claimed" &&
      existing.expires_at !== null &&
      new Date(existing.expires_at).getTime() <= Date.now();
    if (expired) {
      await client.query(
        `DELETE FROM idempotency_keys
         WHERE organization_id = $1
           AND scope = $2
           AND idempotency_key = $3
           AND status IN ('completed', 'failed')
           AND expires_at <= transaction_timestamp()`,
        [input.organizationId, input.scope, input.idempotencyKey],
      );
      continue;
    }

    if (existing.request_hash !== input.requestHash) {
      throw new DomainError(
        409,
        "idempotency_key_conflict",
        "The idempotency key was already used with a different request",
      );
    }
    if (existing.status === "completed" && existing.response_reference) {
      return {
        kind: "replay",
        response: JSON.parse(existing.response_reference) as TResponse,
      };
    }
    throw new DomainError(
      409,
      "request_in_progress",
      "A request with this idempotency key is already in progress",
    );
  }

  throw new DomainError(
    409,
    "idempotency_claim_conflict",
    "The idempotency key could not be claimed after concurrent changes",
  );
}

export async function completeIdempotentCommand(
  client: DatabaseClient,
  input: {
    organizationId: string;
    scope: string;
    idempotencyKey: string;
    requestHash: string;
    response: unknown;
  },
): Promise<void> {
  const completed = await client.query(
    `UPDATE idempotency_keys
     SET
       status = 'completed',
       response_reference = $5,
       terminal_at = transaction_timestamp(),
       expires_at = transaction_timestamp()
         + make_interval(secs => retention_seconds_snapshot),
       updated_at = transaction_timestamp()
     WHERE organization_id = $1
       AND scope = $2
       AND idempotency_key = $3
       AND request_hash = $4
       AND status = 'claimed'`,
    [
      input.organizationId,
      input.scope,
      input.idempotencyKey,
      input.requestHash,
      canonicalJson(input.response),
    ],
  );
  if (completed.rowCount !== 1) {
    throw new Error("Idempotency claim could not be completed");
  }
}

export interface IdempotencyReaperResult {
  reaperRunId: string;
  deletedCount: number;
  cutoffAt: string;
}

export async function reapExpiredIdempotencyKeys(
  pool: DatabasePool,
  traceId: string,
  batchSize = IDEMPOTENCY_REAPER_BATCH_SIZE,
): Promise<IdempotencyReaperResult> {
  const result = await pool.query<{
    reaper_run_id: string;
    deleted_count: number;
    cutoff_at: Date | string;
  }>(
    `SELECT *
     FROM operating_layer.reap_expired_idempotency_keys($1, $2)`,
    [batchSize, traceId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Idempotency reaper did not return a run result");
  }
  return {
    reaperRunId: row.reaper_run_id,
    deletedCount: row.deleted_count,
    cutoffAt:
      row.cutoff_at instanceof Date
        ? row.cutoff_at.toISOString()
        : new Date(row.cutoff_at).toISOString(),
  };
}
