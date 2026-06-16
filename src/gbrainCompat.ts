import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hybridSearch as upstreamHybridSearch } from 'gbrain/search/hybrid';
import type { SearchResult } from 'gbrain/types';

type StorePage = {
  slug: string;
  title?: string | null;
  chunk_text?: string | null;
  source_id?: string | null;
  score: number;
  content?: string;
  content_hash?: string | null;
  source_kind?: string | null;
  source_uri?: string | null;
  metadata?: Record<string, unknown>;
  raw_event?: unknown;
  received_at?: string | null;
  imported_at?: string;
};

interface JsonStore {
  sources: Array<{ id: string; name: string; local_path: null; config: Record<string, unknown>; archived: boolean; created_at: string }>;
  pages: StorePage[];
}

const STORE_PATH = '.company-brain-store.json';

function emptyStore(): JsonStore {
  return { sources: [], pages: [] };
}

function readStore(): JsonStore {
  if (!existsSync(STORE_PATH)) return emptyStore();
  const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf8')) as Partial<JsonStore>;
  return {
    sources: Array.isArray(parsed.sources) ? parsed.sources as JsonStore['sources'] : [],
    pages: Array.isArray(parsed.pages) ? parsed.pages as StorePage[] : [],
  };
}

function writeStore(store: JsonStore): void {
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function titleFromContent(content: string, fallback: string): string {
  const frontmatterTitle = content.match(/^---[\s\S]*?\ntitle:\s*"?([^"\n]+)"?[\s\S]*?---/);
  if (frontmatterTitle?.[1]) return frontmatterTitle[1].trim();
  const heading = content.match(/^#\s+(.+)$/m);
  return heading?.[1]?.trim() || fallback;
}

export interface JsonBrainEngine {
  kind: 'json';
  store: JsonStore;
  dirty: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  initSchema(): Promise<void>;
  importContent(slug: string, content: string, options?: Record<string, any>): Promise<{ status: 'imported' | 'skipped'; slug: string }>;
  executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  getStats(): Promise<{ page_count: number; source_count: number; sources: Array<{ id: string; name: string; page_count: number; document_count: number }> }>;
}

export function createJsonEngine(): JsonBrainEngine {
  return {
    kind: 'json',
    store: emptyStore(),
    dirty: false,
    async connect() {
      this.store = readStore();
      this.dirty = false;
    },
    async disconnect() {
      if (this.dirty) {
        writeStore(this.store);
        this.dirty = false;
      }
    },
    async initSchema() {},
    async importContent(slug, content, options = {}) {
      const contentHash = options.content_hash ?? null;
      const existing = this.store.pages.find((page) => page.slug === slug && page.source_id === (options.sourceId ?? options.source_id ?? 'default'));
      if (existing?.content_hash && contentHash && existing.content_hash === contentHash) return { status: 'skipped', slug };
      const page: StorePage = {
        slug,
        title: titleFromContent(String(content), slug),
        content,
        chunk_text: String(content).replace(/^---[\s\S]*?---/, '').replace(/\s+/g, ' ').trim(),
        score: 0,
        content_hash: contentHash,
        source_id: options.sourceId ?? options.source_id ?? 'default',
        source_kind: options.source_kind ?? null,
        source_uri: options.source_uri ?? null,
        metadata: options.metadata ?? {},
        raw_event: options.raw_event ?? null,
        received_at: options.received_at ?? null,
        imported_at: new Date().toISOString(),
      };
      if (existing) Object.assign(existing, page);
      else this.store.pages.push(page);
      this.dirty = true;
      return { status: 'imported', slug };
    },
    async executeRaw<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (normalized.startsWith('select id from sources where id =')) {
        return this.store.sources.filter((source) => source.id === params[0]).map(({ id }) => ({ id }) as T);
      }
      if (normalized.startsWith('insert into sources')) {
        const [id, name] = params as [string, string];
        if (!this.store.sources.some((source) => source.id === id)) {
          this.store.sources.push({ id, name, local_path: null, config: {}, archived: false, created_at: new Date().toISOString() });
          this.dirty = true;
        }
        return [];
      }
      if (normalized.startsWith('select slug, title, chunk_text, source_id, source_uri from brain_documents')) {
        const sourceIds = params[0] as string[] | null;
        return this.store.pages
          .filter((page) => !sourceIds?.length || sourceIds.includes(page.source_id ?? ''))
          .map((page) => ({
            slug: page.slug,
            title: page.title ?? null,
            chunk_text: page.chunk_text ?? null,
            source_id: page.source_id ?? null,
            source_uri: page.source_uri ?? null,
          }) as T);
      }
      return [];
    },
    async getStats() {
      const sources = this.store.sources.map((source) => {
        const count = this.store.pages.filter((page) => page.source_id === source.id).length;
        return { id: source.id, name: source.name, page_count: count, document_count: count };
      });
      return { page_count: this.store.pages.length, source_count: this.store.sources.length, sources };
    },
  };
}

function scorePage(page: StorePage, query: string): number {
  const haystack = `${page.title ?? ''} ${page.slug ?? ''} ${page.chunk_text ?? ''}`.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return 0;
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += 1;
  }
  if (haystack.includes(query.toLowerCase())) score += terms.length;
  return score / terms.length;
}

export async function hybridSearch(engine: any, query: string, options: { limit?: number; sourceIds?: string[] } = {}): Promise<SearchResult[]> {
  if (!Array.isArray(engine.store?.pages)) return upstreamHybridSearch(engine, query, options);
  const sourceIds = new Set(options.sourceIds ?? []);
  const limit = options.limit ?? 10;
  return engine.store.pages
    .filter((page: StorePage) => sourceIds.size === 0 || sourceIds.has(page.source_id ?? ''))
    .map((page: StorePage) => ({ ...page, score: scorePage(page, query) }))
    .filter((page: StorePage) => Number(page.score) > 0)
    .sort((a: StorePage, b: StorePage) => Number(b.score ?? 0) - Number(a.score ?? 0) || String(a.slug).localeCompare(String(b.slug)))
    .slice(0, limit)
    .map(({ content, content_hash, imported_at, metadata, raw_event, received_at, source_kind, ...hit }: StorePage) => hit as SearchResult);
}
