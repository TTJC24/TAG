#!/usr/bin/env node
import { classifyFreshness, type FreshnessStatus } from '../page-gen/freshness.ts';
import { getConnectorStatuses, type ConnectorStatus } from '../sources/status.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertConnectorStatus(status: ConnectorStatus): void {
  assert(status.id.trim().length > 0, 'connector status missing id');
  assert(status.displayName.trim().length > 0, `${status.id}: missing display name`);
  assert(status.kind.trim().length > 0, `${status.id}: missing kind`);
  assert(Number.isInteger(status.documentCount) && status.documentCount >= 0, `${status.id}: invalid document count`);

  const expectedHealth = status.liveReady
    ? 'live_ready'
    : status.fixtureAvailable
      ? 'fixture_ready'
      : 'blocked';
  assert(status.healthState === expectedHealth, `${status.id}: expected healthState ${expectedHealth}, got ${status.healthState}`);

  const expectedFailure = status.liveReady
    ? null
    : status.missingEnv.length > 0
      ? 'missing_env'
      : 'missing_fixture';
  assert(status.failureState === expectedFailure, `${status.id}: expected failureState ${expectedFailure}, got ${status.failureState}`);

  for (const key of status.missingEnv) {
    assert(!key.includes('='), `${status.id}: missingEnv must contain env names only, not assignments`);
    assert(!/AIza[0-9A-Za-z_-]{35}|sk-(?:proj-)?[0-9A-Za-z_-]{20,}/.test(key), `${status.id}: missingEnv leaked secret-shaped material`);
  }
}

function assertFreshness(
  upstream: Date | null,
  pageUpdatedAt: Date,
  now: Date,
  expectedStatus: FreshnessStatus,
  expectedReference: 'upstream' | 'ingest',
): void {
  const report = classifyFreshness(upstream, pageUpdatedAt, now);
  assert(report.status === expectedStatus, `expected freshness ${expectedStatus}, got ${report.status}`);
  assert(report.reference === expectedReference, `expected freshness reference ${expectedReference}, got ${report.reference}`);
}

async function main(): Promise<void> {
  const statuses = await getConnectorStatuses();
  assert(statuses.length > 0, 'no connector statuses returned');
  for (const status of statuses) {
    assertConnectorStatus(status);
  }
  assert(
    statuses.some((status) => status.healthState === 'fixture_ready' || status.healthState === 'live_ready'),
    'no connector is usable through live or fixture mode',
  );

  const now = new Date('2026-06-17T12:00:00Z');
  const pageUpdatedAt = new Date('2026-06-17T11:00:00Z');
  assertFreshness(null, pageUpdatedAt, now, 'unknown', 'ingest');
  assertFreshness(new Date('2026-06-17T00:30:00Z'), pageUpdatedAt, now, 'fresh', 'upstream');
  assertFreshness(new Date('2026-06-14T12:00:00Z'), pageUpdatedAt, now, 'recent', 'upstream');
  assertFreshness(new Date('2026-06-01T12:00:00Z'), pageUpdatedAt, now, 'stale', 'upstream');

  console.log(JSON.stringify({
    ok: true,
    connectors: statuses.map((status) => ({
      id: status.id,
      healthState: status.healthState,
      failureState: status.failureState,
      fixtureAvailable: status.fixtureAvailable,
      liveReady: status.liveReady,
      documentCount: status.documentCount,
    })),
    freshness: {
      unknown: 'ingest',
      fresh: 'upstream',
      recent: 'upstream',
      stale: 'upstream',
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
