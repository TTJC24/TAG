import { hybridSearch } from './gbrainCompat.ts';
import type { SearchResult } from 'gbrain/types';
import { openEngine } from './engine.ts';
import { config } from './config.ts';
import { recall, type MemoryScope } from './memory.ts';
import { resolveEntity, type EntityResolution } from './entityResolver.ts';
import { createProcurementActionPlan } from './procurement/actionPlan.ts';
import { procurementPlanBrainAnswer } from './procurement/answer.ts';

export interface BrainCitation {
  slug: string;
  source_id: string;
  title: string | null;
  source_uri: string | null;
}

export interface BrainAnswer {
  text: string;
  citations: BrainCitation[];
  /** Facts pulled from the Supermemory layer-5 feedback loop. */
  memories: string[];
  intent: BrainIntent;
  scope: BrainScope;
  confidence: 'high' | 'medium' | 'low';
  resolvedEntity: EntityResolution | null;
}

type SourcePage = Pick<SearchResult, 'slug' | 'title' | 'source_id' | 'chunk_text'> & {
  source_uri?: string | null;
};

export interface AskOptions {
  question: string;
  sources?: string[];
  entity?: MemoryScope;
  limit?: number;
}

export type BrainIntent =
  | 'customer_lookup'
  | 'item_lookup'
  | 'order_lookup'
  | 'invoice_lookup'
  | 'credit_lookup'
  | 'contact_lookup'
  | 'pipeline_lookup'
  | 'procurement_request'
  | 'collaboration_lookup'
  | 'general_lookup';

export type BrainScope =
  | 'revenue_ops'
  | 'procurement'
  | 'collaboration'
  | 'all';

interface IntentProfile {
  intent: BrainIntent;
  scope: BrainScope;
  entity?: MemoryScope;
  sourceIds?: string[];
  answerFields: string[];
  label: string;
  preferredKinds: string[];
  requestedFields: string[];
}

const FIELD_LABELS: Record<string, string> = {
  CustomerID: 'Customer ID',
  CustomerName: 'Customer',
  Status: 'Status',
  Terms: 'Terms',
  TaxZone: 'Tax zone',
  TaxRegistrationID: 'Tax registration',
  TaxExemptionNumber: 'Tax exemption number',
  ResaleCertificate: 'Resale certificate',
  CreditLimit: 'Credit limit',
  CreditHold: 'Credit hold',
  CreditHoldStatus: 'Credit hold',
  Branch: 'Branch',
  BranchID: 'Branch',
  PriceClassID: 'Price class',
  CustomerClass: 'Customer class',
  CustomerCategory: 'Customer category',
  Warehouse: 'Warehouse',
  SiteID: 'Warehouse',
  QtyOnHand: 'Qty on hand',
  QtyAvailable: 'Qty available',
  ContactEmail: 'Contact email',
  Address: 'Address',
  ShipTo: 'Ship-to',
  ShipToAddress: 'Ship-to address',
  BillTo: 'Bill-to',
  BillingAddress: 'Billing address',
  owner_id: 'Owner ID',
  name: 'Name',
  email: 'Email',
  phone: 'Phone',
  title: 'Title',
  value: 'Value',
  currency: 'Currency',
  status: 'Status',
  stage_name: 'Stage',
  expected_close_date: 'Expected close',
  person_id: 'Person ID',
  org_id: 'Organization ID',
  industry: 'Industry',
  people_count: 'People count',
  deals_count: 'Deals count',
  InventoryID: 'Inventory ID',
  Description: 'Description',
  ItemClass: 'Item class',
  BaseUOM: 'Base UOM',
  DefaultPrice: 'Default price',
  CurySpecificPrice: 'Current price',
  ListPrice: 'List price',
  OrderNbr: 'Order number',
  OrderTotal: 'Order total',
  RequestedOn: 'Requested on',
  ReferenceNbr: 'Reference number',
  Type: 'Type',
  DocType: 'Document type',
  DocTypeLabel: 'Document type',
  id: 'ID',
  type: 'Type',
  due_date: 'Due date',
  due_time: 'Due time',
  done: 'Done',
  Amount: 'Amount',
  Balance: 'Balance',
  DueDate: 'Due date',
  Updated: 'Updated',
  from: 'From',
  to: 'To',
  subject: 'Subject',
  From: 'From',
  To: 'To',
  Cc: 'Cc',
  Received: 'Received',
  Author: 'Author',
  Created: 'Created',
  Start: 'Start',
  End: 'End',
  Organizer: 'Organizer',
  Location: 'Location',
  Attendees: 'Attendees',
  Site: 'Site',
  Drive: 'Drive',
  'Last modified': 'Last modified',
};

const REVENUE_SOURCE_IDS = ['acumatica', 'pipedrive'];
const PROCUREMENT_SOURCE_IDS = ['acumatica', 'pipedrive', 'm365-mail', 'm365-teams'];
const SALES_SUPPORT_SOURCE_IDS = ['acumatica', 'pipedrive', 'm365-mail', 'm365-teams'];
const COLLABORATION_SOURCE_IDS = ['m365-mail', 'm365-calendar', 'm365-teams', 'm365-sharepoint'];

