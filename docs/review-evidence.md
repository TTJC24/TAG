# Phase 3 Review Evidence

This file maps the governed internal slices and the first disabled-by-default
Gmail-draft external-write slice to executable evidence. The feature suite starts from
an empty PostgreSQL 16 database, applies migrations `0001` through `0008`,
loads deterministic seed data, and runs through separate non-owner API and
worker runtime roles.

## Gmail draft external-write evidence

| Acceptance criterion                      | Executable proof                                                                                                                                                                                                    | Status                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `drafts.create` only; no send code path   | Executor unit test asserts the sole capability, exact compose scope, and fixed transport; feature test asserts `messages.send` is absent from capabilities and its API route is `404`                               | Automated                     |
| Disabled and inert by default             | `ships disabled, exposes drafts.create only, and preserves internal execution` proves preview is rejected with no config and deterministic internal execution still completes                                       | Automated                     |
| Exact dry-run before external command     | `previews exactly...` compares persisted/returned `to`, `subject`, and `body`, then asserts zero Gmail commands and zero results before authorization                                                               | Automated                     |
| Existing approval is required             | Preview service and database trigger require the bound approval to be approved and the action to be `draft_external_follow_up`                                                                                      | App + database enforced       |
| Organization kill switch and allowlist    | Success test rejects an outside domain before provider invocation; kill-switch test disables after authorization, proves zero provider calls, records abandonment, returns to `approved`, then completes internally | Automated                     |
| Second explicit authorization             | Success test proves preview alone creates no command; authorization creates one immutable authorization, Gmail command, and outbox item                                                                             | Automated + database enforced |
| Duplicate authorization and result replay | Success test replays authorization to the same IDs, forces outbox redelivery after success, and asserts one provider call, one result, and the same stored draft ID                                                 | Automated                     |
| Typed untrusted provider output           | Worker validates generic execution output and the Gmail-specific `drafts.create` schema plus rendered-payload-hash equality before persistence                                                                      | Automated path                |
| Bounded retries and visible dead letter   | `retries a failed drafts.create within bounds and exposes the dead letter` proves attempts 1/2 fail, attempt 3 terminally fails, and the exact dead letter appears in the executive queue                           | Automated                     |
| Organization isolation                    | Success test proves cross-org API `403` and zero direct-ID rows under the other organization’s runtime RLS scope                                                                                                    | Automated                     |
| Immutable audit and root trace            | Success test asserts approval, preview, authorization, execution, and `gmail_draft.created` share the intake trace; created event records capability, authorization, and draft ID                                   | Automated                     |
| Task detail and queue                     | Detail response includes config state, exact previews, authorizations, abandonments, command/result and draft ID/link; queue counts `awaiting_external_authorization` and exposes execution dead letters            | Automated + build             |
| No real network in tests                  | Feature tests inject an in-memory `GmailDraftCreateTransport`; production network transport is not instantiated by API/tests and worker runtime defaults disabled                                                   | Structural + automated        |
| Ciphertext at rest                        | `encrypts credentials...` reads the credential row through the migration role and proves ciphertext/wrapped key do not contain the submitted token; API runtime has no table access                                 | Automated + DB grants         |
| Worker-only, organization-scoped load     | Same test proves API query denial, zero cross-org rows under worker RLS, successful active-version load, and rejected prior-version load after rotation                                                             | Automated + RLS               |
| Exact OAuth scope                         | Typed service and database constraint accept exactly `gmail.compose`; feature test rejects a credential that adds `gmail.modify` without reflecting the token                                                       | Automated + DB constraint     |
| Rotation and revocation                   | Rotation returns the replaced ID, leaves the new credential immediately usable, makes the old version unusable, and publishes a bounded mocked OAuth-revocation job                                                 | Automated                     |
| Organization/global kill                  | Organization test proves synchronous invalidation plus internal fallback; global test invalidates active bindings in USA and FSI and audits both under one trace                                                    | Automated                     |
| Credential telemetry is metadata-only     | Feature tests assert plaintext absent from raw envelope fields and durable audit/trace text; load/use/revoke events contain IDs, fingerprint, purpose, scope, outcome, and trace only                               | Automated                     |
| Startup invariants                        | Worker startup assertion is exercised with the dedicated worker login and refuses unsafe identity/key/storage conditions; no configuration or key enables network execution                                         | Automated + structural        |
| Workspace and migration verification      | `pnpm typecheck`, `pnpm build`, and `pnpm test:feature` against clean PostgreSQL 16                                                                                                                                 | Automated commands            |
| Pull-request verification                 | GitHub Actions check `verify` runs formatting, typecheck, unit tests, clean PostgreSQL feature tests, and build                                                                                                     | Hosted check                  |

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
| Provider-neutral seam, internal path preserved  | Executor unit tests prove deterministic internal output; disabled-connector feature test proves the existing internal path still completes without invoking Gmail             | Automated         |
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

The Phase 3 tests run with all Phase 1 and Phase 2 tests; no prior test was removed or
weakened. The suite continues to prove:

- database-enforced workflow transitions and task-status projection equality;
- forced organization RLS and startup rejection of superuser, `BYPASSRLS`,
  and protected-table-owner identities;
- append-only, independently verifiable audit hash chains with deterministic
  tamper detection;
- schema validation of untrusted deterministic-agent output;
- intake-to-worker-to-audit trace equality;
- bounded outbox retries and executive-queue dead-letter visibility; and
- no external-send, live-model, ERP, accounting, or non-Gmail-draft write
  capability.

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
- Approval alone records authorization only. Internal completion records
  `externalEffect=false`. The separately authorized Gmail branch may record
  only an unsent `drafts.create` result.

## Deferred, explicit

| Deferred capability                   | Why safe for this slice                                                                                                                                                   | Forcing trigger                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Administrative dead-letter replay     | Retries remain bounded and exhausted jobs are visible; all current work is internal                                                                                       | Before scheduled production ingestion or a production worker SLO   |
| N-approver collection                 | The schema/evaluator can represent it, but seeded `phase1-v1-data` needs one approver only                                                                                | Before activating a policy with `requires_n_approvers`             |
| Cancel/expiry approval outcomes       | Approved slice requires only approve authorization and reject termination                                                                                                 | A separately approved approval-lifecycle slice                     |
| Ambiguous Gmail create crash recovery | Gmail `drafts.create` exposes no client idempotency key; stable stored-result replay is safe, but post-accept/pre-commit process loss needs an explicit production policy | Before enabling network transport in any organization              |
| Gmail send or other mutations         | The connector exposes only `drafts.create`; no send route, method, or scope exists                                                                                        | Separate architecture/security approval; never implied by this ADR |
| Strict hosted merge protection        | Reviewer approved the runbook's single-human-committer exception                                                                                                          | A second human committer or this repository becoming a dependency  |
| Scheduled/connector CSV ingestion     | Internal file upload proves batch semantics without any production source credential                                                                                      | A separately approved connector/read architecture                  |
| Batch rollback/compensation           | Rows have no external effects; partial outcomes are explicit immutable facts                                                                                              | Before any batch row can cause an external effect                  |
