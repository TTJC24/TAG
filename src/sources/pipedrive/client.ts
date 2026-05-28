import { requireEnv } from '../../config.ts';
import type { PipedriveEntity, PipedriveSnapshot, PipedriveEntityKind } from '../pipedrive.ts';

async function get<T>(path: string): Promise<T> {
  const token = requireEnv('PIPEDRIVE_API_TOKEN');
  const domain = requireEnv('PIPEDRIVE_COMPANY_DOMAIN');
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`https://${domain}.pipedrive.com/api/v1${path}${sep}api_token=${token}`);
  if (!res.ok) throw new Error(`Pipedrive ${path} ${res.status}`);
  const json = (await res.json()) as { data: T };
  return json.data;
}

function toEntity(kind: PipedriveEntityKind, row: Record<string, unknown>): PipedriveEntity {
  const id = String(row.id ?? row.uuid ?? '');
  const name =
    String(row.title ?? row.name ?? row.subject ?? row.content ?? id).slice(0, 200) || id;
  const updated = String(row.update_time ?? row.add_time ?? new Date().toISOString());
  return { kind, id, name, updated_at: updated, body: row };
}

export async function fetchPipedriveSnapshot(): Promise<PipedriveSnapshot> {
  const [deals, persons, orgs, activities, notes] = await Promise.all([
    get<Record<string, unknown>[]>('/deals?limit=100&sort=update_time%20DESC').catch(() => []),
    get<Record<string, unknown>[]>('/persons?limit=100&sort=update_time%20DESC').catch(() => []),
    get<Record<string, unknown>[]>('/organizations?limit=100&sort=update_time%20DESC').catch(() => []),
    get<Record<string, unknown>[]>('/activities?limit=100&sort=update_time%20DESC').catch(() => []),
    get<Record<string, unknown>[]>('/notes?limit=100&sort=update_time%20DESC').catch(() => []),
  ]);
  return {
    deals: (deals ?? []).map((r) => toEntity('deal', r)),
    persons: (persons ?? []).map((r) => toEntity('person', r)),
    organizations: (orgs ?? []).map((r) => toEntity('organization', r)),
    activities: (activities ?? []).map((r) => toEntity('activity', r)),
    notes: (notes ?? []).map((r) => toEntity('note', r)),
  };
}
