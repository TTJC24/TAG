#!/usr/bin/env bun
import { getConnector, listConnectorIds } from '../sources/registry.ts';
import { runIngestion } from '../ingest/run.ts';

function npmFlag(name: string): boolean {
  const value = process.env[`npm_config_${name}`];
  return value !== undefined && value !== 'false';
}

const KNOWN_INGEST_FLAGS = new Set([
  '--dry-run',
  '--no-embed',
  '--fixtures',
  '--live',
  '--summary',
  '--quiet',
]);

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
    console.error(`usage: bun run ingest <source-id> [--dry-run] [--no-embed]\n`);
    console.error(`known sources: ${listConnectorIds().join(', ')}`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  if (args[0].startsWith('--')) {
    console.error(`expected <source-id> as first argument, got flag '${args[0]}'`);
    console.error(`known sources: ${listConnectorIds().join(', ')}`);
    process.exit(2);
  }
  const unknown = args.slice(1).filter((a) => a.startsWith('--') && !KNOWN_INGEST_FLAGS.has(a));
  if (unknown.length > 0) {
    console.error(
      `unknown flag(s): ${unknown.join(', ')}. valid: ${Array.from(KNOWN_INGEST_FLAGS).join(', ')}`,
    );
    process.exit(2);
  }
  const summaryOnly = args.includes('--summary') || npmFlag('summary');
  const quiet = args.includes('--quiet') || npmFlag('quiet');
  const dryRun = args.includes('--dry-run') || npmFlag('dry_run') || summaryOnly;
  if (dryRun) {
    console.error('[dry-run] no writes will be performed');
  }
  return {
    sourceId: args[0],
    dryRun,
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
