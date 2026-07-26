# ADR 0008: Operator Dead-Letter Replay of Internal Executions

Status: Accepted and implemented; internal-only, no external write enabled
Date: 2026-07-26

## Context

A deterministic-internal execution that exhausts its bounded retries dead-letters
its outbox job and drives the workflow to the terminal `execution_failed` state.
Prior to this change a dead letter was _visible_ (executive queue, task detail)
but not _recoverable_: an operator who remediated the underlying cause had no
supported path to re-run the work. This was the sole remaining internal
operability gap and the last item deferrable before any live external write.

The execution model made replay non-trivial. An execution command is immutable,
its `execution_results` row is `UNIQUE` per command, a deferred constraint
requires every command to carry a matching audit event, a trigger enforced at
most one non-abandoned command per approval, and a `UNIQUE` index forbade any
second `(organization, approval, provider)` command. Terminal states were, by
design, terminal.

## Decision

Replay mints a **new** immutable execution command against the still-`approved`
approval rather than mutating the failed one. The original command and its
`execution_failed` result are preserved as history; the fresh command carries
its own succeeded/failed result. Concretely:

- A DB-enforced `execution_failed -> executing` transition is added to
  `workflow_allowed_transitions`, and both `transition_workflow` and
  `begin_execution` are extended to permit the re-open only for a
  `deterministic_internal` command — the same guard shape as
  `approved -> executing`.
- `replay_internal_execution` is a `SECURITY DEFINER` function gated by a new
  `executions.replay` permission. It verifies the workflow is
  `execution_failed`, the approval is still `approved`, and the supplied job is
  a genuine `dead_letter` for the original command; it then mints the new
  command, enqueues a fresh `issue.execute` job, and records an immutable
  `execution_replays` linkage row.
- The per-approval exclusivity `UNIQUE` index is dropped; the
  `guard_execution_command_insert` trigger is relaxed to block a new command
  only when a prior non-abandoned command has **not** terminally failed. This
  keeps duplicate-live-trigger protection while allowing replay of a failed
  command. The trigger is now the sole enforcer of one active command per
  approval.
- `verify_execution_command_audited` accepts `execution.replay_requested`
  alongside `execution.requested` as a valid audited origin for a command.
- `execution_replays` is append-only (immutability trigger), organization-scoped
  under forced RLS, requires a matching audit event (deferred constraint), and
  is unique per replayed dead-letter so the same dead letter cannot be replayed
  twice.

The service (`requestInternalExecutionReplay`, `POST
/v1/approvals/:approvalId/executions/replay`) is idempotent, carries the
original approval's trace through to the replay command and audit event, and
requires `executions.replay` (seeded to the admin permission set only).

## Consequences

- Replay is auditable, org-isolated, idempotent, and DB-enforced end to end;
  no immutable row is mutated and the original dead letter remains history.
- A repeated failure can be replayed again (each failed command no longer
  blocks a successor); the `execution_replays` dead-letter uniqueness prevents
  double-replaying the same job.
- Scope is internal-only. Replay of a dead-lettered `gmail_draft` execution is
  deferred: it involves the external-authorization state and remains gated
  behind the live-pilot work.
- A task-detail "Replay" UI action is a thin follow-up over the shipped API.
