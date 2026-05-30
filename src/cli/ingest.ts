#!/usr/bin/env bun
import { getConnector, listConnectorIds } from '../sources/registry.ts';
import { runIngestion } from '../ingest/run.ts';

function npmFlag(name: string): boolean {
  const value = process.env[`npm_config_${name}`];
  return value !== undefined && value !== 'false';
}

function parseArgs(argv: string[]): {
  sourceId: string;
  dryRun: boolean;
  noEmbed: boolean;
  fixtures: boolean;
  live: boolean;
  summaryOnly: boolean;
  quiet: boolean;
} {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.error(`usage: npm run ingest -- <source-id> [--dry-run] [--live] [--fixtures] [--no-embed] [--summary] [--quiet]\n`);
    console.error(`known sources: ${listConnectorIds().join(', ')}`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const summaryOnly = args.includes('--summary') || npmFlag('summary');
  const quiet = args.includes('--quiet') || npmFlag('quiet');
  return {
    sourceId: args[0],
    dryRun: args.includes('--dry-run') || npmFlag('dry_run') || summaryOnly,
    noEmbed: args.includes('--no-embed') || npmFlag('no_embed'),
    fixtures: args.includes('--fixtures') || npmFlag('fixtures'),
    live: args.includes('--live') || npmFlag('live'),
    summaryOnly,
    quiet,
  };
}

async function main(): Promise<void> {
  const { sourceId, dryRun, noEmbed, fixtures, live, summaryOnly, quiet } = parseArgs(process.argv);
  const spec = getConnector(sourceId);
  const useFixtures = fixtures || (dryRun && !live);
  const source = await spec.build({ dryRun: useFixtures });
  const result = await runIngestion(spec.id, spec.displayName, source, {
    dryRun,
    noEmbed,
    ingestedVia: useFixtures ? 'fixture-import' : undefined,
    summaryOnly,
    quiet,
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
