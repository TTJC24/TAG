import { requireEnv } from '../../config.ts';
import type { AcumaticaEntity, AcumaticaSnapshot } from '../acumatica.ts';

let sessionCookie: string | null = null;

async function login(): Promise<void> {
  const base = requireEnv('ACUMATICA_BASE_URL');
  const res = await fetch(`${base}/entity/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: requireEnv('ACUMATICA_USERNAME'),
      password: requireEnv('ACUMATICA_PASSWORD'),
      company: requireEnv('ACUMATICA_TENANT'),
      branch: requireEnv('ACUMATICA_BRANCH'),
    }),
  });
  if (!res.ok) throw new Error(`Acumatica login ${res.status}`);
  sessionCookie = res.headers.get('set-cookie');
}

async function get<T>(endpoint: string): Promise<T> {
  if (!sessionCookie) await login();
  const base = requireEnv('ACUMATICA_BASE_URL');
  const res = await fetch(`${base}/entity/Default/24.200.001/${endpoint}`, {
    headers: {
      Accept: 'application/json',
      Cookie: sessionCookie ?? '',
    },
  });
  if (!res.ok) throw new Error(`Acumatica ${endpoint} ${res.status}`);
  return (await res.json()) as T;
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
  return { kind, id: String(id), name, updated_at: updated, body: row };
}

export async function fetchAcumaticaSnapshot(): Promise<AcumaticaSnapshot> {
  const [customers, orders, invoices, items] = await Promise.all([
    get<ContractRow[]>('Customer?$top=100'),
    get<ContractRow[]>('SalesOrder?$top=100'),
    get<ContractRow[]>('SalesInvoice?$top=100'),
    get<ContractRow[]>('StockItem?$top=100'),
  ]);
  return {
    customers: customers.map((r) => toEntity('customer', r)),
    orders: orders.map((r) => toEntity('order', r)),
    invoices: invoices.map((r) => toEntity('invoice', r)),
    items: items.map((r) => toEntity('item', r)),
  };
}
