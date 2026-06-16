# Product Boundary

`company-brain` is the portfolio's company knowledge and retrieval platform. It should own ingestion, indexing, cited search, answer generation, and generated static/internal knowledge surfaces.

## Owns

- Pipedrive-backed static internal directory and refresh pipeline.
- M365, Pipedrive, and Acumatica ingestion patterns when they are used for knowledge/retrieval.
- Fixture ingestion, smoke tests, answer-quality evaluation, and cited answer behavior.
- Knowledge API consumed by other apps through `COMPANY_BRAIN_API_URL` and `COMPANY_BRAIN_API_TOKEN`.
- Retrieval quality, provenance, citations, and source freshness.

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

## Readiness Gates

Before production-impacting changes:

```bash
bun run fixtures:check
bun run smoke
bun run smoke:api
bun run eval:answers
bun run typecheck
```

For production Pipedrive/static-directory work, also verify the scheduled refresh logs and `build-meta.json` on the droplet.

For Acumatica work, do not remove caps or schedule live refresh until readiness passes without `API Login Limit` and capped validation data has been inspected in the static site.
