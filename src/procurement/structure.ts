import { basename } from 'node:path';
import { openEngine } from '../engine.ts';
import { hybridSearch } from '../gbrainCompat.ts';

const FIELD_ALIASES: Record<string, keyof StructuredFields> = {
  customer: 'customerName',
  'customer name': 'customerName',
  contact: 'contactName',
  'contact name': 'contactName',
  email: 'contactEmail',
  'contact email': 'contactEmail',
  job: 'jobName',
  'job name': 'jobName',
  project: 'jobName',
  'ship to': 'shipTo',
  'ship-to': 'shipTo',
  site: 'shipTo',
  'needed by': 'neededBy',
  'need by': 'neededBy',
  'required by': 'neededBy',
  delivery: 'deliveryMethod',
  'delivery method': 'deliveryMethod',
  tax: 'taxNotes',
  'tax notes': 'taxNotes',
};

const REQUIRED_FIELDS: Array<keyof StructuredFields> = ['customerName', 'shipTo'];
const LINE_PATTERN = /^\s*(?:[-*]|\d+[.)])?\s*(?<qty>\d+(?:\.\d+)?)?\s*(?<unit>boxes|box|rolls|roll|bags|bag|each|ea|pcs|pc|ft|lf|sf)?\s*(?<desc>.+?)\s*$/i;

export interface StructuredFields {
  customerName: string | null;
  contactName: string | null;
  contactEmail: string | null;
  jobName: string | null;
  shipTo: string | null;
  neededBy: string | null;
  deliveryMethod: string | null;
  taxNotes: string | null;
}

export interface StructuredLine {
  description: string;
  quantity: string | null;
  unit: string | null;
  confidence: number;
}

export interface ProcurementEvidence {
  slug: string;
  title: string | null;
  source_id: string | null;
  source_uri: string | null;
  snippet: string;
  score: number | null;
}

export interface ProcurementStructure {
  fields: StructuredFields;
  lines: StructuredLine[];
  warnings: string[];
  escalationRequired: boolean;
  malformed: boolean;
  confidence: number;
  evidence: {
    customer: ProcurementEvidence[];
    lines: Array<{ line: StructuredLine; hits: ProcurementEvidence[] }>;
  };
  suggestedSearches: string[];
}

export function parseProcurementRequest(rawText: string): Omit<ProcurementStructure, 'evidence' | 'suggestedSearches'> {
  const text = rawText.trim();
  const fields: StructuredFields = {
    customerName: null,
    contactName: null,
    contactEmail: null,
    jobName: null,
    shipTo: null,
    neededBy: null,
    deliveryMethod: null,
    taxNotes: null,
  };
  const warnings: string[] = [];
  const itemCandidates: string[] = [];

  if (!text) {
    return {
      fields,
      lines: [],
      warnings: ['Order text is required.'],
      escalationRequired: true,
      malformed: true,
      confidence: 0,
    };
  }

  if (text.length < 20) warnings.push('Order text is too short to structure reliably.');

  let inItemsBlock = false;
  for (const originalLine of text.split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line) continue;

    const [key, value] = splitLabel(line);
    if (key) {
      const normalizedKey = FIELD_ALIASES[key.toLowerCase().trim()];
      if (normalizedKey) {
        fields[normalizedKey] = value?.trim() || null;
        inItemsBlock = false;
        continue;
      }
      if (['item', 'items', 'material', 'materials', 'lines'].includes(key.toLowerCase().trim())) {
        inItemsBlock = true;
        if (value?.trim()) itemCandidates.push(value.trim());
        continue;
      }
    }

    if (inItemsBlock || looksLikeLineItem(line)) itemCandidates.push(line);
  }

  if (!fields.customerName) fields.customerName = inferInlineCustomer(text);
  if (!itemCandidates.length) {
    const inferredLine = inferSourcingLine(text, fields.customerName);
    if (inferredLine) itemCandidates.push(inferredLine);
  }

  const lines = itemCandidates.map((line) => parseLine(line, fields.customerName));
  for (const requiredField of REQUIRED_FIELDS) {
    if (!fields[requiredField]) warnings.push(`Missing required field: ${humanizeField(requiredField)}.`);
  }
  if (!lines.length) warnings.push('No line items were detected.');
  for (const line of lines) {
    if (!line.quantity) warnings.push(`Missing quantity for line item: ${line.description}.`);
    if (line.description.length < 3) warnings.push('Line item description is too short.');
  }

  const populatedFields = Object.values(fields).filter(Boolean).length;
  const averageLineConfidence = lines.length
    ? Math.floor(lines.reduce((sum, line) => sum + line.confidence, 0) / lines.length)
    : 0;
  let confidence = Math.min(95, 15 + populatedFields * 8 + lines.length * 8 + Math.floor(averageLineConfidence / 4));
  if (warnings.length) confidence = Math.max(5, confidence - warnings.length * 12);
  const malformed = !Object.values(fields).some(Boolean) && !lines.length;
  if (malformed) confidence = Math.min(confidence, 10);

  return {
    fields,
    lines,
    warnings,
    escalationRequired: malformed || warnings.length > 0 || confidence < 60,
    malformed,
    confidence,
  };
}

