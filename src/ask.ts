import { hybridSearch } from 'gbrain/search/hybrid';
import type { SearchResult } from 'gbrain/types';
import { openEngine } from './engine.ts';
import { config } from './config.ts';
import { recall, type MemoryScope } from './memory.ts';

export interface BrainCitation {
  slug: string;
  source_id: string;
  title: string | null;
}

export interface BrainAnswer {
  text: string;
  citations: BrainCitation[];
  /** Facts pulled from the Supermemory layer-5 feedback loop. Empty when
   *  SUPERMEMORY_API_KEY is unset, no facts matched, or recall failed. */
  memories: string[];
}

export interface AskOptions {
  question: string;
  sources?: string[];
  limit?: number;
}

/**
 * Resolve the memory scope to recall against. When Session A's
 * `buildRetrievalProfile` lands in src/retrieval.ts, replace this stub with
 * `profile.entity ?? 'shared'` so entity-scoped questions hit the
 * brain-fs / brain-blcs / brain-usa containers instead of the shared one.
 */
function resolveMemoryScope(_opts: AskOptions): MemoryScope {
  // TODO(integration): pull the entity from buildRetrievalProfile() once
  // retrieval.ts ships. Until then everything routes to the shared container.
  return 'shared';
}

/**
 * Pull facts from Supermemory for this question. Returns [] if the key is
 * unset, if no facts match, or if the network/API call fails — never throws.
 * The brain still answers when Supermemory is unreachable.
 */
async function safeRecall(question: string, scope: MemoryScope): Promise<string[]> {
  if (!config.SUPERMEMORY_API_KEY) return [];
  try {
    return await recall(question, scope);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[ask] supermemory recall failed (scope=${scope}): ${reason}`);
    return [];
  }
}

function renderAnswer(question: string, hits: SearchResult[], memories: string[]): string {
  const sections: string[] = [];

  if (memories.length > 0) {
    sections.push('## Memory context (Supermemory)');
    sections.push('');
    for (const m of memories.slice(0, 5)) {
      const snippet = m.replace(/\s+/g, ' ').trim().slice(0, 400);
      sections.push(`- ${snippet}`);
    }
    sections.push('');
  }

  if (!hits.length) {
    sections.push(
      memories.length > 0
        ? `## Brain search\n\nNo relevant pages in the brain DB for: ${question}`
        : `No relevant pages in the brain for: ${question}`,
    );
    return sections.join('\n');
  }

  sections.push(`## Brain search`);
  sections.push('');
  sections.push(`Found ${hits.length} relevant chunk(s):`);
  sections.push('');
  for (const h of hits.slice(0, 5)) {
    const title = h.title || h.slug;
    const snippet = (h.chunk_text ?? '').replace(/\s+/g, ' ').trim().slice(0, 280);
    sections.push(`- ${title}`);
    if (snippet) sections.push(`  ${snippet}`);
  }
  return sections.join('\n');
}

export async function askBrain(opts: AskOptions): Promise<BrainAnswer> {
  const scope = resolveMemoryScope(opts);
  // Kick off recall in parallel with DB connect — recall is safe-bounded
  // (never throws) so we can await it after hybridSearch without risk.
  const memoriesPromise = safeRecall(opts.question, scope);

  const engine = await openEngine();
  try {
    const hits = await hybridSearch(engine, opts.question, {
      limit: opts.limit ?? 10,
      sourceIds: opts.sources && opts.sources.length > 0 ? opts.sources : undefined,
    });
    const memories = await memoriesPromise;
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
    return {
      text: renderAnswer(opts.question, hits, memories),
      citations,
      memories,
    };
  } finally {
    await engine.disconnect();
  }
}
