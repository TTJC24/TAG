# Workflow Contract

The executable TypeScript contract is in `packages/workflows`.

## Phase 1 durability

The API executes each accepted command in one PostgreSQL transaction:

1. claim the organization-scoped idempotency key;
2. authorize the actor and evaluate risk policy;
3. lock/load the workflow and verify expected version;
4. compute a deterministic transition;
5. update workflow state/version;
6. append the immutable transition;
7. append the audit event;
8. append any outbox messages;
9. commit.

Workers deliver outbox messages at least once. Handlers therefore use command and idempotency keys and may safely observe duplicates.

## State rules

- The workflow definition is pure domain logic and cannot query providers or queues.
- Agents recommend results; commands decide whether a transition is accepted.
- Policy code—not prompts—sets risk and approval behavior.
- Failed or blocked work remains visible and retains its history.
- Replay requires permission and emits a new audit event.
- Human waits use persisted states and deadlines rather than sleeping worker processes.

## Temporal migration boundary

`WorkflowEngine` is the application port. The initial implementation may use PostgreSQL/outbox/Redis. A future Temporal adapter will orchestrate waits, schedules, and compensation while continuing to call the same domain transition and policy code.