export async function structureProcurementRequest(rawText: string): Promise<ProcurementStructure> {
  const parsed = parseProcurementRequest(rawText);
  const suggestedSearches = buildSuggestedSearches(parsed.fields, parsed.lines);
  const engine = await openEngine();
  try {
    const customer = parsed.fields.customerName
      ? toEvidence(await hybridSearch(engine, parsed.fields.customerName, {
          limit: 5,
          sourceIds: ['acumatica', 'pipedrive', 'm365-mail'],
        }))
      : [];
    const lines = [];
    for (const line of parsed.lines.slice(0, 6)) {
      const query = [line.description, parsed.fields.customerName, parsed.fields.jobName]
        .filter(Boolean)
        .join(' ');
      let hits = toEvidence(await hybridSearch(engine, query || line.description, {
        limit: 5,
        sourceIds: isExactSku(line.description)
          ? ['acumatica']
          : ['acumatica', 'pipedrive', 'm365-mail', 'm365-teams', 'm365-sharepoint'],
      }));
      if (isExactSku(line.description)) {
        const itemHits = hits.filter(isItemEvidence);
        if (itemHits.length) hits = itemHits;
      }
      lines.push({ line, hits });
    }

    return {
      ...parsed,
      evidence: { customer, lines },
      suggestedSearches,
    };
  } finally {
    await engine.disconnect();
  }
}

function splitLabel(line: string): [string | null, string | null] {
  if (!line.includes(':')) return [null, null];
  const [key, ...rest] = line.split(':');
  return [key, rest.join(':')];
}

function looksLikeLineItem(line: string): boolean {
  const lowered = line.toLowerCase();
  if (/^(customer|contact|job|ship|needed|delivery|tax)\b/.test(lowered)) return false;
  return /^\s*(?:[-*]|\d+[.)]|\d+\s+\w+|(?:need(?:s|ed)?|source|buy|order|quote|get)\b.*\d+\s+\w+)/i.test(line);
}

function parseLine(line: string, customerName?: string | null): StructuredLine {
  const cleaned = line
    .replace(/^\s*(?:[-*]|\d+[.)])\s*/i, '')
    .replace(/^\s*(?:need|needs|needed|source|buy|order|quote|get)\s+(?:to\s+)?(?:(?:source|buy|order|quote|get|and)\s+)*/i, '')
    .replace(customerName ? new RegExp(`\\s+for\\s+${escapeRegExp(customerName)}\\s*$`, 'i') : /$a/, '')
    .replace(/\s+(?:on|with)\s+terms\s*$/i, '')
    .trim();
  if (isExactSku(cleaned)) {
    return { description: cleaned, quantity: null, unit: null, confidence: 60 };
  }
  const match = LINE_PATTERN.exec(cleaned);
  if (!match?.groups) return { description: cleaned, quantity: null, unit: null, confidence: 35 };
  const description = match.groups.desc.trim();
  const quantity = match.groups.qty || null;
  const unit = match.groups.unit?.toLowerCase() || null;
  return {
    description,
    quantity,
    unit,
    confidence: quantity && description ? 70 : 45,
  };
}

function isExactSku(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{2,}$/i.test(value) && /\d/.test(value) && !/\s/.test(value);
}

