# Company Brain v3 -- Static + SQL Read-Only Build

Company Brain v1 is a read-only internal operating directory: static generated HTML pages for the team, static client-side search across those pages, and a guarded read-only SQL endpoint for power users -- all behind Cloudflare Access with Entra SSO.

This is v3. It supersedes both HANDOFF_V2.md and HANDOFF_V2_1.md. v2 and v2.1 are preserved as historical context only; do NOT build against them. v3 is canonical going forward.

## Current beta implementation note (June 2026)

This document is the v3 product boundary, but several early implementation
details below are historical. The live initial beta currently serves the
generated static directory from `company-brain-static` (nginx) through
`company-brain-cloudflared` to `https://brain.blcsops.com`. It does **not**
deploy `/dist` to Cloudflare Pages or Wrangler. The Cloudflare Tunnel routes
only to `company-brain-static:8080`; it does not route to
`company-brain-query:4317`, Postgres, `/ask`, React/Vite, Teams bot, or any
writeback surface.

The current beta safety gates are:

- `bun run static:check` validates generated static output.
- `infra/refresh-pipedrive-static.sh` restores the previous snapshot if pagegen
  or the static contract fails.
- CI runs `static:seed-fixtures`, `pagegen`, and `static:check` against a
  pgvector Postgres service so every v3 surface is generated before merge.

## 0. Thesis and core decision

Company Brain v1 is a read-only internal operating directory. It is not an agent. It is not a writeback platform. It is not a chat product. The team needs to look up customers, sales orders, invoices, vendors, items, and reps with source-backed freshness metadata, and a small number of power users need to run safe read-only SQL against the same store. That is the entire product.

The user's core decision, verbatim:

> Company Brain v1 is not an agent, not a Teams bot, not a writeback platform, and not an LLM /ask product. It is a read-only internal operating directory with three access modes:
> 1. Static generated HTML pages for normal team lookup
> 2. Static client-side search across generated records
> 3. Guarded read-only SQL endpoint for power users/admins

This v3 doc supersedes both HANDOFF_V2.md (which described a four-layer ingest/store/query/action platform) and HANDOFF_V2_1.md (which extended that into a 3-4 month action-service roadmap with Teams bot, Bot Framework, approval workflows, role tables, and Acumatica writeback). Neither describes what v1 will ship. HANDOFF_V2_1.md is preserved as `HANDOFF_V2_1.md`, historical only -- do not build against it. The Codex WIP files it coordinated around (`src/ask.ts`, `src/cli/answer-eval.ts`, `src/procurement/structure.ts`) are de-prioritized under v3, so the v2.1 "high-coordination zone" effectively dissolves.

What stays from prior work: the 15 connectors, the ingest pipeline, Postgres/gbrain, and the connector bug fixes already identified. What gets cut: the 17-commit React UI as the v1 surface, /ask, the eval suite as a shipping gate, and every action-layer artifact. v3 is a four-week build to a static site plus a guarded SQL endpoint, not a platform.

## 1. Architecture

Company Brain v3 is a small, boring system. Nothing in this section is novel; the novelty is what is deliberately absent.

### Components

The ingest side is unchanged from v2.1. The 15 existing connectors under `src/sources/` (Acumatica, Pipedrive, M365 mail/calendar/teams/sharepoint, supermemory, etc.) continue to run on a cron, normalize their payloads into gbrain's standard `{type: 'note', frontmatter, body}` shape, and write to the Postgres-backed gbrain store (`pages`, `content_chunks`, `raw_data`, `links`, `tags`, `ingest_log`). The schema lives in `node_modules/gbrain/src/schema.sql`; company-brain creates zero tables of its own.

What is new is downstream of the store and consists of exactly two services:

1. A **page generator** -- a Bun script that reads from Postgres, renders one HTML page per logical entity (customer, sales order, invoice, vendor, item, rep, deal, contact, activity), plus an index and `search-index.json`, into `/opt/company-brain/dist`. It runs after the scheduled Pipedrive refresh, is stateless, and produces a fully static directory. The beta serves that directory from the internal `company-brain-static` nginx container through Cloudflare Tunnel; there is no Cloudflare Pages/Wrangler deploy in the live path.
2. A **guarded SQL query service** -- implemented and kept private on the Docker network. It is not routed through Cloudflare Tunnel for the public beta. Normal team users only see the static site.

### Auth

Cloudflare Access sits in front of the public beta hostname. The identity provider is Entra (Microsoft Entra ID), the same tenant the M365 connectors already authenticate against, so users sign in with the work identity they already have. Access policies live at the Cloudflare zone level. The beta hostname routes only to the static site.

### Hosting

Everything server-side runs on the existing DigitalOcean droplet `jerry-data` (NYC1, Ubuntu 24.04, 8 GB / 160 GB at `142.93.196.10`), strictly isolated under the `/opt/company-brain/` namespace and the `company-brain` Docker Compose project. The droplet already hosts Jerry and Hermes; Company Brain shares the host but lives in a distinct directory tree, network, container namespace, and database (`company_brain`) so nothing it does can touch jerry-* or hermes-* services. The stack runs on a private `company-brain-net` bridge: `company-brain-postgres` (`pgvector/pgvector:pg16`, bind-mounted data under `/opt/company-brain/postgres-data/`), `company-brain-ingest`, `company-brain-query` (internal `:4317` only), `company-brain-static` (nginx serving `/opt/company-brain/dist`), and `company-brain-cloudflared` (official `cloudflare/cloudflared` image). A Cloudflare Tunnel exposes only `company-brain-static:8080`; the box publishes no host ports for Postgres, query, or static nginx. See `infra/README.md` for the full isolation contract, bring-up runbook, and day-2 operations.

### What is not there

No Hono `/ask` endpoint. No LLM query routing. No Microsoft Bot Framework, no Teams bot registration, no Adaptive Cards, no proactive messaging. No action service, no write adapters, no approval workflows, no role table, no ERP audit-log infrastructure. The existing `web/` React tree (17 commits) is deprecated as a v1 surface -- doctor/status concepts may be salvaged into a `/api/doctor` JSON shape consumed by the static page generator, but the SPA itself does not deploy. `src/ask.ts`, `src/cli/answer-eval.ts`, and `src/procurement/structure.ts` are de-prioritized; the eval suite is no longer a v1 shipping gate.

### Flow

```
connectors --> Postgres (gbrain pages/raw_data) --> page-generator --> /opt/company-brain/dist --> company-brain-static --> Cloudflare Tunnel + Access --> team

power user SQL path --> deferred/private; company-brain-query is not exposed in public beta
```

Both arrows terminating at Postgres hit the same database; the page generator uses the normal app role (read-only is sufficient for it too, but it shares the ingest role for simplicity), while the SQL service uses a separate role with `GRANT SELECT` only -- detailed in the Security section.

## 2. Static pages

