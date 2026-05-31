#!/usr/bin/env node
import { getBrainStatus, type BrainStatus } from '../brainStatus.ts';

function parseArgs(argv: string[]): { json: boolean } {
  const args = argv.slice(2);
  let json = process.env.npm_config_json === 'true';
  for (const a of args) {
    if (a === '-h' || a === '--help') {
      console.error('usage: bun run status [--json]');
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

function printSummary(status: BrainStatus): void {
  console.error(
    `status: engine=${status.engine}, ${status.source_count} sources, ${status.document_count} documents total`,
  );
  if (status.sources.length === 0) {
    console.error('status: next step: no sources ingested yet. Run `bun run ingest` to populate the brain.');
    return;
  }
  // Sort sources by document_count desc so heaviest sources surface first.
  const sorted = [...status.sources].sort((a, b) => b.document_count - a.document_count);
  for (const source of sorted) {
    console.error(`  - ${source.id} (${source.name}): ${source.document_count} docs`);
  }
  const empty = sorted.filter((s) => s.document_count === 0).map((s) => s.id);
  if (empty.length > 0) {
    console.error(`status: next step: sources with 0 docs: ${empty.join(', ')}. Re-run ingest for those connectors.`);
  }
}

const { json } = parseArgs(process.argv);
getBrainStatus()
  .then((status) => {
    if (!json) {
      printSummary(status);
    }
    console.log(JSON.stringify(status, null, 2));
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
