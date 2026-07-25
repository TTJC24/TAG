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
  const eventHash = sha256({
    ...event,
    streamSequence,
    previousHash: stream.last_event_hash,
  });

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