Static pages are the daily browse surface. After every accepted ingest cycle, a page generator reads from `pages` and emits a fresh `/opt/company-brain/dist` tree. The internal nginx container serves that directory through Cloudflare Tunnel and Access. There is no app server, query service, LLM runtime, or writeback in the page path: the team hits a URL behind Cloudflare Access and Entra, and the browser gets pre-rendered HTML plus local client-side search.

### Entities that get pages

One page per record for each of:

| Entity | Path pattern | Source discriminator |
|--------|--------------|----------------------|
| Customer | `/customer/<id>.html` | `frontmatter->>'acumatica_kind' = 'customer'` |
| Sales order | `/order/<nbr>.html` | `frontmatter->>'acumatica_kind' = 'order'` |
| Invoice | `/invoice/<nbr>.html` | `frontmatter->>'acumatica_kind' = 'invoice'` |
| Vendor | `/vendor/<id>.html` | `frontmatter->>'acumatica_kind' = 'vendor'` |
| Item | `/item/<id>.html` | `frontmatter->>'acumatica_kind' = 'item'` |
| Rep | `/rep/<id>.html` | rep records joined from customer/order pages |
| Index | `/index.html` | the search landing page (see section 3) |

The generator runs as a Bun script after accepted refresh jobs. It writes the full `/opt/company-brain/dist` tree on every run; no incremental diffing in v1. `bun run static:check` validates the generated snapshot before the refresh script discards the previous backup.

### Required fields on every page

Every generated page MUST show:

- title/name
- entity ID
- source systems (the upstream feeds that contributed, e.g. Acumatica, Pipedrive)
- system of record (the authoritative one, e.g. Acumatica for invoices)
- last-refreshed UTC (from `pages.updated_at` or `metadata.upstream_updated_at` when present)
- key fields (parsed from the `- **FieldName**: value` bullets currently rendered into `compiled_truth` by `src/sources/acumatica.ts:41-52`)
- related records (orders for a customer, line items for an order, etc.)
- links to related pages (resolved via the gbrain `links` table and via foreign-key text in the bullets)
- source/citation metadata (the `source_uri` from frontmatter, e.g. `acumatica://invoice/INV-44021`)
- freshness warnings when upstream timestamp is missing or stale

The freshness warning fires when `metadata.upstream_updated_at` is absent (the generator must not silently substitute `now()`; this is the Week 2 freshness normalization work) or when the timestamp is older than the per-entity staleness threshold.

### Example: /customer/ACME001.html

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>ACME Corp (ACME001) - Company Brain</title>
  <link rel="stylesheet" href="/static/cb.css">
</head>
<body>
  <header>
    <a href="/index.html">Search</a> | <a href="/customer/">Customers</a>
  </header>

  <div class="freshness warn">
    Upstream timestamp missing for Pipedrive contact link.
    Acumatica refreshed: 2026-05-31 18:04 UTC (12 hours ago).
  </div>

  <h1>ACME Corp</h1>
  <p class="ids">
    Customer ID: <code>ACME001</code> |
    System of record: Acumatica |
    Also seen in: Pipedrive (deal pipeline)
  </p>

  <section>
    <h2>Key fields</h2>
    <table>
      <tr><th>CustomerID</th><td>ACME001</td></tr>
      <tr><th>CustomerName</th><td>ACME Corp</td></tr>
      <tr><th>CustomerClass</th><td>WHOLESALE</td></tr>
      <tr><th>Status</th><td>Active</td></tr>
      <tr><th>Terms</th><td>Net 30</td></tr>
      <tr><th>Rep</th><td><a href="/rep/JDOE.html">J. Doe</a></td></tr>
    </table>
  </section>

  <section>
    <h2>Related sales orders (last 12)</h2>
    <ul>
      <li><a href="/order/SO-10422.html">SO-10422</a> -- 2026-05-28 -- $4,210.00</li>
      <li><a href="/order/SO-10410.html">SO-10410</a> -- 2026-05-21 -- $1,895.50</li>
    </ul>
  </section>

  <section>
    <h2>Related invoices</h2>
    <ul>
      <li><a href="/invoice/INV-44021.html">INV-44021</a> -- Due 2026-06-15 -- $4,210.00 -- Open</li>
    </ul>
  </section>

  <section>
    <h2>Related contacts and deals (Pipedrive)</h2>
    <ul>
      <li>Jane Smith, AP Manager -- jane@acme.example</li>
      <li>Deal: 2026 Q3 Reorder -- $18,500 -- Negotiation</li>
    </ul>
  </section>

  <footer>
    <h3>Sources</h3>
    <ul>
      <li><code>acumatica://customer/ACME001</code> -- pulled 2026-05-31 18:04 UTC</li>
      <li><code>pipedrive://organization/5821</code> -- pulled 2026-05-31 17:58 UTC</li>
    </ul>
  </footer>
