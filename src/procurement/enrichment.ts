import { basename } from 'node:path';
import { hybridSearch } from '../gbrainCompat.ts';
import { openEngine } from '../engine.ts';
import {
  structureProcurementRequest,
  type ProcurementStructure,
  type StructuredLine,
} from './structure.ts';

export interface AcumaticaContextRecord {
  kind: 'customer' | 'item' | 'order' | 'invoice' | 'unknown';
  slug: string;
  title: string | null;
  sourceUri: string | null;
  score: number | null;
  fields: Record<string, string>;
  snippet: string;
}

export interface LineAcumaticaContext {
  line: StructuredLine;
  itemCandidates: AcumaticaContextRecord[];
}

export interface ProcurementAcumaticaEnrichment {
  structure: ProcurementStructure;
  acumatica: {
    customerCandidates: AcumaticaContextRecord[];
    lineItems: LineAcumaticaContext[];
    recentOrders: AcumaticaContextRecord[];
    recentInvoices: AcumaticaContextRecord[];
  };
  warnings: string[];
}

export async function enrichProcurementRequest(
  rawText: string,
  knownStructure?: ProcurementStructure,
): Promise<ProcurementAcumaticaEnrichment> {
  const structure = knownStructure ?? await structureProcurementRequest(rawText);
  const warnings: string[] = [];
  const engine = await openEngine();
  try {
    const customerCandidates = structure.fields.customerName
      ? recordsOfKind(await searchAcumatica(engine, structure.fields.customerName, 8), 'customer')
      : [];

    if (structure.fields.customerName && customerCandidates.length === 0) {
      warnings.push('No Acumatica customer candidates were found for the parsed customer name.');
    }

    const lineItems: LineAcumaticaContext[] = [];
    for (const line of structure.lines.slice(0, 8)) {
      const candidates = recordsOfKind(await searchAcumatica(engine, line.description, 8), 'item');
      if (candidates.length === 0) {
        warnings.push(`No Acumatica item candidates were found for ${line.description}.`);
      }
      lineItems.push({ line, itemCandidates: candidates });
    }

    const customerQuery = structure.fields.customerName ?? structure.fields.contactEmail ?? '';
    const customerHistory = customerQuery ? await searchAcumatica(engine, customerQuery, 12) : [];
    const recentOrders = recordsOfKind(customerHistory, 'order');
    const recentInvoices = recordsOfKind(customerHistory, 'invoice');

    return {
      structure,
      acumatica: {
        customerCandidates,
        lineItems,
        recentOrders,
        recentInvoices,
      },
      warnings,
    };
  } finally {
    await engine.disconnect();
  }
}

export function compactAcumaticaContext(enrichment: ProcurementAcumaticaEnrichment): Record<string, unknown> {
  return {
    customerCandidates: enrichment.acumatica.customerCandidates.slice(0, 3).map(compactRecord),
    lineItems: enrichment.acumatica.lineItems.map((entry) => ({
      requested: {
        description: entry.line.description,
        quantity: entry.line.quantity,
        unit: entry.line.unit,
      },
      itemCandidates: entry.itemCandidates.slice(0, 3).map(compactRecord),
    })),
    recentOrders: enrichment.acumatica.recentOrders.slice(0, 3).map(compactRecord),
    recentInvoices: enrichment.acumatica.recentInvoices.slice(0, 3).map(compactRecord),
    warnings: enrichment.warnings,
  };
}

async function searchAcumatica(engine: Awaited<ReturnType<typeof openEngine>>, query: string, limit: number) {
  return await hybridSearch(engine, query, {
    limit,
    sourceIds: ['acumatica'],
  });
}

function recordsOfKind(hits: any[], kind: AcumaticaContextRecord['kind']): AcumaticaContextRecord[] {
  return hits
    .map(toContextRecord)
    .filter((record) => record.kind === kind);
}

function toContextRecord(hit: any): AcumaticaContextRecord {
  const snippet = String(hit.chunk_text ?? hit.content ?? '').slice(0, 900);
  const sourceUri = hit.source_uri ? String(hit.source_uri) : null;
  return {
    kind: kindFromHit(hit),
    slug: String(hit.slug ?? basename(String(hit.source_uri ?? 'unknown'))),
    title: hit.title ?? null,
    sourceUri,
    score: typeof hit.score === 'number' ? hit.score : null,
    fields: extractMarkdownFields(snippet),
    snippet,
  };
}

function kindFromHit(hit: any): AcumaticaContextRecord['kind'] {
  const sourceUri = String(hit.source_uri ?? '').toLowerCase();
  const metadataKind = String(hit.metadata?.entity_kind ?? '').toLowerCase();
  const slug = String(hit.slug ?? '').toLowerCase();
  const haystack = `${sourceUri} ${metadataKind} ${slug}`;
  if (haystack.includes('customer')) return 'customer';
  if (haystack.includes('stockitem') || haystack.includes('/item/') || haystack.includes('item')) return 'item';
  if (haystack.includes('salesorder') || haystack.includes('/order/') || haystack.includes('order')) return 'order';
  if (haystack.includes('salesinvoice') || haystack.includes('/invoice/') || haystack.includes('invoice')) return 'invoice';
  return 'unknown';
}

function extractMarkdownFields(snippet: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of snippet.matchAll(/-\s+\*\*([^*]+)\*\*:\s*([^\n\r]+)/g)) {
    const key = match[1]?.trim();
    const value = match[2]?.trim();
    if (key && value && value !== '{}') fields[key] = value.slice(0, 220);
  }
  return fields;
}

function compactRecord(record: AcumaticaContextRecord): Record<string, unknown> {
  const usefulFields = [
    'CustomerID',
    'CustomerName',
    'Status',
    'Terms',
    'InventoryID',
    'Description',
    'ItemClass',
    'BaseUOM',
    'DefaultPrice',
    'ListPrice',
    'OrderNbr',
    'ReferenceNbr',
    'OrderTotal',
    'Amount',
    'RequestedOn',
    'DueDate',
  ];
  const fields: Record<string, string> = {};
  for (const field of usefulFields) {
    if (record.fields[field]) fields[field] = record.fields[field];
  }
  return {
    kind: record.kind,
    title: record.title,
    slug: record.slug,
    sourceUri: record.sourceUri,
    score: record.score,
    fields,
  };
}
