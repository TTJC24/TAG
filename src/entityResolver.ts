import type { SearchResult } from 'gbrain/types';
import { hybridSearch } from 'gbrain/search/hybrid';
import type { Engine } from './engine.ts';
import { buildEntityGraph, scoreEntityGraphMatches } from './entityGraph.ts';

export interface EntityResolution {
  query: string;
  canonicalName: string | null;
  aliases: string[];
  sourceIds: string[];
  confidence: 'high' | 'medium' | 'low';
  alternatives: string[];
  ambiguous: boolean;
}

const ENTITY_STOP_WORDS = new Set([
  'account',
  'about',
  'and',
  'any',
  'are',
  'can',
  'customer',
  'details',
  'do',
  'does',
  'contact',
  'credit',
  'email',
  'find',
  'for',
  'invoice',
  'info',
  'item',
  'know',
  'look',
  'lookup',
  'our',
  'order',
  'owner',
  'owns',
  'price',
  'pricing',
  'rep',
  'salesperson',
  'sell',
  'status',
  'stock',
  'summary',
  'term',
  'terms',
  'their',
  'we',
  'what',
  'where',
  'who',
]);

export async function resolveEntity(
  engine: Engine,
  question: string,
  sourceIds?: string[],
  allowedKinds?: string[],
): Promise<EntityResolution> {
  const query = entityQuery(question);
  if (!query) {
    return emptyResolution('');
  }

  const graph = filterGraphByKind(await buildEntityGraph(engine, sourceIds), allowedKinds);
  const graphMatches = scoreEntityGraphMatches(query, graph, 5);
  const graphTop = graphMatches[0]?.record;
  const ambiguousGraph = graphMatchesAreAmbiguous(query, graphMatches);
  if (graphTop && !ambiguousGraph) {
    return {
      query,
      canonicalName: graphTop.canonicalName,
      aliases: Array.from(new Set([query, ...graphTop.aliases])),
      sourceIds: Array.from(new Set(graphMatches.flatMap((match) => match.record.sourceIds))),
      confidence: graphTop.aliases.some((alias) => normalize(alias) === normalize(query)) ? 'high' : 'medium',
      alternatives: graphAlternatives(query, graphMatches),
      ambiguous: false,
    };
  }
  if (graphTop && ambiguousGraph) {
    return {
      query,
      canonicalName: graphTop.canonicalName,
      aliases: Array.from(new Set([query, ...graphTop.aliases])),
      sourceIds: Array.from(new Set(graphMatches.flatMap((match) => match.record.sourceIds))),
      confidence: 'low',
      alternatives: graphAlternatives(query, graphMatches),
      ambiguous: true,
    };
  }

  const hits = await hybridSearch(engine, query, {
    limit: 8,
    sourceIds,
  });
  const ranked = hits
    .filter((hit) => recordKindAllowed(recordKind(hit), allowedKinds))
    .map((hit) => ({ hit, score: entityScore(query, hit) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const top = ranked[0];
  if (!top) {
    return { ...emptyResolution(query), aliases: [query] };
  }

  const aliases = new Set<string>([query]);
  const canonical = cleanEntityName(top.hit.title)
    ?? cleanEntityName(fieldValue(top.hit, ['CustomerName', 'name', 'title', 'Description']))
    ?? null;
  if (canonical) aliases.add(canonical);
  for (const hit of ranked.slice(0, 4)) {
    const title = cleanEntityName(hit.hit.title);
    if (title && looseIncludes(title, query)) aliases.add(title);
    const customer = cleanEntityName(fieldValue(hit.hit, ['CustomerName', 'name']));
    if (customer && looseIncludes(customer, query)) aliases.add(customer);
  }

  const alternatives = ranked
    .slice(1, 4)
    .map((item) => cleanEntityName(item.hit.title) ?? cleanEntityName(fieldValue(item.hit, ['CustomerName', 'name', 'title', 'Description'])))
    .filter((value): value is string => Boolean(value));
  const ambiguous = ranked.length > 1 && top.score < 3 && ranked[1] !== undefined && ranked[1].score >= top.score * 0.8;

  return {
    query,
    canonicalName: canonical,
    aliases: Array.from(aliases),
    sourceIds: Array.from(new Set(ranked.map((item) => item.hit.source_id ?? 'default'))),
    confidence: ambiguous ? 'low' : top.score >= 3 ? 'high' : top.score >= 1.5 ? 'medium' : 'low',
    alternatives,
    ambiguous,
  };
}

function emptyResolution(query: string): EntityResolution {
  return {
    query,
    canonicalName: null,
    aliases: [],
    sourceIds: [],
    confidence: 'low',
    alternatives: [],
    ambiguous: false,
  };
}

function filterGraphByKind<T extends { kinds: string[] }>(graph: T[], allowedKinds?: string[]): T[] {
  if (!allowedKinds?.length) return graph;
  return graph.filter((record) => record.kinds.some((kind) => allowedKinds.includes(kind)));
}

function recordKindAllowed(kind: string, allowedKinds?: string[]): boolean {
  return !allowedKinds?.length || allowedKinds.includes(kind);
}

function graphMatchesAreAmbiguous(
  query: string,
  matches: Array<{ record: { canonicalName: string; aliases: string[] }; score: number }>,
): boolean {
  if (matches.length < 2) return false;
  const top = matches[0];
  const second = matches[1];
  if (!top || !second) return false;
  const queryTerms = query.split(/\s+/).filter(Boolean);
  if (queryTerms.length > 1) return false;
  if (top.record.aliases.some((alias) => normalize(alias) === normalize(query))) return false;
  if (recordEntityAliases(top.record.aliases, query).length >= 2) return true;
  return second.score >= top.score * 0.75;
}

function graphAlternatives(
  query: string,
  matches: Array<{ record: { canonicalName: string; aliases: string[] }; score: number }>,
): string[] {
  const alternatives = new Set<string>();
  for (const alias of recordEntityAliases(matches[0]?.record.aliases ?? [], query)) {
    alternatives.add(alias);
    if (alternatives.size >= 4) return Array.from(alternatives);
  }
  for (const match of matches) {
    alternatives.add(match.record.canonicalName);
    if (alternatives.size >= 4) break;
  }
  return Array.from(alternatives);
}

function recordEntityAliases(aliases: string[], query: string): string[] {
  const normalizedQuery = normalize(query);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const alias of aliases) {
    const normalizedAlias = normalize(alias);
    if (!normalizedAlias.includes(normalizedQuery)) continue;
    if (!/[a-z]/i.test(alias) || !/\s/.test(alias) || /@/.test(alias)) continue;
    if (seen.has(normalizedAlias)) continue;
    seen.add(normalizedAlias);
    out.push(alias);
  }
  return out;
}

export function entityQuery(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9/@._-]+/g, ' ')
    .split(/\s+/)
    .filter((term) => term.length >= 3)
    .filter((term) => !ENTITY_STOP_WORDS.has(term))
    .join(' ')
    .trim();
}

