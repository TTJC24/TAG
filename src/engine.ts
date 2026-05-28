import { createEngine } from 'gbrain/engine-factory';
import { config } from './config.ts';

export type Engine = Awaited<ReturnType<typeof createEngine>>;

export async function openEngine(): Promise<Engine> {
  const opts = { engine: 'postgres' as const, database_url: config.DATABASE_URL };
  const engine = await createEngine(opts);
  await engine.connect(opts);
  return engine;
}

export async function ensureSourceRow(
  engine: Engine,
  id: string,
  displayName: string,
): Promise<void> {
  const existing = await engine.executeRaw<{ id: string }>(
    'SELECT id FROM sources WHERE id = $1',
    [id],
  );
  if (existing.length > 0) return;
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, archived, created_at)
     VALUES ($1, $2, NULL, '{}'::jsonb, false, now())`,
    [id, displayName],
  );
}
