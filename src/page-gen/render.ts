/**
 * Static HTML rendering for the page generator.
 *
 * Templates are plain template literals (no framework). Every value that
 * enters HTML goes through escapeHtml() unless it's a deliberately-trusted
 * markdown body, which is rendered via gbrain's existing `marked`-equivalent
 * (or, if unavailable, a tiny inline conversion that escapes everything
 * except for a few safe markdown idioms).
 *
 * Output structure:
 *   /dist/index.html          home with section counts + recent activity
 *   /dist/search.html         search shell that loads search-index.json
 *   /dist/styles.css          shared stylesheet
 *   /dist/search.js           client-side search using Lunr from CDN
 *   /dist/<type>/index.html   listing per entity type
 *   /dist/<type>/<slug>.html  per-record detail
 */
import { marked } from 'marked';
import {
  type ClassifiedEntity,
  type ClassifiedBuckets,
  type RelationshipIndex,
  objectField,
  relationKey,
} from './classify.ts';
import { classifyFreshness, type FreshnessReport } from './freshness.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * URL-safe slug for filenames. Preserves ASCII alphanumerics, dashes,
 * underscores, and dots; everything else is replaced with `-`. Length
 * capped at 80 to stay friendly to every filesystem.
 */
export function safeSlug(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : 'untitled';
}

function renderBodyMarkdown(md: string): string {
  // marked v9+ returns string; older returns Promise<string>. We force sync.
  const out = marked.parse(md ?? '', { async: false }) as unknown;
  return typeof out === 'string' ? out : String(out);
}

function formatTimestamp(d: Date | null): string {
  if (!d) return '(unknown)';
  return d.toISOString().replace('.000Z', 'Z');
}

function freshnessBadge(report: FreshnessReport): string {
  const cls = `freshness freshness-${report.status}`;
  const tip =
    report.reference === 'upstream'
      ? `upstream last updated ${formatTimestamp(report.upstreamUpdatedAt)}`
      : `freshness unknown -- last ingested ${formatTimestamp(report.pageUpdatedAt)}`;
  return `<span class="${cls}" title="${escapeHtml(tip)}">${escapeHtml(report.status)} · ${escapeHtml(report.label)}</span>`;
}

const TYPE_LABELS: Record<string, { single: string; plural: string }> = {
  customer: { single: 'Customer', plural: 'Customers' },
  order: { single: 'Order', plural: 'Orders' },
  invoice: { single: 'Invoice', plural: 'Invoices' },
  item: { single: 'Item', plural: 'Items' },
  vendor: { single: 'Vendor', plural: 'Vendors' },
  rep: { single: 'Rep', plural: 'Reps' },
  deal: { single: 'Deal', plural: 'Deals' },
  contact: { single: 'Contact', plural: 'Contacts' },
  activity: { single: 'Activity', plural: 'Activities' },
};

const NAV_TYPES = ['customer', 'deal', 'contact', 'activity', 'order', 'invoice', 'item', 'vendor', 'rep'] as const;

export function entityHref(type: string, id: string): string {
  return `/${encodeURIComponent(type)}/${encodeURIComponent(safeSlug(id))}.html`;
}

// ---------------------------------------------------------------------------
// Layout shell
// ---------------------------------------------------------------------------
interface LayoutOpts {
  title: string;
  generatedAt: Date;
  active?: string; // which nav item to mark current
}

