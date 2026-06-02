#!/usr/bin/env bun
/**
 * Company Brain v3 — guarded read-only SQL query service.
 *
 * One of the three v3 access modes (Section 4 of HANDOFF_V3.md). Power
 * users (operators, admins) hit this endpoint behind Cloudflare Access
 * to run safe read-only SQL against the brain's Postgres store.
 *
 * Endpoints:
 *   GET  /health         - liveness + DB reachability
 *   GET  /query/schema   - introspect tables, columns, types, PKs
 *   POST /query          - execute a single read-only SQL statement
 *
 * Security boundary (layered, in order from most to least authoritative):
 *
 *   1. Dedicated read-only Postgres role (company_brain_reader).
 *      Provisioned in infra/postgres/init.sql with SELECT-only grants
 *      and forward-compatible ALTER DEFAULT PRIVILEGES so future tables
 *      auto-inherit read-only access. INSERT/UPDATE/DELETE/DDL are
 *      rejected by the database, not by this service.
 *
 *   2. Read-only transaction. Every /query call is wrapped in
 *      `BEGIN; SET TRANSACTION READ ONLY; ...; COMMIT;`. Postgres
 *      refuses any write at the transaction level regardless of the
 *      query string, even if the user has write grants somewhere.
 *
 *   3. Per-request statement_timeout (default 5s, hard cap 30s).
 *      Long-running scans cannot starve the connection pool.
 *
 *   4. Row cap at the response-shaping layer (default 100, hard 500).
 *      Pathological SELECTs cannot exfiltrate the entire DB in one call.
 *
 *   5. Optional UX-only regex check (first-word INSERT/UPDATE/etc.) so
 *      obvious mistakes get a friendly 400 instead of a generic "permission
 *      denied". NOT a security boundary. SELECT 1; DROP TABLE customers;
 *      bypasses this trivially; layers 1+2 catch it.
 *
 * Logging:
 *   Every call (success or failure) logs to public.query_log: who (Cloudflare
 *   Access user email), what (truncated query text), when, duration, row count,
 *   ok/error, errorClass. The log writes happen on a SEPARATE pool using the
 *   ingest credentials, so the reader role stays purely SELECT-only.
 *   This is an OPERATIONAL USAGE LOG, not an ERP audit log.
 */

import { Pool, type PoolClient } from 'pg';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const QUERY_PORT = Number.parseInt(process.env.QUERY_PORT ?? '4317', 10);
const QUERY_DATABASE_URL = process.env.QUERY_DATABASE_URL;
const QUERY_LOG_DATABASE_URL = process.env.QUERY_LOG_DATABASE_URL;

const DEFAULT_ROW_LIMIT = 100;
const HARD_ROW_CAP = 500;
const DEFAULT_TIMEOUT_MS = 5000;
const HARD_TIMEOUT_MS = 30000;
const MAX_LOGGED_QUERY_CHARS = 10000;

if (!QUERY_DATABASE_URL) {
  console.error('[query] FATAL: QUERY_DATABASE_URL is not set. Set it in /opt/company-brain/infra/.env to the company_brain_reader connection string.');
  process.exit(1);
}

// Reader pool: executes user SQL. company_brain_reader role.
const readerPool = new Pool({
  connectionString: QUERY_DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  application_name: 'company-brain-query',
});

readerPool.on('error', (err) => {
  console.error('[query] reader pool error (background):', err.message);
});

// Logger pool: writes to query_log only. Uses ingest creds (which have
// INSERT). Separate pool so the reader role remains SELECT-only.
const loggerPool = QUERY_LOG_DATABASE_URL
  ? new Pool({
      connectionString: QUERY_LOG_DATABASE_URL,
      max: 2,
      idleTimeoutMillis: 30000,
      application_name: 'company-brain-query-logger',
    })
  : null;

if (!loggerPool) {
  console.warn('[query] QUERY_LOG_DATABASE_URL not set; queries will execute but will NOT be logged to query_log');
}

