# Phase 2 Review Evidence

This file maps the approved deterministic internal-execution and controlled
CSV batch-intake slices to executable evidence. The feature suite starts from
an empty PostgreSQL 16 database, applies migrations `0001` through `0006`,
loads deterministic seed data, and runs through the non-owner runtime role.

## Controlled CSV batch-intake evidence

| Acceptance criterion                            | Executable proof                                                                                                                                                                                                                    | Status                        |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Real internal file upload, no connector         | Web file control reads the selected `.csv`; API accepts the typed `csv-issue.v1` upload; health reports `csvUploadMode=internal`; no connector code is invoked                                                                      | Automated path                |
| Raw source is exact and immutable               | `imports mixed rows with immutable evidence, RLS, and two idempotency layers` compares exact UTF-8 bytes/checksum/timestamps/identity/schema/retention and proves a privileged update is trigger-rejected                           | Automated                     |
| Batch audit references source                   | The mixed-batch test asserts exactly one `csv.batch.imported` event whose source IDs contain the batch source; migration `0006` adds a deferred database constraint                                                                 | Automated + database-enforced |
| Typed row validation before task creation       | Parser unit tests cover quoting and mixed shape/schema failures; feature test asserts zero tasks before valid row jobs and no job for the rejected row                                                                              | Automated                     |
| Valid rows reuse the existing pipeline          | Mixed-batch test drains valid rows through normalize → classify → recommend → declarative policy and asserts task/recommendation source links                                                                                       | Automated                     |
| Mixed rows partially succeed                    | A three-row batch finishes as two accepted, one rejected, zero pending/failed, with per-row outcomes and reasons                                                                                                                    | Automated                     |
| Batch idempotency                               | Same organization/key/payload returns HTTP `200`, the same batch/source, and the stored live result; existing claim logic rejects hash conflicts                                                                                    | Automated                     |
| Row idempotency                                 | Forced at-least-once redelivery produces one task, one accepted result, and one `csv.row.accepted` audit                                                                                                                            | Automated                     |
| Independent bounded retry/dead letter           | `retries a downstream row failure, dead-letters it, and exposes it` removes the source projection after normalization, proves attempts 1/2 fail and 3 dead-letters, then asserts immutable failed result and guarded `failed` state | Automated                     |
| Failure visible in management surfaces          | The failed batch row exposes safe error/attempts/task and executive queue contains the exact `issue.classify` dead letter                                                                                                           | Automated                     |
| Organization authorization and RLS              | Cross-org upload/result return API `403`; direct-ID query under the other organization's runtime scope returns zero rows                                                                                                            | Automated                     |
| Trace continuity                                | Mixed and failed tests compare batch, row outbox, row result, workflow transition, and audit trace IDs                                                                                                                              | Automated                     |
| UI result reporting                             | Upload screen documents the contract; result page shows batch metadata/counts plus pending, accepted, rejected, or failed row details and task links                                                                                | Build + smoke/manual          |
| Workspace type-checks                           | `pnpm typecheck`                                                                                                                                                                                                                    | Automated command             |
| Workspace builds                                | `pnpm build`                                                                                                                                                                                                                        | Automated command             |
| Clean PostgreSQL 16 migration and feature suite | `pnpm test:feature`                                                                                                                                                                                                                 | Automated command             |
| Pull-request verification                       | GitHub Actions check `verify` runs formatting, typecheck, unit tests, clean PostgreSQL feature tests, and build                                                                                                                     | Hosted check                  |

## Internal execution acceptance evidence

