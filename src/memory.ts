/**
 * Layer 5 feedback loop — Supermemory client wrapper.
 *
 * Talks to the Supermemory REST API directly (no MCP SDK) so the brain gains
 * no new runtime dependency. Facts are scoped per business entity via the
 * Supermemory `containerTag`, one container per entity:
 *
 *   fs     → brain-fs      (Fastening Specialists)
 *   blcs   → brain-blcs    (Big League Construction Supply)
 *   usa    → brain-usa     (Utility Supply Associates)
 *   shared → brain-shared  (cross-entity: M365, general)
 */
import { config } from './config.ts';

/** The three sister companies. `shared` is the cross-entity scope. */
export type Entity = 'fs' | 'blcs' | 'usa';
export type MemoryScope = Entity | 'shared';

const API_BASE = 'https://api.supermemory.ai';

const CONTAINER_TAGS: Record<MemoryScope, string> = {
  fs: 'brain-fs',
  blcs: 'brain-blcs',
  usa: 'brain-usa',
  shared: 'brain-shared',
};

/** Map an entity scope to its Supermemory containerTag. */
export function containerTagFor(scope: MemoryScope): string {
  return CONTAINER_TAGS[scope];
}

/** A document as returned by the Supermemory list endpoint. */
export interface SupermemoryDocument {
  id: string;
  customId?: string;
  content: string;
  title?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  status?: string;
  containerTags?: string[];
}

function apiKey(): string {
  const key = config.SUPERMEMORY_API_KEY;
  if (!key) throw new Error('Missing required env: SUPERMEMORY_API_KEY');
  return key;
}

async function smFetch<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supermemory ${init.method ?? 'GET'} ${path} ${res.status}: ${body.slice(0, 500)}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Store a fact in the entity's container. */
export async function remember(fact: string, entity: MemoryScope): Promise<void> {
  await smFetch('/v3/documents', {
    method: 'POST',
    body: JSON.stringify({ content: fact, containerTag: containerTagFor(entity) }),
  });
}

/** Retrieve facts relevant to a query from the entity's container. */
export async function recall(query: string, entity: MemoryScope): Promise<string[]> {
  const res = await smFetch<{ results?: Array<{ content?: string }> }>('/v4/search', {
    method: 'POST',
    body: JSON.stringify({ q: query, containerTag: containerTagFor(entity) }),
  });
  return (res?.results ?? []).map((r) => r.content ?? '').filter((c) => c.length > 0);
}

/** Remove a stale or incorrect fact by its Supermemory document id. */
export async function forget(factId: string): Promise<void> {
  await smFetch(`/v3/documents/${encodeURIComponent(factId)}`, { method: 'DELETE' });
}

/**
 * List recent documents in an entity's container, newest first. Used by the
 * ingestion source to pull corrections back into the brain.
 */
export async function listMemories(
  scope: MemoryScope,
  opts: { limit?: number } = {},
): Promise<SupermemoryDocument[]> {
  const res = await smFetch<{ documents?: SupermemoryDocument[] }>('/v3/documents/list', {
    method: 'POST',
    body: JSON.stringify({
      containerTags: [containerTagFor(scope)],
      limit: opts.limit ?? 100,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    }),
  });
  return res?.documents ?? [];
}
