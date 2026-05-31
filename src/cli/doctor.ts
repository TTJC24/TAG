#!/usr/bin/env node
import { getConnectorStatuses, type ConnectorStatus } from '../sources/status.ts';

function parseArgs(argv: string[]): { json: boolean } {
  const args = argv.slice(2);
  let json = process.env.npm_config_json === 'true';
  for (const a of args) {
    if (a === '-h' || a === '--help') {
      console.error('usage: bun run doctor [--json]');
      console.error('  --json   suppress human-readable stderr summary; emit only JSON on stdout');
      process.exit(0);
    } else if (a === '--json') {
      json = true;
    } else {
      console.error("unknown flag '" + a + "'. valid flags: --json");
      process.exit(2);
    }
  }
  return { json };
}

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
  const { json } = parseArgs(process.argv);
  const statuses = await getConnectorStatuses();
  if (!json) {
    printSummary(statuses);
  }
  console.log(JSON.stringify({
    ok: statuses.every((status) => status.fixtureAvailable),
    connectors: statuses,
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
