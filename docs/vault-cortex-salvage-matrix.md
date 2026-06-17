# Vault / Cortex Salvage Matrix

Use this document before merging, copying, or archiving any of the knowledge-stack leftovers.

Candidate source repos:

- `vault`
- `vault-ui`
- `vault-gateway`
- `cortex`
- `gbrain-eval`

Default destination: `company-brain`, unless the owner decides Vault remains a separate product.

## Salvage Principle

Do not copy entire repos blindly. Salvage only patterns that are clearly better than, or clearly complementary to, the current `company-brain` architecture.

Every moved idea should answer:

1. What user/operator problem does this solve?
2. Does `company-brain` already solve it?
3. Is this implementation safer, simpler, or more production-ready?
4. What files/docs/tests prove it?
5. What is the smallest useful move?

## Comparison Matrix

| Area | Source repo/file | Existing `company-brain` pattern | Salvage decision | Action | Evidence needed |
|---|---|---|---|---|---|
| Workspace/team access | `vault/app/db/models.py`, `vault/app/api/workspaces.py`, `vault/alembic/versions/0010_visibility_scope.py` | Company Brain currently uses service/deployment boundary plus optional source/entity scope; no full workspace membership model yet. | Defer | Preserve model notes, but do not port until a current Company Brain consumer needs workspace/team scoping. First implementation should be API/retrieval-boundary tests that prove cross-scope leakage is blocked. | Data model exists in Vault; still need Company Brain use case, API contract, and tests before implementation. |
| Tenant isolation / RLS | `vault/alembic/versions/0008_rls_substrate.py`, `vault/alembic/versions/0009_create_app_role.py`, `vault/app/db/session.py`, `vault/tests/test_deny_defaults.py` | `docs/source-lifecycle-and-provenance.md` explicitly says Company Brain is not adopting Vault's full workspace/RLS system yet. | Defer | Keep as reference material for a future scoped-retrieval slice. Do not port the SQL policies blindly. | Need current auth model, request-scoped principal, RLS policy tests, and rollback plan. |
| Source lifecycle | `vault/app/db/models.py`, `vault/app/connectors/base.py`, `vault/app/workers/ingest.py`, `vault/alembic/versions/0015_source_sync_telemetry.py` | Company Brain already documents source lifecycle fields and has fixture/provenance/citation gates. | Keep | Keep concept-level alignment. Next code work should extend live freshness and source failure-state eval/smoke coverage rather than moving Vault tables wholesale. | Current fixture gates pass; still need safe-env live freshness and failure-state tests. |
| Pipedrive connector | `vault/app/connectors/pipedrive.py`, `vault/tests/test_pipedrive_mappers.py` | Company Brain has `src/sources/pipedrive.ts` and Pipedrive answer routing in `src/ask.ts`. | Keep selectively | Reuse mapper lessons: entity coverage, virtual paths, authority classes, name normalization, cursor/freshness expectations. Do not port Python connector directly. | Compare TypeScript field coverage against Vault mapper tests; add focused fixtures if gaps are found. |
| M365 connector | `vault/app/connectors/m365_mail.py`, `vault/app/connectors/m365_calendar.py`, `vault/app/api/m365_auth.py`, `vault/tests/test_m365_mail_paths.py`, `vault/tests/test_m365_calendar_paths.py` | Company Brain has M365 mail/calendar/Teams/SharePoint source modules and collaboration answer routing. | Keep selectively | Preserve Graph delta/backfill, mailbox approval, sensitivity, attachment, and virtual path lessons as test cases or docs. Do not port delegated-auth flow without security review. | Need Graph permission model, mailbox approval policy, safe fixture set, and failure-state tests. |
| Acumatica connector | `vault/app/connectors/acumatica.py`, `vault/scripts/create_acumatica_source.py` | Company Brain has Acumatica source/client modules and Acumatica readiness CLI. | Keep selectively | Preserve semantic lessons: Acumatica as authoritative for AR/revenue/COGS/customer record, read-only discipline, session-limit backoff, branch/entity-prefix caution, and pacing. | Need read-only proof, branch scoping, bounded live-read smoke, and source mapping coverage. |
| Ingestion workers | `vault/app/workers/ingest.py`, `vault/app/workers/extract.py`, `vault/app/workers/entra_sync.py`, `vault/app/pageindex/*` | Company Brain has CLI/scheduler ingestion and provenance checks, but deeper worker telemetry is still immature. | Keep concepts | Adopt scheduling/idempotency/retry/logging expectations in docs/tests first. Port no worker code until Company Brain has a matching runtime. | Need scheduler contract, idempotent upsert tests, retry/cursor persistence, and sanitized logs. |
| Query API | `vault/app/api/query.py`, `cortex/cortex/retrieval/*`, `cortex/samson-cortex/retrieval/*` | Company Brain has `src/query/server.ts`, `src/ask.ts`, gbrain compatibility, and strict citation checks. | Keep selectively | Keep path/source summaries and Cortex retrieval/eval ideas as future query improvements. Do not replace current cited answer path. | Need answer eval cases proving better recall/citation behavior before moving logic. |
| Path browsing | `vault/app/api/query.py` `list_paths`, `vault/tests/test_m365_mail_paths.py`, `vault/tests/test_m365_calendar_paths.py` | Company Brain documents virtual paths and enforces citation source URIs. | Keep | Add a future source/path browsing API or admin view only when needed for source inspection and cleanup. | Need UX/API consumer and tests for path prefix behavior. |
| Agent tools | `vault/app/api/agent.py`, `vault/app/api/mcp_server.py`, `cortex/cortex_agent/*` | Company Brain has procurement/action answer modules, but no broad autonomous tool surface is marked production-ready. | Defer | Preserve tool-contract and ambiguity-planning ideas only. Do not expose broad agent tools until permissions, cost gates, and audit logs are explicit. | Need tool contracts, role/cost gates, audit log, and safety tests. |
| Gateway/auth boundary | `vault/app/api/auth.py`, `vault-gateway/main.py`, `vault-gateway/docs/company-brain-salvage-contract.md` | Company Brain currently relies on service/deployment controls and API routes; Vault JWT path is already documented as unfinished. | Skip direct port | Keep only boundary cautions. Do not copy Vault auth or keep `vault-gateway` as an active service unless later branch/tree review finds more code. | Need production auth design and tests; current gateway repo has no proven standalone runtime beyond a tiny entrypoint. |
| UI components | `vault-ui/app/page.tsx`, `vault-ui/app/api/sources/health/route.ts`, `vault-ui/app/entities/[entity]/page.tsx`, `vault-ui/app/customer/[id]/page.tsx` | Company Brain has no full admin UI; TractionOS has the stronger dashboard destination. | Keep selectively | Salvage Pulse/source-health, watch-item, entity/customer detail, and honest unavailable-state concepts into TractionOS or a future Company Brain admin surface. Skip scaffold/auth assumptions. | Need target UI backlog item and live API contract before port. |
| Deployment | `vault/DEPLOY.md`, `vault/docker-compose.yml`, `vault/railway.json`, `vault/.env.example` | Company Brain has its own Node/Bun shape; deployment is not Railway-first by default. | Defer | Preserve env/runbook lessons only. Do not adopt Railway/Docker shape unless chosen as Company Brain deployment target. | Need deployment target decision, env inventory, smoke/API checks, and backup/restore plan. |
| Evaluation findings | `gbrain-eval/PLAY_A_REPORT.md`, `gbrain-eval/PLAY_B_REPORT.md`, `gbrain-eval/UPSTREAM_BUG_ANALYSIS.md`, `cortex/samson-cortex/retrieval/evals/*` | Company Brain already has citation evals; full answer eval/live failure coverage remains open. | Keep | Preserve gbrain provenance/source-isolation lessons and Cortex gold-query/eval harness ideas. Next Company Brain eval work should add known-failure cases for missing provenance, source isolation, import robustness, and unavailable synthesis. | Need fixture conversion into `bun run eval:answers` or a parallel eval harness. |
| Fixtures/prompts | `gbrain-eval/scripts/play-b-import.ts`, `gbrain-eval/scripts/play-b-verify.ts`, `cortex/samson-cortex/retrieval/evals/gold_queries.json`, `cortex/lakehouse/access/public_test_corpus.json` | Company Brain fixture/citation evals exist and should stay source-provenance-first. | Keep selectively | Convert only small, non-sensitive examples into fixtures. Do not import raw local snapshots or operational lakehouse data. | Need sensitivity review and sanitized fixture set. |

