# Phase 2 Slice Decision

Status: Approved and implemented

Date: 2026-07-25

## Approved foundation

- Idempotency retention is seven days under ADR 0002.
- Declarative, immutable approval policy is accepted under ADR 0003.
- The first Phase 2 slice is internal approval resolution.
- A single-committer CI exception is accepted under the runbook trigger.

## Implemented slice one: internal approval resolution

The slice closes the existing internal loop:

```text
manual intake
  -> classification
  -> cited recommendation
  -> awaiting approval
  -> approve -> approved
  -> reject  -> rejected
```

The permitted human records an approve/reject decision and reason. PostgreSQL
updates the approval, workflow, task-status projection, immutable resolution,
workflow transitions, and audit history transactionally. Approval produces no
external action and is not completion.

### Acceptance contract

- Only a user with `approvals.decide` in the owning organization may resolve.
- API authorization rejects unauthorized organization scope with `403`;
  forced RLS returns no cross-organization approval row at the query layer.
- Approval and rejection use only database-allowed transitions and reach
  executable `approved` and terminal `rejected` states respectively.
- Direct workflow, task-status, approval-decision, transition-history, and
  resolution-history mutation remains rejected.
- A resolution records actor, reason, policy-version ID/content hash, resulting
  state, root trace ID, and request ID.
- Repeating the same resolution command inside the retention window replays
  the stored result and creates neither a second transition nor a second audit
  event.
- The executive queue removes resolved work from approval-pending counts and
  shows recent outcomes.
- Task detail shows the decision, resolver, reason, policy version, resulting
  state, and audit history.

### Deliberately excluded

- CSV import and batch intake.
- Cancel/expiry decisions and N-approver collection.
- External execution or source-system effects.
- Production connectors or source-system reads.
- Live model calls.
- Email, chat, or other external sends.
- ERP, CRM, accounting, payment, master-data, or any other external write.
- Temporal and new screens unrelated to the approval loop.

## Implemented follow-on: deterministic internal execution

The separately approved follow-on closes approved work through an immutable,
internal-only execution outcome:

```text
approved -> executing -> completed
                      \-> execution_failed
```

The outbox worker invokes only `deterministic_internal`, validates its output,
and stores one immutable execution result linked to the exact approval,
recommendation, policy version, action, and root trace. Retries are bounded;
exhaustion produces `execution_failed`, a dead-letter row, and queue
visibility. No external provider, connector, send, or source-system write is
enabled.

Controlled CSV intake remains unselected. Any external execution capability
requires a separately approved architecture, security model, and slice.
