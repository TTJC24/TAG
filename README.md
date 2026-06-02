# company-brain

Production-shaped company knowledge platform built on
[`garrytan/gbrain`](https://github.com/garrytan/gbrain). Successor to the
bounded evaluation in `gbrain-eval`.

## Status

v1 in-progress. Direct-write ingestion using the Play B workaround for
upstream issue [#1522](https://github.com/garrytan/gbrain/issues/1522).

New here? Jump to [Quickstart](#quickstart-fixture-only-60-seconds).

## Production v3 static site

Company Brain v3 is served as a static, read-only internal directory behind
Cloudflare Access. The query service and Postgres stay private on the Docker
network; the public surface is the generated `dist/` site only.

### Scheduled Pipedrive refresh

On the production droplet, Pipedrive refresh is installed as cron:

```bash
cat /etc/cron.d/company-brain-pipedrive-refresh
```

Current schedule: every 4 hours at minute 17. Logs are written under:

```bash
/opt/company-brain/logs/
```

Typical log inspection:

```bash
ls -lah /opt/company-brain/logs
tail -n 120 /opt/company-brain/logs/pipedrive-refresh-$(date +%Y%m%d).log
```

Manual refresh command:

```bash
cd /opt/company-brain/repo/infra
docker compose --env-file /opt/company-brain/infra/.env run --rm company-brain-ingest bun run ingest pipedrive-fs --no-embed
docker compose --env-file /opt/company-brain/infra/.env run --rm company-brain-ingest bun run ingest pipedrive-blcs-usa --no-embed
docker compose --env-file /opt/company-brain/infra/.env run --rm company-brain-ingest bun run pagegen
docker compose --env-file /opt/company-brain/infra/.env restart company-brain-static
```

The refresh script is failure-safe: if ingest fails, it exits before pagegen so
the existing static snapshot is not wiped.

After code changes, rebuild the Bun image with the current commit stamped into
pagegen:

```bash
cd /opt/company-brain/repo/infra
docker compose --env-file /opt/company-brain/infra/.env build \
  --build-arg COMPANY_BRAIN_GIT_COMMIT=$(git -C /opt/company-brain/repo rev-parse --short HEAD) \
  company-brain-ingest
```

### Build metadata

Every pagegen run writes:

```bash
/opt/company-brain/dist/build-meta.json
```

Inspect it from the droplet:

```bash
python3 -m json.tool /opt/company-brain/dist/build-meta.json
```

It includes the generated timestamp, build commit, search entry count, section
counts, source counts, and pagegen duration.

## Quickstart (fixture-only, ~60 seconds)

This path takes you from a fresh clone to a cited answer using only stub
fixtures — no M365, Acumatica, or Pipedrive credentials needed.

```bash
# 1) Env: fill DATABASE_URL, ZEROENTROPY_API_KEY, ANTHROPIC_API_KEY only.
cp .env.example .env

# 2) Install deps.
bun install

# 3) Start Postgres 16 (skip if you already have one on :5432).
docker run -d --name company-brain-pg \
  -e POSTGRES_PASSWORD=company_brain \
  -e POSTGRES_USER=company_brain \
  -e POSTGRES_DB=company_brain \
  -p 5432:5432 postgres:16

# 4) Load every connector's stub fixtures in one shot.
bun run ingest:fixtures

# 5) Ask a question backed by the fixtures.
bun run ask "Acme pump terms"

# 6) End-to-end sanity check.
bun run smoke
```

If anything misbehaves, run `bun run doctor` first.

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
# 1) One-time setup
cp .env.example .env   # fill in real values as you go
bun install
docker run -d --name company-brain-pg -e POSTGRES_PASSWORD=company_brain \
  -e POSTGRES_USER=company_brain -e POSTGRES_DB=company_brain \
  -p 5432:5432 postgres:16
bun run ingest m365-calendar --dry-run

# 2) Start servers (each is long-running — run in its own terminal)
bun run api          # long-running; run in its own terminal
bun run web:dev      # long-running; run in its own terminal
bun run scheduler    # long-running; run in its own terminal
```

### Web UI

`bun run web:dev` starts the Vite dev server at
<http://localhost:5173>. It requires `bun run api` running in a second
terminal — Vite proxies `/api` to `:4317`. The UI authenticates with
`VITE_API_TOKEN`, which defaults to `dev-local-token` to match
`COMPANY_BRAIN_API_TOKEN` in `.env.example`. If you change one, change
the other.

## Common scripts

Beyond the long-running servers above, the following one-shot scripts are the
ones you'll reach for day-to-day:

- `bun run ingest:fixtures` — load every connector's stub fixtures in one
  shot. The fastest way to populate a fresh database.
- `bun run ask "Acme pump terms"` — ask a natural-language question against
  the ingested corpus and stream the answer (with citations) on stdout.
- `bun run search "<query>"` — run a hybrid search and print ranked matches
  without invoking the LLM (useful for debugging retrieval).
- `bun run doctor` — env + DB + embedding checks; run this first if anything
  misbehaves.
- `bun run status` — per-connector document counts and last-ingest timestamps.
- `bun run smoke` — end-to-end check (ingest fixtures → ask → assert cited
  answer).
- `bun run smoke:api` — same end-to-end check, but via the HTTP API.
- `bun run eval:answers` — answer-quality regression suite; run before merging
  retrieval or prompt changes.
- `bun run fixtures:check` — verify that every connector's stub fixtures parse
  and round-trip through the ingestion path; run this before opening a PR.
- `bun run typecheck` — run `tsc --noEmit` across the project; required to
  pass before committing.
