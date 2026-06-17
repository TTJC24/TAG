# Source Lifecycle and Provenance Contract

This is the first Company Brain salvage slice from the older Vault work. It converts the useful Vault concepts into Company Brain rules without porting Vault code.

## Purpose

Company Brain owns ingestion, indexing, cited retrieval, generated internal knowledge surfaces, source freshness, and answer quality. Every connector and generated page should make source health visible and preserve provenance well enough that a cited answer can be trusted or rejected.

## Source Lifecycle Fields

Every durable source record or connector state should be able to answer:

| Field | Meaning |
|---|---|
| `source_id` | Stable internal identifier used in provenance and cleanup. |
| `source_kind` | Connector/source type, such as `pipedrive`, `m365`, `acumatica`, `fixture`, `generated`, `file`, or `rss`. |
| `source_uri` | Stable source-system URI or virtual path. |
| `scope` | Optional workspace/team/entity/customer scope. Keep optional until authorization needs require it. |
| `owner` | Human or system owner for operational follow-up. |
| `cursor` | Source-specific continuation token, timestamp, page marker, or delta token. |
| `last_sync_at` | Last attempted sync timestamp. |
| `last_success_at` | Last successful sync timestamp. |
| `last_failure_at` | Last failed sync timestamp, if any. |
| `failure_state` | Sanitized failure class, such as `auth_failed`, `rate_limited`, `mapping_failed`, `source_unavailable`, `parse_failed`, or `unknown`. |
| `failure_detail` | Sanitized operator-facing detail. Never store raw secrets. |
| `ingested_via` | CLI, scheduler, fixture, manual import, pagegen, or migration path. |
| `content_hash` | Hash used for idempotent upsert and change detection where available. |

These fields can live in existing tables or metadata structures. Do not create a second source registry until the current Company Brain schema requires it.

## Virtual Path Convention

Use virtual paths to keep citations and cleanup predictable across connectors.

| Source | Pattern |
|---|---|
| Pipedrive org | `pipedrive/orgs/<org_id>` |
| Pipedrive person | `pipedrive/persons/<person_id>` |
| Pipedrive deal | `pipedrive/deals/<deal_id>` |
| Pipedrive note | `pipedrive/orgs/<org_id>/notes/<note_id>` or `pipedrive/deals/<deal_id>/notes/<note_id>` |
| M365 mail | `m365/mail/<mailbox>/<yyyy-mm>/<message_id>` |
| M365 calendar | `m365/calendar/<calendar>/<event_id>` |
| M365 Teams | `m365/teams/<team>/<channel>/<yyyy-mm>/<message_id>` |
| M365 SharePoint | `m365/sharepoint/<site>/<library>/<path>` |
| Acumatica customer | `acumatica/customers/<customer_id>` |
| Acumatica sales order | `acumatica/sales-orders/<order_nbr>` |
| Acumatica invoice | `acumatica/invoices/<invoice_ref>` |
| Acumatica item | `acumatica/items/<inventory_id>` |
| Generated internal page | `generated/<surface>/<slug>` |
| Fixture | `fixtures/<connector>/<fixture_name>` |
| File upload or static file | `files/<normalized_path>` |
| RSS item | `rss/<feed_slug>/<item_guid>` |

Prefer stable source-system IDs over names. Names change; IDs give cleanup, freshness, and citations a spine.

## Provenance Rules

- Every imported document must carry `source_id`, `source_kind`, `source_uri`, and `ingested_via`.
- Every generated page should include build metadata: generated timestamp, commit, source counts, and pagegen duration when available.
- Every cited answer should expose enough source metadata for an operator to decide whether the answer is current and grounded.
- Failed source pulls must not silently wipe generated pages or current search entries.
- Last-good content may remain visible only when the UI/API makes freshness or failure state clear.
- Cleanup must target source-scoped rows, not broad shared tables, unless a backup and rollback path are documented.

## Authorization Stance

Company Brain is not adopting Vault's full workspace system yet.

Current rule:

- Keep Company Brain as a service boundary behind API token and deployment access controls.
- Add optional source scope fields now only where they help future workspace/team/entity filtering.
- Do not implement broad workspace/RLS features until a current Company Brain consumer needs them.
- If workspace or team scoping becomes necessary, implement it at the API/retrieval boundary first and add tests proving cross-scope leakage is blocked.

Do not copy Vault's production auth path. Vault's production JWT verification was unfinished in the reviewed code.

## Connector Health Checks

Smoke and evaluation plans should cover source health, not only answer quality.

Minimum health signals:

- connector can run fixture mode without live credentials,
- dry-run does not write live data,
- live readiness checks perform bounded reads only,
- source failures produce sanitized operator-facing states,
- cursor or continuation state is preserved after successful sync,
- generated pages include build/source metadata,
- and answer evals can identify stale or missing citations.

`bun run provenance:check` enforces the fixture-mode baseline: connector events must include stable `source_id`, `source_kind`, protocol-shaped `source_uri`, content hash, slug metadata, explicit `upstream_updated_at` or `null`, and operator-visible source URI in the rendered content. It skips registered live-only connector variants that do not have fixture files.

`bun run source-health:check` enforces the connector health baseline: status output must classify every connector as `live_ready`, `fixture_ready`, or `blocked`; missing live credentials must be reported as sanitized env-name-only failure state; and freshness classification must distinguish fresh, recent, stale, and unknown upstream timestamps without pretending ingestion time is upstream freshness.

`bun run eval:citations` now enforces two related baselines. First, fixture search hits must preserve protocol-shaped `source_uri` through the JSON search adapter. Second, representative cited answers must include non-empty citation slug/source ID/protocol-shaped source URI, stay within expected source systems, and render freshness cues such as received/start timestamps for recency-sensitive mail and calendar answers. Ambiguous answers must not return authoritative citations.

Current gap: live source freshness against configured systems and production environment verification still need a safe configured environment. Local fixture-mode `smoke` and `smoke:api` now prove seeded fixture/domain/API behavior, but they do not prove live source freshness.

`docs/live-readiness-ledger.md` is the release ledger for that gap. `bun run live-readiness:check` keeps the blocked live-readiness boundary visible in CI until safe-env smoke/API/source-freshness evidence is recorded.

Company Brain CI runs fixture validation, provenance validation, source health validation, citation eval, answer eval, and typecheck in that order.

## First Code Slice Candidate

The first code slice is partially implemented:

1. Audit existing connector metadata for the lifecycle fields above.
2. Add missing virtual path helpers where connectors currently use ad hoc identifiers.
3. Extend `status`, `doctor`, `smoke`, or fixture checks to report source freshness/failure state. Done for the current connector status contract via `src/cli/source-health-check.ts` and `bun run source-health:check`; live configured source checks still need safe env verification.
4. Add one fixture/eval case that fails when a citation lacks source metadata. Done via `src/cli/citation-eval.ts` and `bun run eval:citations` for the current answer contract; JSON search hit source URIs are preserved and answer citations now require protocol-shaped source URIs.
5. Document any schema gap before adding new tables.

## Non-Goals

- No wholesale Vault port.
- No direct Vault database migration.
- No Railway deployment adoption by default.
- No source-system writeback.
- No workspace/RLS rollout until a current Company Brain use case needs it and tests exist.
