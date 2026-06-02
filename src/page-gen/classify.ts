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
  | 'other';

export interface ClassifiedEntity {
  /** Stable id within its type. For Acumatica: `acumatica_id`. */
  id: string;
  type: EntityType;
  /** Display title. Falls back to `id` if no title. */
  title: string;
  /** Source system identifier (`Acumatica`, `Pipedrive`, `M365 Mail`, etc.) */
  sourceSystem: string;
  /** Raw connector source_kind. */
  sourceKind: string;
  /** Source URI from frontmatter, if any. */
  sourceUri: string | null;
  /** Page slug (gbrain's stable handle). */
  pageSlug: string;
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

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
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
  // Pipedrive: persons could be reps if the user later wires that mapping.
  // For v1, leave them as 'other' (searchable but no dedicated page).
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

function entityTitle(page: RawPage, fields: Record<string, string>): string {
  // Prefer the human field over the raw title when both exist.
  return (
    (page.title && page.title.length > 0 ? page.title : null) ??
    fields['CustomerName'] ??
    fields['Name'] ??
    fields['Description'] ??
    fields['OrderNbr'] ??
    fields['ReferenceNbr'] ??
    fields['InventoryID'] ??
    'Untitled record'
  );
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
    title: entityTitle(page, fields),
    sourceSystem,
    sourceKind,
    sourceUri: getString(fm, 'source_uri'),
    pageSlug: page.slug,
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
}

export function buildRelations(buckets: ClassifiedBuckets): RelationshipIndex {
  const ordersByCustomer = new Map<string, ClassifiedEntity[]>();
  const invoicesByCustomer = new Map<string, ClassifiedEntity[]>();

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

  return { ordersByCustomer, invoicesByCustomer };
}
