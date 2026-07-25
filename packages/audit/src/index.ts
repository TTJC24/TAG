import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

export type AuditActorType = "user" | "service" | "agent" | "system";

export interface AuditEventInput {
  organizationId: string;
  actorType: AuditActorType;
  actorId: string;
  eventType: string;
  traceId: string;
  requestId: string;
  workflowId?: string;
  sourceRecordIds: readonly string[];
  inputHash?: string;
  outputHash?: string;
  metadata: Readonly<Record<string, unknown>>;
  occurredAt: string;
}

export interface PersistedAuditEvent extends AuditEventInput {
  id: string;
  streamSequence: number;
  previousHash?: string;
  eventHash: string;
}

export interface AuditWriter {
  append(event: AuditEventInput): Promise<PersistedAuditEvent>;
}

export interface AuditChainVerification {
  valid: boolean;
  organizationId: string;
  checkedEvents: number;
  errors: readonly {
    streamSequence: number | null;
    code:
      | "sequence_gap"
      | "previous_hash_mismatch"
      | "event_hash_mismatch"
      | "stream_head_mismatch";
  }[];
}

function normalizeCanonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeCanonical);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeCanonical(entry)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeCanonical(value));
}

export function sha256(value: unknown): string {
  const serialized = typeof value === "string" ? value : canonicalJson(value);
  return createHash("sha256").update(serialized).digest("hex");
}

export function computeAuditEventHash(
  event: AuditEventInput,
  streamSequence: number,
  previousHash: string | null,
): string {
  return sha256({
    ...event,
    streamSequence,
    previousHash,
  });
}

export async function appendAuditEvent(
  client: PoolClient,
  event: AuditEventInput,
): Promise<PersistedAuditEvent> {
  await client.query(
    `INSERT INTO audit_streams (organization_id)
     VALUES ($1)
     ON CONFLICT (organization_id) DO NOTHING`,
    [event.organizationId],
  );

  const streamResult = await client.query<{
    last_sequence: string;
    last_event_hash: string | null;
  }>(
    `SELECT last_sequence, last_event_hash
     FROM audit_streams
     WHERE organization_id = $1
     FOR UPDATE`,
    [event.organizationId],
  );
  const stream = streamResult.rows[0];
  if (!stream) {
    throw new Error("Audit stream is unavailable");
  }

  const streamSequence = Number(stream.last_sequence) + 1;
  const eventHash = computeAuditEventHash(
    event,
    streamSequence,
    stream.last_event_hash,
  );

  const insertResult = await client.query<{ id: string }>(
    `INSERT INTO audit_events (
       organization_id,
       stream_sequence,
       actor_type,
       actor_id,
       event_type,
       workflow_id,
       source_record_ids,
       input_hash,
       output_hash,
       trace_id,
       request_id,
       previous_hash,
       event_hash,
       metadata,
       occurred_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7::uuid[], $8, $9, $10, $11, $12, $13,
       $14::jsonb, $15
     )
     RETURNING id`,
    [
      event.organizationId,
      streamSequence,
      event.actorType,
      event.actorId,
      event.eventType,
      event.workflowId ?? null,
      event.sourceRecordIds,
      event.inputHash ?? null,
      event.outputHash ?? null,
      event.traceId,
      event.requestId,
      stream.last_event_hash,
      eventHash,
      JSON.stringify(event.metadata),
      event.occurredAt,
    ],
  );

  await client.query(
    `UPDATE audit_streams
     SET last_sequence = $2, last_event_hash = $3, updated_at = now()
     WHERE organization_id = $1`,
    [event.organizationId, streamSequence, eventHash],
  );

  return {
    id: insertResult.rows[0]!.id,
    ...event,
    streamSequence,
    ...(stream.last_event_hash ? { previousHash: stream.last_event_hash } : {}),
    eventHash,
  };
}

function isoTimestamp(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

export async function verifyAuditChain(
  client: Pick<PoolClient, "query">,
  organizationId: string,
): Promise<AuditChainVerification> {
  const eventResult = await client.query<{
    organization_id: string;
    stream_sequence: string;
    actor_type: AuditActorType;
    actor_id: string;
    event_type: string;
    workflow_id: string | null;
    source_record_ids: string[];
    input_hash: string | null;
    output_hash: string | null;
    trace_id: string;
    request_id: string;
    previous_hash: string | null;
    event_hash: string;
    metadata: Record<string, unknown>;
    occurred_at: Date | string;
  }>(
    `SELECT
       organization_id,
       stream_sequence,
       actor_type,
       actor_id,
       event_type,
       workflow_id,
       source_record_ids,
       input_hash,
       output_hash,
       trace_id,
       request_id,
       previous_hash,
       event_hash,
       metadata,
       occurred_at
     FROM operating_layer.audit_events
     WHERE organization_id = $1
     ORDER BY stream_sequence`,
    [organizationId],
  );
  const streamResult = await client.query<{
    last_sequence: string;
    last_event_hash: string | null;
  }>(
    `SELECT last_sequence, last_event_hash
     FROM operating_layer.audit_streams
     WHERE organization_id = $1`,
    [organizationId],
  );

  const errors: Array<AuditChainVerification["errors"][number]> = [];
  let priorStoredHash: string | null = null;
  let expectedSequence = 1;

  for (const row of eventResult.rows) {
    const streamSequence = Number(row.stream_sequence);
    if (streamSequence !== expectedSequence) {
      errors.push({ streamSequence, code: "sequence_gap" });
    }
    if (row.previous_hash !== priorStoredHash) {
      errors.push({ streamSequence, code: "previous_hash_mismatch" });
    }

    const event: AuditEventInput = {
      organizationId: row.organization_id,
      actorType: row.actor_type,
      actorId: row.actor_id,
      eventType: row.event_type,
      traceId: row.trace_id,
      requestId: row.request_id,
      sourceRecordIds: row.source_record_ids,
      metadata: row.metadata,
      occurredAt: isoTimestamp(row.occurred_at),
      ...(row.workflow_id ? { workflowId: row.workflow_id } : {}),
      ...(row.input_hash ? { inputHash: row.input_hash } : {}),
      ...(row.output_hash ? { outputHash: row.output_hash } : {}),
    };
    const expectedHash = computeAuditEventHash(
      event,
      streamSequence,
      row.previous_hash,
    );
    if (row.event_hash !== expectedHash) {
      errors.push({ streamSequence, code: "event_hash_mismatch" });
    }

    priorStoredHash = row.event_hash;
    expectedSequence = streamSequence + 1;
  }

  const stream = streamResult.rows[0];
  const finalSequence =
    eventResult.rows.length === 0
      ? 0
      : Number(eventResult.rows[eventResult.rows.length - 1]!.stream_sequence);
  if (
    !stream ||
    Number(stream.last_sequence) !== finalSequence ||
    stream.last_event_hash !== priorStoredHash
  ) {
    errors.push({ streamSequence: null, code: "stream_head_mismatch" });
  }

  return {
    valid: errors.length === 0,
    organizationId,
    checkedEvents: eventResult.rows.length,
    errors,
  };
}
