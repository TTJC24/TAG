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
    if (typeof engine.getStatus === 'function') {
      return await engine.getStatus();
    }
    throw new Error('Current brain engine does not expose status.');
  } finally {
    await engine.disconnect();
  }
}
