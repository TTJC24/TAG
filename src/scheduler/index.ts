#!/usr/bin/env node
import cron from 'node-cron';
import { config } from '../config.ts';
import { getConnector, listConnectorIds } from '../sources/registry.ts';
import { runIngestion } from '../ingest/run.ts';

interface ScheduleEntry {
  sourceId: string;
  cron: string;
}

const DEFAULT_SCHEDULE: ScheduleEntry[] = [
  { sourceId: 'm365-calendar', cron: '*/30 * * * *' },
  { sourceId: 'm365-mail', cron: '*/15 * * * *' },
  { sourceId: 'm365-sharepoint', cron: '0 */2 * * *' },
  { sourceId: 'm365-teams', cron: '*/20 * * * *' },
  // Acumatica remains manual/capped until branch-scoped ERP data is QA'd for scheduling.
  { sourceId: 'pipedrive', cron: '*/30 * * * *' },
];

async function runOnce(entry: ScheduleEntry): Promise<void> {
  const spec = getConnector(entry.sourceId);
  console.log(`[scheduler] ${new Date().toISOString()} starting ${entry.sourceId} (dryRun=${config.SCHEDULER_DRY_RUN})`);
  try {
    const source = await spec.build({ dryRun: config.SCHEDULER_DRY_RUN });
    const result = await runIngestion(spec.id, spec.displayName, source, {
      dryRun: config.SCHEDULER_DRY_RUN,
      noEmbed: config.SCHEDULER_NO_EMBED,
      ingestedVia: 'scheduler',
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
  const enabledSources = new Set(
    (config.SCHEDULER_SOURCES || listConnectorIds().join(','))
      .split(',')
      .map((source) => source.trim())
      .filter(Boolean),
  );
  const entries = DEFAULT_SCHEDULE.filter((entry) => enabledSources.has(entry.sourceId));
  console.log(`[scheduler] starting with sources: ${entries.map((entry) => entry.sourceId).join(', ')}`);
  for (const entry of entries) {
    cron.schedule(entry.cron, () => {
      void runOnce(entry);
    });
    console.log(`[scheduler] scheduled ${entry.sourceId} @ ${entry.cron} (dryRun=${config.SCHEDULER_DRY_RUN})`);
  }
  process.on('SIGINT', () => {
    console.log('[scheduler] shutting down');
    process.exit(0);
  });
}

main();
