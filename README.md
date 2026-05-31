# company-brain

Production-shaped company knowledge platform built on
[`garrytan/gbrain`](https://github.com/garrytan/gbrain). Successor to the
bounded evaluation in `gbrain-eval`.

## Status

v1 in-progress. Direct-write ingestion using the Play B workaround for
upstream issue [#1522](https://github.com/garrytan/gbrain/issues/1522).

## Architecture

- **Engine**: Postgres via the `gbrain` engine factory. ZeroEntropy embeddings.
- **Ingestion**: Each connector implements `IngestionSource` and emits
  `IngestionEvent`s. A shared runner threads provenance
  (`source_id` / `source_kind` / `source_uri` / `ingested_via`) into
  `importFromContent` directly, bypassing the broken `ingest_capture` path.
- **Surfaces**: Query CLI, HTTP API (Hono), Web UI (Vite SPA), Scheduler
  (`node-cron`).

## Connectors (v1)

- `m365-calendar` — Graph `/me/calendar/events`
- `m365-mail` — Graph `/me/messages` with delta
- `m365-sharepoint` — Graph `/sites` + `/drives`
- `m365-teams` — Graph `/teams` channels + messages
- `acumatica` — REST contract API (customers/orders/invoices/items)
- `pipedrive` — v1 API (deals/persons/orgs/activities/notes)

## Dry-run first

Every connector ships with stub fixtures under `fixtures/<connector>/` so the
ingestion path can be exercised end-to-end without any external API calls.
Real credentials are wired last.

```bash
bun run ingest m365-mail --dry-run
bun run ingest acumatica --dry-run
```

## Prerequisites

- [Bun](https://bun.sh) >= 1.3 (matches `bun-types` in `package.json`; this project does not run on Node)
- Docker (for the Postgres 16 container shown below — or an existing Postgres 16 instance you can point `DATABASE_URL` at)
- ZeroEntropy API key (embeddings) and Anthropic API key (LLM)

## Running

```bash
cp .env.example .env   # fill in real values as you go
bun install
docker run -d --name company-brain-pg -e POSTGRES_PASSWORD=company_brain \
  -e POSTGRES_USER=company_brain -e POSTGRES_DB=company_brain \
  -p 5432:5432 postgres:16
bun run ingest m365-calendar --dry-run
bun run api
bun run web:dev
bun run scheduler
```