function profileQuestion(question: string, sourcesOrEntity?: string[] | MemoryScope): IntentProfile {
  const q = question.toLowerCase();
  const explicitSources = Array.isArray(sourcesOrEntity) && sourcesOrEntity.length > 0 ? sourcesOrEntity : undefined;
  const entity = typeof sourcesOrEntity === 'string' ? sourcesOrEntity : inferEntityScope(q);
  const withEntity = (profile: Omit<IntentProfile, 'entity'>): IntentProfile => ({ ...profile, entity });
  if (isPipelineQuestion(q)) {
    return withEntity({
      intent: 'pipeline_lookup',
      scope: 'revenue_ops',
      sourceIds: explicitSources ?? ['pipedrive'],
      label: 'deal/pipeline',
      answerFields: ['title', 'status', 'stage_name', 'value', 'currency', 'expected_close_date', 'person_id', 'org_id'],
      preferredKinds: ['deal'],
      requestedFields: pipelineRequestedFields(q),
    });
  }
  if (isSalesActivityQuestion(q)) {
    return withEntity({
      intent: 'collaboration_lookup',
      scope: 'revenue_ops',
      sourceIds: explicitSources ?? ['pipedrive', 'm365-mail', 'm365-teams', 'm365-calendar'],
      label: 'sales activity',
      answerFields: ['subject', 'type', 'due_date', 'due_time', 'done', 'name', 'email', 'phone', 'From', 'To', 'Received', 'Author', 'Created', 'Start', 'End'],
      preferredKinds: ['activity', 'deal', 'person', 'organization', 'mail', 'teams', 'calendar'],
      requestedFields: salesActivityRequestedFields(q),
    });
  }
  if (isVendorSourcingQuestion(q)) {
    return withEntity({
      intent: 'procurement_request',
      scope: 'procurement',
      sourceIds: explicitSources ?? PROCUREMENT_SOURCE_IDS,
      label: 'procurement request',
      answerFields: ['CustomerName', 'CustomerID', 'InventoryID', 'Description', 'Status', 'Terms'],
      preferredKinds: ['customer', 'item', 'organization', 'mail', 'teams'],
      requestedFields: requestedFields(q),
    });
  }
  if (isReceivablesQuestion(q)) {
    return withEntity({
      intent: 'invoice_lookup',
      scope: 'revenue_ops',
      sourceIds: explicitSources ?? ['acumatica'],
      label: 'invoice',
      answerFields: ['ReferenceNbr', 'Status', 'Amount', 'Balance', 'DueDate', 'CustomerID'],
      preferredKinds: ['invoice'],
      requestedFields: requestedFields(q),
    });
  }
  if (/\b(who|rep|owner|salesperson|contact|phone)\b/.test(q) || isContactEmailQuestion(q)) {
    return withEntity({
      intent: 'contact_lookup',
      scope: 'revenue_ops',
      sourceIds: explicitSources ?? (isContactEmailQuestion(q) ? REVENUE_SOURCE_IDS : SALES_SUPPORT_SOURCE_IDS),
      label: 'contact',
      answerFields: ['owner_id', 'name', 'email', 'phone', 'title', 'CustomerName', 'ContactEmail', 'from', 'to'],
      preferredKinds: ['person', 'organization', 'customer', 'mail', 'teams'],
      requestedFields: contactRequestedFields(q),
    });
  }
  if (isCreditTransactionQuestion(q)) {
    return withEntity({
      intent: 'credit_lookup',
      scope: 'revenue_ops',
      sourceIds: explicitSources ?? ['acumatica'],
      label: 'credit/return',
      answerFields: ['ReferenceNbr', 'Type', 'DocType', 'DocTypeLabel', 'Status', 'Amount', 'Balance', 'DueDate', 'CustomerID'],
      preferredKinds: ['invoice'],
      requestedFields: requestedFields(q),
    });
  }
  if (/\b(price\s+class|priceclass|customer\s+class|pricing\s+tier|pricing\s+class)\b/.test(q)) {
    return withEntity({
      intent: 'customer_lookup',
      scope: 'revenue_ops',
      sourceIds: explicitSources ?? REVENUE_SOURCE_IDS,
      label: 'customer',
      answerFields: ['CustomerID', 'CustomerName', 'Status', 'Terms', 'CreditLimit', 'ContactEmail'],
      preferredKinds: ['customer', 'organization'],
      requestedFields: requestedFields(q),
    });
  }
  if (/\b(invoices?|inv-|due|amount owed|ar|a\/r|receivable|receivables|owe|owes|owed|balance|past due|overdue)\b/.test(q)) {
    return withEntity({
      intent: 'invoice_lookup',
      scope: 'revenue_ops',
      sourceIds: explicitSources ?? ['acumatica'],
      label: 'invoice',
      answerFields: ['ReferenceNbr', 'Status', 'Amount', 'Balance', 'DueDate', 'CustomerID'],
      preferredKinds: ['invoice'],
      requestedFields: requestedFields(q),
    });
  }
  if (/\b(payments?|paid|payment history)\b/.test(q) && !/\bpayment\s+terms?\b/.test(q)) {
    return withEntity({
      intent: 'invoice_lookup',
      scope: 'revenue_ops',
      sourceIds: explicitSources ?? ['acumatica'],
      label: 'payment/invoice',
      answerFields: ['ReferenceNbr', 'Status', 'Amount', 'Balance', 'DueDate', 'CustomerID'],
      preferredKinds: ['invoice'],
      requestedFields: requestedFields(q),
    });
  }
  if (/\b(quotes?|sales quotes?|quote status)\b/.test(q)) {
    return withEntity({
      intent: 'order_lookup',
      scope: 'revenue_ops',
      sourceIds: explicitSources ?? SALES_SUPPORT_SOURCE_IDS,
      label: 'quote/order',
      answerFields: ['OrderNbr', 'Status', 'OrderTotal', 'RequestedOn', 'CustomerID'],
      preferredKinds: ['order', 'salesorder'],
      requestedFields: requestedFields(q),
    });
  }
  if (isProcurementQuestion(q)) {
    return withEntity({
      intent: 'procurement_request',
      scope: 'procurement',
      sourceIds: explicitSources ?? PROCUREMENT_SOURCE_IDS,
      label: 'procurement request',
      answerFields: ['CustomerName', 'CustomerID', 'InventoryID', 'Description', 'Status', 'Terms'],
      preferredKinds: ['customer', 'item', 'organization', 'mail', 'teams'],
      requestedFields: requestedFields(q),
    });
  }
  if (isCollaborationQuestion(q)) {
    return withEntity({
      intent: 'collaboration_lookup',
      scope: 'collaboration',
      sourceIds: explicitSources ?? collaborationSourceIds(q),
      label: 'collaboration record',
      answerFields: ['From', 'To', 'Received', 'Author', 'Created', 'Start', 'End', 'Organizer', 'Location', 'Site', 'Drive', 'Last modified'],
      preferredKinds: ['mail', 'teams', 'calendar', 'sharepoint'],
      requestedFields: requestedFields(q),
    });
  }
  if (/\b(orders?|so-|\bso\b|sales orders?|status|ship|shipped|shipment|tracking|track|delivered|pod|proof of delivery|route|fulfill|fulfillment|backorder|backordered|back order)\b/.test(q)) {
    return withEntity({
      intent: 'order_lookup',
      scope: 'revenue_ops',
      sourceIds: explicitSources ?? SALES_SUPPORT_SOURCE_IDS,
      label: 'order',
      answerFields: ['OrderNbr', 'Status', 'OrderTotal', 'RequestedOn', 'CustomerID'],
      preferredKinds: ['order', 'salesorder'],
      requestedFields: requestedFields(q),
    });
  }
  if (/\b(item|inventory|stock|sku|part|price|uom|material|warehouse|bin|availability|available|quantity|qty)\b/.test(q)) {
    return withEntity({
      intent: 'item_lookup',
      scope: 'procurement',
      sourceIds: explicitSources ?? PROCUREMENT_SOURCE_IDS,
      label: 'item',
      answerFields: ['InventoryID', 'Description', 'ItemClass', 'BaseUOM', 'CurySpecificPrice', 'DefaultPrice', 'ListPrice', 'Warehouse', 'SiteID', 'QtyOnHand', 'QtyAvailable', 'Status'],
      preferredKinds: ['item', 'stockitem'],
      requestedFields: requestedFields(q),
    });
  }
  if (/\b(contact|email|phone|who|rep|owner)\b/.test(q)) {
    return withEntity({
      intent: 'contact_lookup',
      scope: 'revenue_ops',
      sourceIds: explicitSources ?? (isContactEmailQuestion(q) ? REVENUE_SOURCE_IDS : SALES_SUPPORT_SOURCE_IDS),
      label: 'contact',
      answerFields: ['owner_id', 'name', 'email', 'phone', 'title', 'CustomerName', 'ContactEmail', 'from', 'to'],
      preferredKinds: ['person', 'organization', 'customer', 'mail', 'teams'],
      requestedFields: contactRequestedFields(q),
    });
  }
  if (/\b(customer|account|terms|credit|tax|taxable|exempt|resale|certificate|cert|branch)\b/.test(q)) {
    return withEntity({
      intent: 'customer_lookup',
      scope: 'revenue_ops',
      sourceIds: explicitSources ?? REVENUE_SOURCE_IDS,
      label: 'customer',
      answerFields: ['CustomerID', 'CustomerName', 'Status', 'Terms', 'CreditLimit', 'ContactEmail', 'Address', 'ShipTo', 'ShipToAddress', 'BillTo', 'BillingAddress'],
      preferredKinds: ['customer', 'organization'],
      requestedFields: requestedFields(q),
    });
  }
  if (/\b(address|ship\s*to|shipping|bill\s*to|billing)\b/.test(q)) {
    return withEntity({
      intent: 'customer_lookup',
      scope: 'revenue_ops',
      sourceIds: explicitSources ?? REVENUE_SOURCE_IDS,
      label: 'customer',
      answerFields: ['CustomerID', 'CustomerName', 'Status', 'Terms', 'CreditLimit', 'ContactEmail', 'Address', 'ShipTo', 'ShipToAddress', 'BillTo', 'BillingAddress'],
      preferredKinds: ['customer', 'organization'],
      requestedFields: requestedFields(q),
    });
  }
  return withEntity({
    intent: 'general_lookup',
    scope: explicitSources ? 'all' : 'revenue_ops',
    sourceIds: explicitSources ?? REVENUE_SOURCE_IDS,
    label: 'record',
    answerFields: ['CustomerName', 'Description', 'Status', 'Terms', 'OrderNbr', 'ReferenceNbr', 'InventoryID'],
    preferredKinds: [],
    requestedFields: requestedFields(q),
  });
}

