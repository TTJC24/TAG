#!/usr/bin/env node
import { getConnectorStatuses } from '../sources/status.ts';

async function main(): Promise<void> {
  const statuses = await getConnectorStatuses();
  console.log(JSON.stringify({
    ok: statuses.every((status) => status.fixtureAvailable),
    connectors: statuses,
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
