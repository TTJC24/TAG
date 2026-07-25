# Workflow Contract

The executable TypeScript contract is in `packages/workflows`.

## Durability

The API executes each accepted command in one PostgreSQL transaction:

1. claim the organization-scoped idempotency key;
2. authorize the actor and evaluate approval policy;
3. lock/load the workflow and verify expected version;
4. compute a deterministic transition;
5. update workflow state/version and its task-status projection;
6. append the immutable transition;
7. append the audit event;
8. append any outbox messages;
9. commit.

Workers deliver outbox messages at least once. Handlers therefore use command
and idempotency keys and may safely observe duplicates.

Internal execution deliberately separates authorization from outcome:

```text
awaiting_approval -> approved -> executing -> completed
                                     \-----> execution_failed
awaiting_approval -> rejected
```

PostgreSQL permits `approved -> executing` only when the transition references
an immutable execution command for that exact approval and workflow. It permits
an execution terminal transition only when it references the matching
immutable execution result. No application update or provider response can
skip those guards.

## State rules

- The workflow definition is pure domain logic and cannot query providers or
  queues.
- Agents recommend results; commands decide whether a transition is accepted.
- Immutable policy data interpreted by one deterministic evaluator—not
  prompts—sets risk and approval behavior.
- Provider output is untrusted and must pass a typed schema before workflow
  use or persistence.
- Failed or blocked work remains visible and retains its history.
- Human waits use persisted states and deadlines rather than sleeping worker
  processes.

## Temporal migration boundary

`WorkflowEngine` is the application port. The current implementation uses
PostgreSQL and a transactional outbox; Redis is never authoritative. A future
Temporal adapter may orchestrate waits, schedules, and compensation while
continuing to call the same domain transition and policy evaluator.