function inferInlineCustomer(text: string): string | null {
  if (/^\s*(?:who\s+sells|vendors?\s+for|suppliers?\s+for|vendor\s+for|supplier\s+for)\b/i.test(text)) {
    return null;
  }
  const actorMatch = /\b(?:can|could|should|will|would)\s+([a-z0-9][a-z0-9 .&'_-]{1,60}?)\s+(?:buy|order|get|source|purchase)\b/i.exec(text);
  const actorValue = actorMatch?.[1]?.trim().replace(/[.,;:]+$/, '');
  if (actorValue && !/^\d/.test(actorValue)) return actorValue;

  const match = /\bfor\s+([a-z0-9][a-z0-9 .&'_-]{1,60}?)(?=\s+(?:ship|needed|need by|required|by|with|to|and|$)|$)/i.exec(text);
  const value = match?.[1]?.trim().replace(/[.,;:]+$/, '');
  if (!value) return null;
  if (/^\d/.test(value)) return null;
  return value;
}

function inferSourcingLine(text: string, customerName?: string | null): string | null {
  const patterns = [
    /\b(?:buy|order|get)\s+(?!for\b)(.+?)(?=\s+(?:for|to|on\s+terms|with\s+terms|ship|needed|need\s+by|required\s+by|by)\b|$)/i,
    /\bwho\s+is\s+the\s+vendor\s+for\s+(.+?)\s*$/i,
    /\bwho\s+is\s+the\s+supplier\s+for\s+(.+?)\s*$/i,
    /\bwho\s+sells\s+(.+?)\s*$/i,
    /\bvendors?\s+for\s+(.+?)\s*$/i,
    /\bsuppliers?\s+for\s+(.+?)\s*$/i,
    /\bvendor\s+for\s+(.+?)\s*$/i,
    /\bsupplier\s+for\s+(.+?)\s*$/i,
    /\bpurchase\s+orders?\s+for\s+(.+?)\s*$/i,
    /\bpo\s+for\s+(.+?)\s*$/i,
    /\bsource\s+(.+?)\s*$/i,
    /\bsourcing\s+(.+?)\s*$/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = cleanInferredLine(match?.[1] ?? '', customerName);
    if (value) return value;
  }
  return null;
}

function cleanInferredLine(value: string, customerName?: string | null): string | null {
  let cleaned = value.trim().replace(/[.,;:]+$/, '');
  if (customerName) {
    cleaned = cleaned.replace(new RegExp(`\\s+for\\s+${escapeRegExp(customerName)}\\s*$`, 'i'), '');
  }
  cleaned = cleaned.replace(/\s+(?:on|with)\s+terms\s*$/i, '');
  cleaned = cleaned.replace(/\s+(?:for|to)\s+[a-z0-9][a-z0-9 .&'_-]{1,60}$/i, '').trim();
  if (!cleaned || cleaned.length < 3) return null;
  if (/^\d+$/.test(cleaned) && cleaned.length < 3) return null;
  return cleaned;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function humanizeField(field: string): string {
  return field.replace(/[A-Z]/g, (m) => ` ${m.toLowerCase()}`);
}

function buildSuggestedSearches(fields: StructuredFields, lines: StructuredLine[]): string[] {
  const searches = new Set<string>();
  if (fields.customerName) searches.add(`customer history ${fields.customerName}`);
  if (fields.shipTo) searches.add(`ship to ${fields.shipTo}`);
  if (fields.taxNotes || fields.customerName) searches.add(`tax exemption ${fields.customerName ?? ''}`.trim());
  for (const line of lines.slice(0, 4)) {
    searches.add(`vendor history ${line.description}`);
    searches.add(`stock item ${line.description}`);
  }
  return Array.from(searches);
}

function toEvidence(hits: any[]): ProcurementEvidence[] {
  return hits.map((hit) => ({
    slug: String(hit.slug ?? basename(String(hit.source_uri ?? 'unknown'))),
    title: hit.title ?? null,
    source_id: hit.source_id ?? null,
    source_uri: hit.source_uri ?? null,
    snippet: String(hit.chunk_text ?? hit.content ?? '').slice(0, 450),
    score: typeof hit.score === 'number' ? hit.score : null,
  }));
}

function isItemEvidence(hit: ProcurementEvidence): boolean {
  const text = `${hit.slug} ${hit.title ?? ''} ${hit.source_uri ?? ''} ${hit.snippet}`.toLowerCase();
  return text.includes('/item/') || text.includes('stockitem') || text.includes('inventory id');
}
