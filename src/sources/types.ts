import type { IngestionSource } from 'gbrain/ingestion';

export interface ConnectorSpec {
  id: string;
  displayName: string;
  kind: string;
  fixturePath: string;
  requiredEnv: string[];
  requiredAnyEnv?: string[][];
  build(opts: { dryRun: boolean; cap?: number; skip?: number }): Promise<IngestionSource> | IngestionSource;
}
