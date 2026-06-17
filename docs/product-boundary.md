# Product Boundary

`company-brain` is the portfolio's company knowledge and retrieval platform. It should own ingestion, indexing, cited search, answer generation, and generated static/internal knowledge surfaces.

## Owns

- Pipedrive-backed static internal directory and refresh pipeline.
- M365, Pipedrive, and Acumatica ingestion patterns when they are used for knowledge/retrieval.
- Fixture ingestion, smoke tests, answer-quality evaluation, and cited answer behavior.
- Knowledge API consumed by other apps through `COMPANY_BRAIN_API_URL` and `COMPANY_BRAIN_API_TOKEN`.
- Retrieval quality, provenance, citations, and source freshness.
- Source lifecycle conventions, virtual paths, and connector health/freshness rules documented in `docs/source-lifecycle-and-provenance.md`.

## Does Not Own

- Executive/operator dashboard UX: belongs in `tractionos`.
- Procurement/order review workflow state: belongs in `inside-sales-bot` / future `procurement-os`.
- Bid takeoff and estimator review engine: belongs in `waterworks-takeoff`.
- Public construction supply/vendor directory: belongs in `build-smart-source`.
- Durable task-control infrastructure: belongs in `agent-os`.

## Integration Pattern

Other apps should call `company-brain` as a service rather than copy its ingestion/indexing internals.

Preferred boundary:

```text
tractionos / procurement-os / other apps
  -> COMPANY_BRAIN_API_URL + Bearer token
  -> cited answer/search response
```

Avoid direct database coupling unless there is a deliberate migration or monorepo decision.

## Salvage Candidates

Compare and selectively salvage useful ideas from:

- `vault`: workspace/RLS/source lifecycle/worker concepts.
- `vault-ui`: knowledge browsing UI if it has custom work beyond scaffold.
- `vault-gateway`: gateway/auth patterns if still useful.
- `cortex`: document/context/search concepts if unique work exists.
- `gbrain-eval`: historical evaluation notes.

The first Vault salvage slice has been translated into Company Brain's own source lifecycle and provenance contract in `docs/source-lifecycle-and-provenance.md`. Treat that document as the active target for source metadata, virtual paths, source health, and future workspace/team scoping. Do not port Vault code wholesale.

## Automated Readiness Gate

`.github/workflows/ci.yml` now runs on pushes and pull requests to `main`:

```bash
bun install --frozen-lockfile
bun run fixtures:check
bun run typecheck
```

The workflow provides Postgres 16 and fixture-mode placeholder env vars, but it intentionally does not call live connectors or external LLM/embedding providers.

## Manual / Deployment Readiness Gates

Before production-impacting changes, still run the deeper checks in an environment with the required local services and safe credentials:

```bash
bun run fixtures:check
bun run smoke
bun run smoke:api
bun run eval:answers
bun run typecheck
```

Record live-source/API promotion evidence in `docs/live-readiness-ledger.md`. CI runs `bun run live-readiness:check` so the repo does not claim live production readiness from fixture-mode checks alone.

For production Pipedrive/static-directory work, also verify the scheduled refresh logs and `build-meta.json` on the droplet.

For Acumatica work, do not remove caps or schedule live refresh until readiness passes without `API Login Limit` and capped validation data has been inspected in the static site.
