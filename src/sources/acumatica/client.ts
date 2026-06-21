import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { config, entityBranch, requireEnv, type EntityCode } from '../../config.ts';
import type { AcumaticaEntity, AcumaticaSnapshot } from '../acumatica.ts';

/**
 * Disk-cached Acumatica session.
 *
 * Acumatica enforces a per-user seat limit on the Contract API. Login uses
 * the shared database/instance company value (ACUMATICA_TENANT, currently
 * Production). Each read request sets PX-CbApiBranch to select the
 * branch-scoped data.
 */
const SESSION_FILE = process.env.ACUMATICA_SESSION_FILE ?? 'state/.acumatica-session';
let sessionCookie: string | null = null;

interface CachedSession {
  cookie: string;
  savedAt: string;
}

function loadCachedSession(): string | null {
  try {
    if (!existsSync(SESSION_FILE)) return null;
    const raw = readFileSync(SESSION_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CachedSession>;
    return typeof parsed.cookie === 'string' && parsed.cookie.length > 0 ? parsed.cookie : null;
  } catch {
    // Corrupt cache file is non-fatal; fall through to fresh login.
    return null;
  }
}

function saveCachedSession(cookie: string): void {
  try {
    const payload: CachedSession = { cookie, savedAt: new Date().toISOString() };
    writeFileSync(SESSION_FILE, JSON.stringify(payload, null, 2));
  } catch {
    // Caching is best-effort; a write failure should not block the live request.
  }
}

function clearCachedSession(): void {
  sessionCookie = null;
  try {
    if (existsSync(SESSION_FILE)) unlinkSync(SESSION_FILE);
  } catch {
    // Stale file is non-fatal; the next login will overwrite it.
  }
}

async function ensureSession(): Promise<void> {
  if (sessionCookie) return;
  const cached = loadCachedSession();
  if (cached) {
    sessionCookie = cached;
    return;
  }
  await login();
}

function cookieHeader(raw: string | null): string {
  if (!raw) return '';
  return raw
    .split(/,(?=\s*[^;,]+=)/)
    .map((cookie) => cookie.split(';')[0]?.trim())
    .filter(Boolean)
    .join('; ');
}

function acumaticaLoginHint(status: number): string {
  switch (status) {
    case 401:
      return 'check ACUMATICA_USERNAME / ACUMATICA_PASSWORD';
    case 403:
      return 'user authenticated but lacks API access';
    case 404:
      return 'check ACUMATICA_BASE_URL and ACUMATICA_ENDPOINT_VERSION';
    default:
      return '';
  }
}

async function login(): Promise<void> {
  const base = normalizeBaseUrl(requireEnv('ACUMATICA_BASE_URL'));
  const body: Record<string, string> = {
    name: requireEnv('ACUMATICA_USERNAME'),
    password: requireEnv('ACUMATICA_PASSWORD'),
    company: requireEnv('ACUMATICA_TENANT'),
  };
  let res: Response;
  try {
    res = await fetch(`${base}/entity/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `Acumatica login network error against ${base}: ${err instanceof Error ? err.message : String(err)}. Check ACUMATICA_BASE_URL (DNS/TLS reachable?) in .env.`,
    );
  }
  if (res.ok) {
    sessionCookie = cookieHeader(res.headers.get('set-cookie'));
    if (sessionCookie) saveCachedSession(sessionCookie);
    return;
  }
  const text = await res.text();
  const hint = acumaticaLoginHint(res.status);
  throw new Error(
    `Acumatica login failed for company ${config.ACUMATICA_TENANT}: ${res.status} ${text.slice(0, 300)}${hint ? ` - ${hint}` : ''}`,
  );
}

function requestHeaders(branch: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Cookie: sessionCookie ?? '',
  };
  if (branch) headers['PX-CbApiBranch'] = branch;
  return headers;
}

async function get<T>(branch: string | undefined, endpoint: string): Promise<T> {
  await ensureSession();
  const base = normalizeBaseUrl(requireEnv('ACUMATICA_BASE_URL'));
  const url = `${base}/entity/Default/${config.ACUMATICA_ENDPOINT_VERSION}/${endpoint}`;
  let res = await fetch(url, { headers: requestHeaders(branch) });

  if (res.status === 401) {
    // A cached Acumatica session can expire independently of the local cache.
    // Do one fresh login + one GET retry, then fail. This avoids retry loops
    // that could contribute to API login-limit issues.
    clearCachedSession();
    await login();
    res = await fetch(url, { headers: requestHeaders(branch) });
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) clearCachedSession();
    const text = await res.text();
    throw new Error(`Acumatica ${endpoint} ${res.status}: ${text.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

async function listCapped(branch: string | undefined, entity: string, max: number, startSkip = 0): Promise<ContractRow[]> {
  const rows: ContractRow[] = [];
  const top = Math.min(100, max);
  for (let skip = startSkip; rows.length < max; skip += top) {
    const sep = entity.includes('?') ? '&' : '?';
    const page = await get<ContractRow[]>(branch, `${entity}${sep}$top=${top}&$skip=${skip}`);
    rows.push(...page);
    if (page.length < top) break;
  }
  return rows.slice(0, max);
}

async function listOptional(branch: string | undefined, entity: string, max: number, startSkip = 0): Promise<ContractRow[]> {
  try {
    return await listCapped(branch, entity, max, startSkip);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/\s(404|405):/.test(msg) || msg.includes(' 404:') || msg.includes(' 405:')) {
      console.warn(`[acumatica] optional endpoint ${entity} unavailable for branch ${branch ?? 'cross-branch'}; skipping`);
      return [];
    }
    throw err;
  }
}

type ContractRow = {
  id?: string;
  CustomerID?: { value?: string };
  CustomerName?: { value?: string };
  VendorID?: { value?: string };
  VendorName?: { value?: string };
  OrderNbr?: { value?: string };
  ReferenceNbr?: { value?: string };
  InventoryID?: { value?: string };
  Description?: { value?: string };
  SalespersonID?: { value?: string };
  AccountCD?: { value?: string };
  AccountID?: { value?: string };
  LedgerID?: { value?: string };
  BatchNbr?: { value?: string };
  ClassID?: { value?: string };
  ReceiptNbr?: { value?: string };
  PaymentRef?: { value?: string };
  CashAccountCD?: { value?: string };
  TaxID?: { value?: string };
  TaxZoneID?: { value?: string };
  TaxCategoryID?: { value?: string };
  FinancialYear?: { value?: string };
  Name?: { value?: string };
  LastModifiedDateTime?: { value?: string };
  [k: string]: unknown;
};

function fieldValue(row: ContractRow, key: string): string {
  const v = row[key];
  if (v && typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
    return String((v as { value?: unknown }).value ?? '');
  }
  return v ? String(v) : '';
}

function plainRow(row: ContractRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value && typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
      out[key] = (value as { value?: unknown }).value ?? null;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function toEntity(kind: AcumaticaEntity['kind'], row: ContractRow): AcumaticaEntity {
  const id =
    (row.id as string | undefined) ||
    fieldValue(row, 'CustomerID') ||
    fieldValue(row, 'VendorID') ||
    fieldValue(row, 'OrderNbr') ||
    fieldValue(row, 'ReferenceNbr') ||
    fieldValue(row, 'InventoryID') ||
    fieldValue(row, 'SalespersonID') ||
    fieldValue(row, 'AccountCD') ||
    fieldValue(row, 'AccountID') ||
    fieldValue(row, 'LedgerID') ||
    fieldValue(row, 'BatchNbr') ||
    fieldValue(row, 'ClassID') ||
    fieldValue(row, 'ReceiptNbr') ||
    fieldValue(row, 'PaymentRef') ||
    fieldValue(row, 'CashAccountCD') ||
    fieldValue(row, 'TaxID') ||
    fieldValue(row, 'TaxZoneID') ||
    fieldValue(row, 'TaxCategoryID') ||
    fieldValue(row, 'FinancialYear') ||
    `row-${Math.random().toString(36).slice(2, 10)}`;
  const name =
    fieldValue(row, 'CustomerName') ||
    fieldValue(row, 'VendorName') ||
    fieldValue(row, 'Description') ||
    fieldValue(row, 'Name') ||
    fieldValue(row, 'OrderNbr') ||
    fieldValue(row, 'CustomerID') ||
    fieldValue(row, 'VendorID') ||
    fieldValue(row, 'InventoryID') ||
    fieldValue(row, 'SalespersonID') ||
    fieldValue(row, 'AccountCD') ||
    fieldValue(row, 'AccountID') ||
    fieldValue(row, 'LedgerID') ||
    fieldValue(row, 'BatchNbr') ||
    fieldValue(row, 'ClassID') ||
    fieldValue(row, 'ReceiptNbr') ||
    fieldValue(row, 'PaymentRef') ||
    fieldValue(row, 'CashAccountCD') ||
    fieldValue(row, 'TaxID') ||
    fieldValue(row, 'TaxZoneID') ||
    fieldValue(row, 'TaxCategoryID') ||
    fieldValue(row, 'FinancialYear') ||
    id;
  // v3 freshness contract (Phase 2): when LastModifiedDateTime is missing from
  // the upstream row, surface empty rather than pretending the row was just
  // modified now. The silent `new Date().toISOString()` fallback was masking
  // unknown-freshness as apparent-current, which v3's "last refreshed" stamps
  // would then render as a lie. Downstream renderers and the SQL query
  // endpoint check for empty/null and surface "freshness unknown" instead.
  const updated = fieldValue(row, 'LastModifiedDateTime') || '';
  return { kind, id: String(id), name, updated_at: updated, body: plainRow(row) };
}

export interface FetchAcumaticaSnapshotOptions {
  entity?: EntityCode;
  cap?: number;
  skip?: number;
  includeOperational?: boolean;
  includeFinancial?: boolean;
  financialKinds?: string[];
}

export async function fetchAcumaticaSnapshot(options: FetchAcumaticaSnapshotOptions = {}): Promise<AcumaticaSnapshot> {
  const entity = options.entity;
  const branch = entity ? entityBranch(entity) : undefined;
  const envCap = Number(process.env.ACUMATICA_INGEST_CAP ?? '');
  const cap = options.cap ?? (Number.isInteger(envCap) && envCap > 0 ? envCap : Math.min(config.ACUMATICA_MAX_ITEMS, 100));
  const envSkip = Number(process.env.ACUMATICA_INGEST_SKIP ?? '');
  const skip = options.skip ?? (Number.isInteger(envSkip) && envSkip >= 0 ? envSkip : 0);
  const includeOperational = options.includeOperational ?? true;
  const includeFinancial = options.includeFinancial ?? false;
  const financialKinds = new Set((options.financialKinds ?? []).map((kind) => kind.toLowerCase()));
  const customers = includeOperational ? await listCapped(branch, 'Customer', cap, skip) : [];
  const items = includeOperational ? await listCapped(branch, 'StockItem', cap, skip) : [];
  const vendors = includeOperational ? await listCapped(branch, 'Vendor', cap, skip) : [];
  const orders = includeOperational ? await listCapped(branch, 'SalesOrder', cap, skip) : [];
  const invoices = includeOperational ? await listCapped(branch, 'SalesInvoice', cap, skip) : [];
  const reps = includeOperational ? await listOptional(branch, 'SalesPerson', cap, skip) : [];
  const financialSpecs: Array<[string, string]> = [
    ['account', 'Account'],
    ['ledger', 'Ledger'],
    ['financial-period', 'FinancialPeriod'],
    ['currency', 'Currency'],
    ['journal-transaction', 'JournalTransaction'],
    ['ar-payment', 'Payment'],
    ['customer-class', 'CustomerClass'],
    ['customer-payment-method', 'CustomerPaymentMethod'],
    ['ap-bill', 'Bill'],
    ['ap-check', 'Check'],
    ['vendor-class', 'VendorClass'],
    ['purchase-receipt', 'PurchaseReceipt'],
    ['purchase-order', 'PurchaseOrder'],
    ['cash-transaction', 'CashTransaction'],
    ['tax-zone', 'TaxZone'],
    ['tax-category', 'TaxCategory'],
    ['tax', 'Tax'],
  ];
  const financials: AcumaticaEntity[] = [];
  if (includeFinancial) {
    for (const [label, endpoint] of financialSpecs) {
      if (financialKinds.size > 0 && !financialKinds.has(label)) continue;
      const rows = await listOptional(branch, endpoint, cap, skip);
      financials.push(...rows.map((r) => {
        const entity = toEntity('financial', r);
        return { ...entity, id: `${label}:${entity.id}`, name: `${label}: ${entity.name}`, body: { financial_kind: label, endpoint, ...entity.body } };
      }));
    }
  }
  return {
    customers: customers.map((r) => toEntity('customer', r)),
    items: items.map((r) => toEntity('item', r)),
    vendors: vendors.map((r) => toEntity('vendor', r)),
    orders: orders.map((r) => toEntity('order', r)),
    invoices: invoices.map((r) => toEntity('invoice', r)),
    reps: reps.map((r) => toEntity('rep', r)),
    financials,
  };
}