| Acceptance criterion                            | Executable proof                                                                                                                                                              | Status            |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Provider-neutral seam, internal mock only       | `packages/executors/src/index.test.ts` proves deterministic internal output and rejects external-provider resolution; feature test also makes the database reject `external`  | Automated         |
| Approved task executes to `completed`           | `executes an approved task once to completed with RLS and trace continuity` drives API → outbox → worker → immutable result → terminal state                                  | Automated         |
| Failure becomes terminal and dead-lettered      | `retries deterministic execution failure to terminal dead-letter visibility` proves two bounded retries, third-attempt finalization, `execution_failed`, and queue visibility | Automated         |
| Non-approved execution is DB-rejected           | `rejects once and reaches the rejected terminal state` attempts raw pending→executing and raw enqueue against pending/rejected approvals                                      | Automated         |
| Only guarded transitions can execute            | Migration `0005` requires a referenced immutable execution command before `executing` and an immutable result before either terminal transition                               | Database-enforced |
| Duplicate execution is idempotent               | Success feature test replays the same API command and asserts one command, one outbox item, one result, and one outcome audit                                                 | Automated         |
| Terminal states have no onward transition       | Success/failure tests call `transition_workflow()` from `completed` and `execution_failed` and assert PostgreSQL rejection                                                    | Automated         |
| Cross-organization execution is isolated        | Success feature test asserts API `403` and zero direct-ID rows through the other organization’s runtime RLS scope                                                             | Automated         |
| Root trace remains continuous                   | Success/failure tests compare intake, approval, execution command, outbox, result, and execution-audit trace IDs                                                              | Automated         |
| Execution output is validated before storage    | Worker parses the provider’s unknown output through `executionProviderOutputSchema`; feature results prove only typed terminal payloads persist                               | Automated path    |
| Execution records are immutable and scoped      | Migration `0005` uses composite organization foreign keys, forced RLS, mutation triggers/revoked grants, and one-result uniqueness                                            | Database-enforced |
| Queue and task detail show execution state      | Success/failure tests assert recent completed/failed outcomes, in-execution and failure counts, dead-letter output, commands/results, provider, result, and audit history     | Automated         |
| Full process path works                         | `pnpm test:smoke` starts built API/worker/web with PostgreSQL 16 and proves approval → queued internal execution → completed plus rendered queue/detail evidence              | Automated command |
| Workspace type-checks                           | `pnpm typecheck`                                                                                                                                                              | Automated command |
| Workspace builds                                | `pnpm build`                                                                                                                                                                  | Automated command |
| Clean PostgreSQL 16 migration and feature suite | `pnpm test:feature`                                                                                                                                                           | Automated command |
| Pull-request verification                       | GitHub Actions check `verify` runs formatting, typecheck, unit tests, clean PostgreSQL feature tests, and build                                                               | Hosted check      |

## Preserved Phase 1 guarantees

The Phase 2 tests run with all Phase 1 tests; no prior test was removed or
weakened. The suite continues to prove:

- database-enforced workflow transitions and task-status projection equality;
- forced organization RLS and startup rejection of superuser, `BYPASSRLS`,
  and protected-table-owner identities;
- append-only, independently verifiable audit hash chains with deterministic
  tamper detection;
- schema validation of untrusted deterministic-agent output;
- intake-to-worker-to-audit trace equality;
- bounded outbox retries and executive-queue dead-letter visibility; and
- no connector, live-model, external-send, ERP, or accounting capability.

The same suite also retains the accepted Phase 2 foundation: seven-day
idempotency replay/reaping and lock-race proof, declarative-policy equivalence,
two-person new-version activation, single-actor prior-version restore,
idempotent approve/reject resolution, and approval trace history.

## Integrity boundaries

- The audit chain detects partial database-history tampering. It is not an
  external cryptographic anchor against a privileged administrator who
  rewrites and re-hashes the complete stream.
- Seven-day expiry makes a later duplicate a new intent. Business-semantic
  duplicate detection is not implied.
- Declarative policy can require or block approval but cannot grant a runtime
  permission or expose an absent external-write adapter.
- Approval records authorization only. `completed` records a deterministic
  internal outcome with `externalEffect=false`; it performs no external action.

## Deferred, explicit

| Deferred capability               | Why safe for this slice                                                                    | Forcing trigger                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Administrative dead-letter replay | Retries remain bounded and exhausted jobs are visible; all current work is internal        | Before scheduled production ingestion or a production worker SLO  |
| N-approver collection             | The schema/evaluator can represent it, but seeded `phase1-v1-data` needs one approver only | Before activating a policy with `requires_n_approvers`            |
| Cancel/expiry approval outcomes   | Approved slice requires only approve authorization and reject termination                  | A separately approved approval-lifecycle slice                    |
| External action execution         | Only the deterministic internal provider exists; no adapter or source-system effect        | Separate external-write architecture/security approval            |
| Strict hosted merge protection    | Reviewer approved the runbook's single-human-committer exception                           | A second human committer or this repository becoming a dependency |
| Scheduled/connector CSV ingestion | Internal file upload proves batch semantics without any production source credential       | A separately approved connector/read architecture                 |
| Batch rollback/compensation       | Rows have no external effects; partial outcomes are explicit immutable facts               | Before any batch row can cause an external effect                 |
