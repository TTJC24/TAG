/**
 * Classify raw `pages` rows into v3's six entity buckets and extract the
 * structured fields gbrain renders as markdown bullets into `compiled_truth`.
 *
 * Why this exists: gbrain stores everything as one generic `pages` row with
 * the body as markdown. Business fields like `CustomerID`, `Amount`,
 * `DueDate` are LITERAL TEXT in `compiled_truth` (rendered by each
 * connector's markdownFor() at ingest time), not typed columns. To produce
 * a real "customer page" we have to re-parse the bullet list.
 *
 * Source bullet format (see src/sources/acumatica.ts renderBody):
 *   - **CustomerID**: ACME001
 *   - **CustomerName**: Acme Industries
 *   - **DueDate**: 2026-07-15
 *
 * This module is forgiving: missing fields are just absent from the
 * extracted map. Unknown source kinds get classified as 'other' (not
 * rendered to a page, but still searchable if we choose to include them).
 */
import type { RawPage } from './db.ts';

export type EntityType =
  | 'customer'
  | 'order'
  | 'invoice'
  | 'item'
  | 'vendor'
  | 'rep'
  | 'deal'
  | 'contact'
  | 'activity'
  | 'other';

export interface ClassifiedEntity {
  /** Stable id within its type. For Acumatica: `acumatica_id`. */
  id: string;
  type: EntityType;
  /** Display title. Falls back to `id` if no title. */
  title: string;
  /** Source system identifier (`Acumatica`, `Pipedrive`, `M365 Mail`, etc.) */
  sourceSystem: string;
  /** Source instance/scope (`FS`, `BLCS/USA`, etc.) */
  sourceInstance: string;
  /** Source record type (`deal`, `organization`, `person`, etc.) */
  entityKind: string | null;
  /** Raw connector source_kind. */
  sourceKind: string;
  /** Source URI from frontmatter, if any. */
  sourceUri: string | null;
  /** Page slug (gbrain's stable handle). */
  pageSlug: string;
  /** Output slug used by the static page generator. */
  fileSlug: string;
  /** gbrain ingestion timestamp (when we last imported the page). */
  pageUpdatedAt: Date;
  /**
   * Upstream record's update timestamp (the source-system's last-modified
   * field), parsed from frontmatter. Null when the connector didn't carry
   * one (the v3 freshness contract from cb7bf4d/0a4f8dd/60f2813).
   */
  upstreamUpdatedAt: Date | null;
  /** Structured fields extracted from compiled_truth bullets. */
  fields: Record<string, string>;
  /** Full markdown body. */
  body: string;
  /** Raw frontmatter for debugging / advanced rendering. */
  frontmatter: Record<string, unknown>;
}

export interface ClassifiedBuckets {
  customers: ClassifiedEntity[];
  orders: ClassifiedEntity[];
  invoices: ClassifiedEntity[];
  items: ClassifiedEntity[];
  vendors: ClassifiedEntity[];
  reps: ClassifiedEntity[];
  deals: ClassifiedEntity[];
  contacts: ClassifiedEntity[];
  activities: ClassifiedEntity[];
  /** Anything that doesn't map to the six v3 surfaces. Surfaced in search
   *  but not rendered as a dedicated page in v1. */
  other: ClassifiedEntity[];
}

const SOURCE_KIND_LABELS: Record<string, string> = {
  acumatica: 'Acumatica',
  pipedrive: 'Pipedrive',
  'm365-mail': 'M365 Mail',
  'm365-calendar': 'M365 Calendar',
  'm365-sharepoint': 'M365 SharePoint',
  'm365-teams': 'M365 Teams',
  supermemory: 'Supermemory',
};

function getString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function decodeHtmlEntities(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&#(\d+);/g, (_m, code: string) => {
      const n = Number(code);
      return Number.isFinite(n) ? String.fromCharCode(n) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => {
      const n = Number.parseInt(code, 16);
      return Number.isFinite(n) ? String.fromCharCode(n) : '';
    });
}

