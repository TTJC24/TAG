# Phase 2 Slice 1 Review Evidence

This file maps the approved internal approval-resolution slice to executable
evidence. The feature suite starts from an empty PostgreSQL 16 database,
applies migrations `0001` through `0004`, loads deterministic seed data, and
runs through the non-owner runtime role.

## Acceptance evidence

| Acceptance criterion                                 | Executable proof                                                                                                                                 | Status            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| Duplicate within seven days replays the prior result | `retains idempotency results for seven days and reaps without racing replay` asserts the same task/result and the `604800`-second snapshot       | Automated         |
| Expired key is reaped and reuse is new intent        | Same test expires a terminal row, runs the reaper, and asserts a distinct task after key reuse                                                   | Automated         |
| Reaper cannot race replay                            | Same test holds the idempotency row lock, proves `SKIP LOCKED` deletes zero, releases it, and then proves deletion                               | Automated         |
| Declarative policy preserves Phase 1 behavior        | `policy.test.ts` evaluates boundary fixtures through the legacy oracle and data evaluator and compares complete behavioral output                | Automated         |
| Policy versions and rules are immutable              | Migration revokes mutation and installs immutable-row triggers; activation feature test uses only guarded functions                              | Database-enforced |
| Author cannot activate own version                   | `enforces two-person policy activation, permits one-person revert, and audits changes` rejects author-as-activator                               | Automated         |
| A new version requires two actors                    | Same test rejects activation without a distinct actor's request, then activates after distinct review                                            | Automated         |
| Prior approved version supports single-actor revert  | Same test restores seeded version 1 with one authorized actor                                                                                    | Automated         |
| Policy change is audited                             | Same test asserts the immutable activation fact and `approval_policy.activated` audit event                                                      | Automated         |
| Approve reaches terminal completion                  | `approves once, reaches terminal state, removes pending work, and preserves the root trace` asserts `awaiting_approval -> approved -> completed` | Automated         |
| Reject reaches rejected terminal                     | `rejects once and reaches the rejected terminal state` asserts `awaiting_approval -> rejected`                                                   | Automated         |
| Illegal transition is rejected by PostgreSQL         | Approval feature test attempts a terminal transition; the Phase 1 transition test also exercises raw invalid function/direct writes              | Automated         |
| Cross-organization resolution is rejected            | Approval feature test asserts API `403` and zero rows from a direct runtime-role RLS query                                                       | Automated         |
| Duplicate resolution is idempotent                   | Approval feature test repeats the identical command and asserts prior-result replay, one resolution, and one audit event                         | Automated         |
| Resolution audit preserves root trace                | Approve and reject tests compare intake, transition, resolution, and audit trace IDs end to end                                                  | Automated         |
| Queue reflects resolution                            | Approval test asserts approval-pending work leaves the open queue and the immutable recent outcome appears                                       | Automated         |
| Task detail shows resolution history                 | Approval test asserts decision, resolver, reason, policy version, resulting state, approvals, transitions, and audit history                     | Automated         |
| Workspace type-checks                                | `pnpm typecheck`                                                                                                                                 | Automated command |
| Workspace builds                                     | `pnpm build`                                                                                                                                     | Automated command |
| Clean PostgreSQL 16 migration and feature suite      | `pnpm test:feature`                                                                                                                              | Automated command |
| Pull-request verification                            | GitHub Actions check `verify` runs formatting, typecheck, clean PostgreSQL feature tests, and build                                              | Hosted check      |

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

## Integrity boundaries

- The audit chain detects partial database-history tampering. It is not an
  external cryptographic anchor against a privileged administrator who
  rewrites and re-hashes the complete stream.
- Seven-day expiry makes a later duplicate a new intent. Business-semantic
  duplicate detection is not implied.
- Declarative policy can require or block approval but cannot grant a runtime
  permission or expose an absent external-write adapter.
- Internal approval completion records authorization only. It performs no
  external action.

## Deferred, explicit

| Deferred capability               | Why safe for this slice                                                                    | Forcing trigger                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Administrative dead-letter replay | Retries remain bounded and exhausted jobs are visible; all current work is internal        | Before scheduled production ingestion or a production worker SLO  |
| N-approver collection             | The schema/evaluator can represent it, but seeded `phase1-v1-data` needs one approver only | Before activating a policy with `requires_n_approvers`            |
| Cancel/expiry approval outcomes   | Approved slice requires only approve/reject terminal decisions                             | A separately approved approval-lifecycle slice                    |
| External action execution         | Approval has no adapter or source-system effect                                            | Separate external-write architecture/security approval            |
| Strict hosted merge protection    | Reviewer approved the runbook's single-human-committer exception                           | A second human committer or this repository becoming a dependency |
