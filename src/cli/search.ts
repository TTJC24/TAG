#!/usr/bin/env bun
import { hybridSearch } from '../gbrainCompat.ts';
import { openEngine } from '../engine.ts';
import { listConnectorIds } from '../sources/registry.ts';

function parseArgs(argv: string[]): { query: string; sources: string[]; limit: number; json: boolean } {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.error(`usage: bun run search -- <query> [--source <id>...] [--limit N] [--json]`);
    console.error(`known sources: ${listConnectorIds().join(', ')}`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const validSources = listConnectorIds();
  const validSourceSet = new Set(validSources);
  const sources: string[] = [];
  let limit = 10;
  let json = process.env.npm_config_json === 'true';
  const queryParts: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--source') {
      const v = args[i + 1];
      if (!v || v.startsWith('--')) {
        throw new Error(`--source requires a value (saw: ${v ?? '<end of args>'})`);
      }
      if (!validSourceSet.has(v)) {
        throw new Error(`unknown --source '${v}'. valid: ${validSources.join(', ')}`);
      }
      sources.push(v);
      i += 1;
    } else if (a === '--limit') {
      const v = args[i + 1];
      if (!v || v.startsWith('--')) {
        throw new Error(`--limit requires a value (saw: ${v ?? '<end of args>'})`);
      }
      const n = Number(v);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 1000) {
        throw new Error(`--limit must be a positive integer 1-1000, got '${v}'`);
      }
      limit = n;
      i += 1;
    } else if (a === '--json') {
      json = true;
    } else if (a.startsWith('--')) {
      throw new Error("unknown flag '" + a + "'. valid flags: --source, --limit, --json");
    } else {
      queryParts.push(a);
    }
  }
  if (queryParts.length === 0) {
    throw new Error('missing <query>. usage: bun run search <query> [--source <id>] [--limit N] [--json]');
  }
  return { query: queryParts.join(' '), sources, limit, json };
}

async function main(): Promise<void> {
  const { query, sources, limit, json } = parseArgs(process.argv);
  const engine = await openEngine();
  try {
    const results = await hybridSearch(engine, query, {
      limit,
      sourceIds: sources.length > 0 ? sources : undefined,
    });
    if (json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }
    if (!results.length) {
      console.log('(no results)');
      return;
    }
    const pretty = Boolean(process.stdout.isTTY);
    if (pretty) {
      const rows = results.map((r) => ({
        score: r.score.toFixed(3),
        source: r.source_id ?? 'default',
        slug: (r.slug ?? '').length > 40 ? (r.slug ?? '').slice(0, 39) + '…' : (r.slug ?? ''),
        title: (r.title ?? '').slice(0, 80),
      }));
      const scoreW = Math.max(...rows.map((r) => r.score.length));
      const sourceW = Math.max(...rows.map((r) => r.source.length));
      const slugW = Math.max(...rows.map((r) => r.slug.length));
      for (const r of rows) {
        console.log(
          `${r.score.padStart(scoreW)}  ${r.source.padEnd(sourceW)}  ${r.slug.padEnd(slugW)}  ${r.title}`,
        );
      }
    } else {
      for (const r of results) {
        const score = r.score.toFixed(3);
        console.log(`${score}\t${r.source_id ?? 'default'}\t${r.slug}\t${(r.title ?? '').slice(0, 80)}`);
      }
    }
  } finally {
    await engine.disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
