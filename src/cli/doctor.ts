#!/usr/bin/env node
import { getConnectorStatuses, type ConnectorStatus } from '../sources/status.ts';

function printSummary(statuses: ConnectorStatus[]): void {
  const total = statuses.length;
  const live = statuses.filter((s) => s.liveReady).length;
  const withFixtures = statuses.filter((s) => s.fixtureAvailable).length;
  const broken = statuses.filter((s) => !s.liveReady && !s.fixtureAvailable).length;

  console.error(
    `doctor: ${live}/${total} connectors live, ${withFixtures}/${total} have fixtures, ${broken} broken (no live + no fixture)`,
  );

  // Dedupe missing env keys -> which connectors need them
  const envToConnectors = new Map<string, string[]>();
  for (const status of statuses) {
    for (const key of status.missingEnv) {
      const existing = envToConnectors.get(key);
      if (existing) {
        existing.push(status.id);
      } else {
        envToConnectors.set(key, [status.id]);
      }
    }
  }

  if (envToConnectors.size > 0) {
    console.error('doctor: missing env keys:');
    const keys = Array.from(envToConnectors.keys()).sort();
    for (const key of keys) {
      const ids = envToConnectors.get(key) ?? [];
      console.error(`  - ${key} (needed by: ${ids.join(', ')})`);
    }
    console.error('doctor: next step: set the env keys above, or run with fixtures (BRAIN_USE_FIXTURES=1).');
  } else if (live === total) {
    console.error('doctor: next step: all connectors live. You are good to go.');
  } else {
    console.error('doctor: next step: connectors without env are running in fixture mode.');
  }
}

async function main(): Promise<void> {
  const statuses = await getConnectorStatuses();
  printSummary(statuses);
  console.log(JSON.stringify({
    ok: statuses.every((status) => status.fixtureAvailable),
    connectors: statuses,
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
