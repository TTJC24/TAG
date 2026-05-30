import { existsSync } from 'node:fs';
import { config, type Config } from '../config.ts';
import { openEngine } from '../engine.ts';
import { connectors } from './registry.ts';

export interface ConnectorStatus {
  id: string;
  displayName: string;
  kind: string;
  fixtureAvailable: boolean;
  liveReady: boolean;
  missingEnv: string[];
  documentCount: number;
}

function hasConfigValue(key: string): boolean {
  const value = config[key as keyof Config];
  return value !== undefined && value !== null && value !== '';
}

export async function getConnectorStatuses(): Promise<ConnectorStatus[]> {
  const engine = await openEngine();
  try {
    const brainStatus = typeof engine.getStats === 'function'
      ? await engine.getStats() as { sources?: Array<{ id: string; document_count?: number; page_count?: number }> }
      : { sources: [] };
    const documentCounts = new Map<string, number>(
      (brainStatus.sources ?? []).map((source) => [
        source.id,
        Number(source.document_count ?? source.page_count ?? 0),
      ]),
    );

    return Object.values(connectors).map((connector) => {
      const missingEnv = [
        ...connector.requiredEnv.filter((key) => !hasConfigValue(key)),
        ...(connector.requiredAnyEnv ?? [])
          .filter((group) => !group.some((key) => hasConfigValue(key)))
          .map((group) => group.join('|')),
      ];
      return {
        id: connector.id,
        displayName: connector.displayName,
        kind: connector.kind,
        fixtureAvailable: existsSync(connector.fixturePath),
        liveReady: missingEnv.length === 0,
        missingEnv,
        documentCount: documentCounts.get(connector.id) ?? 0,
      };
    });
  } finally {
    await engine.disconnect();
  }
}