export function cleanVisibleText(value: unknown): string {
  return decodeHtmlEntities(value)
    .replace(/<\s*br\s*\/?\s*>/gi, ' ')
    .replace(/<\s*\/p\s*>/gi, ' ')
    .replace(/<\s*\/div\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isDirtyTitle(value: string | null | undefined): boolean {
  if (!value) return true;
  const clean = cleanVisibleText(value);
  if (clean.length === 0) return true;
  const lower = clean.toLowerCase();
  return (
    /<[^>]+>/.test(value) ||
    lower === 'null' ||
    lower === 'undefined' ||
    lower === 'mobile scan' ||
    lower.startsWith('mobile scan ') ||
    lower.length > 140
  );
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

function sourceInstanceFor(sourceId: string): string {
  if (sourceId === 'pipedrive-fs') return 'FS';
  if (sourceId === 'pipedrive-blcs-usa') return 'BLCS/USA';
  if (sourceId.endsWith('-fs')) return 'FS';
  if (sourceId.endsWith('-blcs')) return 'BLCS';
  if (sourceId.endsWith('-usa')) return 'USA';
  return sourceId;
}

/**
 * Extract `- **Key**: Value` bullets from a markdown body. Returns a flat
 * key/value map; later occurrences of the same key win (rare in practice).
 */
export function extractFieldsFromMarkdown(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^- \*\*([^*]+)\*\*:\s*(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const key = m[1]?.trim();
    const value = m[2]?.trim();
    if (key && value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function classifyType(page: RawPage, fm: Record<string, unknown>): EntityType {
  const acumaticaKind = getString(fm, 'acumatica_kind');
  if (acumaticaKind === 'customer') return 'customer';
  if (acumaticaKind === 'order') return 'order';
  if (acumaticaKind === 'invoice') return 'invoice';
  if (acumaticaKind === 'item') return 'item';
  if (acumaticaKind === 'vendor') return 'vendor';
  if (acumaticaKind === 'rep' || acumaticaKind === 'salesperson') return 'rep';
  const pipedriveKind = getString(fm, 'pipedrive_kind');
  if (pipedriveKind === 'organization') return 'customer';
  if (pipedriveKind === 'person') return 'contact';
  if (pipedriveKind === 'deal') return 'deal';
  if (pipedriveKind === 'activity' || pipedriveKind === 'note') return 'activity';

  return 'other';
}

function entityId(page: RawPage, fm: Record<string, unknown>): string {
  return (
    getString(fm, 'acumatica_id') ??
    getString(fm, 'pipedrive_id') ??
    getString(fm, 'supermemory_id') ??
    page.slug
  );
}

function entityTitle(page: RawPage, fm: Record<string, unknown>, fields: Record<string, string>): string {
  const pipedriveKind = getString(fm, 'pipedrive_kind');
  if (pipedriveKind === 'activity' || pipedriveKind === 'note') {
    const derived = activityTitle(page, fields, pipedriveKind);
    if (derived) return derived;
  }

  const candidates = [
    fields['CustomerName'],
    fields['Name'],
    fields.name,
    fields.title,
    fields.subject,
    fields['Description'],
    fields['OrderNbr'],
    fields['ReferenceNbr'],
    fields['InventoryID'],
    page.title,
  ];
  for (const candidate of candidates) {
    if (!isDirtyTitle(candidate)) return cleanVisibleText(candidate);
  }
  return 'Untitled record';
}

function activityTitle(page: RawPage, fields: Record<string, string>, kind: string): string | null {
  const subject = fields.subject ?? fields.title ?? page.title;
  const related =
    fields.org_name ??
    objectField(fields.org_id, 'name') ??
    objectField(fields.person_id, 'name') ??
    objectField(fields.deal_id, 'title') ??
    objectField(fields.deal_id, 'name');
  if (related && isDirtyTitle(subject)) return cleanVisibleText(related);
  if (subject && !isDirtyTitle(subject)) return cleanVisibleText(subject);

  const rawType = cleanVisibleText(fields.type ?? fields.activity_type ?? '');
  const type = rawType.toLowerCase() === 'mobile scan' ? '' : rawType;
  const date = cleanVisibleText(fields.due_date ?? fields.add_time ?? fields.update_time ?? '');
  const label = kind === 'note' ? 'Pipedrive note' : (type ? `${type} activity` : 'Pipedrive activity');
  return date ? `${label} - ${date}` : label;
}

export function classifyPage(page: RawPage): ClassifiedEntity {
  const fm = page.frontmatter ?? {};
  const fields = extractFieldsFromMarkdown(page.compiled_truth ?? '');
  const sourceKind = getString(fm, 'source_kind') ?? 'unknown';
  const sourceSystem = SOURCE_KIND_LABELS[sourceKind] ?? sourceKind;
  const upstreamRaw = getString(fm, 'updated_at') ?? getString(fm, 'last_modified');
  return {
    id: entityId(page, fm),
    type: classifyType(page, fm),
    title: entityTitle(page, fm, fields),
    sourceSystem,
    sourceInstance: sourceInstanceFor(page.source_id),
    entityKind: getString(fm, 'pipedrive_kind') ?? getString(fm, 'acumatica_kind'),
    sourceKind,
    sourceUri: getString(fm, 'source_uri'),
    pageSlug: page.slug,
    fileSlug: page.slug,
    pageUpdatedAt: page.updated_at,
    upstreamUpdatedAt: parseDate(upstreamRaw),
    fields,
    body: page.compiled_truth ?? '',
    frontmatter: fm,
  };
}

export function classifyAll(pages: readonly RawPage[]): ClassifiedBuckets {
  const buckets: ClassifiedBuckets = {
    customers: [],
    orders: [],
    invoices: [],
    items: [],
    vendors: [],
    reps: [],
    deals: [],
    contacts: [],
    activities: [],
    other: [],
  };
  for (const p of pages) {
    const c = classifyPage(p);
    switch (c.type) {
      case 'customer': buckets.customers.push(c); break;
      case 'order': buckets.orders.push(c); break;
      case 'invoice': buckets.invoices.push(c); break;
      case 'item': buckets.items.push(c); break;
      case 'vendor': buckets.vendors.push(c); break;
      case 'rep': buckets.reps.push(c); break;
      case 'deal': buckets.deals.push(c); break;
      case 'contact': buckets.contacts.push(c); break;
      case 'activity': buckets.activities.push(c); break;
      default: buckets.other.push(c); break;
    }
  }
  return buckets;
}

/**
 * Forward index: customer id -> related entities (orders, invoices).
 * Derived from each entity's `body.CustomerID` bullet. v1 only handles
 * the customer relationship because that's the highest-value join we
 * have today; future iterations can add deal/contact joins.
 */
export interface RelationshipIndex {
  /** customerId -> ordered list of orders for that customer. */
  ordersByCustomer: Map<string, ClassifiedEntity[]>;
  /** customerId -> ordered list of invoices for that customer. */
  invoicesByCustomer: Map<string, ClassifiedEntity[]>;
  /** customer/org id -> Pipedrive contacts. */
  contactsByCustomer: Map<string, ClassifiedEntity[]>;
  /** customer/org id -> Pipedrive deals. */
  dealsByCustomer: Map<string, ClassifiedEntity[]>;
  /** customer/org id -> Pipedrive activity and note records. */
  activitiesByCustomer: Map<string, ClassifiedEntity[]>;
  /** deal id -> Pipedrive activity and note records. */
  activitiesByDeal: Map<string, ClassifiedEntity[]>;
  /** contact/person id -> Pipedrive deals. */
  dealsByContact: Map<string, ClassifiedEntity[]>;
  /** contact/person id -> Pipedrive activity and note records. */
  activitiesByContact: Map<string, ClassifiedEntity[]>;
  customersByKey: Map<string, ClassifiedEntity>;
  dealsByKey: Map<string, ClassifiedEntity>;
  contactsByKey: Map<string, ClassifiedEntity>;
}

export function buildRelations(buckets: ClassifiedBuckets): RelationshipIndex {
  const ordersByCustomer = new Map<string, ClassifiedEntity[]>();
  const invoicesByCustomer = new Map<string, ClassifiedEntity[]>();
  const contactsByCustomer = new Map<string, ClassifiedEntity[]>();
  const dealsByCustomer = new Map<string, ClassifiedEntity[]>();
  const activitiesByCustomer = new Map<string, ClassifiedEntity[]>();
  const activitiesByDeal = new Map<string, ClassifiedEntity[]>();
  const dealsByContact = new Map<string, ClassifiedEntity[]>();
  const activitiesByContact = new Map<string, ClassifiedEntity[]>();
  const customersByKey = new Map<string, ClassifiedEntity>();
  const dealsByKey = new Map<string, ClassifiedEntity>();
  const contactsByKey = new Map<string, ClassifiedEntity>();

  for (const order of buckets.orders) {
    const customerId = order.fields['CustomerID'];
    if (!customerId) continue;
    const list = ordersByCustomer.get(customerId) ?? [];
    list.push(order);
    ordersByCustomer.set(customerId, list);
  }
  for (const invoice of buckets.invoices) {
    const customerId = invoice.fields['CustomerID'];
    if (!customerId) continue;
    const list = invoicesByCustomer.get(customerId) ?? [];
    list.push(invoice);
    invoicesByCustomer.set(customerId, list);
  }
  for (const customer of buckets.customers) {
    customersByKey.set(relationKey(customer.sourceInstance, customer.id), customer);
  }
  for (const deal of buckets.deals) {
    dealsByKey.set(relationKey(deal.sourceInstance, deal.id), deal);
  }
  for (const contact of buckets.contacts) {
    contactsByKey.set(relationKey(contact.sourceInstance, contact.id), contact);
  }

  for (const contact of buckets.contacts) {
    addRelation(contactsByCustomer, relatedKey(contact, 'org_id', 'org'), contact);
  }
  for (const deal of buckets.deals) {
    addRelation(dealsByCustomer, relatedKey(deal, 'org_id', 'org'), deal);
    addRelation(dealsByContact, relatedKey(deal, 'person_id', 'person'), deal);
  }
  for (const activity of buckets.activities) {
    addRelation(activitiesByCustomer, relatedKey(activity, 'org_id', 'org'), activity);
    addRelation(activitiesByDeal, relatedKey(activity, 'deal_id', 'deal'), activity);
    addRelation(activitiesByContact, relatedKey(activity, 'person_id', 'person'), activity);
  }

  // Sort related lists by upstream timestamp desc when present, else by
  // gbrain page updated_at desc -- newest first.
  const sortDesc = (list: ClassifiedEntity[]): void => {
    list.sort((a, b) => {
      const at = (a.upstreamUpdatedAt ?? a.pageUpdatedAt).getTime();
      const bt = (b.upstreamUpdatedAt ?? b.pageUpdatedAt).getTime();
      return bt - at;
    });
  };
  for (const list of ordersByCustomer.values()) sortDesc(list);
  for (const list of invoicesByCustomer.values()) sortDesc(list);
  for (const list of contactsByCustomer.values()) sortDesc(list);
  for (const list of dealsByCustomer.values()) sortDesc(list);
  for (const list of activitiesByCustomer.values()) sortDesc(list);
  for (const list of activitiesByDeal.values()) sortDesc(list);
  for (const list of dealsByContact.values()) sortDesc(list);
  for (const list of activitiesByContact.values()) sortDesc(list);

  return {
    ordersByCustomer,
    invoicesByCustomer,
    contactsByCustomer,
    dealsByCustomer,
    activitiesByCustomer,
    activitiesByDeal,
    dealsByContact,
    activitiesByContact,
    customersByKey,
    dealsByKey,
    contactsByKey,
  };
}

function addRelation(
  map: Map<string, ClassifiedEntity[]>,
  id: string | null,
  entity: ClassifiedEntity,
): void {
  if (!id) return;
  const list = map.get(id) ?? [];
  list.push(entity);
  map.set(id, list);
}

function relatedId(entity: ClassifiedEntity, fieldName: string, fallbackPrefix: string): string | null {
  const raw = entity.fields[fieldName];
  if (!raw) return null;
  const parsed = parseMaybeJson(raw);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const value = obj.value ?? obj.id;
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  if (/^\d+$/.test(raw)) return raw;
  return raw.length > 0 ? `${fallbackPrefix}:${raw}` : null;
}

function relatedKey(entity: ClassifiedEntity, fieldName: string, fallbackPrefix: string): string | null {
  const id = relatedId(entity, fieldName, fallbackPrefix);
  return id ? relationKey(entity.sourceInstance, id) : null;
}

export function relationKey(sourceInstance: string, id: string): string {
  return `${sourceInstance}:${id}`;
}

export function parseMaybeJson(raw: string | undefined): unknown {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export function objectField(raw: string | undefined, key: string): string | null {
  const parsed = parseMaybeJson(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const value = (parsed as Record<string, unknown>)[key];
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  return null;
}
