# Phase 1 Review Evidence

This document maps the Phase 1 acceptance criteria to executable evidence.
Several tests intentionally cover multiple criteria because they exercise one
transactional workflow end to end. Accepted deferrals are explicit below.

| Acceptance criterion                                                            | Evidence                                                                                                                                                       | Status                                 |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Authorized user creates an issue                                                | `vertical-slice.integration.test.ts` — “creates, deduplicates, classifies, recommends, and queues approval”                                                    | Automated                              |
| Issue becomes a normalized task                                                 | Same feature test asserts the initial `normalized` result and final persisted task                                                                             | Automated                              |
| Classification and recommendation are schema validated                          | `agents.test.ts` runs the deterministic provider through the production parser and rejects malformed untrusted output                                          | Automated                              |
| Workflow uses only allowed transitions                                          | Database integration test rejects direct workflow updates, invalid transition-function calls, and direct transition inserts                                    | Automated                              |
| Task status cannot drift from workflow state                                    | Integration test asserts equality after legal transitions and rejects application-role and privileged direct status updates                                    | Automated                              |
| Approval requirement is determined                                              | Policy unit cases plus high-exposure feature case                                                                                                              | Automated                              |
| Audit history is append-only and hash-chained                                   | Integration test verifies untampered history, rejects application-role mutation, performs privileged payload tampering, detects the hash break, and rolls back | Automated                              |
| Duplicate idempotency key does not duplicate records                            | Feature test repeats the same request and receives the original task/workflow result; conflicting payload returns `409`                                        | Automated                              |
| Unauthorized user cannot access another organization                            | API denial and direct application-role RLS query returning zero rows                                                                                           | Automated                              |
| RLS-bypassing runtime identity cannot boot                                      | Integration test rejects the migration superuser and accepts `operating_layer_runtime`                                                                         | Automated                              |
| Trace ID survives intake, worker, and audit                                     | Feature test asserts equality across the classification outbox row, worker transition, and classification audit event                                          | Automated                              |
| Failed jobs retry within policy and become visible when exhausted               | Feature test drives an unsupported job through bounded attempts to `dead_letter` and asserts queue visibility                                                  | Automated                              |
| Executive queue shows open, overdue, blocked, and approval-pending fields       | Feature test asserts open, overdue, and approval-pending counts plus the blocked count field                                                                   | Automated; no positive blocked fixture |
| Task detail shows source, recommendation, workflow, approval, and audit history | End-to-end feature test asserts each collection                                                                                                                | Automated                              |
| All workspace packages type-check                                               | `pnpm typecheck`                                                                                                                                               | Automated command                      |
| PostgreSQL 16 migrations apply cleanly                                          | `pnpm test:feature` creates a clean PostgreSQL 16 instance before the suite                                                                                    | Automated command                      |
| Feature tests run from one documented command                                   | `pnpm test:feature` in `README.md` and `docs/runbook.md`                                                                                                       | Automated command                      |

## Reviewer-requested control proofs

| Control                       | Implemented proof                                                                                                                                                | Boundary                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Database-enforced transitions | Allowed-transition table, guarded transition function, update/insert triggers, and raw SQL rejection tests                                                       | PostgreSQL is authoritative                                                                                  |
| Task-status projection        | `transition_workflow()` updates workflow and task in one transaction; column privileges, guard trigger, and deferred equality triggers reject drift              | Initial task/workflow rows both start at `received`; later writes are transition-only                        |
| Organization RLS              | Forced RLS, direct cross-organization SQL test, boot-time superuser/`BYPASSRLS`/owner rejection, and non-owner runtime role                                      | Migration identity is deliberately separate from runtime                                                     |
| Audit chain                   | Genesis has `previous_hash = NULL`; every event hashes canonical event fields plus sequence/link; verifier recomputes events, linkage, sequence, and stream head | Not externally anchored against a fully privileged administrator who rewrites and re-hashes the entire chain |
| Idempotency                   | Composite primary key and prior-result replay test                                                                                                               | TTL is an accepted deferral below                                                                            |
| Approval policy               | All Phase 1 rules are centralized in `packages/workflows/src/index.ts` and every decision carries `phase1-v1`                                                    | Policy-as-data is an accepted deferral below                                                                 |
| Shared model validation path  | Deterministic and malformed providers both pass through `parseUntrustedModelOutput`                                                                              | Live providers remain disabled                                                                               |
| Trace propagation             | Exact trace equality asserted across intake outbox, worker transition, and audit                                                                                 | No external telemetry backend is selected                                                                    |
| Dead-letter visibility        | Exhausted job appears in executive queue failure output                                                                                                          | Administrative replay is an accepted deferral below                                                          |

## Deferred, accepted

### Idempotency key TTL and retention

- **Deferred:** a non-null expiry and purge schedule for
  `idempotency_keys.expires_at`.
- **Why safe now:** Phase 1 has one internal manual-intake command, retains the
  prior response deterministically, and performs no external side effect.
  Leaving keys unexpired prevents accidental duplicate work.
- **Forcing trigger:** approve retention policy before Phase 2 ingestion or the
  first production multi-tenant deployment, whichever comes first.

### Approval policy as declarative data

- **Deferred:** moving approval rules from a code-versioned module into signed,
  declarative policy records.
- **Why safe now:** every rule is consolidated in the single deterministic
  `packages/workflows/src/index.ts` module, outside prompts and agent code, and
  every decision/approval/audit event is stamped `phase1-v1`. External writes
  are absent, so this is a representation refactor rather than a behavior
  rewrite.
- **Forcing trigger:** complete policy-as-data before the first external write
  capability or the first separately administered customer tenant.

### Administrative dead-letter replay

- **Deferred:** operator-authorized replay tooling and replay audit commands.
- **Why safe now:** retries are bounded and exhausted work is visible in the
  executive queue; Phase 1 actions are internal and create no external side
  effect. Recovery is manual database administration in a local environment.
- **Forcing trigger:** implement before Phase 2 scheduled ingestion or any
  production worker service-level objective.
