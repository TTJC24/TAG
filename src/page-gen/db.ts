/**
 * Read-only Postgres access for the page generator.
 *
 * Connects as `company_brain_reader` (the same role the SQL query endpoint
 * uses). All queries run inside a READ ONLY transaction. The page generator
 * never writes to the brain DB.
 */
import { Pool, type PoolClient } from 'pg';

const QUERY_DATABASE_URL = process.env.QUERY_DATABASE_URL ?? process.env.DATABASE_URL;
const PAGEGEN_STATEMENT_TIMEOUT_MS = Number.parseInt(
  process.env.PAGEGEN_STATEMENT_TIMEOUT_MS ?? '30000',
  10,
);

if (!QUERY_DATABASE_URL) {
  throw new Error(
    '[pagegen/db] QUERY_DATABASE_URL (or DATABASE_URL) must be set. ' +
      'On jerry-data the docker-compose injects QUERY_DATABASE_URL pointed at company_brain_reader.',
  );
}

export function openReaderPool(): Pool {
  return new Pool({
    connectionString: QUERY_DATABASE_URL,
    max: 4,
    idleTimeoutMillis: 30000,
    application_name: 'company-brain-pagegen',
  });
}

/**
 * Raw row from gbrain's `pages` table. We capture only the columns the
 * generator needs. Everything entity-specific lives in `compiled_truth`
 * (the rendered markdown body) and `frontmatter` (JSONB).
 *
 * Source of truth: node_modules/gbrain/src/schema.sql (verified during the
 * v3 architecture pass; see HANDOFF_V3.md Section 6).
 */
export interface RawPage {
  id: number;
  source_id: string;
  slug: string;
  type: string | null;
  title: string | null;
  compiled_truth: string;
  frontmatter: Record<string, unknown>;
  content_hash: string | null;
  effective_date: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

/**
 * Load every non-deleted page from `pages` for static rendering. The
 * generator processes them in memory (classification + relationship
 * indexing) so we hit the DB once.
 *
 * If the brain DB hasn't been populated yet (fresh install), this returns
 * an empty array and the generator emits the empty-state homepage.
 */
export async function loadAllPages(pool: Pool): Promise<RawPage[]> {
  const client = await pool.connect();
  try {
    await beginReadOnly(client);

    // Tolerant of empty schema: if `pages` doesn't exist yet, return [].
    const exists = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'pages'
      ) AS exists`,
    );
    if (!exists.rows[0]?.exists) {
      await client.query('COMMIT');
      return [];
    }

    const result = await client.query<RawPage>(
      `SELECT
        id, source_id, slug, type, title,
        compiled_truth, frontmatter, content_hash,
        effective_date, created_at, updated_at, deleted_at
      FROM pages
      WHERE deleted_at IS NULL
      ORDER BY updated_at DESC`,
    );
    await client.query('COMMIT');
    return result.rows;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback failure
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Load sources table (display names per source_id). Optional — graceful
 * empty when the table doesn't exist.
 */
export async function loadSources(pool: Pool): Promise<Map<string, string>> {
  const client = await pool.connect();
  const out = new Map<string, string>();
  try {
    await beginReadOnly(client);
    const exists = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'sources'
      ) AS exists`,
    );
    if (!exists.rows[0]?.exists) {
      await client.query('COMMIT');
      return out;
    }
    const r = await client.query<{ id: string; name: string | null }>(
      'SELECT id, name FROM sources',
    );
    for (const row of r.rows) {
      out.set(row.id, row.name ?? row.id);
    }
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    throw err;
  } finally {
    client.release();
  }
}

async function beginReadOnly(client: PoolClient): Promise<void> {
  await client.query('BEGIN');
  await client.query('SET TRANSACTION READ ONLY');
  await client.query(`SET LOCAL statement_timeout = '${PAGEGEN_STATEMENT_TIMEOUT_MS}ms'`);
}
