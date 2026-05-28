#!/usr/bin/env bun
import cron from 'node-cron';
import { config } from '../config.ts';
import { getConnector, listConnectorIds } from '../sources/registry.ts';
import { runIngestion } from '../ingest/run.ts';

interface ScheduleEntry {
  sourceId: string;
  cron: string;
  dryRun: boolean;
}

const DEFAULT_SCHEDULE: ScheduleEntry[] = [
  { sourceId: 'm365-calendar', cron: '*/30 * * * *', dryRun: true },
  { sourceId: 'm365-mail', cron: '*/15 * * * *', dryRun: true },
  { sourceId: 'm365-sharepoint', cron: '0 */2 * * *', dryRun: true },
  { sourceId: 'm365-teams', cron: '*/20 * * * *', dryRun: true },
  { sourceId: 'acumatica', cron: '0 * * * *', dryRun: true },
  { sourceId: 'pipedrive', cron: '*/30 * * * *', dryRun: true },
];

async function runOnce(entry: ScheduleEntry): Promise<void> {
  const spec = getConnector(entry.sourceId);
  console.log(`[scheduler] ${new Date().toISOString()} starting ${entry.sourceId} (dryRun=${entry.dryRun})`);
  try {
    const source = await spec.build({ dryRun: entry.dryRun });
    const result = await runIngestion(spec.id, spec.displayName, source, {
      dryRun: entry.dryRun,
      noEmbed: true,
    });
    console.log(`[scheduler] ${entry.sourceId} done: ${JSON.stringify(result)}`);
  } catch (err) {
    console.error(`[scheduler] ${entry.sourceId} failed:`, err instanceof Error ? err.message : err);
  }
}

function main(): void {
  if (!config.SCHEDULER_ENABLED) {
    console.log('[scheduler] SCHEDULER_ENABLED is false; exiting');
    process.exit(0);
  }
  console.log(`[scheduler] starting with sources: ${listConnectorIds().join(', ')}`);
  for (const entry of DEFAULT_SCHEDULE) {
    cron.schedule(entry.cron, () => {
      void runOnce(entry);
    });
    console.log(`[scheduler] scheduled ${entry.sourceId} @ ${entry.cron} (dryRun=${entry.dryRun})`);
  }
  process.on('SIGINT', () => {
    console.log('[scheduler] shutting down');
    process.exit(0);
  });
}

main();
