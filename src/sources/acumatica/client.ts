import { config, requireEnv } from '../../config.ts';
import type { AcumaticaEntity, AcumaticaSnapshot } from '../acumatica.ts';

let sessionCookie: string | null = null;

function companyCandidates(): string[] {
  const values = [
    config.ACUMATICA_TENANT,
  ];
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function cookieHeader(raw: string | null): string {
  if (!raw) return '';
  return raw
    .split(/,(?=\s*[^;,]+=)/)
    .map((cookie) => cookie.split(';')[0]?.trim())
    .filter(Boolean)
    .join('; ');
}

async function login(): Promise<void> {
  const base = normalizeBaseUrl(requireEnv('ACUMATICA_BASE_URL'));
  const errors: string[] = [];
  for (const company of companyCandidates()) {
    const body: Record<string, string> = {
      name: requireEnv('ACUMATICA_USERNAME'),
      password: requireEnv('ACUMATICA_PASSWORD'),
      company,
    };
    const res = await fetch(`${base}/entity/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      sessionCookie = cookieHeader(res.headers.get('set-cookie'));
      return;
    }
    const text = await res.text();
    errors.push(`${company}: ${res.status} ${text.slice(0, 300)}`);
  }
  throw new Error(`Acumatica login failed for configured company candidates: ${errors.join(' | ')}`);
}

async function get<T>(endpoint: string, branch?: string): Promise<T> {
  if (!sessionCookie) await login();
  const base = normalizeBaseUrl(requireEnv('ACUMATICA_BASE_URL'));
  const res = await fetch(`${base}/entity/Default/${config.ACUMATICA_ENDPOINT_VERSION}/${endpoint}`, {
    headers: {
      Accept: 'application/json',
      Cookie: sessionCookie ?? '',
      ...(branch ? { 'PX-CbApiBranch': branch } : {}),
    },
  });
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

async function listAll(entity: string, max = config.ACUMATICA_MAX_ITEMS, branch?: string): Promise<ContractRow[]> {
  const rows: ContractRow[] = [];
  const top = Math.min(100, max);
  for (let skip = 0; rows.length < max; skip += top) {
    const sep = entity.includes('?') ? '&' : '?';
    const page = await get<ContractRow[]>(`${entity}${sep}$top=${top}&$skip=${skip}`, branch);
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

export async function fetchAcumaticaSnapshot(branch?: string): Promise<AcumaticaSnapshot> {
  sessionCookie = null;
  const [customers, orders, invoices, items] = await Promise.all([
    listAll('Customer', config.ACUMATICA_MAX_ITEMS, branch),
    listAll('SalesOrder', config.ACUMATICA_MAX_ITEMS, branch),
    listAll('SalesInvoice', config.ACUMATICA_MAX_ITEMS, branch),
    listAll('StockItem', config.ACUMATICA_MAX_ITEMS, branch),
  ]);
  return {
    customers: customers.map((r) => toEntity('customer', r)),
    orders: orders.map((r) => toEntity('order', r)),
    invoices: invoices.map((r) => toEntity('invoice', r)),
    items: items.map((r) => toEntity('item', r)),
  };
}
