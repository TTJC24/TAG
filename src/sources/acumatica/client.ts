import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { config, entityBranch, entityTenant, requireEnv, type EntityCode } from '../../config.ts';
import type { AcumaticaEntity, AcumaticaSnapshot } from '../acumatica.ts';

/**
 * Disk-cached Acumatica sessions.
 *
 * Acumatica enforces a per-user seat limit on the Contract API. Each
 * /entity/auth/login burns a seat until the session expires (or is
 * logged out). The live system has three separate companies, so session
 * cookies are cached per tenant. Lookup order is memory -> disk -> fresh
 * login. A request that returns 401/403 invalidates that tenant's cache
 * and triggers exactly one re-login + retry; a second auth failure throws.
 */
const SESSION_FILE = '.acumatica-session';
const sessionCookies = new Map<string, string>();

interface CachedSession {
  cookie?: string;
  cookies?: Record<string, string>;
  savedAt: string;
}

function loadCachedSession(tenant: string): string | null {
  try {
    if (!existsSync(SESSION_FILE)) return null;
    const raw = readFileSync(SESSION_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CachedSession>;
    if (parsed.cookies && typeof parsed.cookies[tenant] === 'string' && parsed.cookies[tenant].length > 0) {
      return parsed.cookies[tenant];
    }
    return typeof parsed.cookie === 'string' && parsed.cookie.length > 0 ? parsed.cookie : null;
  } catch {
    // Corrupt cache file is non-fatal; fall through to fresh login.
    return null;
  }
}

function saveCachedSession(tenant: string, cookie: string): void {
  try {
    let cookies: Record<string, string> = {};
    if (existsSync(SESSION_FILE)) {
      const parsed = JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as Partial<CachedSession>;
      if (parsed.cookies && typeof parsed.cookies === 'object') cookies = parsed.cookies;
      if (parsed.cookie && typeof parsed.cookie === 'string') cookies[tenant] = parsed.cookie;
    }
    cookies[tenant] = cookie;
    const payload: CachedSession = { cookies, savedAt: new Date().toISOString() };
    writeFileSync(SESSION_FILE, JSON.stringify(payload, null, 2));
  } catch {
    // Caching is best-effort; a write failure should not block the live request.
  }
}

function clearCachedSession(tenant: string): void {
  sessionCookies.delete(tenant);
  try {
    if (!existsSync(SESSION_FILE)) return;
    const parsed = JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as Partial<CachedSession>;
    const cookies = parsed.cookies && typeof parsed.cookies === 'object' ? parsed.cookies : {};
    delete cookies[tenant];
    if (Object.keys(cookies).length > 0) {
      writeFileSync(SESSION_FILE, JSON.stringify({ cookies, savedAt: new Date().toISOString() }, null, 2));
    } else {
      unlinkSync(SESSION_FILE);
    }
  } catch {
    // Stale file is non-fatal; the next login will overwrite it.
  }
}

async function ensureSession(tenant: string, branch: string): Promise<void> {
  if (sessionCookies.has(tenant)) return;
  const cached = loadCachedSession(tenant);
  if (cached) {
    sessionCookies.set(tenant, cached);
    return;
  }
  await login(tenant, branch);
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

async function login(tenant: string, branch: string): Promise<void> {
  const base = normalizeBaseUrl(requireEnv('ACUMATICA_BASE_URL'));
  const body: Record<string, string> = {
    name: requireEnv('ACUMATICA_USERNAME'),
    password: requireEnv('ACUMATICA_PASSWORD'),
    company: tenant,
    branch,
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
    const cookie = cookieHeader(res.headers.get('set-cookie'));
    if (cookie) {
      sessionCookies.set(tenant, cookie);
      saveCachedSession(tenant, cookie);
    }
    return;
  }
  const text = await res.text();
  const hint = acumaticaLoginHint(res.status);
  throw new Error(
    `Acumatica login failed for tenant ${tenant} branch ${branch}: ${res.status} ${text.slice(0, 300)}${hint ? ` - ${hint}` : ''}`,
  );
}

async function get<T>(tenant: string, branch: string, endpoint: string): Promise<T> {
  return await getOnce<T>(tenant, branch, endpoint, /* allowReloginOnAuthFail */ true);
}

async function getOnce<T>(tenant: string, branch: string, endpoint: string, allowReloginOnAuthFail: boolean): Promise<T> {
  await ensureSession(tenant, branch);
  const base = normalizeBaseUrl(requireEnv('ACUMATICA_BASE_URL'));
  const res = await fetch(`${base}/entity/Default/${config.ACUMATICA_ENDPOINT_VERSION}/${endpoint}`, {
    headers: {
      Accept: 'application/json',
      Cookie: sessionCookies.get(tenant) ?? '',
    },
  });
  // Expired or revoked session; clear the tenant cache, log in fresh, and retry once.
  // Second 401/403 falls through to the generic error below.
  if ((res.status === 401 || res.status === 403) && allowReloginOnAuthFail) {
    clearCachedSession(tenant);
    await login(tenant, branch);
    return await getOnce<T>(tenant, branch, endpoint, /* allowReloginOnAuthFail */ false);
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

async function listAll(tenant: string, branch: string, entity: string, max = config.ACUMATICA_MAX_ITEMS): Promise<ContractRow[]> {
  const rows: ContractRow[] = [];
  const top = Math.min(100, max);
  for (let skip = 0; rows.length < max; skip += top) {
    const sep = entity.includes('?') ? '&' : '?';
    const page = await get<ContractRow[]>(tenant, branch, `${entity}${sep}$top=${top}&$skip=${skip}`);
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
  const tenant = entity ? entityTenant(entity) : requireEnv('ACUMATICA_TENANT');
  const branch = entity ? entityBranch(entity) : requireEnv('ACUMATICA_BRANCH');
  // Stale sessions invalidate themselves via the 401/403 retry path in getOnce().
  const [customers, orders, invoices, items] = await Promise.all([
    listAll(tenant, branch, 'Customer', config.ACUMATICA_MAX_ITEMS),
    listAll(tenant, branch, 'SalesOrder', config.ACUMATICA_MAX_ITEMS),
    listAll(tenant, branch, 'SalesInvoice', config.ACUMATICA_MAX_ITEMS),
    listAll(tenant, branch, 'StockItem', config.ACUMATICA_MAX_ITEMS),
  ]);
  return {
    customers: customers.map((r) => toEntity('customer', r)),
    orders: orders.map((r) => toEntity('order', r)),
    invoices: invoices.map((r) => toEntity('invoice', r)),
    items: items.map((r) => toEntity('item', r)),
  };
}
