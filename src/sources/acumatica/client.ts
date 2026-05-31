import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { config, entityBranch, requireEnv, type EntityCode } from '../../config.ts';
import type { AcumaticaEntity, AcumaticaSnapshot } from '../acumatica.ts';

/**
 * Disk-cached Acumatica session.
 *
 * Acumatica enforces a per-user seat limit on the Contract API. Login uses
 * the shared database/instance company value (ACUMATICA_TENANT, currently
 * Production) plus one default branch. Each request then sets PX-CbApiBranch
 * to select the branch-scoped data.
 */
const SESSION_FILE = '.acumatica-session';
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
    branch: entityBranch('FS'),
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

async function get<T>(branch: string, endpoint: string): Promise<T> {
  return await getOnce<T>(branch, endpoint, /* allowReloginOnAuthFail */ true);
}

async function getOnce<T>(branch: string, endpoint: string, allowReloginOnAuthFail: boolean): Promise<T> {
  await ensureSession();
  const base = normalizeBaseUrl(requireEnv('ACUMATICA_BASE_URL'));
  const res = await fetch(`${base}/entity/Default/${config.ACUMATICA_ENDPOINT_VERSION}/${endpoint}`, {
    headers: {
      Accept: 'application/json',
      Cookie: sessionCookie ?? '',
      'PX-CbApiBranch': branch,
    },
  });
  // Expired or revoked session; clear the cache, log in fresh, and retry once.
  // Second 401/403 falls through to the generic error below.
  if ((res.status === 401 || res.status === 403) && allowReloginOnAuthFail) {
    clearCachedSession();
    await login();
    return await getOnce<T>(branch, endpoint, /* allowReloginOnAuthFail */ false);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Acumatica ${endpoint} ${res.status}: ${text.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

async function listAll(branch: string, entity: string, max = config.ACUMATICA_MAX_ITEMS): Promise<ContractRow[]> {
  const rows: ContractRow[] = [];
  const top = Math.min(100, max);
  for (let skip = 0; rows.length < max; skip += top) {
    const sep = entity.includes('?') ? '&' : '?';
    const page = await get<ContractRow[]>(branch, `${entity}${sep}$top=${top}&$skip=${skip}`);
    rows.push(...page);
    if (page.length < top) break;
  }
  return rows.slice(0, max);
}

type ContractRow = {
  id?: string;
  CustomerID?: { value?: string };
  CustomerName?: { value?: string };
  OrderNbr?: { value?: string };
  ReferenceNbr?: { value?: string };
  InventoryID?: { value?: string };
  Description?: { value?: string };
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
    fieldValue(row, 'OrderNbr') ||
    fieldValue(row, 'ReferenceNbr') ||
    fieldValue(row, 'InventoryID') ||
    `row-${Math.random().toString(36).slice(2, 10)}`;
  const name =
    fieldValue(row, 'CustomerName') ||
    fieldValue(row, 'Description') ||
    fieldValue(row, 'OrderNbr') ||
    fieldValue(row, 'CustomerID') ||
    fieldValue(row, 'InventoryID') ||
    id;
  const updated = fieldValue(row, 'LastModifiedDateTime') || new Date().toISOString();
  return { kind, id: String(id), name, updated_at: updated, body: plainRow(row) };
}

export async function fetchAcumaticaSnapshot(entity?: EntityCode): Promise<AcumaticaSnapshot> {
  const branch = entity ? entityBranch(entity) : entityBranch('FS');
  const [customers, orders, invoices, items] = await Promise.all([
    listAll(branch, 'Customer', config.ACUMATICA_MAX_ITEMS),
    listAll(branch, 'SalesOrder', config.ACUMATICA_MAX_ITEMS),
    listAll(branch, 'SalesInvoice', config.ACUMATICA_MAX_ITEMS),
    listAll(branch, 'StockItem', config.ACUMATICA_MAX_ITEMS),
  ]);
  return {
    customers: customers.map((r) => toEntity('customer', r)),
    orders: orders.map((r) => toEntity('order', r)),
    invoices: invoices.map((r) => toEntity('invoice', r)),
    items: items.map((r) => toEntity('item', r)),
  };
}
