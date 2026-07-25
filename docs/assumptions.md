# Assumptions, Decisions Pending, and Risk Register

Date: 2026-07-25

## Working assumptions

These assumptions enabled the reversible Phase 1 slice. They are not
production decisions.

| Area                | Working assumption                                                                      | Revisit before                        |
| ------------------- | --------------------------------------------------------------------------------------- | ------------------------------------- |
| Codename            | Use `operating-layer` in package names only                                             | Permanent naming                      |
| Runtime             | Node.js 22 LTS and TypeScript                                                           | First production deployment           |
| Package tooling     | pnpm workspaces with Turborepo task orchestration                                       | CI implementation                     |
| Web                 | Next.js App Router                                                                      | UI implementation                     |
| API                 | NestJS-compatible modular TypeScript service, using Fastify in production               | API feature work                      |
| Worker              | Separate TypeScript worker process                                                      | Background processing                 |
| Database            | Managed PostgreSQL 16+ with `pgcrypto`; `pgvector` is optional until retrieval work     | Environment provisioning              |
| Async jobs          | PostgreSQL is authoritative; an outbox and Redis-backed workers dispatch async work     | High-volume or long-running workflows |
| Workflow durability | Explicit persisted state machine for Phase 1; preserve an adapter boundary for Temporal | Phase 3 workflow automation           |
| Identity            | Google Workspace OIDC through an authentication adapter                                 | Production authentication             |
| Object storage      | S3-compatible storage for immutable raw payload versions                                | Connector implementation              |
| Models              | Deterministic provider by default behind a provider-neutral interface                   | Live model-backed agent enablement    |
| Tenant model        | One business group with strict organization/entity access controls                      | Production data load                  |
| Time                | Store instants in UTC and render in the user’s configured zone                          | UI implementation                     |

## Known unknowns

- Acumatica version, tenant/company/branch structure, API endpoints, throttling, and read-only scopes.
- Whether Pipedrive remains the authoritative CRM.
- Google Workspace domains, groups, SSO enforcement, and administrator contacts.
- Production document system and source-of-truth rules.
- Final roles, approvers, segregation-of-duties rules, and financial materiality thresholds.
- Authoritative task systems and duplicate-resolution policy.
- Hosting provider, regions, recovery objectives, and data residency requirements.
- Approved model providers and restrictions on sending company data outside the private environment.
- Retention periods for source payloads, agent artifacts, logs, and audit exports.
- Initial operators, platform administrators, and incident owners.
- Exact customer/vendor/order/project identifiers and cross-entity record-linking rules.

None of these unknowns should be silently encoded into connector or workflow logic.

## Risk register

| Risk                                          | Impact   | Initial control                                                                        | Owner/status           |
| --------------------------------------------- | -------- | -------------------------------------------------------------------------------------- | ---------------------- |
| Cross-entity data leakage                     | Critical | Organization membership checks at every service boundary; scoped queries; access tests | Unassigned             |
| Unauthorized ERP/accounting write             | Critical | No write credentials or write methods in Phase 1; deny-by-default action policy        | Controlled by scope    |
| Audit records altered or omitted              | Critical | Append-only database table, transactionally coupled audit writes, hash chaining/export | Design defined         |
| Unsupported AI recommendation                 | High     | Structured output, citations, freshness, confidence, verification, human approval      | Design defined         |
| Source data becomes stale                     | High     | Sync watermark, observed/source timestamps, stale-data flags, connector health         | Design defined         |
| Duplicate issue creation                      | High     | Source identity uniqueness, idempotency keys, deterministic import keys, manual merge  | Design defined         |
| Prompt contains credentials or excessive data | High     | Secret references only; redaction and data-minimizing context builder                  | Design defined         |
| Workflow job is lost or repeated              | High     | Persisted transition, transactional outbox, idempotent handlers                        | Design defined         |
| LLM vendor lock-in                            | Medium   | Provider contract and normalized model telemetry                                       | Design defined         |
| Cost overrun                                  | Medium   | Per-run budgets, task routing, caching, usage ledger, hard caps                        | Pending implementation |
| Raw payload exposure                          | High     | Encrypted object storage, short-lived access, metadata-only UI, retention decision     | Pending infrastructure |
| Incorrect automatic record merge              | High     | Automatic merging prohibited; link suggestions require review                          | Controlled by scope    |

## Decisions requiring explicit approval

The implementation must pause before:

- permanent product naming;
- external or source-system writes;
- production credential storage;
- sending external communications;
- financial approval thresholds or retention periods;
- payment, journal, customer-master, or vendor-master workflows;
- automated record merges;
- provider selection where company data would leave a private environment.

## Questions for the first architecture review

1. Which Google Workspace domain and groups should map to initial roles?
2. Who may see all four entities, and who must be restricted to one?
3. Which three users will act as system administrator, operational approver, and audit reviewer?
4. Is a managed Temporal service acceptable for Phase 3, or must all workflow infrastructure be self-hosted?
5. Which hosting region and recovery objectives are required?
6. Can synthetic fixtures be used for acceptance testing before read-only credentials are issued?