## Inspection Summary - 2026-06-17

| Repo | Branch/tree evidence | Secret scan result | Salvage recommendation | Archive readiness |
|---|---|---|---|---|
| `vault` | Full FastAPI/Postgres backend with models, migrations, connectors, workers, query API, M365 auth, demo/runbook docs, and tests. | Pattern scan found credential/config references and placeholders only, including expected `password`, `api_token`, and `client_secret` code paths. No obvious committed key/token match was found in the scanned working tree. | Strongest concept source. Keep source lifecycle, virtual paths, connector semantics, worker telemetry, and RLS/workspace notes. Do not port unfinished auth or database schema wholesale. | Not archive-ready until useful concepts are either implemented, linked, or deliberately deferred in Company Brain and owner approves. |
| `gbrain-eval` | `main` has Play A/B reports and scripts; remote `upstream-issue` exists at `122a8d7` and records the upstream provenance issue. | Pattern scan found no matches. | Keep historical eval lessons: source isolation, provenance receipt, import robustness, citation shape, and model-key failure modes. | Archive candidate after eval lessons are converted to Company Brain eval/docs and owner approves. |
| `vault-ui` | Next.js app includes custom Pulse/source-health strip, watch items, entity/customer detail routes, and proxy API routes beyond stock scaffold. | Pattern scan found no matches. | Salvage UI concepts only, preferably into TractionOS or a future Company Brain admin surface. Skip scaffold and auth assumptions. | Not archive-ready until custom UI concepts are either backlogged/ported or intentionally skipped and owner approves. |
| `vault-gateway` | Root contains README, `.env.example`, `main.py`, and salvage contract; no broad runtime tree found in the working tree. | Pattern scan found no matches. | Skip as active service; preserve only gateway/auth-boundary cautions. | Likely archive candidate after final branch/tree check and owner approval. |
| `cortex` | Contains real retrieval engines, document envelope schema, source registry, eval harness/gold queries, UI shell, and sample lakehouse/raw operational artifacts. | Pattern scan found no matches. | Keep retrieval/eval/schema/source-registry lessons. Do not import raw lakehouse data without sensitivity review. | Not archive-ready until eval/schema lessons are captured and raw artifacts are reviewed. |

## Required Inspection Steps

For each candidate repo:

1. List branches and identify non-main work.
2. Inspect root files and non-root source directories.
3. Search for secret references and credential history concerns.
4. Identify docs worth preserving.
5. Identify tests or fixtures worth moving.
6. Fill the comparison matrix above.
7. Move only approved items into `company-brain` with focused commits.
8. Add archive note to the source repo after salvage.
9. Archive only after owner approval.

## Default Decisions Unless Evidence Says Otherwise

- `gbrain-eval`: historical evidence only; capture lessons, then archive.
- `vault-ui`: archive if it remains a scaffold or thin UI shell.
- `vault-gateway`: archive if no unique gateway/auth runtime remains.
- `cortex`: archive if no unique document/context/search concepts remain.
- `vault`: strongest salvage candidate because it documents workspace/RLS/connectors/workers.

## Done Definition

The Vault/Cortex family is cleaned up when:

- this matrix is filled with evidence,
- useful patterns are moved or deliberately deferred,
- `company-brain` docs mention any adopted concepts,
- source repos contain final archive/salvage notes,
- owner approves archive actions,
- and `ops-bootstrap/docs/repo-status-index.md` reflects the final state.
