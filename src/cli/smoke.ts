#!/usr/bin/env node
import { askBrain } from '../ask.ts';
import { getBrainStatus } from '../brainStatus.ts';
import { getConnectorStatuses } from '../sources/status.ts';
import { connectors, listConnectorIds } from '../sources/registry.ts';
import { runIngestion } from '../ingest/run.ts';

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

async function seedFixtureIndex(): Promise<void> {
  for (const spec of Object.values(connectors)) {
    const source = await spec.build({ dryRun: true });
    await runIngestion(spec.id, spec.displayName, source, {
      dryRun: false,
      noEmbed: true,
      ingestedVia: 'fixture-smoke',
      quiet: true,
    });
  }
}

async function main(): Promise<void> {
  const expectedConnectors = listConnectorIds();
  await seedFixtureIndex();
  const connectorStatuses = await getConnectorStatuses();
  const brainStatus = await getBrainStatus();
  const answer = await askBrain({ question: 'Acme pump terms', limit: 5 });

  assert(
    connectorStatuses.length === expectedConnectors.length,
    `Expected ${expectedConnectors.length} connectors, found ${connectorStatuses.length}`,
  );
  for (const connectorId of expectedConnectors) {
    const status = connectorStatuses.find((connector) => connector.id === connectorId);
    if (!status) throw new Error(`Missing connector status for ${connectorId}`);
    if (status.fixtureAvailable) {
      assert(status.documentCount > 0, `${connectorId} has no imported fixture documents`);
    } else {
      assert(status.healthState === 'blocked', `${connectorId} without fixtures should remain blocked`);
      assert(status.documentCount === 0, `${connectorId} without fixtures should not import documents`);
    }
  }
  const fixtureBackedCount = connectorStatuses.filter((connector) => connector.fixtureAvailable).length;
  assert(brainStatus.document_count >= fixtureBackedCount, 'Brain has too few documents');
  assert(answer.citations.length > 0, 'Ask returned no citations');

  console.log(JSON.stringify({
    ok: true,
    engine: brainStatus.engine,
    documentCount: brainStatus.document_count,
    connectorCount: connectorStatuses.length,
    connectors: connectorStatuses.map((connector) => ({
      id: connector.id,
      documentCount: connector.documentCount,
      fixtureAvailable: connector.fixtureAvailable,
      liveReady: connector.liveReady,
    })),
    sampleAnswer: answer.text,
    citations: answer.citations,
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
