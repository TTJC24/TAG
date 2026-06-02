import { config, requireEnv } from '../../config.ts';
import type { PipedriveEntity, PipedriveSnapshot, PipedriveEntityKind } from '../pipedrive.ts';

export interface PipedriveFetchOptions {
  apiToken?: string;
  companyDomain?: string;
}

type PipedriveListResponse<T> = {
  data: T[];
  additional_data?: {
    pagination?: {
      start: number;
      limit: number;
      more_items_in_collection: boolean;
      next_start?: number;
    };
  };
};

async function getJson<T>(path: string, opts: PipedriveFetchOptions = {}): Promise<T> {
  const token = opts.apiToken ?? requireEnv('PIPEDRIVE_API_TOKEN');
  const domain = normalizeCompanyDomain(opts.companyDomain ?? requireEnv('PIPEDRIVE_COMPANY_DOMAIN'));
  const sep = path.includes('?') ? '&' : '?';
  let res: Response;
  try {
    res = await fetch(`https://${domain}.pipedrive.com/api/v1${path}${sep}api_token=${token}`);
  } catch (err) {
    throw new Error(
      `Pipedrive network error for ${path} (domain=${domain}): ${err instanceof Error ? err.message : String(err)}. Check PIPEDRIVE_COMPANY_DOMAIN in .env.`,
    );
  }
  if (!res.ok) {
    const body = await res.text();
    const hint =
      res.status === 401 || res.status === 403
        ? ' — check PIPEDRIVE_API_TOKEN (or PIPEDRIVE_API_TOKEN_FS / PIPEDRIVE_API_TOKEN_BLCS_USA for multi-tenant) in .env'
        : '';
    throw new Error(`Pipedrive ${path} ${res.status}: ${body.slice(0, 500)}${hint}`);
  }
  return (await res.json()) as T;
}

function normalizeCompanyDomain(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/\.pipedrive\.com$/i, '');
}

async function listAll(path: string, max = config.PIPEDRIVE_MAX_ITEMS, opts: PipedriveFetchOptions = {}): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let start = 0;
  const limit = Math.min(100, max);
  while (rows.length < max) {
    const sep = path.includes('?') ? '&' : '?';
    const page = await getJson<PipedriveListResponse<Record<string, unknown>>>(
      `${path}${sep}start=${start}&limit=${limit}`,
      opts,
    );
    rows.push(...(page.data ?? []));
    const pagination = page.additional_data?.pagination;
    if (!pagination?.more_items_in_collection || pagination.next_start === undefined) break;
    start = pagination.next_start;
  }
  return rows.slice(0, max);
}

function toEntity(kind: PipedriveEntityKind, row: Record<string, unknown>): PipedriveEntity {
  const id = String(row.id ?? row.uuid ?? '');
  const name =
    String(row.title ?? row.name ?? row.subject ?? row.content ?? id).slice(0, 200) || id;
  // v3 freshness contract (Phase 2): when neither update_time nor add_time
  // is present, surface empty rather than wall-clock. Pipedrive in practice
  // always carries at least add_time, so the fallback is defensive -- but
  // the silent `new Date().toISOString()` was masking the corner cases
  // (incomplete rows from partial fetches, beta API endpoints, etc).
  const updated = String(row.update_time ?? row.add_time ?? '');
  return { kind, id, name, updated_at: updated, body: row };
}

export async function fetchPipedriveSnapshot(opts: PipedriveFetchOptions = {}): Promise<PipedriveSnapshot> {
  const [deals, persons, orgs, activities, notes] = await Promise.all([
    listAll('/deals?sort=update_time%20DESC', config.PIPEDRIVE_MAX_ITEMS, opts),
    listAll('/persons?sort=update_time%20DESC', config.PIPEDRIVE_MAX_ITEMS, opts),
    listAll('/organizations?sort=update_time%20DESC', config.PIPEDRIVE_MAX_ITEMS, opts),
    listAll('/activities?sort=update_time%20DESC', config.PIPEDRIVE_MAX_ITEMS, opts),
    listAll('/notes?sort=update_time%20DESC', config.PIPEDRIVE_MAX_ITEMS, opts),
  ]);
  const activityByDeal = new Map<string, Array<{ id: string; subject: string; type?: string; done?: boolean }>>();
  for (const row of activities) {
    const dealId = String(row.deal_id ?? '');
    if (!dealId) continue;
    const bucket = activityByDeal.get(dealId) ?? [];
    bucket.push({
      id: String(row.id ?? ''),
      subject: String(row.subject ?? row.type ?? row.id ?? ''),
      type: row.type ? String(row.type) : undefined,
      done: Boolean(row.done),
    });
    activityByDeal.set(dealId, bucket);
  }
  const notesByDeal = new Map<string, Array<{ id: string; content: string }>>();
  for (const row of notes) {
    const dealId = String(row.deal_id ?? '');
    if (!dealId) continue;
    const bucket = notesByDeal.get(dealId) ?? [];
    bucket.push({
      id: String(row.id ?? ''),
      content: String(row.content ?? ''),
    });
    notesByDeal.set(dealId, bucket);
  }
  return {
    deals: deals.map((r) => {
      const entity = toEntity('deal', r);
      entity.related = {
        notes: notesByDeal.get(entity.id),
        activities: activityByDeal.get(entity.id),
      };
      return entity;
    }),
    persons: (persons ?? []).map((r) => toEntity('person', r)),
    organizations: (orgs ?? []).map((r) => toEntity('organization', r)),
    activities: (activities ?? []).map((r) => toEntity('activity', r)),
    notes: (notes ?? []).map((r) => toEntity('note', r)),
  };
}
