import { hybridSearch } from 'gbrain/search/hybrid';
import type { SearchResult } from 'gbrain/types';
import { openEngine } from './engine.ts';

export interface BrainCitation {
  slug: string;
  source_id: string;
  title: string | null;
}

export interface BrainAnswer {
  text: string;
  citations: BrainCitation[];
}

export interface AskOptions {
  question: string;
  sources?: string[];
  limit?: number;
}

function renderAnswer(question: string, hits: SearchResult[]): string {
  if (!hits.length) {
    return `No relevant pages in the brain for: ${question}`;
  }
  const lines: string[] = [`Found ${hits.length} relevant chunk(s):`, ''];
  for (const h of hits.slice(0, 5)) {
    const title = h.title || h.slug;
    const snippet = (h.chunk_text ?? '').replace(/\s+/g, ' ').trim().slice(0, 280);
    lines.push(`- ${title}`);
    if (snippet) lines.push(`  ${snippet}`);
  }
  return lines.join('\n');
}

export async function askBrain(opts: AskOptions): Promise<BrainAnswer> {
  const engine = await openEngine();
  try {
    const hits = await hybridSearch(engine, opts.question, {
      limit: opts.limit ?? 10,
      sourceIds: opts.sources && opts.sources.length > 0 ? opts.sources : undefined,
    });
    const seen = new Set<string>();
    const citations: BrainCitation[] = [];
    for (const h of hits) {
      if (seen.has(h.slug)) continue;
      seen.add(h.slug);
      citations.push({
        slug: h.slug,
        source_id: h.source_id ?? 'default',
        title: h.title ?? null,
      });
      if (citations.length >= 5) break;
    }
    return { text: renderAnswer(opts.question, hits), citations };
  } finally {
    await engine.disconnect();
  }
}
