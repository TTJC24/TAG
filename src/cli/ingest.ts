#!/usr/bin/env bun
import { getConnector, listConnectorIds } from '../sources/registry.ts';
import { runIngestion } from '../ingest/run.ts';

function parseArgs(argv: string[]): { sourceId: string; dryRun: boolean; noEmbed: boolean } {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.error(`usage: bun run src/cli/ingest.ts <source-id> [--dry-run] [--no-embed]\n`);
    console.error(`known sources: ${listConnectorIds().join(', ')}`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  return {
    sourceId: args[0],
    dryRun: args.includes('--dry-run'),
    noEmbed: args.includes('--no-embed'),
  };
}

async function main(): Promise<void> {
  const { sourceId, dryRun, noEmbed } = parseArgs(process.argv);
  const spec = getConnector(sourceId);
  const source = await spec.build({ dryRun });
  const result = await runIngestion(spec.id, spec.displayName, source, {
    dryRun,
    noEmbed,
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
