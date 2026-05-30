import type { SearchResult } from 'gbrain/types';
import type { Engine } from './engine.ts';

export interface EntityGraphRecord {
  canonicalName: string;
  aliases: string[];
  sourceIds: string[];
  slugs: string[];
  sourceUris: string[];
  kinds: string[];
}

export interface EntityGraphMatch {
  record: EntityGraphRecord;
  score: number;
}

interface BrainPage {
  slug: string;
  title?: string | null;
  chunk_text?: string | null;
  source_id?: string | null;
  source_uri?: string | null;
}

const BUSINESS_SUFFIXES = new Set([
  'inc',
  'incorporated',
  'llc',
  'lc',
  'ltd',
  'co',
  'company',
  'corp',
  'corporation',
]);

const ENTITY_STOP_TERMS = new Set([
  'a',
  'an',
  'and',
  'any',
  'are',
  'can',
  'do',
  'does',
  'for',
  'from',
  'have',
  'is',
  'of',
  'our',
  'sell',
  'the',
  'their',
  'to',
  'we',
  'what',
  'with',
]);

const ENTITY_GRAPH_CACHE_TTL_MS = 60_000;
const entityGraphCache = new Map<string, { expiresAt: number; records: EntityGraphRecord[] }>();

export async function buildEntityGraph(engine: Engine, sourceIds?: string[]): Promise<EntityGraphRecord[]> {
  const cacheKey = graphCacheKey(sourceIds);
  const cached = entityGraphCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.records;

  const pages = await readPages(engine, sourceIds);
  const groups = new Map<string, EntityGraphRecord>();

  for (const page of pages) {
    const fields = extractFields(page.chunk_text ?? '');
    const kind = recordKind(page);
    const names = candidateNames(page, fields, kind);
    if (!names.length) continue;
    const canonicalName = chooseCanonicalName(names);
    const key = entityKey(canonicalName);
    if (!key) continue;

    const group = groups.get(key) ?? {
      canonicalName,
      aliases: [],
      sourceIds: [],
      slugs: [],
      sourceUris: [],
      kinds: [],
    };
    for (const alias of names) addUnique(group.aliases, alias);
    addUnique(group.aliases, canonicalName);
    if (page.source_id) addUnique(group.sourceIds, page.source_id);
    addUnique(group.slugs, page.slug);
    if (page.source_uri) addUnique(group.sourceUris, page.source_uri);
    addUnique(group.kinds, kind);
    if (canonicalScore(canonicalName) > canonicalScore(group.canonicalName)) {
      group.canonicalName = canonicalName;
    }
    groups.set(key, group);
  }

  const records = Array.from(groups.values());
  entityGraphCache.set(cacheKey, {
    expiresAt: Date.now() + ENTITY_GRAPH_CACHE_TTL_MS,
    records,
  });
  return records;
}

export function clearEntityGraphCache(): void {
  entityGraphCache.clear();
}

export function findEntityGraphMatches(
  query: string,
  graph: EntityGraphRecord[],
  limit = 5,
): EntityGraphRecord[] {
  return scoreEntityGraphMatches(query, graph, limit).map((item) => item.record);
}

