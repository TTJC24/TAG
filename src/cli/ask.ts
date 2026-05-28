#!/usr/bin/env bun
import { askBrain } from '../ask.ts';

function parseArgs(argv: string[]): { question: string; sources: string[]; json: boolean } {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.error(`usage: bun run src/cli/ask.ts <question> [--source <id>...] [--json]`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const sources: string[] = [];
  let json = false;
  const questionParts: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--source') {
      const v = args[i + 1];
      if (!v) throw new Error('--source requires a value');
      sources.push(v);
      i += 1;
    } else if (a === '--json') {
      json = true;
    } else {
      questionParts.push(a);
    }
  }
  return { question: questionParts.join(' '), sources, json };
}

async function main(): Promise<void> {
  const { question, sources, json } = parseArgs(process.argv);
  const answer = await askBrain({ question, sources });
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
