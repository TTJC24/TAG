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
  healthState: 'live_ready' | 'fixture_ready' | 'blocked';
  failureState: null | 'missing_env' | 'missing_fixture';
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
      const fixtureAvailable = existsSync(connector.fixturePath);
      const liveReady = missingEnv.length === 0;
      const healthState = liveReady ? 'live_ready' : fixtureAvailable ? 'fixture_ready' : 'blocked';
      const failureState = liveReady ? null : missingEnv.length > 0 ? 'missing_env' : 'missing_fixture';
      return {
        id: connector.id,
        displayName: connector.displayName,
        kind: connector.kind,
        fixtureAvailable,
        liveReady,
        missingEnv,
        documentCount: documentCounts.get(connector.id) ?? 0,
        healthState,
        failureState,
      };
    });
  } finally {
    await engine.disconnect();
  }
}
