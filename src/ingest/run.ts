import { basename } from 'node:path';
import { importFromContent } from 'gbrain/import-file';
import {
  validateIngestionEvent,
  type IngestionEvent,
  type IngestionSource,
} from 'gbrain/ingestion';
import { ensureSourceRow, openEngine, type Engine } from '../engine.ts';

export interface IngestRunResult {
  sourceId: string;
  emitted: number;
  imported: number;
  skipped: number;
  dryRun: boolean;
}

export interface IngestRunOptions {
  dryRun: boolean;
  noEmbed?: boolean;
  ingestedVia?: string;
  summaryOnly?: boolean;
  quiet?: boolean;
}

export async function runIngestion(
  sourceId: string,
  displayName: string,
  source: IngestionSource,
  opts: IngestRunOptions,
): Promise<IngestRunResult> {
  const ingestedVia = opts.ingestedVia ?? 'ingestion-source';

  let engine: Engine | null = null;
  if (!opts.dryRun) {
    engine = await openEngine();
    await ensureSourceRow(engine, sourceId, displayName);
  }

  const emitted: IngestionEvent[] = [];
  const abortController = new AbortController();

  try {
    const stubEngine = new Proxy({}, {
      get() {
        throw new Error('engine access during dry-run is not supported');
      },
    });
    await source.start({
      emit(event) {
        const err = validateIngestionEvent(event);
        if (err) throw err;
        emitted.push(event);
      },
      engine: engine ?? (stubEngine as never),
      logger: console,
      abortSignal: abortController.signal,
      config: { runner: 'company-brain' },
    });

    let imported = 0;
    let skipped = 0;

    if (opts.dryRun) {
      if (!opts.summaryOnly && !opts.quiet) {
        for (const event of emitted) {
          const slug = String(event.metadata?.slug ?? basename(event.source_uri));
          console.log(`dry-run\t${event.source_id}\t${slug}\t${event.content_hash}`);
        }
      }
    } else {
      if (!engine) throw new Error('engine missing for non-dry-run');
      for (const event of emitted) {
        const slug = String(event.metadata?.slug ?? basename(event.source_uri));
        const result = await importFromContent(engine, slug, event.content, {
          sourceId: event.source_id,
          noEmbed: opts.noEmbed ?? false,
          source_kind: event.source_kind,
          source_uri: event.source_uri,
          ingested_via: ingestedVia,
          metadata: event.metadata ?? {},
          raw_event: event,
          received_at: event.received_at,
        });
        if (result.status === 'imported') imported += 1;
        if (result.status === 'skipped') skipped += 1;
        if (!opts.quiet) console.log(`${result.status}\t${slug}\t${event.content_hash}`);
      }
    }

    return {
      sourceId,
      emitted: emitted.length,
      imported,
      skipped,
      dryRun: opts.dryRun,
    };
  } finally {
    await source.stop?.();
    if (engine) await engine.disconnect();
  }
}
