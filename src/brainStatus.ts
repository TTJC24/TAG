import { openEngine } from './engine.ts';

export interface BrainSourceStatus {
  id: string;
  name: string;
  document_count: number;
}

export interface BrainStatus {
  engine: string;
  document_count: number;
  source_count: number;
  sources: BrainSourceStatus[];
}

export async function getBrainStatus(): Promise<BrainStatus> {
  const engine = await openEngine();
  try {
    if (typeof engine.getStats === 'function') {
      const stats = await engine.getStats() as {
        page_count?: number;
        source_count?: number;
        sources?: Array<{ id: string; name?: string; document_count?: number; page_count?: number }>;
      };
      return {
        engine: 'gbrain',
        document_count: Number(stats.page_count ?? 0),
        source_count: Number(stats.source_count ?? stats.sources?.length ?? 0),
        sources: (stats.sources ?? []).map((source) => ({
          id: source.id,
          name: source.name ?? source.id,
          document_count: Number(source.document_count ?? source.page_count ?? 0),
        })),
      };
    }
    throw new Error('Current brain engine does not expose status.');
  } finally {
    await engine.disconnect();
  }
}