loggerPool?.on('error', (err) => {
  console.error('[query] logger pool error (background):', err.message);
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface QueryRequest {
  sql?: unknown;
  rowLimit?: unknown;
  timeoutMs?: unknown;
}

interface QueryColumn {
  name: string;
  type: string;
}

interface SchemaTable {
  schema: string;
  name: string;
  columns: Array<{
    name: string;
    type: string;
    nullable: boolean;
    default: string | null;
    is_primary_key: boolean;
  }>;
}

type ErrorClass =
  | 'syntax_error'
  | 'permission_denied'
  | 'write_attempted'
  | 'timeout'
  | 'row_limit_exceeded'
  | 'validation_error'
  | 'server_error';

interface LogRecord {
  cfEmail: string | null;
  sql: string;
  durationMs: number | null;
  rowCount: number | null;
  ok: boolean;
  errorClass: ErrorClass | null;
  errorMessage: string | null;
  clientAddr: string | null;
}

// ---------------------------------------------------------------------------
// Postgres OID -> human-readable type name
// ---------------------------------------------------------------------------
const PG_TYPE_NAMES: Record<number, string> = {
  16: 'boolean',
  17: 'bytea',
  20: 'bigint',
  21: 'smallint',
  23: 'integer',
  25: 'text',
  114: 'json',
  142: 'xml',
  700: 'real',
  701: 'double precision',
  790: 'money',
  1042: 'char',
  1043: 'varchar',
  1082: 'date',
  1083: 'time',
  1114: 'timestamp',
  1184: 'timestamptz',
  1186: 'interval',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb',
};
const ARRAY_OID_OFFSET = 1000; // not real, just to keep "unknown oid" readable

function pgTypeName(oid: number): string {
  return PG_TYPE_NAMES[oid] ?? `oid:${oid}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let queryCounter = 0;
function generateQueryId(): string {
  queryCounter += 1;
  const ts = Date.now().toString(36);
  return `q_${ts}_${queryCounter.toString(36)}`;
}

function getCfAccessEmail(req: Request): string | null {
  return req.headers.get('cf-access-authenticated-user-email');
}

function getClientAddr(req: Request): string | null {
  return (
    req.headers.get('cf-connecting-ip') ??
    req.headers.get('x-forwarded-for') ??
    null
  );
}

function clampRowLimit(reqLimit: unknown): number {
  if (typeof reqLimit !== 'number' || !Number.isFinite(reqLimit) || reqLimit <= 0) {
    return DEFAULT_ROW_LIMIT;
  }
  return Math.min(Math.floor(reqLimit), HARD_ROW_CAP);
}

function clampTimeoutMs(reqTimeout: unknown): number {
  if (
    typeof reqTimeout !== 'number' ||
    !Number.isFinite(reqTimeout) ||
    reqTimeout <= 0
  ) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.floor(reqTimeout), HARD_TIMEOUT_MS);
}

const UX_FORBIDDEN_FIRST_WORDS = /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|COPY|CALL|DO|MERGE)\b/i;

function uxValidateSql(sql: string): string | null {
  if (UX_FORBIDDEN_FIRST_WORDS.test(sql)) {
    return 'this endpoint is read-only; use SELECT or WITH ... SELECT. Writes/DDL are not accepted.';
  }
  return null;
}

function classifyPgError(err: unknown): { errorClass: ErrorClass; message: string } {
  if (!(err instanceof Error)) {
    return { errorClass: 'server_error', message: String(err) };
  }
  const code = (err as Error & { code?: string }).code;
  const message = err.message;
  switch (code) {
    case '42501':
      return { errorClass: 'permission_denied', message };
    case '25006':
      return { errorClass: 'write_attempted', message };
    case '57014':
      return { errorClass: 'timeout', message };
    case '42601':
    case '42P01':
    case '42703':
    case '42P02':
    case '42P03':
    case '42P04':
    case '42P05':
    case '42883':
      return { errorClass: 'syntax_error', message };
    default:
      if (code && code.startsWith('42')) return { errorClass: 'syntax_error', message };
      return { errorClass: 'server_error', message };
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// ---------------------------------------------------------------------------
// query_log writer (operational usage log, not an ERP audit log)
// ---------------------------------------------------------------------------
async function logQuery(record: LogRecord): Promise<void> {
  if (!loggerPool) return;
  const truncated = record.sql.length > MAX_LOGGED_QUERY_CHARS;
  const sqlText = truncated
    ? record.sql.slice(0, MAX_LOGGED_QUERY_CHARS)
    : record.sql;
  try {
    await loggerPool.query(
      `INSERT INTO query_log (
        cf_access_user_email, query_text, query_text_truncated,
        duration_ms, row_count, ok, error_class, error_message, client_addr
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        record.cfEmail,
        sqlText,
        truncated,
        record.durationMs,
        record.rowCount,
        record.ok,
        record.errorClass,
        record.errorMessage,
        record.clientAddr,
      ],
    );
  } catch (err) {
    // Logging is best-effort: never block or fail a user response on log issues.
    console.error('[query] failed to write query_log row:', err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------
async function handleHealth(): Promise<Response> {
  let dbOk = false;
  let dbError: string | null = null;
  try {
    const client = await readerPool.connect();
    try {
      await client.query('SELECT 1');
      dbOk = true;
    } finally {
      client.release();
    }
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }
  return jsonResponse(dbOk ? 200 : 503, {
    ok: dbOk,
    service: 'company-brain-query',
    db: { ok: dbOk, error: dbError, role: 'company_brain_reader' },
    timestamp: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// GET /query/schema  — introspect public.* tables, columns, types, PKs
// ---------------------------------------------------------------------------
async function handleSchema(): Promise<Response> {
  const client = await readerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '${DEFAULT_TIMEOUT_MS}ms'`);

    const tablesRes = await client.query<{ table_schema: string; table_name: string }>(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);

    const columnsRes = await client.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: 'YES' | 'NO';
      column_default: string | null;
      ordinal_position: number;
    }>(`
      SELECT table_name, column_name, data_type, is_nullable, column_default, ordinal_position
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position
    `);

    const pksRes = await client.query<{ table_name: string; column_name: string }>(`
      SELECT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'
    `);

    await client.query('COMMIT');

    const colsByTable = new Map<string, typeof columnsRes.rows>();
    for (const row of columnsRes.rows) {
      const list = colsByTable.get(row.table_name) ?? [];
      list.push(row);
      colsByTable.set(row.table_name, list);
    }
    const pksByTable = new Map<string, Set<string>>();
    for (const row of pksRes.rows) {
      const set = pksByTable.get(row.table_name) ?? new Set();
      set.add(row.column_name);
      pksByTable.set(row.table_name, set);
    }

    const tables: SchemaTable[] = tablesRes.rows.map((t) => {
      const cols = colsByTable.get(t.table_name) ?? [];
      const pkSet = pksByTable.get(t.table_name) ?? new Set();
      return {
        schema: t.table_schema,
        name: t.table_name,
        columns: cols.map((c) => ({
          name: c.column_name,
          type: c.data_type,
          nullable: c.is_nullable === 'YES',
          default: c.column_default,
          is_primary_key: pkSet.has(c.column_name),
        })),
      };
    });

    return jsonResponse(200, {
      database: 'company_brain',
      schemaScanned: 'public',
      tableCount: tables.length,
      tables,
      note:
        'gbrain stores most business data in the `pages` table; structured fields ' +
        'like CustomerID / Amount / DueDate are rendered as markdown bullets inside ' +
        'pages.compiled_truth, NOT as typed columns. See HANDOFF_V3.md Section 6 for ' +
        'the recommended JSONB-filter + tsquery patterns and the materialized-view path.',
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[query] /query/schema failed:', msg);
    return jsonResponse(500, {
      error: msg,
      errorClass: 'server_error',
    });
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// POST /query — execute a single read-only SQL statement
// ---------------------------------------------------------------------------
async function handleQuery(req: Request): Promise<Response> {
  const queryId = generateQueryId();
  const cfEmail = getCfAccessEmail(req);
  const clientAddr = getClientAddr(req);
  const startNs = Bun.nanoseconds();

  // Parse body
  let body: QueryRequest;
  try {
    body = (await req.json()) as QueryRequest;
  } catch {
    await logQuery({
      cfEmail,
      sql: '(unparseable body)',
      durationMs: null,
      rowCount: null,
      ok: false,
      errorClass: 'validation_error',
      errorMessage: 'request body is not valid JSON',
      clientAddr,
    });
    return jsonResponse(400, {
      error: 'request body must be valid JSON',
      errorClass: 'validation_error' as ErrorClass,
      queryId,
    });
  }

  if (typeof body.sql !== 'string' || body.sql.trim().length === 0) {
    await logQuery({
      cfEmail,
      sql: typeof body.sql === 'string' ? body.sql : '(empty)',
      durationMs: null,
      rowCount: null,
      ok: false,
      errorClass: 'validation_error',
      errorMessage: 'sql must be a non-empty string',
      clientAddr,
    });
    return jsonResponse(400, {
      error: 'request must include `sql` as a non-empty string',
      errorClass: 'validation_error' as ErrorClass,
      queryId,
    });
  }

  const sql = body.sql.trim();
  const rowLimit = clampRowLimit(body.rowLimit);
  const timeoutMs = clampTimeoutMs(body.timeoutMs);

  // Layer 5 (UX only): catch obvious writes and DDL before sending to DB.
  // Layers 1-4 below are what actually enforce read-only.
  const uxError = uxValidateSql(sql);
  if (uxError) {
    const durationMs = Math.round((Bun.nanoseconds() - startNs) / 1_000_000);
    await logQuery({
      cfEmail,
      sql,
      durationMs,
      rowCount: null,
      ok: false,
      errorClass: 'validation_error',
      errorMessage: uxError,
      clientAddr,
    });
    return jsonResponse(400, {
      error: uxError,
      errorClass: 'validation_error' as ErrorClass,
      queryId,
    });
  }

  // Layer 1: reader pool (SELECT-only role).
  let client: PoolClient | null = null;
  try {
    client = await readerPool.connect();

    // Layer 2: read-only transaction.
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');
    // Layer 3: per-request statement timeout.
    await client.query(`SET LOCAL statement_timeout = '${timeoutMs}ms'`);

    const result = await client.query({
      text: sql,
      rowMode: 'array',
    });

    await client.query('COMMIT');

    const allRows = result.rows as unknown[][];
    // Layer 4: row cap.
    const truncated = allRows.length > rowLimit;
    const rows = truncated ? allRows.slice(0, rowLimit) : allRows;
    const columns: QueryColumn[] = result.fields.map((f) => ({
      name: f.name,
      type: pgTypeName(f.dataTypeID),
    }));

    const durationMs = Math.round((Bun.nanoseconds() - startNs) / 1_000_000);

    await logQuery({
      cfEmail,
      sql,
      durationMs,
      rowCount: allRows.length,
      ok: true,
      errorClass: null,
      errorMessage: null,
      clientAddr,
    });

    return jsonResponse(200, {
      columns,
      rows,
      rowCount: rows.length,
      truncated,
      executionMs: durationMs,
      queryId,
    });
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback failure
      }
    }
    const { errorClass, message } = classifyPgError(err);
    const durationMs = Math.round((Bun.nanoseconds() - startNs) / 1_000_000);

    await logQuery({
      cfEmail,
      sql,
      durationMs,
      rowCount: null,
      ok: false,
      errorClass,
      errorMessage: message,
      clientAddr,
    });

    const status =
      errorClass === 'timeout' ? 408 :
      errorClass === 'permission_denied' || errorClass === 'write_attempted' ? 403 :
      errorClass === 'syntax_error' ? 400 :
      500;

    return jsonResponse(status, {
      error: message,
      errorClass,
      queryId,
    });
  } finally {
    if (client) client.release();
  }
}

// ---------------------------------------------------------------------------
// Preflight: verify the reader role really is read-only on boot
// ---------------------------------------------------------------------------
async function preflightReadOnly(): Promise<void> {
  const client = await readerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'");
    const res = await client.query<{ current_user: string; current_database: string }>(
      'SELECT current_user, current_database()',
    );
    await client.query('COMMIT');
    const u = res.rows[0]?.current_user ?? '?';
    const d = res.rows[0]?.current_database ?? '?';
    console.log(`[query] preflight ok: connected as ${u} to ${d}`);
    if (u !== 'company_brain_reader') {
      console.warn(`[query] WARNING: reader pool is using "${u}" rather than "company_brain_reader". Check QUERY_DATABASE_URL.`);
    }
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  await preflightReadOnly();

  const server = Bun.serve({
    port: QUERY_PORT,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);

      if (req.method === 'GET' && url.pathname === '/health') {
        return handleHealth();
      }
      if (req.method === 'GET' && url.pathname === '/query/schema') {
        return handleSchema();
      }
      if (req.method === 'POST' && url.pathname === '/query') {
        return handleQuery(req);
      }
      if (req.method === 'GET' && url.pathname === '/') {
        return jsonResponse(200, {
          service: 'company-brain-query',
          version: 'v3-phase-3',
          endpoints: ['GET /health', 'GET /query/schema', 'POST /query'],
        });
      }
      return jsonResponse(404, {
        error: 'not found',
        hint: 'available routes: GET /health, GET /query/schema, POST /query',
      });
    },
  });

  console.log(`[query] listening on :${server.port}`);
}

main().catch((err) => {
  console.error('[query] FATAL on boot:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