function layout(opts: LayoutOpts, contentHtml: string): string {
  const nav = (['index', ...NAV_TYPES] as const)
    .map((slot) => {
      const href = slot === 'index' ? '/' : `/${slot}/`;
      const label = slot === 'index' ? 'Home' : (TYPE_LABELS[slot]?.plural ?? slot);
      const isActive = opts.active === slot ? ' aria-current="page"' : '';
      return `<a href="${escapeHtml(href)}"${isActive}>${escapeHtml(label)}</a>`;
    })
    .join('\n      ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <title>${escapeHtml(opts.title)} -- Company Brain</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/"><span class="brand-mark">CB</span><span>Company Brain</span></a>
    <nav>
      ${nav}
      <a class="search-link" href="/search.html">Search</a>
    </nav>
  </header>
  <main>
${contentHtml}
  </main>
  <footer class="generated-at">
    Snapshot generated ${formatTimestamp(opts.generatedAt)}. Static, read-only, access controlled.
  </footer>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Home page
// ---------------------------------------------------------------------------
export function renderHome(
  buckets: ClassifiedBuckets,
  generatedAt: Date,
  totalPages: number,
): string {
  const sections = NAV_TYPES.map(
    (type) => {
      const list = bucketFor(buckets, type);
      const label = TYPE_LABELS[type]!.plural;
      const count = list.length;
      const single = TYPE_LABELS[type]!.single;
      return `<a class="stat-card" href="${escapeHtml('/' + type + '/')}">
        <span class="stat-label">${escapeHtml(label)}</span>
        <strong>${count.toLocaleString()}</strong>
        <span class="stat-sub">${count === 1 ? single : `${single} records`}</span>
      </a>`;
    },
  );

  const body = `
    <section class="hero">
      <div>
        <p class="eyebrow">Internal operating directory</p>
        <h1>Company Brain</h1>
        <p class="lede">Search customers, contacts, deals, activity, and operating records from connected systems. Static, read-only, and gated by Cloudflare Access.</p>
      </div>
      <div class="hero-meta">
        <span>${totalPages.toLocaleString()} records</span>
        <span>Source: Pipedrive</span>
      </div>
    </section>

    <a class="home-search" href="/search.html">
      <span>Search the directory</span>
      <strong>Customers, contacts, deals, notes, owners, emails, phone numbers</strong>
    </a>

    <div class="home-grid">
      ${sections.join('\n      ')}
    </div>

    ${
      totalPages === 0
        ? `<div class="empty-state">
        <h2>The brain is empty</h2>
        <p>No pages found in <code>public.pages</code>. This usually means ingest hasn't run yet. From the droplet:</p>
        <pre><code>cd /opt/company-brain/repo/infra
docker compose logs company-brain-ingest</code></pre>
        <p>Once ingest runs and writes rows, re-run <code>bun run pagegen</code> to regenerate this site.</p>
      </div>`
        : ''
    }
  `;

  return layout({ title: 'Home', generatedAt, active: 'index' }, body);
}

// ---------------------------------------------------------------------------
// Type listing (one per type)
// ---------------------------------------------------------------------------
export function renderTypeListing(
  type: string,
  entities: ClassifiedEntity[],
  generatedAt: Date,
): string {
  const label = TYPE_LABELS[type]?.plural ?? type;
  if (entities.length === 0) {
    const single = TYPE_LABELS[type]?.single ?? type;
    const body = `
      <section class="page-heading">
        <p class="breadcrumbs"><a href="/">Home</a> &rsaquo; <span>${escapeHtml(label)}</span></p>
        <h1>${escapeHtml(label)}</h1>
      </section>
      <div class="empty-state">
        <p>No ${escapeHtml(single.toLowerCase())} records in the brain yet.</p>
        ${
          type === 'vendor' || type === 'rep'
            ? `<p>The ${escapeHtml(single.toLowerCase())} surface is reserved -- no connector currently produces ${escapeHtml(label.toLowerCase())} records (Acumatica's vendor REST contract is not wired). This page will populate when that connector ships.</p>`
            : '<p>Run an ingest cycle and then re-run <code>bun run pagegen</code> to populate this view.</p>'
        }
      </div>
    `;
    return layout({ title: label, generatedAt, active: type }, body);
  }

  const rows = entities
    .map((e) => {
      const f = classifyFreshness(e.upstreamUpdatedAt, e.pageUpdatedAt, generatedAt);
      return `<tr>
        <td class="entity-name"><a href="${escapeHtml(entityHref(type, e.fileSlug))}">${escapeHtml(e.title)}</a><span>${escapeHtml(primaryLine(e))}</span></td>
        <td>${badge(type)}</td>
        <td>${badge(e.sourceSystem)} ${badge(e.sourceInstance)}</td>
        <td>${freshnessBadge(f)}</td>
      </tr>`;
    })
    .join('\n      ');

  const body = `
    <section class="page-heading">
      <p class="breadcrumbs"><a href="/">Home</a> &rsaquo; <span>${escapeHtml(label)}</span></p>
      <h1>${escapeHtml(label)} <span class="count">${entities.length.toLocaleString()}</span></h1>
      <p class="lede">Browse records, then use Search when you need to jump directly to a company, person, deal, or note.</p>
    </section>
    <table class="entity-list">
      <thead>
        <tr><th>Name</th><th>Type</th><th>Source</th><th>Freshness</th></tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
  return layout({ title: label, generatedAt, active: type }, body);
}

// ---------------------------------------------------------------------------
// Per-record detail
// ---------------------------------------------------------------------------
export function renderEntityDetail(
  type: string,
  entity: ClassifiedEntity,
  relations: RelationshipIndex,
  generatedAt: Date,
): string {
  const single = TYPE_LABELS[type]?.single ?? type;
  const freshness = classifyFreshness(entity.upstreamUpdatedAt, entity.pageUpdatedAt, generatedAt);

  const metaCards = renderMetaCards(type, entity, freshness);

  // Key fields table (parsed from markdown bullets)
  const summaryBlock = renderPipedriveSummary(type, entity);
  const fieldEntries = usefulFieldEntries(entity);
  const fieldsBlock =
    fieldEntries.length === 0
      ? '<p class="muted">No structured fields extracted from this record.</p>'
      : `<table class="entity-fields">
          <tbody>
            ${fieldEntries
              .map(
                ([k, v]) =>
                  `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`,
              )
              .join('\n            ')}
          </tbody>
        </table>`;

  // Related records
  const related = renderRelated(type, entity, relations);

  // Body (markdown -> HTML)
  const bodyHtml = renderBodyMarkdown(entity.body);

  const content = `
    <section class="detail-heading">
      <p class="breadcrumbs">
        <a href="/">Home</a>
        &rsaquo; <a href="/search.html">Search</a>
        &rsaquo; <a href="${escapeHtml('/' + type + '/')}">${escapeHtml(TYPE_LABELS[type]?.plural ?? type)}</a>
      </p>
      <div class="detail-title-row">
        <div>
          <p class="eyebrow">${escapeHtml(single)} · ${escapeHtml(entity.sourceSystem)} · ${escapeHtml(entity.sourceInstance)}</p>
          <h1>${escapeHtml(entity.title)}</h1>
          <p class="lede">${escapeHtml(primaryLine(entity))}</p>
        </div>
        ${freshnessBadge(freshness)}
      </div>
    </section>

    ${metaCards}

    ${summaryBlock}

    <section>
      <h2>Useful fields</h2>
      ${fieldsBlock}
    </section>

    ${related}

    <details class="raw-data">
      <summary>Raw data</summary>
      <p class="muted">Source markdown as ingested. This is intentionally collapsed to keep operational pages readable.</p>
      <article class="source-body">${bodyHtml}</article>
    </details>
  `;

  return layout({ title: entity.title, generatedAt, active: type }, content);
}

function badge(value: string): string {
  return `<span class="badge">${escapeHtml(value)}</span>`;
}

function primaryLine(entity: ClassifiedEntity): string {
  const org = entity.fields.org_name ?? objectField(entity.fields.org_id, 'name');
  const owner = entity.fields.owner_name ?? objectField(entity.fields.user_id, 'name') ?? objectField(entity.fields.creator_user_id, 'name');
  const status = entity.fields.status;
  const value = formatMoney(entity.fields.value, entity.fields.currency);
  const email = primaryFromArray(entity.fields.email) ?? entity.fields.primary_email;
  const phone = primaryFromArray(entity.fields.phone);
  const parts = [org, owner ? `Owner: ${owner}` : null, status, value, email, phone].filter(
    (part): part is string => Boolean(part && part.length > 0),
  );
  return parts.length > 0 ? parts.slice(0, 3).join(' · ') : `${entity.sourceSystem} ${entity.entityKind ?? entity.type}`;
}

function primaryFromArray(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const preferred = parsed.find((item) => item && typeof item === 'object' && (item as Record<string, unknown>).primary === true) ?? parsed[0];
    if (!preferred || typeof preferred !== 'object') return null;
    const value = (preferred as Record<string, unknown>).value;
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function renderMetaCards(type: string, entity: ClassifiedEntity, freshness: FreshnessReport): string {
  const cards: Array<[string, string]> = [
    ['Record type', TYPE_LABELS[type]?.single ?? type],
    ['Source', `${entity.sourceSystem} · ${entity.sourceInstance}`],
    ['System of record', systemOfRecordFor(type, entity)],
    ['Owner', entity.fields.owner_name ?? objectField(entity.fields.user_id, 'name') ?? objectField(entity.fields.creator_user_id, 'name') ?? 'Unknown'],
    ['Updated', formatTimestamp(entity.upstreamUpdatedAt)],
    ['Refreshed', formatTimestamp(entity.pageUpdatedAt)],
    ['Freshness', freshness.status],
  ];
  if (entity.sourceUri) cards.push(['Source URI', entity.sourceUri]);

  return `<section class="meta-grid">
    ${cards
      .map(
        ([label, value]) => `<div class="meta-tile">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
        </div>`,
      )
      .join('\n    ')}
  </section>`;
}

function usefulFieldEntries(entity: ClassifiedEntity): Array<[string, string]> {
  const priority = [
    'name',
    'title',
    'org_name',
    'owner_name',
    'status',
    'stage_id',
    'value',
    'currency',
    'email',
    'phone',
    'primary_email',
    'due_date',
    'add_time',
    'update_time',
    'last_activity_date',
    'next_activity_date',
    'notes_count',
    'open_deals_count',
    'closed_deals_count',
    'won_deals_count',
    'lost_deals_count',
  ];
  const seen = new Set<string>();
  const rows: Array<[string, string]> = [];
  const push = (key: string, value: string | undefined): void => {
    if (!value || seen.has(key) || isJsonLike(value) || looksSensitive(key, value)) return;
    seen.add(key);
    rows.push([humanizeField(key), value]);
  };
  for (const key of priority) push(key, entity.fields[key]);
  for (const [key, value] of Object.entries(entity.fields)) {
    if (rows.length >= 24) break;
    push(key, value);
  }
  return rows;
}

function humanizeField(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function isJsonLike(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function looksSensitive(key: string, value: string): boolean {
  const haystack = `${key} ${value}`.toLowerCase();
  return haystack.includes('token') || haystack.includes('secret') || haystack.includes('password') || haystack.includes('api_key');
}

function systemOfRecordFor(type: string, entity: ClassifiedEntity): string {
  // v3 source-authority rule:
  //   customer/order/invoice/item/vendor -> Acumatica
  //   rep -> Pipedrive (when wired); otherwise N/A
  //   anything else -> the entity's own sourceSystem
  if (entity.sourceKind === 'pipedrive') return 'Pipedrive';
  if (['customer', 'order', 'invoice', 'item', 'vendor'].includes(type)) return 'Acumatica';
  if (type === 'rep') return entity.sourceSystem;
  return entity.sourceSystem;
}

function renderPipedriveSummary(type: string, entity: ClassifiedEntity): string {
  if (entity.sourceKind !== 'pipedrive') return '';

  const rawRows: Array<[string, string | null | undefined]> = [
    ['Display name/title', entity.title],
    ['Owner/user', entity.fields.owner_name ?? objectField(entity.fields.user_id, 'name') ?? objectField(entity.fields.creator_user_id, 'name')],
    ['Organization/customer', entity.fields.org_name ?? objectField(entity.fields.org_id, 'name')],
    ['Contact/person', objectField(entity.fields.person_id, 'name') ?? entity.fields.name],
    ['Email', primaryFromArray(entity.fields.email) ?? entity.fields.primary_email],
    ['Phone', primaryFromArray(entity.fields.phone)],
    ['Deal status', entity.fields.status],
    ['Deal stage', entity.fields.stage_id],
    ['Deal value', formatMoney(entity.fields.value, entity.fields.currency)],
    ['Activity subject', entity.fields.subject],
    ['Activity type', entity.fields.type],
    ['Due date', entity.fields.due_date],
  ];
  const rows = rawRows.filter((row): row is [string, string] => Boolean(row[1] && row[1].length > 0));

  if (rows.length === 0) return '';

  return `<section>
    <h2>Pipedrive summary</h2>
    <table class="entity-fields">
      <tbody>
        ${rows
          .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
          .join('\n        ')}
      </tbody>
    </table>
  </section>`;
}

function formatMoney(value: string | undefined, currency: string | undefined): string | null {
  if (!value) return null;
  if (!currency) return value;
  return `${value} ${currency}`;
}

function renderRelated(
  type: string,
  entity: ClassifiedEntity,
  relations: RelationshipIndex,
): string {
  if (type !== 'customer') {
    // For non-customer records (orders, invoices), link back to the
    // owning customer if we have one extracted.
    const customerId = entity.fields['CustomerID'];
    if (customerId) {
      return `<section>
        <h2>Related</h2>
        <ul class="related">
          <li><a href="${escapeHtml(entityHref('customer', customerId))}">Customer ${escapeHtml(customerId)}</a></li>
        </ul>
      </section>`;
    }
    if (type === 'deal') {
      const orgId = objectField(entity.fields.org_id, 'value') ?? entity.fields.org_id;
      const personId = objectField(entity.fields.person_id, 'value') ?? entity.fields.person_id;
      const customer = orgId ? relations.customersByKey.get(relationKey(entity.sourceInstance, orgId)) : null;
      const contact = personId ? relations.contactsByKey.get(relationKey(entity.sourceInstance, personId)) : null;
      const activities = relations.activitiesByDeal.get(relationKey(entity.sourceInstance, entity.id)) ?? [];
      return renderRelatedLists([
        customer ? ['Customer', 'customer', [[customer.fileSlug, customer.title, customer.id]]] : null,
        contact ? ['Contact', 'contact', [[contact.fileSlug, contact.title, contact.id]]] : null,
        ['Activities and notes', 'activity', activities.map((a) => [a.fileSlug, a.title, a.id])],
      ]);
    }
    if (type === 'contact') {
      const orgId = objectField(entity.fields.org_id, 'value') ?? entity.fields.org_id;
      const customer = orgId ? relations.customersByKey.get(relationKey(entity.sourceInstance, orgId)) : null;
      const deals = relations.dealsByContact.get(relationKey(entity.sourceInstance, entity.id)) ?? [];
      const activities = relations.activitiesByContact.get(relationKey(entity.sourceInstance, entity.id)) ?? [];
      return renderRelatedLists([
        customer ? ['Customer', 'customer', [[customer.fileSlug, customer.title, customer.id]]] : null,
        ['Deals', 'deal', deals.map((d) => [d.fileSlug, d.title, d.id])],
        ['Activities and notes', 'activity', activities.map((a) => [a.fileSlug, a.title, a.id])],
      ]);
    }
    if (type === 'activity') {
      const orgId = entity.fields.org_id;
      const dealId = entity.fields.deal_id;
      const personId = entity.fields.person_id;
      const customer = orgId ? relations.customersByKey.get(relationKey(entity.sourceInstance, orgId)) : null;
      const deal = dealId ? relations.dealsByKey.get(relationKey(entity.sourceInstance, dealId)) : null;
      const contact = personId ? relations.contactsByKey.get(relationKey(entity.sourceInstance, personId)) : null;
      return renderRelatedLists([
        customer ? ['Customer', 'customer', [[customer.fileSlug, customer.title, customer.id]]] : null,
        deal ? ['Deal', 'deal', [[deal.fileSlug, deal.title, deal.id]]] : null,
        contact ? ['Contact', 'contact', [[contact.fileSlug, contact.title, contact.id]]] : null,
      ]);
    }
    return '';
  }

  // For a customer page, list orders, invoices, and Pipedrive CRM records.
  const orders = relations.ordersByCustomer.get(entity.id) ?? [];
  const invoices = relations.invoicesByCustomer.get(entity.id) ?? [];
  const key = relationKey(entity.sourceInstance, entity.id);
  const contacts = relations.contactsByCustomer.get(key) ?? [];
  const deals = relations.dealsByCustomer.get(key) ?? [];
  const activities = relations.activitiesByCustomer.get(key) ?? [];

  if (orders.length === 0 && invoices.length === 0 && contacts.length === 0 && deals.length === 0 && activities.length === 0) {
    return `<section>
      <h2>Related</h2>
      <p class="muted">No related records indexed for this customer yet.</p>
    </section>`;
  }

  return renderRelatedLists([
    ['Contacts', 'contact', contacts.map((c) => [c.fileSlug, c.title, c.id])],
    ['Deals', 'deal', deals.map((d) => [d.fileSlug, d.title, d.id])],
    ['Activities and notes', 'activity', activities.map((a) => [a.fileSlug, a.title, a.id])],
    ['Orders', 'order', orders.map((o) => [o.fileSlug, o.title, o.id])],
    ['Invoices', 'invoice', invoices.map((i) => [i.fileSlug, i.title, i.id])],
  ]);
}

function renderRelatedLists(
  groups: Array<[string, string, Array<[string, string, string]>] | null>,
): string {
  const sections = groups
    .filter((g): g is [string, string, Array<[string, string, string]>] => g !== null && g[2].length > 0)
    .map(([label, type, rows]) => `<h3>${escapeHtml(label)} <span class="count">${rows.length}</span></h3>
        <ul class="related">
          ${rows
            .slice(0, 20)
            .map(
              ([fileSlug, title, id]) =>
                `<li><a href="${escapeHtml(entityHref(type, fileSlug))}">${escapeHtml(title)}</a> <span class="muted">(${escapeHtml(id)})</span></li>`,
            )
            .join('\n          ')}
          ${rows.length > 20 ? `<li class="more">+ ${rows.length - 20} more (truncated)</li>` : ''}
        </ul>`);

  if (sections.length === 0) return '';
  return `<section>
    <h2>Related</h2>
    ${sections.join('\n    ')}
  </section>`;
}

// ---------------------------------------------------------------------------
// Search page (shell + client-side Lunr)
// ---------------------------------------------------------------------------
export function renderSearchPage(generatedAt: Date): string {
  const body = `
    <section class="page-heading">
      <p class="breadcrumbs"><a href="/">Home</a> &rsaquo; <span>Search</span></p>
      <h1>Search Company Brain</h1>
      <p class="lede">Client-side search across the static directory. No server call, no LLM, no writeback.</p>
    </section>
    <input id="q" class="search-input" type="search" placeholder="Search companies, contacts, deals, owners, notes, emails, phone numbers" autofocus />
    <div id="results" class="search-results">
      <p class="muted">Start typing to search.</p>
    </div>
    <script src="https://cdn.jsdelivr.net/npm/lunr@2.3.9/lunr.min.js" integrity="sha384-vRQ9bDyE0Wnu+lMfm57BlYLO0/XauFuKpVsZPs7KEDwYKktWi5+Kw3FFv7Lbwqzc" crossorigin="anonymous"></script>
    <script src="/search.js"></script>
  `;
  return layout({ title: 'Search', generatedAt }, body);
}

// ---------------------------------------------------------------------------
// Static assets
// ---------------------------------------------------------------------------
export function styleSheetSource(): string {
  return `:root {
  --bg: #fafafa;
  --fg: #1a1a1a;
  --muted: #6a6a6a;
  --border: #d8d8d8;
  --card: #ffffff;
  --accent: #1f6feb;
  --fresh: #198754;
  --recent: #f0a020;
  --stale: #c53030;
  --unknown: #6a6a6a;
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: var(--fg);
  background: var(--bg);
}

.topbar {
  background: #fff;
  border-bottom: 1px solid var(--border);
  padding: 0.75rem 1.25rem;
  display: flex; align-items: baseline; gap: 1.5rem;
  position: sticky; top: 0; z-index: 10;
}
.topbar .brand { font-weight: 700; color: var(--fg); text-decoration: none; }
.topbar nav { display: flex; gap: 1rem; flex-wrap: wrap; }
.topbar nav a { color: var(--muted); text-decoration: none; padding: 0.15rem 0.25rem; border-radius: 4px; }
.topbar nav a:hover { color: var(--fg); background: var(--bg); }
.topbar nav a[aria-current="page"] { color: var(--accent); font-weight: 600; }
.topbar .search-link { margin-left: auto; padding-left: 0.5rem; border-left: 1px solid var(--border); }

main {
  max-width: 1080px;
  margin: 1.5rem auto;
  padding: 0 1.25rem;
}
h1 { margin: 0 0 0.5rem; font-size: 1.8rem; }
h2 { margin: 2rem 0 0.75rem; font-size: 1.25rem; }
h3 { margin: 1.5rem 0 0.5rem; font-size: 1.05rem; }
.lede { color: var(--muted); margin: 0 0 1.5rem; }
.muted { color: var(--muted); }
.mono { font-family: "SFMono-Regular", Menlo, Consolas, monospace; font-size: 0.9em; }
.count { color: var(--muted); font-weight: normal; font-size: 0.9em; }

.home-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 1.25rem;
}
.home-section {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1rem 1.25rem;
}
.home-section h2 { margin-top: 0; font-size: 1.05rem; }
.home-section h2 a { color: var(--fg); text-decoration: none; }
.home-section h2 a:hover { color: var(--accent); }
.recent { list-style: none; padding: 0; margin: 0.5rem 0 0; }
.recent li { padding: 0.25rem 0; }
.recent a { color: var(--accent); text-decoration: none; }
.recent a:hover { text-decoration: underline; }
.recent li.more { margin-top: 0.5rem; }
.recent li.more a { color: var(--muted); }

.empty {
  color: var(--muted);
  font-style: italic;
  margin: 0.5rem 0 0;
}
.empty-state {
  background: var(--card);
  border: 1px dashed var(--border);
  border-radius: 8px;
  padding: 1.25rem;
  margin: 1.5rem 0;
  color: var(--muted);
}
.empty-state h2 { margin-top: 0; color: var(--fg); }
.empty-state code, .empty-state pre {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.1rem 0.3rem;
  font-size: 0.9em;
}
.empty-state pre { padding: 0.75rem; overflow-x: auto; }

.stats {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.6rem 0.9rem;
  margin: 0 0 1.5rem;
}

.entity-list {
  width: 100%;
  border-collapse: collapse;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.entity-list th, .entity-list td {
  padding: 0.55rem 0.9rem;
  text-align: left;
  border-bottom: 1px solid var(--border);
}
.entity-list thead th {
  background: var(--bg);
  font-weight: 600;
  font-size: 0.9em;
  color: var(--muted);
}
.entity-list tbody tr:last-child td { border-bottom: none; }
.entity-list a { color: var(--accent); text-decoration: none; }
.entity-list a:hover { text-decoration: underline; }

.entity-meta {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.4rem 1.25rem;
  margin: 0;
}
.entity-meta dt { color: var(--muted); font-size: 0.9em; }
.entity-meta dd { margin: 0; }

.entity-fields {
  width: 100%;
  border-collapse: collapse;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.entity-fields th {
  text-align: left;
  padding: 0.45rem 0.9rem;
  font-weight: 600;
  font-size: 0.9em;
  color: var(--muted);
  vertical-align: top;
  width: 30%;
  border-bottom: 1px solid var(--border);
}
.entity-fields td {
  padding: 0.45rem 0.9rem;
  border-bottom: 1px solid var(--border);
}
.entity-fields tr:last-child th, .entity-fields tr:last-child td { border-bottom: none; }

.related { list-style: none; padding: 0; }
.related li { padding: 0.2rem 0; }
.related a { color: var(--accent); text-decoration: none; }
.related a:hover { text-decoration: underline; }

.source-body {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1rem 1.25rem;
}
.source-body code {
  background: var(--bg);
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
  font-size: 0.9em;
}
.source-body pre {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.75rem;
  overflow-x: auto;
}
.source-body h1, .source-body h2, .source-body h3 { margin-top: 1rem; }
.source-body h1:first-child { margin-top: 0; }

.breadcrumbs { color: var(--muted); font-size: 0.9em; margin: 0 0 0.75rem; }
.breadcrumbs a { color: var(--muted); text-decoration: none; }
.breadcrumbs a:hover { color: var(--fg); }

.meta-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1rem; }

.freshness {
  display: inline-block;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  font-size: 0.85em;
  font-weight: 500;
  border: 1px solid currentColor;
  background: rgba(0,0,0,0.02);
}
.freshness-fresh { color: var(--fresh); }
.freshness-recent { color: var(--recent); }
.freshness-stale { color: var(--stale); }
.freshness-unknown { color: var(--unknown); }

.search-input {
  width: 100%;
  padding: 0.6rem 0.9rem;
  font-size: 1.05rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card);
}
.search-results {
  margin-top: 1.25rem;
}
.search-results ul { list-style: none; padding: 0; margin: 0; }
.search-results li {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.75rem 1rem;
  margin-bottom: 0.6rem;
}
.search-results li .type-badge {
  display: inline-block;
  font-size: 0.75em;
  text-transform: uppercase;
  background: var(--bg);
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.05rem 0.4rem;
  margin-right: 0.5rem;
  letter-spacing: 0.05em;
}
.search-results li a { color: var(--accent); text-decoration: none; font-weight: 500; }
.search-results li a:hover { text-decoration: underline; }

.generated-at {
  max-width: 1080px;
  margin: 3rem auto 1.5rem;
  padding: 1rem 1.25rem;
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 0.85em;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e1116;
    --fg: #e6edf3;
    --muted: #8b949e;
    --border: #2a2f37;
    --card: #161b22;
    --accent: #58a6ff;
  }
  .topbar { background: var(--card); }
  .empty-state, .home-section, .meta-card, .source-body, .stats, .entity-list, .entity-fields, .search-input, .search-results li {
    background: var(--card);
  }
  .source-body code, .source-body pre, .empty-state code, .empty-state pre, .entity-list thead th, .search-results li .type-badge {
    background: var(--bg);
  }
  .freshness { background: rgba(255,255,255,0.04); }
}

/* Internal operating directory polish */
:root {
  --bg: #f6f7f9;
  --fg: #17202a;
  --muted: #647184;
  --border: #dfe4ea;
  --card: #ffffff;
  --card-soft: #fbfcfd;
  --accent: #2457c5;
  --accent-soft: #edf3ff;
  --shadow: 0 1px 2px rgba(16, 24, 40, 0.06), 0 8px 24px rgba(16, 24, 40, 0.04);
}

body {
  font: 15px/1.55 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--bg);
  color: var(--fg);
}

.topbar {
  align-items: center;
  gap: 1rem;
  padding: 0.85rem 1.5rem;
  background: rgba(255,255,255,0.92);
  backdrop-filter: blur(10px);
  box-shadow: 0 1px 0 rgba(16, 24, 40, 0.04);
}
.brand { display: inline-flex; align-items: center; gap: 0.55rem; white-space: nowrap; }
.brand-mark {
  display: inline-grid; place-items: center;
  width: 2rem; height: 2rem;
  border-radius: 6px;
  background: var(--fg);
  color: #fff;
  font-size: 0.78rem;
  letter-spacing: 0.04em;
}
.topbar nav { gap: 0.25rem; align-items: center; }
.topbar nav a {
  padding: 0.42rem 0.65rem;
  border-radius: 6px;
  color: var(--muted);
}
.topbar nav a:hover { background: var(--accent-soft); color: var(--accent); text-decoration: none; }
.topbar nav a[aria-current="page"] { background: var(--accent-soft); color: var(--accent); }
.topbar .search-link { border-left: 0; margin-left: 0.25rem; font-weight: 650; }

main { max-width: 1180px; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
h1 { font-size: 2rem; line-height: 1.15; letter-spacing: 0; }
h2 { font-size: 1.15rem; line-height: 1.25; margin-top: 1.75rem; }
.lede { max-width: 760px; color: var(--muted); font-size: 1rem; }
.eyebrow {
  margin: 0 0 0.45rem;
  color: var(--accent);
  font-weight: 700;
  font-size: 0.78rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.hero, .page-heading, .detail-heading {
  margin-bottom: 1.25rem;
  padding: 1.4rem;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: var(--shadow);
}
.hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 1.5rem; }
.hero h1, .page-heading h1, .detail-heading h1 { margin-bottom: 0.45rem; }
.hero-meta { display: flex; flex-wrap: wrap; gap: 0.5rem; justify-content: flex-end; }
.hero-meta span, .badge {
  display: inline-flex; align-items: center;
  min-height: 1.65rem;
  padding: 0.2rem 0.55rem;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--card-soft);
  color: var(--muted);
  font-size: 0.82rem;
  font-weight: 650;
}

.home-search {
  display: grid;
  gap: 0.25rem;
  margin: 0 0 1rem;
  padding: 1.1rem 1.25rem;
  background: var(--fg);
  color: #fff;
  border-radius: 8px;
  text-decoration: none;
  box-shadow: var(--shadow);
}
.home-search span { color: rgba(255,255,255,0.72); font-size: 0.85rem; }
.home-search strong { font-size: 1.08rem; font-weight: 650; }
.home-search:hover { background: #0f1720; text-decoration: none; }

.home-grid { grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 0.85rem; }
.stat-card {
  display: grid;
  gap: 0.35rem;
  padding: 1rem;
  min-height: 8rem;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  text-decoration: none;
  color: var(--fg);
  box-shadow: var(--shadow);
}
.stat-card:hover { border-color: #b8c7f5; box-shadow: 0 10px 28px rgba(36, 87, 197, 0.12); text-decoration: none; }
.stat-card strong { font-size: 2rem; line-height: 1; letter-spacing: 0; }
.stat-label { color: var(--muted); font-weight: 700; }
.stat-sub { color: var(--muted); font-size: 0.86rem; }

.entity-list, .entity-fields, .meta-card, .source-body, .empty-state, .search-results li {
  border-radius: 8px;
  box-shadow: var(--shadow);
}
.entity-list { font-size: 0.94rem; }
.entity-list th { text-transform: uppercase; letter-spacing: 0.04em; font-size: 0.72rem; }
.entity-list td { vertical-align: top; }
.entity-name { min-width: 18rem; }
.entity-name a { display: block; font-weight: 650; }
.entity-name span { display: block; color: var(--muted); font-size: 0.86rem; margin-top: 0.12rem; }

.detail-title-row { display: flex; justify-content: space-between; gap: 1rem; align-items: flex-start; }
.meta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0.85rem;
  margin-bottom: 1.25rem;
}
.meta-tile {
  padding: 0.9rem 1rem;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: var(--shadow);
}
.meta-tile span { display: block; color: var(--muted); font-size: 0.76rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
.meta-tile strong { display: block; margin-top: 0.25rem; font-size: 0.95rem; overflow-wrap: anywhere; }

.entity-fields th { width: 220px; white-space: nowrap; }
.entity-fields td { overflow-wrap: anywhere; }
.related {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 0.45rem;
}
.related li {
  padding: 0.55rem 0.7rem;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 6px;
}

.raw-data {
  margin-top: 1.5rem;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: var(--shadow);
}
.raw-data summary {
  cursor: pointer;
  padding: 0.9rem 1rem;
  font-weight: 700;
}
.raw-data > p, .raw-data .source-body { margin: 0 1rem 1rem; }
.raw-data .source-body { box-shadow: none; max-height: 36rem; overflow: auto; }

.search-input {
  padding: 0.95rem 1rem;
  font-size: 1.08rem;
  border-radius: 8px;
  box-shadow: var(--shadow);
}
.search-results li {
  padding: 1rem;
  margin-bottom: 0.75rem;
}
.search-results li a { display: inline-block; margin: 0.35rem 0 0.15rem; font-size: 1.02rem; }
.search-results .result-meta { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.35rem; }
.type-badge, .source-badge {
  display: inline-flex;
  align-items: center;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--card-soft);
  color: var(--muted);
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.source-badge { text-transform: none; letter-spacing: 0; }

.generated-at { max-width: 1180px; }

@media (max-width: 760px) {
  .topbar { align-items: flex-start; flex-direction: column; }
  .topbar nav { width: 100%; overflow-x: auto; flex-wrap: nowrap; padding-bottom: 0.1rem; }
  main { padding: 1rem; }
  .hero, .detail-title-row { flex-direction: column; align-items: flex-start; }
  .entity-list { display: block; overflow-x: auto; }
  .entity-fields th, .entity-fields td { display: block; width: 100%; }
  .entity-fields th { border-bottom: 0; padding-bottom: 0.1rem; }
  .entity-fields td { padding-top: 0.1rem; }
}
`;
}

export function searchClientSource(): string {
  // Single-file client-side search. Loads /search-index.json, builds a Lunr
  // index in the browser, debounces input, renders matches into #results.
  return `(function () {
  'use strict';
  var input = document.getElementById('q');
  var results = document.getElementById('results');
  if (!input || !results) return;

  var index = null;
  var docs = {};
  var ready = false;

  function setStatus(html) { results.innerHTML = html; }

  setStatus('<p class="muted">Loading search index...</p>');

  fetch('/search-index.json', { cache: 'force-cache' })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var entries = data.entries || [];
      index = lunr(function () {
        this.ref('id');
        this.field('title', { boost: 5 });
        this.field('id_field', { boost: 4 });
        this.field('keywords');
        this.field('source_system', { boost: 2 });
        this.field('type', { boost: 2 });
        entries.forEach(function (e) {
          this.add({
            id: e.url,
            id_field: e.id,
            title: e.name,
            keywords: e.keywords || '',
            source_system: e.sourceSystem || '',
            type: e.type || '',
          });
          docs[e.url] = e;
        }, this);
      });
      ready = true;
      setStatus(
        '<p class="muted">Indexed ' + entries.length +
        ' records. Type to search.</p>'
      );
      if (input.value.trim().length > 0) run();
    })
    .catch(function (err) {
      setStatus(
        '<p class="muted">Failed to load search index: ' +
        (err && err.message ? err.message : err) +
        '</p>'
      );
    });

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function run() {
    if (!ready) return;
    var q = input.value.trim();
    if (q.length === 0) {
      setStatus('<p class="muted">Start typing to search.</p>');
      return;
    }
    var hits;
    try {
      hits = index.search(q);
    } catch (e) {
      // Lunr throws on bad query syntax (e.g. a stray colon). Re-try with
      // a sanitized version that only keeps word chars + spaces.
      var clean = q.replace(/[^\\w\\s]/g, ' ').replace(/\\s+/g, ' ').trim();
      if (clean.length === 0) {
        setStatus('<p class="muted">Try a simpler query.</p>');
        return;
      }
      try { hits = index.search(clean); } catch (e2) {
        setStatus('<p class="muted">Search failed: ' + esc(e2.message) + '</p>');
        return;
      }
    }
    if (hits.length === 0) {
      setStatus('<p class="muted">No matches for &ldquo;' + esc(q) + '&rdquo;.</p>');
      return;
    }
    var top = hits.slice(0, 50);
    var html = '<ul>' + top.map(function (h) {
      var d = docs[h.ref];
      if (!d) return '';
      var refreshed = d.lastRefreshedUtc
        ? '<span class="muted">Updated ' + esc(d.lastRefreshedUtc) + '</span>'
        : '<span class="muted">Freshness unknown</span>';
      return '<li>' +
        '<div><span class="type-badge">' + esc(d.type) + '</span> ' +
        '<span class="source-badge">' + esc(d.sourceSystem || 'unknown') + '</span></div>' +
        '<a href="' + esc(d.url) + '">' + esc(d.name) + '</a>' +
        '<div class="result-meta">' + refreshed + '</div>' +
        '</li>';
    }).join('') + '</ul>';
    setStatus(
      '<p class="muted">' + hits.length +
      ' match' + (hits.length === 1 ? '' : 'es') +
      ' for &ldquo;' + esc(q) + '&rdquo;' +
      (hits.length > top.length ? ' (showing top ' + top.length + ')' : '') +
      '</p>' + html
    );
  }

  var t = null;
  input.addEventListener('input', function () {
    if (t) clearTimeout(t);
    t = setTimeout(run, 80);
  });
})();
`;
}

// ---------------------------------------------------------------------------
// helpers for index.ts
// ---------------------------------------------------------------------------
function bucketFor(buckets: ClassifiedBuckets, type: string): ClassifiedEntity[] {
  switch (type) {
    case 'customer': return buckets.customers;
    case 'order': return buckets.orders;
    case 'invoice': return buckets.invoices;
    case 'item': return buckets.items;
    case 'vendor': return buckets.vendors;
    case 'rep': return buckets.reps;
    case 'deal': return buckets.deals;
    case 'contact': return buckets.contacts;
    case 'activity': return buckets.activities;
    default: return [];
  }
}