</body>
</html>
```

The generator walks the gbrain `links` table to fill "Related" sections, and emits the `source_uri` from `frontmatter` verbatim into the footer so every rendered fact is traceable to its upstream pull.

## 3. Static search

Static search is the lookup surface. The generator writes a single JSON index to `/dist/search-index.json` (with per-type split fallback, see below), and `/index.html` ships a client-side runtime that queries it in the browser. No server hop. No LLM involvement -- this is text search over a pre-built inverted index, not natural-language query routing.

### Schema per entry

```json
{
  "type": "customer | order | invoice | vendor | item | rep",
  "id": "string",
  "name": "string (display)",
  "aliases": ["string", "..."],
  "keywords": ["string", "..."],
  "url": "/customer/ACME001.html",
  "last_refreshed": "2026-05-31T18:04:00Z",
  "rels": {
    "rep": "JDOE",
    "customer": "ACME001",
    "entity": "FS",
    "order": "SO-10422",
    "invoice": "INV-44021",
    "vendor": null,
    "item": null
  }
}
```

`aliases` covers historical names and DBA variants; `keywords` is a flattened bag from the entity's bullets (city, terms, customer class). `rels` lets a search for `"JDOE"` return every customer, order, and invoice tied to that rep.

### Sample fragment

```json
[
  {
    "type": "customer",
    "id": "ACME001",
    "name": "ACME Corp",
    "aliases": ["ACME", "Acme Corporation"],
    "keywords": ["wholesale", "net 30", "active", "atlanta"],
    "url": "/customer/ACME001.html",
    "last_refreshed": "2026-05-31T18:04:00Z",
    "rels": {"rep": "JDOE", "customer": "ACME001", "entity": "FS"}
  },
  {
    "type": "order",
    "id": "SO-10422",
    "name": "SO-10422 -- ACME Corp -- $4,210.00",
    "aliases": [],
    "keywords": ["open", "shipped", "fastener"],
    "url": "/order/SO-10422.html",
    "last_refreshed": "2026-05-31T18:04:00Z",
    "rels": {"rep": "JDOE", "customer": "ACME001", "order": "SO-10422", "entity": "FS"}
  },
  {
    "type": "invoice",
    "id": "INV-44021",
    "name": "INV-44021 -- ACME Corp -- $4,210.00",
    "aliases": [],
    "keywords": ["open", "due 2026-06-15", "net 30"],
    "url": "/invoice/INV-44021.html",
    "last_refreshed": "2026-05-31T18:04:00Z",
    "rels": {"rep": "JDOE", "customer": "ACME001", "invoice": "INV-44021", "order": "SO-10422", "entity": "FS"}
  }
]
```

### Index size discipline

Target: under 5 MB even at 50,000 records. At ~100 bytes per entry that gives roughly 50 MB raw, so the generator strips long-form text from `keywords`, deduplicates aliases, and rounds timestamps to the minute. If the combined index crosses 5 MB, the generator splits per-type:

- `/dist/search-customers.json`
- `/dist/search-orders.json`
- `/dist/search-invoices.json`
- `/dist/search-vendors.json`
- `/dist/search-items.json`
- `/dist/search-reps.json`

`/index.html` then lazy-loads only the type the user filters to (default loads customers + reps eagerly, others on first keystroke matching the type prefix).

### Client-side runtime

Lunr.js or MiniSearch -- both ship around 20 KB gzipped and do the entire query in the browser. The build script runs the indexer at generation time and serializes the prebuilt index alongside the raw entries so the browser does not pay the index-build cost on every page load. There is no LLM in this path; "search" here means exact and prefix matching against `name`, `aliases`, `keywords`, and the values in `rels`.

### User flow

The team member opens `/index.html` (the same URL behind Cloudflare Access that gates everything else), types in the search box, and matching records render as a list with:

- a type badge (`customer`, `order`, `invoice`, `vendor`, `item`, `rep`)
- the display name
- the `last_refreshed` UTC timestamp
- a link to the static page

Click-through lands on the corresponding `/customer/<id>.html`, `/order/<nbr>.html`, etc. The page generator and the search index are produced by the same post-ingest pass, so both surfaces always reflect the same snapshot of `pages`.

## 4. SQL query endpoint

The SQL endpoint is the power-user surface. It is a deliberately small HTTP service that accepts a SELECT statement, runs it through a hardened read-only path against the same Postgres that backs gbrain, and returns tabular JSON. There is no LLM, no natural-language layer, no query rewriter. The caller writes SQL; the service runs it; the response is rows.

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | /query | Execute a single read-only SELECT |
| GET | /query/schema | Return table/column/JSONB-key catalog for discoverability |

Both routes sit behind the same Cloudflare Access policy that fronts the static site. There is no separate auth layer in the service itself. The service trusts the `CF-Access-Authenticated-User-Email` and `CF-Access-Jwt-Assertion` headers because Cloudflare Tunnel is the only ingress path to the `jerry-data` droplet for the company-brain stack; the service binds to its container network interface on `:4317`, the host does not publish that port, and the tunnel is the only path that reaches it.

### Request shape

POST /query accepts:

```json
{
  "sql": "SELECT id, slug, title FROM pages WHERE frontmatter->>'acumatica_kind' = 'invoice' ORDER BY updated_at DESC LIMIT 100",
  "rowLimit": 100,
  "timeoutMs": 5000
}
```

- `sql` is required. UTF-8. The service caps the stored log copy at 10 KB (see "Query log" below); the executed text is not truncated.
- `rowLimit` is optional. Default 100. Hard maximum 500. Requests above the cap are clamped, not rejected, and the response surfaces `truncated: true` when clamping or LIMIT trimming occurred.
- `timeoutMs` is optional. Default 5000. Hard maximum 30000. The service issues `SET LOCAL statement_timeout` with the requested value (clamped) before executing.

### Response shape -- success

```json
{
  "columns": [
    {"name": "id", "type": "int4"},
    {"name": "slug", "type": "text"},
    {"name": "title", "type": "text"}
  ],
  "rows": [
    [12431, "acumatica/customer/ACME-001", "Acme Fasteners"],
    [12432, "acumatica/customer/BOLT-014", "Bolt Co"]
  ],
  "rowCount": 2,
  "truncated": false,
  "executionMs": 137,
  "queryId": "q_01HVZ8K3R2X4Q9P0M2N5W7Y6T1"
}
```

`columns[].type` is the Postgres type name as reported by the driver (`int4`, `text`, `jsonb`, `timestamptz`, etc.) so a frontend can render numerics vs strings vs JSON correctly. `truncated` is true when either the row cap was hit or the caller's own LIMIT was lower than `rowCount` would have been; the UI surfaces this so power users know to widen `rowLimit` or refine the WHERE clause.

### Response shape -- failure

```json
{
  "error": "permission denied for table customers",
  "errorClass": "permission_denied",
  "queryId": "q_01HVZ8K3R2X4Q9P0M2N5W7Y6T1"
}
```

`errorClass` is one of `syntax_error`, `permission_denied`, `timeout`, `write_attempted`, `row_limit_exceeded`. The service maps Postgres SQLSTATEs into these buckets (`42601` -> `syntax_error`, `42501` -> `permission_denied`, `57014` -> `timeout`, `25006` -> `write_attempted` for "read-only transaction"). `row_limit_exceeded` is reserved for the rare case where the response-shaping layer must reject a query that would have returned more than the hard cap before LIMIT could be injected. Every error response carries the same `queryId` that was written to the query log, so a user can paste it into a support ticket and the operator can find the exact row.

### Query log

The user spec defines the log fields verbatim: query text, user identity from Cloudflare Access headers (`CF-Access-Authenticated-User-Email`), timestamp, duration, row count, success/failure flag, and `errorClass` when the call failed. The log lives in a small Postgres table named `query_log` on the same database the SQL endpoint queries:

```sql
CREATE TABLE IF NOT EXISTS query_log (
  query_id    TEXT PRIMARY KEY,
  user_email  TEXT NOT NULL,
  sql_text    TEXT NOT NULL,
  row_limit   INTEGER NOT NULL,
  timeout_ms  INTEGER NOT NULL,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms INTEGER,
  row_count   INTEGER,
  success     BOOLEAN NOT NULL,
  error_class TEXT,
  error_msg   TEXT
);
CREATE INDEX query_log_user_started_idx ON query_log (user_email, started_at DESC);
CREATE INDEX query_log_started_idx      ON query_log (started_at DESC);
```

This is an operational usage log, NOT an ERP audit log. Use it to find who ran what; do not treat it as a compliance trail. There is no chain-of-custody, no signed timestamps, no immutable storage. If a finance auditor needs evidence of who changed an invoice in Acumatica, the answer is "go look in Acumatica" -- the SQL endpoint cannot change an invoice, so this log is about service usage, not source-of-record history.

Logging discipline matters precisely because the log is best-effort:

- Log every call, including permission-denied and timeout. A denied call is the most interesting signal in the log; it tells the operator someone is reaching for a table the read-only user cannot see, which is either a discoverability gap or a misuse worth a conversation.
- Cap `sql_text` at 10 KB before insert. A pathological 5 MB SELECT, paste of a wrong file, or a generated query with thousands of inlined values should not blow up the log table or its indexes. The cap is enforced in code before the INSERT, not by the column type, so the truncation is explicit and auditable.
- The log row is written from the service's own connection pool (the WRITE-capable connection used only for this table), not from the read-only transaction that ran the user's query. The two pools never mix; see section 5.

## 5. Security: layered guardrails

The single most important guardrail is what we do not rely on. A substring or prefix check like "the query starts with SELECT" is not a security boundary. The string

```sql
SELECT 1; DROP TABLE customers;
```

passes a "starts with SELECT" test and Postgres will execute both statements when the client uses a multi-statement protocol. The same is true of comment tricks, CTE-wrapped writes (`WITH x AS (DELETE FROM ... RETURNING *) SELECT * FROM x`), and a dozen other patterns. Treating string inspection as the boundary is how you ship a SQL injection vector with a friendly UI.

The actual layered guardrails, in order, are:

### Layer 1: Dedicated read-only Postgres user with SELECT-only grants

```sql
CREATE USER brain_ro WITH PASSWORD '<from secrets manager>';
GRANT CONNECT ON DATABASE company_brain TO brain_ro;
GRANT USAGE ON SCHEMA public TO brain_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO brain_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO brain_ro;
REVOKE CREATE ON SCHEMA public FROM brain_ro;
```

This user has no INSERT, UPDATE, DELETE, TRUNCATE, CREATE, or DROP privileges on any table, present or future. Postgres enforces this at the role level. There is no SQL string that grants those privileges back inside a session.

### Layer 2: Read-only transaction wrapping

Every call from the SQL endpoint executes as:

```sql
BEGIN;
SET TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '5s';
<user query>;
COMMIT;
```

`SET TRANSACTION READ ONLY` causes Postgres to refuse INSERT, UPDATE, DELETE, TRUNCATE, COPY FROM, and any DDL with SQLSTATE `25006` ("cannot execute ... in a read-only transaction") regardless of what the query string looks like. This catches the second-statement-in-a-batch attack at the database level: even if a clever input reaches Postgres with a write piggybacked on it, the transaction refuses the write.

### Layer 3: statement_timeout

`SET LOCAL statement_timeout` is set per call from the request's `timeoutMs` (default 5000, clamped to 30000). A runaway query is aborted by Postgres with SQLSTATE `57014`, mapped to `errorClass: "timeout"` in the response. The hard 30 s cap exists so a power user investigating a slow report cannot pin a connection forever.

### Layer 4: Row cap at the response-shaping layer

The service injects `LIMIT N` into the executed plan via the driver (cursor with `FETCH FORWARD N`), defaulting to 100 and capped at 500. This is enforced even when the user's SQL already contains LIMIT; the service takes the minimum of the two. A query that would return 50000 rows is cut off at 500 with `truncated: true`. This is a defense against accidental memory blowups, not against malicious queries -- but it is the difference between a frontend stutter and a Node process OOM.

### Layer 5: Parser/regex check (UX only, NOT security)

Before issuing the transaction, the service runs a lightweight regex check that looks for top-level INSERT, UPDATE, DELETE, DROP, TRUNCATE, ALTER, CREATE, GRANT, REVOKE, COPY, CALL, and DO. When it matches, the service returns a friendly 400 with `errorClass: "write_attempted"` and a message like "this endpoint only runs SELECT statements; use Acumatica or the appropriate system to make changes." This exists for error message quality, not for security. A user who writes `select * from pages where 1=1; update pages set title='x'` gets a useful error instead of a generic "permission denied" from Postgres. If the regex misses something -- and at some point it will -- layers 1 and 2 still refuse the write.

### Failure mode

If the parser is bypassed and someone sends a write through, the database itself rejects it. The connection runs as `brain_ro` (no write grants) inside a transaction that is `READ ONLY` (no writes allowed regardless of grants). The worst observable outcome is `{"error": "...", "errorClass": "permission_denied" | "write_attempted", "queryId": "..."}` and a log row marked `success: false`. The query did not run; the database did not change; the only side effect is one row in `query_log`. That is the right failure mode for an internal tool.

### Connection hygiene

gbrain's existing ingestion uses a WRITE-capable Postgres user (the same role that runs `schema.sql` and that all 15 connectors INSERT through). The SQL service uses the new `brain_ro` user. The two credentials live in separate environment variables (`DATABASE_URL` for the ingest path, `QUERY_DATABASE_URL` for the SQL endpoint) and are loaded into separate connection pools. Audit the code paths that touch Postgres to make sure the two pools are never mixed: the ingestion pool must never serve a `/query` request, and the read-only pool must never serve an ingest. The single exception is the `query_log` table itself, which is written from a dedicated narrow pool that has INSERT on `query_log` and nothing else -- not from `brain_ro` (which has no write grants) and not from the ingest pool (which should not know about the SQL endpoint at all).

## 6. Schema discoverability

The SQL endpoint ships a companion route, `GET /query/schema`, that returns a JSON description of what is actually queryable. Power users hit this once to orient, then write SQL against `/query`. The shape is designed for human reading, not for code generation.

Return shape:

```json
{
  "generated_at": "2026-06-01T12:00:00Z",
  "database": "company_brain",
  "tables": [
    {
      "name": "pages",
      "purpose": "One row per logical document. Every business record (customer, order, invoice, item, vendor) lives here.",
      "primary_key": ["id"],
      "columns": [
        {"name": "id",            "type": "integer",     "note": "serial PK"},
        {"name": "source_id",     "type": "text",        "note": "FK sources.id, e.g. 'default'"},
        {"name": "slug",          "type": "text"},
        {"name": "type",          "type": "text",        "note": "always 'note' for ingested business records"},
        {"name": "page_kind",     "type": "text",        "note": "'markdown' | 'code' | 'image'"},
        {"name": "title",         "type": "text"},
        {"name": "compiled_truth","type": "text",        "note": "rendered markdown body; structured business fields live here as '- **FieldName**: value' bullets"},
        {"name": "frontmatter",   "type": "jsonb",       "note": "see frontmatter_keys below"},
        {"name": "effective_date","type": "timestamptz"},
        {"name": "created_at",    "type": "timestamptz", "freshness": true},
        {"name": "updated_at",    "type": "timestamptz", "freshness": true},
        {"name": "last_retrieved_at","type": "timestamptz","freshness": true},
        {"name": "deleted_at",    "type": "timestamptz", "note": "soft delete; always filter `deleted_at IS NULL`"},
        {"name": "search_vector", "type": "tsvector",    "note": "use with @@ to_tsquery('english', ...)"}
      ],
      "common_joins": [
        {"to": "raw_data",        "on": "raw_data.page_id = pages.id"},
        {"to": "tags",            "on": "tags.page_id = pages.id"},
        {"to": "links",           "on": "links.from_page_id = pages.id"},
        {"to": "timeline_entries","on": "timeline_entries.page_id = pages.id"}
      ],
      "frontmatter_keys": {
        "acumatica.customer": ["title","acumatica_id","acumatica_kind","source_uri","source_kind","updated_at"],
        "acumatica.order":    ["title","acumatica_id","acumatica_kind","source_uri","source_kind","updated_at"],
        "acumatica.invoice":  ["title","acumatica_id","acumatica_kind","source_uri","source_kind","updated_at"],
        "acumatica.item":     ["title","acumatica_id","acumatica_kind","source_uri","source_kind","updated_at"],
        "pipedrive.*":        ["title","source_uri","source_kind","updated_at"],
        "m365.*":             ["title","source_uri","source_kind","updated_at"]
      },
      "discriminator": "frontmatter->>'acumatica_kind' in ('customer','order','invoice','item')",
      "source_system_fields": {
        "source_kind": "frontmatter->>'source_kind'",
        "source_uri":  "frontmatter->>'source_uri'",
        "entity_id":   "frontmatter->>'acumatica_id'"
      }
    },
    {
      "name": "raw_data",
      "purpose": "Sidecar JSONB per (page, upstream source).",
      "primary_key": ["page_id","source"],
      "columns": [
        {"name": "page_id",  "type": "integer", "note": "FK pages.id"},
        {"name": "source",   "type": "text",    "note": "e.g. 'acumatica', 'pipedrive'"},
        {"name": "data",     "type": "jsonb"},
        {"name": "fetched_at","type": "timestamptz","freshness": true}
      ],
      "common_joins": [{"to": "pages", "on": "page_id"}]
    },
    {
      "name": "sources",
      "purpose": "Tenant partitions.",
      "primary_key": ["id"],
      "columns": [
        {"name": "id",        "type": "text"},
        {"name": "name",      "type": "text"},
        {"name": "archived",  "type": "boolean"}
      ]
    },
    {"name": "tags",            "primary_key": ["page_id","tag"]},
    {"name": "links",           "primary_key": ["from_page_id","to_page_id","link_type"]},
    {"name": "timeline_entries","primary_key": ["page_id","date","summary"]},
    {"name": "ingest_log",      "freshness_field": "created_at"}
  ],
  "notes": [
    "Structured business fields (CustomerID, Amount, DueDate) are NOT first-class columns. They are rendered as '- **FieldName**: value' bullets inside pages.compiled_truth. Typed comparisons require regex extraction or a materialized view.",
    "pages.type is always 'note' for ingested business records. The real discriminator is frontmatter->>'acumatica_kind' (or analogous source_kind for non-Acumatica connectors).",
    "Freshness fields: pages.updated_at (set on ingest), pages.last_retrieved_at, raw_data.fetched_at. Stale rows have updated_at < now() - interval '24 hours'."
  ]
}
```

The implementation is a single TypeScript module that returns a static, hand-written JSON tree (committed at `src/query/schema.ts`). It is not introspected from `information_schema` because the useful structure (the JSONB key conventions, which fields are freshness markers, the `acumatica_kind` discriminator) is not visible to `pg_catalog`.

Implication, confirmed by Phase 1 verification: gbrain's `pages` table is the only place business records live, and Acumatica's ingestion path at `C:\Users\timcl\code\company-brain\src\sources\acumatica.ts` (lines 54-108) emits a single `type: note` markdown page per entity with structured fields rendered as body bullets, not JSONB keys. That means `SELECT amount, due_date FROM invoices WHERE due_date < now()` has no clean translation today. Several of the queries in the library below (overdue invoices, AR aging, margin by customer, items below reorder point, inventory by item/vendor) require either regex extraction from `compiled_truth` or per-entity materialized views (`mv_invoices`, `mv_customers`, `mv_orders`, `mv_items`) that project `raw_data.data->>'FieldName'` into typed columns. The materialized-view layer is out of scope for v1 ingest changes, but the sample queries call it out by name so power users know what is and is not currently typed.

## 7. Sample query library

Fifteen queries ship on the `/query` page as click-to-load templates. Each is honest about the current `pages + frontmatter JSONB + compiled_truth TEXT` shape. Queries needing a materialized view are flagged; the SQL is written against the proposed view name so the template stays stable once the view exists.

1. Top overdue invoices over a threshold. Lists invoices past due over $5,000.

```sql
SELECT id, slug, title,
       substring(compiled_truth from '\*\*DueDate\*\*:\s*([0-9-]+)')::date  AS due_date,
       substring(compiled_truth from '\*\*Amount\*\*:\s*([0-9.]+)')::numeric AS amount
