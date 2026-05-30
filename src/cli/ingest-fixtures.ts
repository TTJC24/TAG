#!/usr/bin/env node
import { connectors } from '../sources/registry.ts';
import { runIngestion } from '../ingest/run.ts';

async function main(): Promise<void> {
  const results = [];
  for (const spec of Object.values(connectors)) {
    const source = await spec.build({ dryRun: true });
    const result = await runIngestion(spec.id, spec.displayName, source, {
      dryRun: false,
      noEmbed: true,
      ingestedVia: 'fixture-import',
    });
    results.push(result);
  }
  console.log(JSON.stringify({ results }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
