import type { IngestionSource } from 'gbrain/ingestion';

export interface ConnectorSpec {
  id: string;
  displayName: string;
  kind: string;
  build(opts: { dryRun: boolean }): Promise<IngestionSource> | IngestionSource;
}