FROM pages
WHERE deleted_at IS NULL
  AND frontmatter->>'acumatica_kind' = 'invoice'
  AND (substring(compiled_truth from '\*\*Amount\*\*:\s*([0-9.]+)'))::numeric > 5000
  AND (substring(compiled_truth from '\*\*DueDate\*\*:\s*([0-9-]+)'))::date < now()
ORDER BY due_date ASC
LIMIT 100;
```

Needs materialized view `mv_invoices(page_id, customer_id, amount, due_date, balance, entity)` for safe typed comparison. Regex form works but is unindexed and brittle.

2. Open AR by entity. Sums outstanding invoice balances grouped by source entity (FS, BLCS, etc).

```sql
SELECT frontmatter->>'entity' AS entity,
       SUM((substring(compiled_truth from '\*\*Balance\*\*:\s*([0-9.]+)'))::numeric) AS open_ar
FROM pages
WHERE deleted_at IS NULL
  AND frontmatter->>'acumatica_kind' = 'invoice'
GROUP BY frontmatter->>'entity'
ORDER BY open_ar DESC;
```

Needs materialized view `mv_invoices`; also needs `entity` propagated into frontmatter (not currently emitted by `acumatica.ts`).

3. Open AR by customer. Same as above grouped by CustomerID.

```sql
SELECT substring(compiled_truth from '\*\*CustomerID\*\*:\s*([^\n]+)') AS customer_id,
       SUM((substring(compiled_truth from '\*\*Balance\*\*:\s*([0-9.]+)'))::numeric) AS open_ar
