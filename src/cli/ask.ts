#!/usr/bin/env bun
import { askBrain } from '../ask.ts';
import type { MemoryScope } from '../memory.ts';
import { listConnectorIds } from '../sources/registry.ts';

function parseArgs(argv: string[]): { question: string; sources: string[]; entity?: MemoryScope; json: boolean } {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.error(`usage: bun run src/cli/ask.ts <question> [--source <id>...] [--entity fs|blcs|usa|shared] [--json]`);
    console.error(`known sources: ${listConnectorIds().join(', ')}`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const sources: string[] = [];
  let entity: MemoryScope | undefined;
  let json = false;
  const questionParts: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--source') {
      const v = args[i + 1];
      if (!v) throw new Error('--source requires a value');
      sources.push(v);
      i += 1;
    } else if (a === '--entity') {
      const v = args[i + 1] as MemoryScope | undefined;
      if (!v || !['fs', 'blcs', 'usa', 'shared'].includes(v)) {
        throw new Error('--entity requires one of: fs, blcs, usa, shared');
      }
      entity = v;
      i += 1;
    } else if (a === '--json') {
      json = true;
    } else {
      questionParts.push(a);
    }
  }
  return { question: questionParts.join(' '), sources, entity, json };
}

async function main(): Promise<void> {
  const { question, sources, entity, json } = parseArgs(process.argv);
  const answer = await askBrain({ question, sources, entity });
  if (json) {
    console.log(JSON.stringify(answer, null, 2));
    return;
  }
  console.log(answer.text);
  if (answer.citations.length > 0) {
    console.log('\nSources:');
    for (const c of answer.citations) {
      console.log(`  - ${c.slug}\t${c.source_id}\t${c.title ?? ''}`);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