export function scoreEntityGraphMatches(
  query: string,
  graph: EntityGraphRecord[],
  limit = 5,
): EntityGraphMatch[] {
  const qKey = entityKey(query);
  const terms = tokenSet(query);
  return graph
    .map((record) => ({ record, score: graphScore(qKey, terms, record) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.record.canonicalName.localeCompare(b.record.canonicalName))
    .slice(0, limit);
}

function graphScore(queryKey: string, queryTerms: Set<string>, record: EntityGraphRecord): number {
  if (!queryKey && queryTerms.size === 0) return 0;
  let score = 0;
  for (const alias of record.aliases) {
    const aliasKey = entityKey(alias);
    if (aliasKey === queryKey) score += 5;
    else if (aliasKey.includes(queryKey) || queryKey.includes(aliasKey)) score += 2;
    const aliasTerms = tokenSet(alias);
    for (const term of queryTerms) {
      if (aliasTerms.has(term)) score += 0.75;
    }
  }
  return score;
}

async function readPages(engine: Engine, sourceIds?: string[]): Promise<BrainPage[]> {
  const maybeStore = (engine as any).store;
  if (Array.isArray(maybeStore?.pages)) {
    return maybeStore.pages
      .filter((page: BrainPage) => !sourceIds?.length || sourceIds.includes(page.source_id ?? ''))
      .map(toPage);
  }
  if (typeof (engine as any).executeRaw === 'function') {
    const rows = await (engine as any).executeRaw(
      `SELECT slug, title, chunk_text, source_id, source_uri
       FROM brain_documents
       WHERE ($1::text[] IS NULL OR source_id = ANY($1::text[]))
       LIMIT 10000`,
      [sourceIds?.length ? sourceIds : null],
    );
    return rows.map(toPage);
  }
  return [];
}

function toPage(page: BrainPage): BrainPage {
  return {
    slug: String(page.slug),
    title: page.title ?? null,
    chunk_text: page.chunk_text ?? null,
    source_id: page.source_id ?? null,
    source_uri: page.source_uri ?? null,
  };
}

function candidateNames(page: BrainPage, fields: Record<string, string>, kind: string): string[] {
  const titleIsEntity = !['mail', 'teams', 'unknown'].includes(kind);
  return [
    titleIsEntity ? page.title : null,
    fields.CustomerName,
    fields.name,
    fields.title,
    fields.CustomerID,
    fields.InventoryID,
    fields.ContactEmail,
    fields.email,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .filter((value) => !looksLikeGenericTitle(value));
}

function chooseCanonicalName(names: string[]): string {
  return [...names].sort((a, b) => canonicalScore(b) - canonicalScore(a))[0] ?? names[0];
}

function canonicalScore(value: string): number {
  let score = value.length;
  if (/[a-z]/i.test(value) && /\s/.test(value)) score += 20;
  if (/@/.test(value)) score -= 15;
  if (/^[A-Z0-9_-]+$/.test(value)) score -= 10;
  return score;
}

function looksLikeGenericTitle(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    ['unknown', 'none', 'null', '[object object]'].includes(normalized)
    || normalized.includes('[object object]')
    || normalized.startsWith('{')
    || normalized.startsWith('[')
    || normalized.includes('"id":')
  );
}

function entityKey(value: string): string {
  return Array.from(tokenSet(value)).join(' ');
}

function tokenSet(value: string): Set<string> {
  const terms = value
    .toLowerCase()
    .replace(/[^a-z0-9@._-]+/g, ' ')
    .split(/\s+/)
    .map((term) => term.replace(/^[._-]+|[._-]+$/g, ''))
    .filter((term) => term.length >= 2)
    .filter((term) => !BUSINESS_SUFFIXES.has(term))
    .filter((term) => !ENTITY_STOP_TERMS.has(term));
  return new Set(terms);
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function graphCacheKey(sourceIds?: string[]): string {
  return sourceIds?.length ? [...sourceIds].sort().join('|') : '*';
}

function extractFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of text.matchAll(/-\s+\*\*([^*]+)\*\*:\s*([\s\S]*?)(?=\s+-\s+\*\*|$)/g)) {
    const key = match[1]?.trim();
    const value = match[2]?.replace(/\s+/g, ' ').trim();
    if (key && value && value !== '{}') fields[key] = value;
  }
  return fields;
}

function recordKind(hit: Pick<SearchResult, 'source_uri' | 'slug' | 'source_id' | 'title'>): string {
  const text = `${hit.source_uri ?? ''} ${hit.slug ?? ''} ${hit.source_id ?? ''} ${hit.title ?? ''}`.toLowerCase();
  if (text.includes('customer')) return 'customer';
  if (text.includes('organization')) return 'organization';
  if (text.includes('person')) return 'person';
  if (text.includes('stockitem') || text.includes('/item/') || text.includes('item')) return 'item';
  if (text.includes('salesorder') || text.includes('/order/') || text.includes('order')) return 'order';
  if (text.includes('salesinvoice') || text.includes('/invoice/') || text.includes('invoice')) return 'invoice';
  if (text.includes('mail')) return 'mail';
  if (text.includes('teams')) return 'teams';
  if (text.includes('calendar')) return 'calendar';
  if (text.includes('sharepoint')) return 'sharepoint';
  return 'unknown';
}