FROM pages
WHERE deleted_at IS NULL
  AND frontmatter->>'acumatica_kind' = 'invoice'
GROUP BY 1
ORDER BY open_ar DESC
LIMIT 100;
```

Needs materialized view `mv_invoices`.

4. Customers added this month.

```sql
SELECT id, slug, title, created_at
FROM pages
WHERE deleted_at IS NULL
  AND frontmatter->>'acumatica_kind' = 'customer'
  AND created_at >= date_trunc('month', now())
ORDER BY created_at DESC
LIMIT 100;
```

Works as-is.

5. Orders stuck over X days. Orders whose `updated_at` is older than 14 days and which are not closed.

```sql
SELECT id, slug, title, updated_at,
       substring(compiled_truth from '\*\*Status\*\*:\s*([^\n]+)') AS status
FROM pages
WHERE deleted_at IS NULL
  AND frontmatter->>'acumatica_kind' = 'order'
  AND updated_at < now() - interval '14 days'
  AND substring(compiled_truth from '\*\*Status\*\*:\s*([^\n]+)') NOT ILIKE '%closed%'
ORDER BY updated_at ASC
LIMIT 100;
```

Status is regex-extracted; materialized view `mv_orders` recommended.

6. Items below reorder point.

```sql
SELECT id, slug, title,
       (substring(compiled_truth from '\*\*QtyOnHand\*\*:\s*([0-9.]+)'))::numeric AS qty_on_hand,
       (substring(compiled_truth from '\*\*ReorderPoint\*\*:\s*([0-9.]+)'))::numeric AS reorder_point
