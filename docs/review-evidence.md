# Phase 1 Review Evidence

This document maps the Phase 1 acceptance criteria to executable evidence.
Several tests intentionally cover multiple criteria because they exercise one
transactional workflow end to end. Items without complete automated proof are
called out rather than represented as passing.

| Acceptance criterion                                                            | Evidence                                                                                                                    | Status                                                        |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Authorized user creates an issue                                                | `vertical-slice.integration.test.ts` — “creates, deduplicates, classifies, recommends, and queues approval”                 | Automated                                                     |
| Issue becomes a normalized task                                                 | Same feature test asserts the initial `normalized` result and final persisted task                                          | Automated                                                     |
| Classification and recommendation are schema validated                          | `agents.test.ts` runs the deterministic provider through the production parser and rejects malformed untrusted output       | Automated                                                     |
| Workflow uses only allowed transitions                                          | Database integration test rejects direct workflow updates, invalid transition-function calls, and direct transition inserts | Automated                                                     |
| Approval requirement is determined                                              | Policy unit cases plus high-exposure feature case                                                                           | Automated                                                     |
| Every material action produces immutable audit evidence                         | Feature test asserts the workflow audit trail and mutation rejection                                                        | Automated, with chain-tamper verification not yet implemented |
| Duplicate idempotency key does not duplicate records                            | Feature test repeats the same request and receives the original task/workflow result; conflicting payload returns `409`     | Automated                                                     |
| Unauthorized user cannot access another organization                            | API denial and direct application-role RLS query returning zero rows                                                        | Automated                                                     |
| Failed jobs retry within policy and become visible when exhausted               | Feature test drives an unsupported job through bounded attempts to `dead_letter` and asserts queue visibility               | Automated                                                     |
| Executive queue shows open, overdue, blocked, and approval-pending fields       | Feature test asserts open, overdue, and approval-pending counts plus the blocked count field                                | Automated; no positive blocked fixture                        |
| Task detail shows source, recommendation, workflow, approval, and audit history | End-to-end feature test asserts each collection                                                                             | Automated                                                     |
| All workspace packages type-check                                               | `pnpm typecheck`                                                                                                            | Automated command                                             |
| PostgreSQL 16 migrations apply cleanly                                          | `pnpm test:feature` creates a clean PostgreSQL 16 instance before the suite                                                 | Automated command                                             |
| Feature tests run from one documented command                                   | `pnpm test:feature` in `README.md` and `docs/runbook.md`                                                                    | Automated command                                             |

## Reviewer-requested control proofs

| Control                       | Current evidence                                                                                           | Known limitation                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Database-enforced transitions | Allowed-transition table, guarded transition function, update/insert triggers, and raw SQL rejection tests | Task status is a projection separate from workflow state; the test targets `workflows.current_state` |
| Organization RLS              | Forced RLS for the application role plus a direct cross-organization SQL test                              | Production database identities still require deployment configuration                                |
| Append-only audit             | Application-role `UPDATE` revocation, immutable trigger, and mutation rejection test                       | No independent hash-chain verifier/tamper-detection test yet                                         |
| Idempotency                   | Composite primary key and prior-result replay test                                                         | Key expiry is nullable; final retention/TTL policy is intentionally unresolved                       |
| Approval policy               | Decision and stored approval include `phase1-v1`                                                           | Rules are currently versioned code, not declarative policy data                                      |
| Shared model validation path  | Deterministic and malformed providers both pass through `parseUntrustedModelOutput`                        | Live providers remain disabled                                                                       |
| Trace propagation             | Trace ID is persisted on intake outbox commands and reused by worker transitions/audit writes              | No explicit end-to-end trace equality assertion yet                                                  |
| Dead-letter visibility        | Exhausted job appears in executive queue failure output                                                    | Replay administration is not part of this slice                                                      |
