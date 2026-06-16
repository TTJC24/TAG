# Knowledge Stack Salvage Contract

This contract defines how `company-brain` should absorb useful ideas from the older knowledge-stack repos without preserving duplicate products.

## Rule

`company-brain` is the active knowledge/retrieval service. The older `vault`, `vault-gateway`, `cortex`, and `gbrain-eval` repos are salvage or historical sources unless a future review proves a unique production role.

Do not merge repo histories or archive repositories without owner approval. Do not copy unfinished auth, deployment, or connector code into Company Brain without verification.

## `vault` -> Company Brain

Vault contains the strongest salvage value. Preserve concepts, not the whole app.

### Salvage

- Workspace-scoped access model.
- Tenant admin versus workspace owner/member/viewer boundaries.
- Row-level security discipline and explicit request-scoped visibility.
- Source lifecycle: connect, sync, cursor, retry, refreshed credentials, last-good timestamps.
- Connector interface pattern for Pipedrive, M365, Acumatica, files, RSS, and future sources.
- Virtual path conventions such as `pipedrive/orgs/<id>` and `acumatica/sales-orders/<id>`.
- Background worker responsibilities: schedule due sources, ingest source, reconcile external group membership when configured.
- Hash/upsert/cursor persistence and provenance preservation.
- Cost-aware role distinction where viewers can read but not trigger expensive agent workflows.

### Do Not Salvage Directly

- Production auth implementation from `app/api/auth.py`; the production JWT path is unfinished and returns 501.
- Railway-specific deployment shape unless Company Brain deliberately adopts it.
- Any broad workspace feature that conflicts with Company Brain's current API and deployment model.
- Stub connectors as production-ready connectors.
- Direct database coupling between Vault and Company Brain.

### Company Brain Translation

Represent Vault concepts as:

- source records with owner, workspace/scope, connector type, cursor, last sync, last successful sync, and failure state,
- document/source provenance fields,
- retrieval authorization checks at the API boundary,
- optional workspace/team filters only after current Company Brain use cases require them,
- connector health and freshness telemetry,
- and explicit role/cost gates for expensive answer generation.

## `vault-ui` -> TractionOS or Company Brain

Vault UI has a scaffold-level README and should not be treated as an active product without deeper tree review.

Salvage only custom UI concepts that are visibly better than the current apps:

- source browsing,
- knowledge health,
- ingestion status,
- cited document inspection,
- operator-facing source freshness views.

Default destination is `tractionos` for operator dashboards, or `company-brain` only for source/retrieval admin UI.

## `vault-gateway` -> Company Brain

Vault Gateway currently has no proven standalone runtime role from the portfolio review. Salvage only if a follow-up tree/branch pass finds useful gateway, auth, or API-boundary patterns.

Archive candidate after:

- runtime and branch review,
- secret/reference scan,
- useful gateway lessons copied into Company Brain docs or code,
- owner approval.

## `cortex` -> Company Brain

Cortex currently has no proven standalone runtime role from the portfolio review. Salvage only unique document, context, search, schema, prompt, or evaluation concepts.

Archive candidate after:

- runtime and branch review,
- secret/reference scan,
- useful context/search lessons copied into Company Brain docs or code,
- owner approval.

## `gbrain-eval` -> Company Brain

Treat as historical evaluation material. Preserve any answer-quality prompts, fixtures, scoring rubrics, or known-failure examples that improve `bun run eval:answers` or fixture checks.

Archive candidate after historical lessons are linked or copied into Company Brain and owner approval is given.

## First Company Brain Salvage Slice

The first useful slice should be documentation and data-model alignment, not a large code port:

1. Add source lifecycle fields or docs for connector cursor, last sync, last success, failure state, and provenance.
2. Add a virtual path convention for Pipedrive, M365, Acumatica, files, and generated internal docs.
3. Add explicit retrieval authorization notes for future workspace/team scoping.
4. Add connector health/freshness checks to smoke or evaluation plans.
5. Import only evaluation fixtures from `gbrain-eval` if they improve current answer-quality tests.

## Readiness Gate

Before moving any code from a salvage repo into Company Brain, confirm:

- the target behavior is needed by Company Brain now,
- the source code is production-complete or can be safely adapted,
- auth and tenant boundaries are understood,
- environment variables and secrets are documented,
- tests or smoke checks cover the imported behavior,
- and there is no simpler implementation already present in Company Brain.