FROM pages
WHERE deleted_at IS NULL
  AND frontmatter->>'acumatica_kind' = 'item'
  AND (substring(compiled_truth from '\*\*QtyOnHand\*\*:\s*([0-9.]+)'))::numeric
    < (substring(compiled_truth from '\*\*ReorderPoint\*\*:\s*([0-9.]+)'))::numeric
LIMIT 100;
```

Needs materialized view `mv_items(page_id, item_id, qty_on_hand, reorder_point, vendor_id)`.

7. Sales by rep. Sums invoice amounts grouped by sales rep.

```sql
SELECT substring(compiled_truth from '\*\*SalesPersonID\*\*:\s*([^\n]+)') AS rep,
       SUM((substring(compiled_truth from '\*\*Amount\*\*:\s*([0-9.]+)'))::numeric) AS total_sales
FROM pages
WHERE deleted_at IS NULL
  AND frontmatter->>'acumatica_kind' = 'invoice'
  AND created_at >= date_trunc('month', now()) - interval '3 months'
GROUP BY 1
ORDER BY total_sales DESC NULLS LAST;
```

Needs materialized view `mv_invoices`.

8. Margin by customer if available.

```sql
SELECT substring(compiled_truth from '\*\*CustomerID\*\*:\s*([^\n]+)') AS customer_id,
       SUM((substring(compiled_truth from '\*\*Amount\*\*:\s*([0-9.]+)'))::numeric)
       - SUM((substring(compiled_truth from '\*\*Cost\*\*:\s*([0-9.]+)'))::numeric) AS margin
FROM pages
WHERE deleted_at IS NULL
  AND frontmatter->>'acumatica_kind' = 'invoice'
GROUP BY 1
ORDER BY margin DESC NULLS LAST
LIMIT 100;
```

Needs materialized view `mv_invoices` with a `cost` column; `Cost` is not currently rendered by `acumatica.ts:54-108`, so ingestion change required.

9. Vendor spend. Sums AP bill amounts by vendor over the trailing 90 days.

```sql
SELECT substring(compiled_truth from '\*\*VendorID\*\*:\s*([^\n]+)') AS vendor_id,
       SUM((substring(compiled_truth from '\*\*Amount\*\*:\s*([0-9.]+)'))::numeric) AS spend_90d
FROM pages
WHERE deleted_at IS NULL
  AND frontmatter->>'acumatica_kind' = 'bill'
  AND updated_at >= now() - interval '90 days'
GROUP BY 1
ORDER BY spend_90d DESC NULLS LAST
LIMIT 100;
```

Needs materialized view `mv_bills`; the `bill` discriminator is not currently emitted (Acumatica ingestion covers customer/order/invoice/item only), so ingestion change required.

10. Stale customer activity. Customers with no related order or invoice page updated in the last 90 days.

```sql
SELECT c.id, c.slug, c.title, c.updated_at AS customer_updated,
       MAX(o.updated_at) AS last_related_activity
FROM pages c
LEFT JOIN links l ON l.to_page_id = c.id
LEFT JOIN pages o ON o.id = l.from_page_id
                 AND o.frontmatter->>'acumatica_kind' IN ('order','invoice')
WHERE c.deleted_at IS NULL
  AND c.frontmatter->>'acumatica_kind' = 'customer'
GROUP BY c.id, c.slug, c.title, c.updated_at
HAVING MAX(o.updated_at) IS NULL
    OR MAX(o.updated_at) < now() - interval '90 days'
ORDER BY last_related_activity ASC NULLS FIRST
LIMIT 100;
```

Depends on `links` being populated between customers and their orders/invoices. Gbrain's links table exists; population depends on the ingestion writing `source_uri` references that gbrain resolves into `links` rows.

11. Recent orders by customer.

```sql
SELECT id, slug, title, updated_at,
       substring(compiled_truth from '\*\*CustomerID\*\*:\s*([^\n]+)') AS customer_id
FROM pages
WHERE deleted_at IS NULL
  AND frontmatter->>'acumatica_kind' = 'order'
  AND substring(compiled_truth from '\*\*CustomerID\*\*:\s*([^\n]+)') = 'AC001234'
ORDER BY updated_at DESC
LIMIT 50;
```

Works as a template; users edit the `CustomerID` literal. Materialized view `mv_orders` would make this indexable.

12. Invoices by aging bucket.

```sql
SELECT
  CASE
    WHEN due < now() - interval '90 days' THEN '90+'
    WHEN due < now() - interval '60 days' THEN '61-90'
    WHEN due < now() - interval '30 days' THEN '31-60'
    WHEN due < now()                       THEN '1-30'
    ELSE 'current'
  END AS bucket,
  COUNT(*) AS invoice_count,
  SUM(amt) AS total
FROM (
  SELECT (substring(compiled_truth from '\*\*DueDate\*\*:\s*([0-9-]+)'))::date  AS due,
         (substring(compiled_truth from '\*\*Amount\*\*:\s*([0-9.]+)'))::numeric AS amt
  FROM pages
  WHERE deleted_at IS NULL AND frontmatter->>'acumatica_kind' = 'invoice'
) s
GROUP BY 1
ORDER BY 1;
```

Needs materialized view `mv_invoices`.

13. Inventory by item/vendor.

```sql
SELECT substring(compiled_truth from '\*\*VendorID\*\*:\s*([^\n]+)') AS vendor_id,
       id, slug, title,
       (substring(compiled_truth from '\*\*QtyOnHand\*\*:\s*([0-9.]+)'))::numeric AS qty_on_hand
FROM pages
WHERE deleted_at IS NULL
  AND frontmatter->>'acumatica_kind' = 'item'
ORDER BY vendor_id NULLS LAST, qty_on_hand DESC
LIMIT 200;
```

Needs materialized view `mv_items` for typed `qty_on_hand`.

14. Customers with no activity in X days. Trailing 60-day window.

```sql
SELECT id, slug, title, updated_at
FROM pages
WHERE deleted_at IS NULL
  AND frontmatter->>'acumatica_kind' = 'customer'
  AND updated_at < now() - interval '60 days'
