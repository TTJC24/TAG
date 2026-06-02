/**
 * Freshness classification per v3 contract.
 *
 * Inputs:
 *   upstreamUpdatedAt: source-system last-modified (from connector
 *                      frontmatter; null when the connector didn't carry
 *                      one, per the v3 freshness contract).
 *   pageUpdatedAt:     gbrain ingestion timestamp (always present).
 *   now:               clock reference for unit-testability.
 *
 * Output:
 *   { status, label, ageMs, reference }
 *   status:
 *     - "fresh"    upstream timestamp within the last 24 hours
 *     - "recent"   upstream timestamp within the last 7 days
 *     - "stale"    upstream timestamp older than 7 days
 *     - "unknown"  no upstream timestamp at all -- only ingestion time
 *
 *   `reference` tells the caller which timestamp was used. "unknown" means
 *   the rendered freshness banner should show "(freshness unknown -- last
 *   ingested at <pageUpdatedAt>)" instead of pretending the upstream time
 *   is current.
 */
export type FreshnessStatus = 'fresh' | 'recent' | 'stale' | 'unknown';

export interface FreshnessReport {
  status: FreshnessStatus;
  label: string;
  ageMs: number | null;
  reference: 'upstream' | 'ingest';
  upstreamUpdatedAt: Date | null;
  pageUpdatedAt: Date;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function classifyFreshness(
  upstreamUpdatedAt: Date | null,
  pageUpdatedAt: Date,
  now: Date = new Date(),
): FreshnessReport {
  if (!upstreamUpdatedAt) {
    return {
      status: 'unknown',
      label: 'freshness unknown',
      ageMs: null,
      reference: 'ingest',
      upstreamUpdatedAt: null,
      pageUpdatedAt,
    };
  }

  const ageMs = now.getTime() - upstreamUpdatedAt.getTime();
  let status: FreshnessStatus;
  if (ageMs < DAY_MS) status = 'fresh';
  else if (ageMs < 7 * DAY_MS) status = 'recent';
  else status = 'stale';

  return {
    status,
    label: humanizeAge(ageMs),
    ageMs,
    reference: 'upstream',
    upstreamUpdatedAt,
    pageUpdatedAt,
  };
}

function humanizeAge(ms: number): string {
  if (ms < 0) return 'in the future (clock skew?)';
  if (ms < 60_000) return 'just now';
  if (ms < HOUR_MS) {
    const m = Math.floor(ms / 60_000);
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }
  if (ms < DAY_MS) {
    const h = Math.floor(ms / HOUR_MS);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  const d = Math.floor(ms / DAY_MS);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  if (d < 365) {
    const months = Math.floor(d / 30);
    return `${months} month${months === 1 ? '' : 's'} ago`;
  }
  const years = Math.floor(d / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}
