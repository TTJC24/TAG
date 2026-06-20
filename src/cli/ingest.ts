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

function parsePositiveIntFlag(args: string[], flag: string, envNames: string[]): number | undefined {
  let raw: string | undefined;
  for (const envName of envNames) {
    raw = process.env[envName];
    if (raw !== undefined && raw !== '') break;
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === flag) raw = args[i + 1];
    if (arg?.startsWith(`${flag}=`)) raw = arg.slice(`${flag}=`.length);
  }
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || (flag !== '--skip' && value === 0)) {
    const expected = flag === '--skip' ? 'a non-negative integer' : 'a positive integer';
    console.error(`invalid ${flag} value '${raw}'. Expected ${expected}.`);
    process.exit(2);
  }
  return value;
}

function parseCap(args: string[]): number | undefined {
  return parsePositiveIntFlag(args, '--cap', ['ACUMATICA_INGEST_CAP', 'npm_config_cap']);
}

function parseSkip(args: string[]): number | undefined {
  return parsePositiveIntFlag(args, '--skip', ['ACUMATICA_INGEST_SKIP', 'npm_config_skip']);
}

function parseArgs(argv: string[]): {
  sourceId: string;
  dryRun: boolean;
  noEmbed: boolean;
  fixtures: boolean;
  live: boolean;
  summaryOnly: boolean;
  quiet: boolean;
  cap?: number;
  skip?: number;
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
  const unknown = args.slice(1).filter((a) => (
    a.startsWith('--') &&
    !KNOWN_INGEST_FLAGS.has(a) &&
    a !== '--cap' &&
    !a.startsWith('--cap=') &&
    a !== '--skip' &&
    !a.startsWith('--skip=')
  ));
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
    cap: parseCap(args),
    skip: parseSkip(args),
  };
}

async function main(): Promise<void> {
  const { sourceId, dryRun, noEmbed, fixtures, live, summaryOnly, quiet, cap, skip } = parseArgs(process.argv);
  const spec = getConnector(sourceId);
  const useFixtures = fixtures || (dryRun && !live);
  const source = await spec.build({ dryRun: useFixtures, cap, skip });
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