ORDER BY updated_at ASC
LIMIT 100;
```

Works as-is. Uses the `idx_pages_updated_at_desc` index in reverse scan.

15. Records missing upstream refreshed timestamp.

```sql
SELECT p.id, p.slug, p.title, p.frontmatter->>'acumatica_kind' AS kind,
       p.updated_at, rd.fetched_at
FROM pages p
LEFT JOIN raw_data rd ON rd.page_id = p.id
WHERE p.deleted_at IS NULL
  AND p.frontmatter->>'source_kind' = 'acumatica'
  AND (rd.fetched_at IS NULL OR p.frontmatter->>'updated_at' IS NULL)
ORDER BY p.updated_at DESC
LIMIT 100;
```

Works as-is and is the canonical freshness-gap query for the Week 2 normalization work.

## 8. Non-goals

These are the lines the v3 build will not cross. Treat scope creep toward any of these items as a regression. If a PR, issue, or design note proposes any of the items below, it belongs in a separate post-v1 conversation, not in this codebase.

- No /ask in v1
- No LLM query generation in v1
- No Teams bot
- No Microsoft Bot Framework
- No writeback
- No action approvals
- No Acumatica mutation
- No app-level RBAC unless later proven necessary
- No ERP audit-log infrastructure
- No 3-4 month platform roadmap

## 9. Existing work disposition

The v1 build inherits a working ingest backbone and discards an unfinished read surface. Nothing on disk gets deleted; the React tree and Codex WIP files stay in git history and on `main` for reference, but only the items below carry forward.

| Item (verbatim) | What to actually do |
|---|---|
| Keep all 15 connectors and ingest pipeline. | `src/sources/*` and `src/ingest/run.ts` are the production path; v3 reads what they write into `pages`. No connector rewrites, no new sources, no schema changes to `pages`. Daily full snapshots via cron (see Week 1) are the v3 refresh model; Phase 0C delta-sync from v2.1 is explicitly NOT in scope for v3. |
| Keep Postgres/gbrain. | gbrain v0.42-ish schema in `node_modules/gbrain/src/schema.sql` is the system of record. The SQL endpoint queries `pages`, `content_chunks`, `raw_data`, `links`, `tags`, `ingest_log` directly. No new app-owned tables in v1 (`grep CREATE TABLE src/` returns zero -- keep it that way). |
| Keep connector bug fixes already identified. | Specifically the silent `now()` fallbacks at `src/sources/acumatica/client.ts:207` and `src/sources/m365/graph.ts:276` -- these are the Week 2 freshness-normalization work, not optional. |
| Deprecate the 17-commit React UI as v1 surface. | The `web/` tree stays in git history; do not deploy it; do not iterate on `App.tsx`; salvage the doctor/status surface ideas only. The static generator in Week 2 is greenfield output into `/dist`, not a port of `web/`. |
| Salvage doctor/status ideas only. | Reuse the per-connector "last successful run / last failure / row counts" panel concept for the Week 4 connector-health surface. Do not reuse the React components themselves. |
| Keep `/api/doctor` JSON shape if useful for connector health. | The response shape (per-source `{ ok, lastRunAt, lastError, rowCount }`) is a fine contract for the Week 4 health page to consume. Re-implement it as a small read-only handler against `ingest_log`; do not revive the surrounding Express/React stack. |
| De-prioritize `/ask`, `ask.ts`, `answer-eval.ts`, and action/procurement work. | `src/ask.ts`, `src/cli/answer-eval.ts`, `src/procurement/*` are frozen on `main`. No edits, no deploys, no CI. The Codex high-coordination zone from v2.1 effectively dissolves because no v3 work touches those files. |
| Eval suite is no longer a v1 shipping gate because `/ask` is not in scope. | `eval_candidates` / `eval_takes_quality_runs` / `eval_contradictions_*` tables remain in gbrain but are not run, not graded, not blocking. Shipping criteria for v3 are the success conditions in section 11, not eval pass rates. |

## 10. Phasing

Four weeks, sequential. Each week has one shippable artifact. Phase 0C delta-sync from v2.1 is NOT part of this plan -- for v3, daily full snapshots from the `company-brain-ingest` cron container are fine and the freshness story is "last ingest_log row per source", not incremental watermarks.

### Week 1 -- Move ingest off the laptop

- **Work.** Use the existing DigitalOcean droplet `jerry-data` (`142.93.196.10`, NYC1, Ubuntu 24.04, 8 GB / 160 GB). Run `infra/bootstrap.sh` on the box; it creates `/opt/company-brain/{repo,dist,logs,backups,state,postgres-data,cloudflared,infra}` with the right permissions, detects/installs Docker if absent, clones the repo, and validates `docker-compose.yml`. Populate `/opt/company-brain/infra/.env` from `infra/.env.example` (generate Postgres role passwords with `openssl rand -hex 32`). Stand up Cloudflare Tunnel from the box to `brain.<your-domain>` per `infra/cloudflared/config.example.yml`. Put Cloudflare Access (Entra IdP) in front of the hostname with an allow-list of company emails. `docker compose up -d` brings up the four `company-brain-*` services (postgres, ingest, query, cloudflared) on the `company-brain-net` network; the `company-brain-ingest` container runs `src/scheduler/index.ts` which already has node-cron scheduling (full ingest daily, doctor refresh hourly).
- **Gate.** `systemctl list-timers` shows the ingest timer green; `ingest_log` has at least two consecutive successful daily rows written from the box (not the laptop); hitting `https://brain.internal.<domain>/healthz` from a browser triggers Entra SSO and returns 200; the laptop cron is disabled.
- **Rollback.** `docker compose down` from `/opt/company-brain/repo/infra/` stops only the company-brain-* services on jerry-data; Jerry and Hermes are untouched. The laptop cron can be re-enabled (`schtasks /change /tn company-brain-ingest /enable`) for transitional runs. Postgres data on the droplet survives `docker compose down` because it lives on a bind mount at `/opt/company-brain/postgres-data/`.
- **Training/handoff.** Tim: SSH key + `sudo journalctl -u company-brain-ingest`. Ops contact: Cloudflare Access dashboard login, how to add/remove an email from the allow-list. One-page runbook stub in `docs/runbook.md`.

### Week 2 -- Freshness + static site

- **Work.** Fix `src/sources/acumatica/client.ts:207` and `src/sources/m365/graph.ts:276`: replace silent `now()` fallbacks with the upstream-provided timestamp; when the upstream genuinely has none, write `null` to `metadata.upstream_updated_at` and set a `freshness_unknown` flag so the page can render a warning. Build `src/page-gen/` -- a Bun script that reads `pages`, renders one HTML file per record into `/opt/company-brain/dist/<type>/<id>.html`, plus index pages per type. Emit `/opt/company-brain/dist/search-index.json` and `/opt/company-brain/dist/build-meta.json`. Serve `/opt/company-brain/dist` through `company-brain-static` and Cloudflare Tunnel.
- **Gate.** `https://brain.blcsops.com` behind Access serves a customer page, an invoice page, and a search page that finds known records by name and ID. `bun run static:check --dist=/app/dist --min-search-entries=1 --expect-build-commit` passes through the compose service path. Pages with missing upstream timestamps render the freshness state. Generator run time stays under 5 minutes on the current corpus.
- **Rollback.** `infra/refresh-pipedrive-static.sh` copies the prior `dist` snapshot before pagegen and restores it if pagegen or `static:check` fails. Static nginx is restarted only after the generated snapshot passes.
- **Training/handoff.** Team-wide email: "the new directory lives at `https://brain.blcsops.com`, sign in with your work account, this is read-only, refreshes every 4 hours". Tim: how to trigger a manual regen via the Docker Compose commands in `README.md`.

### Week 3 -- Guarded SQL endpoint

- **Work.** Create the dedicated PG role: `CREATE ROLE brain_ro LOGIN PASSWORD '...'; GRANT CONNECT ON DATABASE company_brain TO brain_ro; GRANT USAGE ON SCHEMA public TO brain_ro; GRANT SELECT ON ALL TABLES IN SCHEMA public TO brain_ro; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO brain_ro;`. Build `src/query/server.ts` (Bun.serve) on the Hetzner box behind the same Cloudflare Tunnel: `POST /query` accepts `{ sql }`, opens a connection as `brain_ro`, runs `BEGIN; SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = '5s'; <sql> LIMIT <min(requested,500)>; COMMIT;`, captures `cf-access-authenticated-user-email` into the query log row (`{ ts, email, sql, duration_ms, rows, ok, error }`). Implement `GET /query/schema` returning `pages` columns, observed `frontmatter` keys per `acumatica_kind` (computed at startup via a one-shot scan), the "structured fields live as markdown bullets in `compiled_truth`" note, and the regex-extraction recipe. Ship the canonical query library as a static JSON the query page renders as clickable cards (the 15 queries from section 7, written against the real schema -- frontmatter JSONB filters plus the regex/tsquery fallback for invoice amount/due-date).
- **Gate.** A power user signs in via Access, runs "customers added this month" and gets rows back; running `DROP TABLE pages;` returns a permission-denied error from Postgres (not from the regex prefilter); a deliberately slow query hits the 5s timeout; `query_log` has one row per attempt with the Access email populated.
- **Rollback.** Disable the `/query` route in nginx/Caddy (or stop the systemd unit); the static site is unaffected. Revoke `brain_ro` (`DROP OWNED BY brain_ro; DROP ROLE brain_ro;`) if the credential is suspected compromised.
- **Training/handoff.** One-hour session with the 3-5 power users: how Access SSO works, the read-only contract, the sample queries, where the schema page lives, the "this is an operational usage log, not an ERP audit log" framing. Tim: `tail -f /var/log/company-brain/query.log` and the `query_log` table.

### Week 4 -- Docs, runbook, health, feedback

- **Work.** Finalize `docs/runbook.md` (cron schedule, how to rotate creds, how to add an Access user, how to redeploy the static site, how to roll back the SQL endpoint, where the read-only role lives). Build the connector-health surface as a static page at `/dist/health.html` driven by `ingest_log` queries (per-source last run, last error, row count, freshness lag) -- reusing the `/api/doctor` JSON shape conceptually but rendered statically. Triage the small-team feedback collected in Weeks 2 and 3: missing fields on specific page types, search ranking misses, sample-query bugs. No new features beyond what the team explicitly asked for.
- **Gate.** Runbook reviewed by one other engineer who can follow it cold to rotate the `brain_ro` password. Health page green for all 15 connectors for 3 consecutive days. Feedback backlog has zero P0/P1 items.
- **Rollback.** Documentation-only week; nothing to roll back except specific feedback fixes, which are individually revertable via `git revert`.
- **Training/handoff.** Send the runbook link to Tim's backup. Archive `HANDOFF_V2.md` and `HANDOFF_V2_1.md` under `docs/historical/`; `HANDOFF_V3.md` becomes the canonical reference at the repo root.

## 11. Success condition

This is the test for whether v1 is done. If both of these statements are true against the deployed `/dist` and the SQL endpoint, v3 has shipped. If either is false, v3 has not shipped, regardless of how many connectors are green or how much code has landed.

> A normal team member can open one internal URL, search for a customer/order/invoice/item/vendor/rep, and see fresh, source-backed operational information.
>
> A power user can safely run read-only SQL against company brain data without risking source systems, Acumatica, accounting records, or ERP integrity.

Concretely: a rep opens the internal URL behind Cloudflare Access, types a customer name into the static search box (served from `/dist/search-index.json` via Lunr or equivalent), clicks through to the generated customer page, and sees entity ID, source system, system of record, last-refreshed UTC, key fields, related orders/invoices, and source citations. Separately, an admin opens `/query`, pastes `SELECT id, slug, title, updated_at FROM pages WHERE frontmatter->>'acumatica_kind' = 'invoice' ORDER BY updated_at DESC LIMIT 50;`, gets a 100-row tabular result back in under five seconds, and has zero ability to mutate Acumatica, the accounting ledger, or any upstream ERP from that surface -- because the DB role is SELECT-only and the transaction is `READ ONLY`.

Anything beyond this -- /ask, Teams, actions -- is explicitly out of v1 scope (see Section 8 Non-goals).

## 12. What another model needs to know

Short trailer for any future model picking this up.

- v3 is canonical. v2 and v2.1 are preserved at `C:\Users\timcl\code\company-brain\HANDOFF_V2.md` and `HANDOFF_V2_1.md` but are historical; do not build against them.
- Three access modes: static pages, static search, guarded SQL. That is the whole product surface. No fourth mode.
- The eval suite (89/2/91) is no longer a v1 shipping gate. Keep it green if convenient; do not treat it as load-bearing for v3.
- Codex's WIP files (`src/ask.ts`, `src/cli/answer-eval.ts`, `src/procurement/structure.ts`) are de-prioritized. v3 does not edit or depend on them. Leave them in place; do not refactor them into v3 paths.
- All connector code, Postgres, and gbrain remain. The fragility surface shrinks to four things: cron, Postgres, the page generator, the SQL service. If something breaks in v1, it is one of those four.
- Where to start: `src/sources/registry.ts` for the connector list, `node_modules/gbrain/src/schema.sql` for the schema (note: domain data lives in `pages.frontmatter` JSONB + markdown bullets inside `compiled_truth`, not in typed columns -- see Section 6), and `package.json` scripts for the current CLI surfaces (`bun run ingest`, doctor, etc.).
- Repo head at v3 writeup: `193b8df` "Acumatica: use FS branch as shared login default" (the same SHA v2.1 cited; origin/main has not moved since). This reference point will drift; run `git fetch origin && git log origin/main -1` and `git pull --rebase origin main` before doing any work, and be aware the user runs Codex against this repo in parallel.