function inferEntityScope(questionLower: string): MemoryScope | undefined {
  if (/\b(fs|fastening|fastening specialists)\b/.test(questionLower)) return 'fs';
  if (/\b(bl|blcs|big league|big league construction)\b/.test(questionLower)) return 'blcs';
  if (/\b(usa|utility|utility supply|waterworks|utility supply associates)\b/.test(questionLower)) return 'usa';
  return undefined;
}

function stripEntityScopePhrases(value: string): string {
  return value
    .replace(/^\s*(?:fs|fastening|fastening specialists)\b/gi, ' ')
    .replace(/^\s*(?:bl|blcs|big league|big league construction)\b/gi, ' ')
    .replace(/^\s*(?:usa|utility|utility supply|waterworks|utility supply associates)\b/gi, ' ')
    .replace(/\b(?:at|in|from|for)\s+(?:fs|fastening|fastening specialists)\b/gi, ' ')
    .replace(/\b(?:at|in|from|for)\s+(?:bl|blcs|big league|big league construction)\b/gi, ' ')
    .replace(/\b(?:at|in|from|for)\s+(?:usa|utility|utility supply|waterworks|utility supply associates)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveMemoryScope(opts: AskOptions): MemoryScope {
  const profile = profileQuestion(opts.question, opts.entity);
  return (profile.entity ?? opts.entity ?? 'shared') as MemoryScope;
}

async function safeRecall(question: string, scope: MemoryScope): Promise<string[]> {
  if (!config.SUPERMEMORY_API_KEY) return [];
  try {
    return await recall(question, scope);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[ask] supermemory recall failed (scope=${scope}): ${reason}`);
    return [];
  }
}

function usefulHits(
  question: string,
  profile: IntentProfile,
  hits: SearchResult[],
  resolvedEntity: EntityResolution | null = null,
): SearchResult[] {
  const terms = importantTerms(question);
  const matchingTerms = profile.intent === 'invoice_lookup' && entityTerms(question, profile).length === 0
    ? []
    : terms;
  const entities = shouldConstrainToResolvedEntity(resolvedEntity) ? [] : entityTerms(question, profile);
  const ranked = rerankHits(question, profile, hits);
  const maxScore = Math.max(0, ...ranked.map((hit) => Number(hit.score ?? 0)));
  const threshold = Math.max(0.25, maxScore * 0.35);
  return ranked
    .filter((hit) => Number(hit.score ?? 0) >= threshold || titleMatches(hit, terms))
    .filter((hit) => recordKindMatchesIntent(hit, profile))
    .filter((hit) => receivablesRecordMatches(question, profile, hit))
    .filter((hit) => matchingTerms.length === 0 || textMatchesAny(hit, matchingTerms))
    .filter((hit) => collaborationRoleMatches(question, profile, hit))
    .filter((hit) => !shouldConstrainToResolvedEntity(resolvedEntity) || textMatchesResolvedAlias(hit, resolvedEntity))
    .filter((hit) => entities.length === 0 || textMatchesEntity(hit, entities, profile))
    .slice(0, 5);
}

function renderAnswer(
  question: string,
  profile: IntentProfile,
  hits: SearchResult[],
  resolvedEntity: EntityResolution | null,
): { text: string; confidence: BrainAnswer['confidence'] } {
  if (resolvedEntity?.ambiguous) {
    return {
      confidence: 'low',
      text: withDeliveryTrackingNote(question, profile, [
        `That ${profile.label} ask is ambiguous.`,
        `I found multiple possible matches: ${resolvedEntity.alternatives.slice(0, 4).join('; ')}.`,
        'Please add the full customer name, item/SKU, order number, or another identifier.',
      ]),
    };
  }

  const filtered = usefulHits(question, profile, hits, resolvedEntity);
  if (!filtered.length) {
    return {
      confidence: 'low',
      text: withDeliveryTrackingNote(question, profile, [
        `I could not find a solid ${profile.label} match for that ask.`,
        noMatchHint(profile),
      ]),
    };
  }

  const top = filtered[0];
  const topFields = extractFields(top.chunk_text ?? '');
  const answerFields = prioritizedFields(profile, topFields);
  const fieldLines = renderFields(topFields, answerFields);
  const requestedLines = renderFields(topFields, profile.requestedFields);
  const confidence = resolvedEntity?.confidence === 'high' && Number(top.score ?? 0) >= 1.2
    ? 'high'
    : Number(top.score ?? 0) >= 2.5 ? 'high' : Number(top.score ?? 0) >= 1.2 ? 'medium' : 'low';
  const title = displayTitle(top, topFields);
  const lines = requestedLines.length > 0
    ? [`${title}: ${requestedLines.join('; ')}`]
    : [`Best match: ${title}`];
  const requestedButMissing = profile.requestedFields.length > 0 && requestedLines.length === 0;

  if (fieldLines.length) {
    if (profile.intent !== 'collaboration_lookup' && requestedButMissing) {
      lines.push(missingRequestedFieldMessage(profile));
    }
    const detailLines = suppressGenericDetailsForMissingRequest(profile)
      ? []
      : fieldLines
        .filter((line) => !requestedLines.includes(line))
        .filter((line) => !suppressDetailLine(question, line));
    lines.push(...detailLines.map((line) => `- ${line}`));
    lines.push(...missingRequestedFieldNotes(question, profile, topFields));
    lines.push(...pricingContextNotes(question, profile, topFields));
  } else {
    const summary = compactSummary(top.chunk_text ?? '');
    if (summary) lines.push(summary);
  }

  const alternates = confidence === 'high' && (requestedLines.length > 0 || Boolean(resolvedEntity))
    ? []
    : uniqueAlternates(title, filtered.slice(1, 5));
  if (alternates.length) {
    lines.push('');
    lines.push(`Also possibly relevant: ${alternates.map((hit) => hit.title || hit.slug).join('; ')}`);
  }

  return { text: withDeliveryTrackingNote(question, profile, lines), confidence };
}

function withDeliveryTrackingNote(question: string, profile: IntentProfile, lines: string[]): string {
  const text = lines.join('\n');
  if (profile.intent !== 'order_lookup' || !needsDeliveryTrackingNote(question)) return text;
  return [
    text,
    '',
    'Delivery and tracking data (TrackPod) is not yet connected to the brain. For live delivery status, check TrackPod directly.',
  ].join('\n');
}

function needsDeliveryTrackingNote(question: string): boolean {
  return /\b(tracking|delivered|pod|proof of delivery|route)\b/i.test(question);
}

export async function askBrain(opts: AskOptions): Promise<BrainAnswer> {
  const scope = resolveMemoryScope(opts);
  const memoriesPromise = safeRecall(opts.question, scope);
  const profile = profileQuestion(opts.question, opts.sources);
  if (profile.intent === 'procurement_request') {
    const answer = procurementPlanBrainAnswer(await createProcurementActionPlan(opts.question));
    return { ...answer, memories: await memoriesPromise };
  }

  const engine = await openEngine();
  try {
    const resolutionQuestion = entityResolutionQuestion(opts.question, profile);
    const resolvedEntity = shouldResolveEntityForQuestion(opts.question, profile)
      ? await resolveEntity(engine, resolutionQuestion, profile.sourceIds, entityResolutionKinds(profile))
      : null;
    const hits = profile.intent === 'collaboration_lookup' && isRecentQuestion(opts.question)
      ? await recentCollaborationHits(engine, profile, opts.question, opts.limit ?? 12)
      : resolvedEntity?.ambiguous
      ? []
      : await runSearches(engine, opts.question, profile, opts.limit ?? 12, resolvedEntity);
    const filtered = resolvedEntity?.ambiguous ? [] : usefulHits(opts.question, profile, hits, resolvedEntity);
    const answerEntity = alignResolvedEntity(resolvedEntity, filtered[0]);
    const seen = new Set<string>();
    const citations: BrainCitation[] = [];
    for (const h of filtered) {
      if (seen.has(h.slug)) continue;
      seen.add(h.slug);
      citations.push({
        slug: h.slug,
        source_id: h.source_id ?? 'default',
        title: displayTitle(h, extractFields(h.chunk_text ?? '')),
        source_uri: h.source_id ?? null,
      });
      if (citations.length >= 3) break;
    }
    const answer = renderAnswer(opts.question, profile, hits, resolvedEntity);
    const memories = await memoriesPromise;
    return {
      text: answer.text,
      citations,
      memories,
      intent: profile.intent,
      scope: profile.scope,
      confidence: answer.confidence,
      resolvedEntity: answerEntity,
    };
  } finally {
    await engine.disconnect();
  }
}

async function recentCollaborationHits(
  engine: Awaited<ReturnType<typeof openEngine>>,
  profile: IntentProfile,
  question: string,
  limit: number,
): Promise<SearchResult[]> {
  const pages = await readSourcePages(engine, profile.sourceIds);
  const now = Date.now();
  const upcoming = isUpcomingQuestion(question);
  return pages
    .map((page) => ({
      slug: page.slug,
      title: page.title,
      source_id: page.source_id,
      chunk_text: page.chunk_text,
      score: Math.max(0.1, recordTimestamp(page as SearchResult) / 1_000_000_000_000),
    }) as SearchResult)
    .filter((hit) => recordTimestamp(hit) > 0)
    .filter((hit) => {
      if (!profile.sourceIds?.includes('m365-calendar')) return true;
      const timestamp = recordTimestamp(hit);
      return upcoming ? timestamp >= now : timestamp <= now;
    })
    .sort((a, b) => upcoming ? recordTimestamp(a) - recordTimestamp(b) : recordTimestamp(b) - recordTimestamp(a))
    .slice(0, limit);
}

async function readSourcePages(
  engine: Awaited<ReturnType<typeof openEngine>>,
  sourceIds?: string[],
): Promise<SourcePage[]> {
  const maybeStore = (engine as any).store;
  if (Array.isArray(maybeStore?.pages)) {
    return maybeStore.pages
      .filter((page: any) => !sourceIds?.length || sourceIds.includes(page.source_id ?? ''))
      .map((page: any) => ({
        slug: String(page.slug),
        title: page.title ?? null,
        source_id: page.source_id ?? null,
        source_uri: page.source_uri ?? null,
        chunk_text: page.chunk_text ?? null,
      }));
  }
  if (typeof (engine as any).executeRaw === 'function') {
    const rows = await (engine as any).executeRaw(
      `SELECT slug, title, chunk_text, source_id, source_uri
       FROM brain_documents
       WHERE ($1::text[] IS NULL OR source_id = ANY($1::text[]))
       LIMIT 10000`,
      [sourceIds?.length ? sourceIds : null],
    );
    return rows.map((page: any) => ({
      slug: String(page.slug),
      title: page.title ?? null,
      source_id: page.source_id ?? null,
      source_uri: page.source_uri ?? null,
      chunk_text: page.chunk_text ?? null,
    }));
  }
  return [];
}

function isProcurementQuestion(questionLower: string): boolean {
  if (/\b(buy|source|sourcing|vendor|supplier|purchase order|po|quote|needed by|need by|ship to)\b/.test(questionLower)) {
    return true;
  }
  if (/\b(need|needs|needed|get|order)\b.+\b\d+(?:\.\d+)?\s*(?:ea|each|box|boxes|pcs|pc|ft|lf|sf|roll|rolls|bag|bags)?\b/.test(questionLower)) {
    return true;
  }
  return false;
}

function isCreditTransactionQuestion(questionLower: string): boolean {
  if (/\bcredit\s+limit\b/.test(questionLower)) return false;
  return /\b(credit\s+memo|credit\s+note|unapplied\s+credit|customer\s+credit|has\s+a\s+credit|have\s+a\s+credit|rma|return|returned|refund)\b/.test(questionLower);
}

function isVendorSourcingQuestion(questionLower: string): boolean {
  return /\b(who\s+sells|vendors?\s+for|suppliers?\s+for|vendor|supplier|source|sourcing)\b/.test(questionLower);
}

function isReceivablesQuestion(questionLower: string): boolean {
  return /\b(who|what|which)\b.*\b(owe|owes|owed|past due|overdue|receivable|receivables|a\/r|ar|balance|balances)\b/.test(questionLower)
    || /\b(owe|owes|owed|past due|overdue|receivable|receivables|a\/r|ar)\b.*\b(money|us|open|balance|balances)\b/.test(questionLower);
}

function isPipelineQuestion(questionLower: string): boolean {
  return /\b(deals?|pipeline|opportunit(?:y|ies)|stage|expected close|close date)\b/.test(questionLower);
}

function isSalesActivityQuestion(questionLower: string): boolean {
  if (/\b(follow[-\s]?ups?|activity|activities|touchpoint|touchpoints)\b/.test(questionLower)) return true;
  return (
    /\b(latest|recent|newest|last|next|upcoming)\b.*\bcalls?\b/.test(questionLower)
    || /\bcalls?\b.*\b(with|about)\b/.test(questionLower)
  );
}

function entityResolutionQuestion(question: string, profile: IntentProfile): string {
  if (!['customer_lookup', 'contact_lookup'].includes(profile.intent)) return question;
  if (!profile.requestedFields.some((field) => ['Terms', 'CreditLimit', 'PriceClassID', 'CustomerClass', 'CustomerCategory', 'owner_id', 'ContactEmail', 'email'].includes(field))) {
    return question;
  }
  const forMatch = /\bfor\s+([a-z0-9@._-]+(?:\s+[a-z0-9@._-]+){0,3})/i.exec(question);
  if (forMatch?.[1]) return stripEntityScopePhrases(forMatch[1]);
  const accountMatch = /\b(?:customer|account|rep|owner|terms?|credit|contact|email)\s+([a-z0-9@._-]+(?:\s+[a-z0-9@._-]+){0,3})/i.exec(question);
  if (accountMatch?.[1]) return stripEntityScopePhrases(accountMatch[1]);
  return stripEntityScopePhrases(question);
}

function entityResolutionKinds(profile: IntentProfile): string[] | undefined {
  if (profile.intent === 'customer_lookup') return ['customer', 'organization'];
  if (profile.intent === 'contact_lookup') return ['person', 'organization', 'customer'];
  if (profile.intent === 'item_lookup') return ['item'];
  return undefined;
}

function shouldResolveEntityForQuestion(question: string, profile: IntentProfile): boolean {
  if (profile.intent === 'collaboration_lookup' || profile.intent === 'pipeline_lookup') return false;
  if (hasSpecificRecordId(question, profile)) return false;
  if (profile.intent === 'invoice_lookup' && entityTerms(question, profile).length === 0) return false;
  return true;
}

function hasSpecificRecordId(question: string, profile: IntentProfile): boolean {
  if (profile.intent === 'order_lookup') return /\bso-?\d+\b/i.test(question);
  if (profile.intent === 'invoice_lookup') return /\binv-?\d+\b/i.test(question);
  if (profile.intent === 'credit_lookup') return /\b(?:cm|rma|inv)-?\d+\b/i.test(question);
  return false;
}

function isCollaborationQuestion(questionLower: string): boolean {
  if (/\bcontact\s+email\b/.test(questionLower)) return false;
  if (isContactEmailQuestion(questionLower)) return false;
  if (/\b(emails?|mail|inbox|messages?|teams|chat|meetings?|calendar|events?|appointments?|sharepoint|drive|documents?|files?)\b/.test(questionLower)) {
    return true;
  }
  return false;
}

function isContactEmailQuestion(questionLower: string): boolean {
  if (!/\bemail\b/.test(questionLower)) return false;
  if (/\b(emails|mail|inbox|latest|recent|newest|last|from|to|about|subject|thread)\b/.test(questionLower)) {
    return false;
  }
  return (
    /\b(email\s+(?:for|of)|(?:for|of)\s+[a-z0-9@._-]+(?:\s+[a-z0-9@._-]+){0,3}\s+email)\b/.test(questionLower)
    || /\b[a-z0-9@._-]+(?:\s+[a-z0-9@._-]+){0,3}\s+email\b/.test(questionLower)
  );
}

function collaborationSourceIds(questionLower: string): string[] {
  if (/\b(emails?|mail|inbox)\b/.test(questionLower)) return ['m365-mail'];
  if (/\b(teams|chat|messages?)\b/.test(questionLower)) return ['m365-teams'];
  if (/\b(meetings?|calendar|events?|appointments?)\b/.test(questionLower)) return ['m365-calendar'];
  if (/\b(sharepoint|documents?|files?)\b/.test(questionLower)) return ['m365-sharepoint'];
  return COLLABORATION_SOURCE_IDS;
}

function alignResolvedEntity(
  resolution: EntityResolution | null,
  topHit: SearchResult | undefined,
): EntityResolution | null {
  if (!resolution) return null;
  if (!topHit) return resolution;
  const canonicalName = topHit.title ?? resolution.canonicalName;
  const aliases = new Set(resolution.aliases);
  if (canonicalName) aliases.add(canonicalName);
  return {
    ...resolution,
    canonicalName,
    aliases: Array.from(aliases),
  };
}

async function runSearches(
  engine: Awaited<ReturnType<typeof openEngine>>,
  question: string,
  profile: IntentProfile,
  limit: number,
  resolvedEntity: EntityResolution | null,
): Promise<SearchResult[]> {
  const queries = searchQueries(question, profile, resolvedEntity);
  const combined = new Map<string, SearchResult>();
  const searchLimit = isBroadReceivablesAsk(question, profile) ? Math.max(limit, 50) : limit;
  for (const query of queries) {
    const hits = await hybridSearch(engine, query, {
      limit: searchLimit,
      sourceIds: profile.sourceIds,
    });
    for (const hit of hits) {
      const existing = combined.get(hit.slug);
      if (!existing || Number(hit.score ?? 0) > Number(existing.score ?? 0)) {
        combined.set(hit.slug, hit);
      }
    }
  }
  return rerankHits(question, profile, Array.from(combined.values())).slice(0, searchLimit);
}

function extractFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of text.matchAll(/-\s+\*\*([^*]+)\*\*:\s*([\s\S]*?)(?=\s+-\s+\*\*|$)/g)) {
    const key = match[1]?.trim();
    const value = match[2]?.replace(/\s+/g, ' ').trim();
    if (key && value && value !== '{}') fields[key] = value;
  }
  for (const match of text.matchAll(/^\s*-\s+([A-Za-z][A-Za-z /]+):\s*(.+)$/gm)) {
    const key = match[1]?.trim();
    const value = match[2]?.replace(/\s+/g, ' ').trim();
    if (key && value && value !== '{}' && !fields[key]) fields[key] = value;
  }
  for (const match of text.matchAll(/-\s+([A-Za-z][A-Za-z /]+):\s*([\s\S]*?)(?=\s+-\s+[A-Za-z][A-Za-z /]+:|$)/g)) {
    const key = match[1]?.trim();
    const value = match[2]?.replace(/\s+/g, ' ').trim();
    if (key && value && value !== '{}' && !fields[key]) fields[key] = value;
  }
  return fields;
}

function renderFields(fields: Record<string, string>, keys: string[]): string[] {
  const lines: string[] = [];
  for (const key of keys) {
    if (!fields[key]) continue;
    lines.push(`${fieldLabel(key, fields[key])}: ${formatFieldValue(key, fields[key])}`);
  }
  return lines.slice(0, 8);
}

function fieldLabel(key: string, raw: string): string {
  if (key === 'owner_id') {
    const value = raw.trim();
    if (value.startsWith('{') && value.includes('"name"')) return 'Owner';
  }
  return FIELD_LABELS[key] ?? key;
}

function formatFieldValue(key: string, raw: string): string {
  const value = raw.trim();
  if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
    try {
      const parsed = JSON.parse(value) as any;
      if (key === 'owner_id' && parsed?.name) {
        return parsed.email ? `${parsed.name} <${parsed.email}>` : String(parsed.name);
      }
      if (parsed?.name) return String(parsed.name);
      if (parsed?.email) return String(parsed.email);
      if (parsed?.value !== undefined) return String(parsed.value);
    } catch {
      return value.slice(0, 160);
    }
  }
  return value.slice(0, 220);
}

function displayTitle(hit: SearchResult, fields: Record<string, string>): string {
  const title = hit.title?.trim();
  if (title && !isBadDisplayValue(title)) return title;
  const fallback = fields.ReferenceNbr
    ?? fields.OrderNbr
    ?? fields.CustomerName
    ?? fields.name
    ?? fields.title
    ?? fields.InventoryID
    ?? hit.slug;
  return isBadDisplayValue(fallback) ? hit.slug : fallback;
}

function isBadDisplayValue(value: string | null | undefined): boolean {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  return normalized === '[object object]' || normalized === 'unknown' || normalized === 'null';
}

function prioritizedFields(profile: IntentProfile, fields: Record<string, string>): string[] {
  const requested = profile.requestedFields.filter((field) => fields[field]);
  const rest = profile.answerFields.filter((field) => !requested.includes(field));
  return [...requested, ...rest];
}

function compactSummary(text: string): string {
  const cleaned = text
    .replace(/^---[\s\S]*?---/, '')
    .replace(/#\s*Fields[\s\S]*$/i, '')
    .replace(/#\s+/g, '')
    .replace(/-\s+\*\*[^*]+\*\*:\s*[^-]+/g, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280);
  return cleaned || 'I found a possible match, but the indexed record did not expose clean fields for a direct answer.';
}

function importantTerms(question: string): string[] {
  return stripEntityScopePhrases(question)
    .toLowerCase()
    .replace(/[^a-z0-9/@._-]+/g, ' ')
    .split(/\s+/)
    .filter((term) => term.length >= 3)
    .filter((term) => !STOP_TERMS.has(term));
}

function searchQueries(question: string, profile: IntentProfile, resolvedEntity: EntityResolution | null = null): string[] {
  const queries = new Set<string>([question.trim()]);
  const recordIds = question.match(/\b(?:so|inv|po)-?\d+\b/gi) ?? [];
  for (const id of recordIds) queries.add(id);
  if (profile.intent === 'invoice_lookup' && entityTerms(question, profile).length === 0) {
    queries.add('invoice balance');
    queries.add('ReferenceNbr Balance Amount');
  }
  const useful = importantTerms(question);
  if (useful.length > 0) queries.add(useful.join(' '));
  const possibleName = entityTerms(question, profileQuestion(question))
    .slice(0, 5)
    .join(' ');
  if (possibleName.length >= 3) queries.add(possibleName);
  for (const alias of resolvedEntity?.aliases ?? []) {
    queries.add(alias);
  }
  return Array.from(queries).filter(Boolean).slice(0, 4);
}

function requestedFields(questionLower: string): string[] {
  const fields: string[] = [];
  if (/\bterms?\b/.test(questionLower)) fields.push('Terms');
  if (/\b(price\s+class|priceclass|pricing\s+tier|pricing\s+class)\b/.test(questionLower)) {
    fields.push('PriceClassID', 'CustomerClass', 'CustomerCategory');
  }
  if (/\b(branch)\b/.test(questionLower)) {
    fields.push('Branch', 'BranchID');
  }
  if (/\b(deals?|pipeline|opportunit(?:y|ies)|stage|expected close|close date)\b/.test(questionLower)) {
    fields.push('title', 'status', 'stage_name', 'value', 'currency', 'expected_close_date');
  }
  if (/\b(warehouse|bin|availability|available|on hand|on-hand|quantity|qty)\b/.test(questionLower)) {
    fields.push('Warehouse', 'SiteID', 'QtyOnHand', 'QtyAvailable');
  }
  if (/\b(tax|taxable|tax exempt|exempt|resale|certificate|cert)\b/.test(questionLower)) {
    fields.push('TaxZone', 'TaxRegistrationID', 'TaxExemptionNumber', 'ResaleCertificate');
  }
  if (/\b(ship\s*to|shipping)\b/.test(questionLower)) fields.push('ShipTo', 'ShipToAddress', 'Address');
  if (/\b(bill\s*to|billing)\b/.test(questionLower)) fields.push('BillTo', 'BillingAddress', 'Address');
  if (/\baddress\b/.test(questionLower)) fields.push('Address', 'ShipToAddress', 'BillingAddress');
  if (/\bcredit\s+hold\b/.test(questionLower)) fields.push('CreditHold', 'CreditHoldStatus', 'Status');
  if (/\bcredit\b/.test(questionLower) && !/\bcredit\s+hold\b/.test(questionLower)) fields.push('CreditLimit');
  if (/\b(phone|call)\b/.test(questionLower)) fields.push('phone');
  if (/\b(email|contact)\b/.test(questionLower)) fields.push('ContactEmail', 'email', 'from', 'to');
  if (/\b(emails?|mail|inbox)\b/.test(questionLower)) fields.push('From', 'To', 'Received');
  if (/\b(messages?|teams|chat)\b/.test(questionLower)) fields.push('Author', 'Created');
  if (/\b(meetings?|calendar|events?|appointments?)\b/.test(questionLower)) fields.push('Start', 'End', 'Organizer', 'Location');
  if (/\b(sharepoint|drive|documents?|files?)\b/.test(questionLower)) fields.push('Site', 'Drive', 'Last modified');
  if (/\b(price|cost|list)\b/.test(questionLower)) fields.push('CurySpecificPrice', 'DefaultPrice', 'ListPrice', 'Amount', 'OrderTotal');
  if (/\b(balance|owe|owes|owed|receivable|receivables|ar|a\/r)\b/.test(questionLower)) fields.push('Balance', 'Amount');
  if (/\b(credit memo|credit note|unapplied credit|customer credit|has a credit|have a credit|rma|return|returned|refund)\b/.test(questionLower)) {
    fields.push('ReferenceNbr', 'Type', 'DocType', 'DocTypeLabel', 'Status', 'Amount', 'Balance');
  }
  if (/\b(status|open|closed)\b/.test(questionLower)) fields.push('Status');
  if (/\b(ship|shipped|shipment|tracking|track|delivered|pod|proof of delivery|route|fulfill|fulfillment|backorder|backordered|back order)\b/.test(questionLower)) fields.push('Status', 'RequestedOn');
  if (/\b(due|needed|requested)\b/.test(questionLower)) fields.push('DueDate', 'RequestedOn');
  if (/\b(owner|owns|rep|salesperson)\b/.test(questionLower)) fields.push('owner_id');
  return fields;
}

function contactRequestedFields(questionLower: string): string[] {
  const allowed = new Set(['owner_id', 'ContactEmail', 'email', 'from', 'to', 'phone']);
  const fields = requestedFields(questionLower).filter((field) => allowed.has(field));
  if (/\b(owner|owns|rep|salesperson|who)\b/.test(questionLower) && !fields.includes('owner_id')) {
    fields.unshift('owner_id');
  }
  return fields;
}

function salesActivityRequestedFields(questionLower: string): string[] {
  const fields = ['subject', 'type', 'due_date', 'due_time', 'done'];
  if (/\bphone\b/.test(questionLower)) fields.push('phone');
  return fields;
}

function pipelineRequestedFields(questionLower: string): string[] {
  const fields: string[] = [];
  if (/\bstage\b/.test(questionLower)) fields.push('stage_name', 'status');
  if (/\b(open|status)\b/.test(questionLower)) fields.push('status');
  if (/\b(value|amount|worth)\b/.test(questionLower)) fields.push('value', 'currency');
  if (/\b(expected close|close date|closing|close)\b/.test(questionLower)) fields.push('expected_close_date');
  if (!fields.length) fields.push('title', 'status', 'stage_name', 'value', 'currency', 'expected_close_date');
  return fields;
}

function missingRequestedFieldMessage(profile: IntentProfile): string {
  if (profile.requestedFields.includes('owner_id')) {
    return 'I found the likely account/contact record, but I only found an owner id, not a resolved owner name.';
  }
  return `I found the likely ${profile.label}, but I did not find the requested field on that record.`;
}

function suppressGenericDetailsForMissingRequest(profile: IntentProfile): boolean {
  const exactFields = new Set(['phone', 'Address', 'ShipTo', 'ShipToAddress', 'BillTo', 'BillingAddress']);
  return profile.requestedFields.some((field) => exactFields.has(field));
}

function suppressDetailLine(question: string, line: string): boolean {
  if (/\bcredit\s+hold\b/i.test(question) && /^Credit limit:/i.test(line)) return true;
  return false;
}

function missingRequestedFieldNotes(
  question: string,
  profile: IntentProfile,
  fields: Record<string, string>,
): string[] {
  if (profile.intent !== 'customer_lookup') return [];
  if (!/\b(resale|certificate|cert|tax exempt|exempt)\b/i.test(question)) return [];
  const hasCertificateEvidence = Boolean(fields.TaxRegistrationID || fields.TaxExemptionNumber || fields.ResaleCertificate);
  if (hasCertificateEvidence) return [];
  return ['I found customer tax context, but I did not find a resale or tax-exemption certificate field on that record.'];
}

function pricingContextNotes(
  question: string,
  profile: IntentProfile,
  fields: Record<string, string>,
): string[] {
  if (profile.intent !== 'item_lookup') return [];
  if (!/\b(customer[-\s]?specific|contract|special|acme|get on|gets on|customer price|price for customer)\b/i.test(question)) {
    return [];
  }
  const hasCustomerSpecificPrice = Boolean(fields.CustomerPrice || fields.ContractPrice || fields.SpecialPrice);
  if (hasCustomerSpecificPrice) return [];
  return ['I found item/base pricing, but I did not find customer-specific contract or special pricing on that record.'];
}

function receivablesRecordMatches(question: string, profile: IntentProfile, hit: SearchResult): boolean {
  if (!isBroadReceivablesAsk(question, profile)) return true;
  const fields = extractFields(hit.chunk_text ?? '');
  if (/closed|void|paid/i.test(fields.Status ?? '')) return false;
  return numericField(fields.Balance) > 0 || numericField(fields.Amount) > 0;
}

function isBroadReceivablesAsk(question: string, profile: IntentProfile): boolean {
  return profile.intent === 'invoice_lookup' && entityTerms(question, profile).length === 0 && isReceivablesQuestion(question.toLowerCase());
}

function numericField(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function noMatchHint(profile: IntentProfile): string {
  if (profile.intent === 'pipeline_lookup') {
    return 'Try adding the customer or deal name, owner, stage, expected close date, or a more specific opportunity identifier.';
  }
  if (profile.label === 'sales activity') {
    return 'Try adding a contact name, activity subject, deal name, owner, or date range.';
  }
  if (profile.intent === 'collaboration_lookup') {
    return 'Try adding a subject, sender, mailbox, Teams channel, file name, meeting title, or date range.';
  }
  return 'Try adding a customer name, order number, item/SKU, contact, or date range.';
}

function rerankHits(question: string, profile: IntentProfile, hits: SearchResult[]): SearchResult[] {
  const terms = importantTerms(question);
  const entities = entityTerms(question, profile);
  return hits
    .map((hit) => {
      const fields = extractFields(hit.chunk_text ?? '');
      const kind = recordKind(hit);
      const entityMatched = entities.length === 0 || textMatchesEntity(hit, entities, profile);
      let score = Number(hit.score ?? 0);
      if (profile.preferredKinds.includes(kind)) score += entityMatched ? 1.2 : 0.2;
      if (profile.requestedFields.some((field) => fields[field])) score += entityMatched ? 1.5 : 0.1;
      if (profile.answerFields.some((field) => fields[field])) score += entityMatched ? 0.6 : 0.1;
      if (titleMatches(hit, terms)) score += 0.8;
      if (titleMatches(hit, entities)) score += 1.4;
      if (!entityMatched && entities.length > 0) score -= 2;
      score += Math.min(1, matchingTermCount(hit, terms) * 0.15);
      return { ...hit, score };
    })
    .sort((a, b) => {
      if (profile.intent === 'collaboration_lookup' && isRecentQuestion(question)) {
        const dateDiff = isUpcomingQuestion(question)
          ? recordTimestamp(a) - recordTimestamp(b)
          : recordTimestamp(b) - recordTimestamp(a);
        if (dateDiff !== 0) return dateDiff;
      }
      return Number(b.score ?? 0) - Number(a.score ?? 0) || String(a.slug).localeCompare(String(b.slug));
    });
}

function entityTerms(question: string, profile: IntentProfile): string[] {
  const fieldWords = new Set([
    'term',
    'terms',
    'price',
    'pricing',
    'class',
    'tier',
    'cost',
    'money',
    'credit',
    'details',
    'status',
    'stage',
    'open',
    'closed',
    'pipeline',
    'deal',
    'deals',
    'opportunity',
    'opportunities',
    'owner',
    'owns',
    'owned',
    'rep',
    'email',
    'contact',
    'order',
    'credit',
    'memo',
    'note',
    'unapplied',
    'rma',
    'return',
    'returned',
    'refund',
    'orders',
    'so',
    'sales',
    'tracking',
    'track',
    'delivered',
    'pod',
    'proof',
    'delivery',
    'route',
    'ship',
    'shipped',
    'shipment',
    'fulfill',
    'fulfillment',
    'backorder',
    'backordered',
    'invoice',
    'owe',
    'owes',
    'owed',
    'receivable',
    'receivables',
    'balance',
    'balances',
    'overdue',
    'item',
    'stock',
    'warehouse',
    'bin',
    'availability',
    'available',
    'quantity',
    'qty',
    'branch',
    'summary',
    'email',
    'emails',
    'mail',
    'inbox',
    'message',
    'messages',
    'teams',
    'chat',
    'meeting',
    'meetings',
    'upcoming',
    'next',
    'future',
    'calendar',
    'event',
    'events',
    'appointment',
    'appointments',
    'sharepoint',
    'drive',
    'document',
    'documents',
    'file',
    'files',
    'customer',
    'account',
    'who',
    'what',
    'where',
    'us',
    'call',
    'calls',
    'follow',
    'followup',
    'activity',
    'activities',
    'touchpoint',
    'touchpoints',
    'address',
    'shipping',
    'billing',
    'phone',
  ]);
  const intentWords = new Set(profile.intent.split('_'));
  return importantTerms(question).filter((term) => !fieldWords.has(term) && !intentWords.has(term));
}

function collaborationRoleMatches(question: string, profile: IntentProfile, hit: SearchResult): boolean {
  if (profile.intent !== 'collaboration_lookup') return true;
  const fields = extractFields(hit.chunk_text ?? '');
  const fromTerm = roleTerm(question, 'from');
  if (fromTerm) return fieldContains(fields.From ?? '', fromTerm);
  const toTerm = roleTerm(question, 'to');
  if (toTerm) return fieldContains(fields.To ?? '', toTerm);
  return true;
}

function roleTerm(question: string, role: 'from' | 'to'): string | null {
  const match = new RegExp(`\\b${role}\\s+([a-z0-9@._-]+)`, 'i').exec(question);
  const term = match?.[1]?.replace(/[.,;:]+$/, '').trim().toLowerCase();
  if (!term || STOP_TERMS.has(term)) return null;
  return term;
}

function fieldContains(value: string, term: string): boolean {
  return value.toLowerCase().includes(term);
}

function entityAliasTerms(resolution: EntityResolution): string[] {
  const terms = new Set<string>();
  for (const alias of resolution.aliases) {
    for (const term of importantTerms(alias)) terms.add(term);
  }
  return Array.from(terms);
}

function recordKind(hit: SearchResult): string {
  const text = `${hit.source_id ?? ''} ${hit.slug ?? ''} ${hit.title ?? ''}`.toLowerCase();
  if (text.includes('activity')) return 'activity';
  if (text.includes('deal')) return 'deal';
  if (text.includes('note')) return 'note';
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

function recordKindMatchesIntent(hit: SearchResult, profile: IntentProfile): boolean {
  const kind = recordKind(hit);
  if (profile.intent === 'customer_lookup') return ['customer', 'organization'].includes(kind);
  if (profile.intent === 'item_lookup') return kind === 'item';
  if (profile.intent === 'order_lookup') return kind === 'order';
  if (profile.intent === 'invoice_lookup') return kind === 'invoice';
  if (profile.intent === 'credit_lookup') return kind === 'invoice';
  if (profile.intent === 'pipeline_lookup') return kind === 'deal';
  if (profile.intent === 'contact_lookup') return ['person', 'organization', 'customer', 'mail', 'teams'].includes(kind);
  return true;
}

function matchingTermCount(hit: SearchResult, terms: string[]): number {
  const text = `${hit.title ?? ''} ${hit.slug ?? ''} ${hit.chunk_text ?? ''}`.toLowerCase();
  return terms.filter((term) => text.includes(term)).length;
}

function uniqueAlternates(primaryTitle: string, hits: SearchResult[]): SearchResult[] {
  const seen = new Set<string>([normalizeTitle(primaryTitle)]);
  const out: SearchResult[] = [];
  for (const hit of hits) {
    const key = normalizeTitle(hit.title || hit.slug);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
    if (out.length >= 2) break;
  }
  return out;
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const STOP_TERMS = new Set([
  'the',
  'and',
  'for',
  'from',
  'with',
  'to',
  'what',
  'where',
  'when',
  'who',
  'us',
  'how',
  'are',
  'was',
  'were',
  'need',
  'needs',
  'tell',
  'show',
  'find',
  'details',
  'email',
  'emails',
  'mail',
  'info',
  'inbox',
  'look',
  'lookup',
  'message',
  'messages',
  'latest',
  'recent',
  'newest',
  'last',
  'upcoming',
  'next',
  'future',
  'teams',
  'chat',
  'meeting',
  'meetings',
  'calendar',
  'event',
  'events',
  'appointment',
  'appointments',
  'sharepoint',
  'drive',
  'document',
  'documents',
  'file',
  'files',
  'summary',
  'about',
  'status',
]);

function isRecentQuestion(question: string): boolean {
  return /\b(latest|recent|newest|last|upcoming|next)\b/i.test(question);
}

function isUpcomingQuestion(question: string): boolean {
  return /\b(upcoming|next|future)\b/i.test(question);
}

function recordTimestamp(hit: SearchResult): number {
  const fields = extractFields(hit.chunk_text ?? '');
  const candidates = [
    fields.Received,
    fields.Created,
    fields.Updated,
    fields.Start,
    fields.End,
    fields['Last modified'],
    fields.due_date,
    fields.DueDate,
    hit.slug?.match(/\d{4}-\d{2}-\d{2}/)?.[0],
  ].filter((value): value is string => Boolean(value));
  for (const value of candidates) {
    const timestamp = Date.parse(value);
    if (!Number.isNaN(timestamp)) return timestamp;
  }
  return 0;
}

function titleMatches(hit: SearchResult, terms: string[]): boolean {
  const title = `${hit.title ?? ''} ${hit.slug ?? ''}`.toLowerCase();
  return terms.some((term) => title.includes(term));
}

function textMatchesAny(hit: SearchResult, terms: string[]): boolean {
  const text = `${hit.title ?? ''} ${hit.slug ?? ''} ${hit.chunk_text ?? ''}`.toLowerCase();
  return terms.some((term) => text.includes(term));
}

function textMatchesEntity(hit: SearchResult, terms: string[], profile: IntentProfile): boolean {
  const text = `${hit.title ?? ''} ${hit.slug ?? ''} ${hit.chunk_text ?? ''}`.toLowerCase();
  if (terms.length <= 1) return terms.some((term) => text.includes(term));
  if (
    profile.intent === 'item_lookup'
    || profile.intent === 'order_lookup'
    || profile.intent === 'invoice_lookup'
    || profile.intent === 'credit_lookup'
    || profile.intent === 'collaboration_lookup'
    || profile.intent === 'pipeline_lookup'
  ) {
    return terms.every((term) => text.includes(term));
  }
  return terms.some((term) => text.includes(term));
}

function textMatchesResolvedAlias(hit: SearchResult, resolution: EntityResolution): boolean {
  const text = `${hit.title ?? ''} ${hit.slug ?? ''} ${hit.chunk_text ?? ''}`.toLowerCase();
  return resolution.aliases.some((alias: string) => {
    const terms = importantTerms(alias);
    if (!terms.length) return false;
    return terms.every((term) => text.includes(term));
  });
}

function shouldConstrainToResolvedEntity(resolution: EntityResolution | null): resolution is EntityResolution {
  return Boolean(resolution?.canonicalName && resolution.confidence !== 'low');
}
