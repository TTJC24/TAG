# Phase 1 Vertical-Slice Implementation Plan

Status: Implemented; validation complete
Date: 2026-07-25

## Delivery boundary

Implement exactly one behavior chain:

```text
manual issue intake
  -> append-only manual source version
  -> normalized task
  -> database-enforced workflow transition
  -> deterministic, schema-validated classification
  -> deterministic, cited recommendation
  -> code-based approval policy
  -> persisted terminal or awaiting-approval state
  -> immutable audit history
  -> executive queue and task detail
```

CSV import, live model calls, production connectors, Temporal, external sends,
and source-system writes remain outside this phase.

## Implementation sequence

1. Add a forward-only Phase 1 migration with the workflow transition graph and
   database transition function, row-level-security policies, raw-version
   metadata, and bounded outbox retry/dead-letter fields.
2. Add deterministic local seeds for the four entities, provisional roles,
   permissions, users, memberships, manual-intake source systems, and prompt
   versions.
3. Implement scoped PostgreSQL transactions that enter the non-owner
   application role and set an explicit organization authorization context.
4. Implement provider-neutral identity plus local-header and Google Workspace
   OIDC adapters.
5. Implement canonical hashing and the transactional audit writer.
6. Implement idempotent manual intake, source versioning, normalized task
   creation, the initial workflow transition, and classification outbox event.
7. Implement the deterministic classifier and recommendation agent. Parse
   their outputs through shared runtime schemas before any database write.
8. Implement the worker lease, bounded attempt, recovery, and dead-letter
   behavior entirely in PostgreSQL.
9. Implement approval policy and the final workflow branch to
   `awaiting_approval` or `completed`.
10. Implement the API, executive queue, issue form, and task-detail history.
11. Add substantive tests alongside each behavior.
12. Validate clean PostgreSQL 16 migration/seed, type checks, feature tests,
    production builds, and documented local commands.

## Database enforcement

- `transition_workflow(...)` is the only accepted state-change path.
- A trigger rejects direct changes to `workflows.current_state`.
- A trigger rejects direct inserts into `workflow_transitions`.
- The transition function checks workflow type, current state, expected
  version, and the approved transition graph.
- Application-role row-level security requires an explicit organization array.
- Cross-organization associations continue to use composite foreign keys.
- Immutable tables retain update/delete rejection triggers.

## Test-first acceptance map

| Requirement           | Test                                                                 |
| --------------------- | -------------------------------------------------------------------- |
| Permitted intake      | API integration test with seeded operator                            |
| Idempotent duplicate  | repeated request and conflicting-payload cases                       |
| Typed model output    | deterministic and malformed provider unit tests                      |
| Permitted transitions | database tests for valid, invalid, and direct updates                |
| Approval decision     | policy unit tests and high-exposure integration case                 |
| Audit immutability    | integration update/delete rejection                                  |
| Entity isolation      | API authorization and direct RLS integration tests                   |
| Bounded retries       | failed job lease/retry/dead-letter integration test                  |
| Executive queue       | API assertions for open, overdue, blocked, and approval              |
| Task history          | API assertions for source, recommendation, workflow, approval, audit |

## Review checkpoint

Stop after the vertical slice passes. Do not begin CSV import or any production
connector/write capability without the next review.
