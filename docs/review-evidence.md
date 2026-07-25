# Phase 2 Internal Execution Review Evidence

This file maps the approved deterministic internal-execution slice to
executable evidence. The feature suite starts from an empty PostgreSQL 16
database, applies migrations `0001` through `0005`, loads deterministic seed
data, and runs through the non-owner runtime role.

## Acceptance evidence

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