function entityScore(query: string, hit: SearchResult): number {
  const title = hit.title ?? '';
  const fields = extractFields(hit.chunk_text ?? '');
  const fieldText = [
    fields.CustomerName,
    fields.name,
    fields.title,
    fields.Description,
    fields.InventoryID,
    fields.CustomerID,
    fields.ContactEmail,
    fields.email,
  ].filter(Boolean).join(' ');
  const haystack = `${title} ${fieldText}`.toLowerCase();
  const terms = query.split(/\s+/).filter(Boolean);
  let score = 0;
  if (looseIncludes(title, query)) score += 2;
  if (looseIncludes(fields.CustomerName ?? '', query) || looseIncludes(fields.name ?? '', query)) score += 2;
  for (const term of terms) {
    if (haystack.includes(term)) score += 0.5;
  }
  return score;
}

function looseIncludes(value: string, query: string): boolean {
  const normalizedValue = normalize(value);
  const normalizedQuery = normalize(query);
  if (!normalizedValue || !normalizedQuery) return false;
  return normalizedValue.includes(normalizedQuery) || normalizedQuery.includes(normalizedValue);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function cleanEntityName(value: string | null | undefined): string | null {
  const cleaned = value?.trim();
  if (!cleaned) return null;
  const normalized = cleaned.toLowerCase();
  if (
    ['unknown', 'none', 'null', '[object object]'].includes(normalized)
    || normalized.includes('[object object]')
    || normalized.startsWith('{')
    || normalized.startsWith('[')
    || normalized.includes('"id":')
  ) {
    return null;
  }
  return cleaned;
}

function fieldValue(hit: SearchResult, keys: string[]): string | null {
  const fields = extractFields(hit.chunk_text ?? '');
  for (const key of keys) {
    if (fields[key]) return fields[key];
  }
  return null;
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

function extractFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of text.matchAll(/-\s+\*\*([^*]+)\*\*:\s*([\s\S]*?)(?=\s+-\s+\*\*|$)/g)) {
    const key = match[1]?.trim();
    const value = match[2]?.replace(/\s+/g, ' ').trim();
    if (key && value && value !== '{}') fields[key] = value;
  }
  return fields;
}
