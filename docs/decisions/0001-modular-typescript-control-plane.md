# ADR 0001: Modular TypeScript Control Plane

Status: Accepted with mandatory amendments
Date: 2026-07-25

## Context

The operating layer must coordinate four entities across knowledge, ERP, CRM, email, files, finance support, and media production without becoming another source system or an uncontrolled chatbot. The initial team is small, the repository is greenfield, source schemas are unknown, and external writes are prohibited in Phase 1.

## Decision

Use a TypeScript pnpm monorepo with separately deployable Next.js web, modular API, and worker applications.

- PostgreSQL is authoritative for operating-layer state.
- S3-compatible object storage holds immutable raw payload versions.
- Redis dispatches jobs but owns no workflow state.
- Phase 1 uses a persisted state machine, transactional outbox, optimistic versions, and idempotent workers.
- A `WorkflowEngine` port preserves a later Temporal adapter.
- Connector read and controlled-write capabilities are separate interfaces.
- Agent and model providers sit behind typed, structured-output interfaces.
- Authorization is role, organization, object, and action-risk based.
- State mutations, audit events, and outbox events commit atomically.
- Authentication uses a provider-neutral OIDC port; Google Workspace is the
  first production adapter.
- PostgreSQL owns retry, dead-letter, task, approval, workflow, and completion
  state. Redis is limited to dispatch, caching, and ephemeral coordination.
- Workflow state changes are accepted only through a database transition
  function guarded by a database transition graph and optimistic version.
- `tasks.status` is a guarded projection written by that same transition
  function and checked against the authoritative workflow state at commit.
- Entity isolation is enforced by application authorization, organization-
  scoped foreign keys, and PostgreSQL row-level security.
- API and worker processes reject a superuser, `BYPASSRLS`, or protected-table
  owner identity during startup.
- Cross-entity reads require an explicit authorized organization set.
- Model output is untrusted input and must pass a typed runtime schema before
  it can be persisted or used by a workflow.
- Raw source versions are append-only and record checksum, source identity,
  source timestamp, ingestion timestamp, schema version, and retention class.
- Async commands carry idempotency and trace IDs, bounded attempts, leases, and
  visible dead-letter state.
- Private chain-of-thought is neither requested nor stored.
- Audit events form a verifiable organization chain over canonical event
  payloads, sequence, and prior hash. The chain is not an external anchor
  against a fully privileged database re-chain.

## Consequences

### Positive

- One language and contract system covers web, API, worker, connectors, and agents.
- The system remains portable across model, queue, storage, and hosting vendors.
- Source-system writes cannot appear accidentally in a read-only adapter.
- Workflow history and audit facts remain available even when queues or model providers fail.
- Temporal can be introduced for long-running workflows without moving business rules into orchestration code.

### Costs

- Application authorization and database organization-scope constraints require disciplined repository design.
- A custom Phase 1 state-machine/outbox implementation needs concurrency and replay tests.
- TypeScript is not a permanent restriction on specialized Python services; any later service must use versioned contracts and the same control boundary.

## Rejected alternatives

- **Monolithic chatbot:** agents would implicitly own routing/state and be difficult to audit.
- **LLM-driven prompt chains as workflow engine:** no durable wait, transition, retry, or concurrency semantics.
- **Queue as system of record:** job loss/replay would corrupt business state.
- **Direct source writes in agent tools:** violates approval, separation-of-duties, and verification requirements.
- **Immediate microservice split:** adds operational boundaries before workload or team ownership justifies them.

## Review trigger

This ADR was approved with the amendments above for the Phase 1 vertical
slice. Revisit the workflow-engine portion before Phase 3 and the deployment
portion when hosting/recovery requirements are known.
