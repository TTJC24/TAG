# Vault Salvage Evidence - 2026-06-16

This note records the concrete evidence found in `TTJC24/vault` before any archive or consolidation decision. It complements `docs/vault-cortex-salvage-matrix.md`.

## Recommendation

Do not keep `vault` as a separate active product right now.

Use `company-brain` as the primary knowledge/retrieval platform and salvage the strongest Vault patterns only where they improve the current service. Vault has real implementation depth, but it overlaps heavily with Company Brain and still has production auth unfinished.

## Keep / Salvage

| Area | Vault evidence | Decision | Destination |
|---|---|---|---|
| Tenant and workspace isolation | `app/db/session.py` uses separate privileged/app database engines and request-scoped GUCs such as `app.workspace_ids`, `app.is_tenant_admin`, `app.user_id`, and `app.user_email`. `app/main.py` verifies the app DB role is restricted and hard-fails if it has `rolsuper` or `rolbypassrls`. | Keep as a security pattern. | `company-brain` backend/API work if multi-tenant or internal role-scoped access is expanded. |
| Raw source provenance | `app/db/models.py` defines append-only `source_payloads`, `documents.raw_ref`, `payload_hash`, and source timestamps. `app/connectors/base.py` exposes `RawDocument.raw_payload`. | Keep. | Company Brain ingestion provenance and replay/audit planning. |
| Authority model | `app/connectors/base.py`, `app/db/models.py`, `app/connectors/pipedrive.py`, and `app/connectors/acumatica.py` classify records with `authority_class`, `authority_scope`, and `entity_mentions`. Acumatica is treated as authoritative for AR/customer/revenue data; Pipedrive records are reference/contextual. | Keep. | Company Brain cited answer contract and source ranking. |
| Connector lifecycle | `app/connectors/README.md` documents connector registration, cursoring, normalized documents, and sync status expectations. `app/connectors/__init__.py` registers Pipedrive, M365, M365 mail/calendar, and Acumatica connectors. | Keep selectively. | Company Brain connector docs/tests. |
| Pipedrive mapper coverage | `app/connectors/pipedrive.py` ingests organizations, persons, deals, notes, and activities, including normalized company/contact mentions. | Compare before copying. Company Brain already has production Pipedrive refresh; use Vault only for fields/mentions that are missing. | Company Brain Pipedrive ingest backlog. |
| Acumatica operational lessons | `app/connectors/acumatica.py` includes session-limit handling, read pacing, order/invoice/payment semantics, and authority notes. | Keep the lessons. Avoid blind code copy. | Company Brain Acumatica readiness and capped ingest docs. |
| Query/path browsing | `app/api/query.py` provides RLS-aware source summaries, path listing, full-text search, and document detail. | Defer unless Company Brain needs a live API beyond generated static pages. | Company Brain API backlog or TractionOS internal tools. |
| Source/queue health | `app/main.py` includes source and queue health endpoints. | Keep concept, not necessarily implementation. | TractionOS health panels and Company Brain operator runbooks. |

## Skip / Defer

| Area | Reason |
|---|---|
| Vault as a standalone product | It duplicates Company Brain's knowledge/retrieval mission and would split attention. |
| Production auth path | `DEPLOY.md` and `app/api/auth.py` show production JWT verification still raises HTTP 501. This blocks production use as-is. |
| Generic product boundary | `app/main.py` mixes knowledge-vault concerns with domain-specific customer/revenue/payment endpoints. That is useful business logic, but it makes the repo boundary muddy. |
| Direct raw SQL dashboard endpoints | Some logic may belong in TractionOS or Company Brain, but large endpoint copies would increase coupling and risk. Extract only named metrics/contracts after current needs are clear. |
| M365 status | Documentation disagrees: root-level notes imply broader connector readiness while `app/connectors/README.md` marks M365-related connectors as stubbed/partial. Verify before using. |

## Blockers Before Any Direct Reuse

- Replace the dev auth shortcut with real JWT/JWKS verification or keep the code out of production paths.
- Reconcile environment naming drift: `.env.example` references `DEV_TENANT_ID` / `DEV_USER_ID`; `app/api/auth.py` uses `DEV_USER_EMAIL`; docs mention the dev email path.
- Verify connector status with tests or live dry-runs before relying on M365/Acumatica claims.
- Confirm whether Company Brain already has equivalent Pipedrive/Acumatica field coverage before copying mappers.
- Keep secret values out of committed files and rotate any historical credentials if they were ever real.

## Smallest Useful Moves

1. Add the authority/provenance vocabulary to Company Brain's answer and ingest docs: `authority_class`, `authority_scope`, `entity_mentions`, immutable raw payload reference, and source timestamps.
2. Compare Vault's Pipedrive mapper against Company Brain's current Pipedrive ingest and open focused issues for missing high-value fields only.
3. Carry Vault's Acumatica session-limit and semantic notes into the Acumatica readiness backlog.
4. Treat RLS/app-role split as the reference pattern if Company Brain grows from static/internal service into an authenticated multi-user API.
5. After `vault-ui`, `vault-gateway`, and `cortex` are inspected, make an owner-approved archive decision for the Vault family.

## Bottom Line

Vault is useful evidence, not the center of gravity. The optimal path is Company Brain as the active knowledge system, TractionOS as the operating dashboard, and Vault as a salvage source for security, provenance, and connector lessons.