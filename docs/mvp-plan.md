# Operations Control Tower MVP Plan

Status: Approved for Phase 1 implementation
Date: 2026-07-25

## MVP boundary

The first deployable workflow is Operational Issue Intake and Resolution. It accepts manual entry and CSV input, creates source-linked tasks, classifies entity/type/priority/owner suggestions, generates a cited recommendation, evaluates approval policy, and exposes status/history on management views.

### Included

- Google Workspace authentication adapter and local development identity;
- organizations, users, memberships, permissions;
- tasks, workflows, source records, recommendations, approvals, actions, audit events;
- manual issue intake and CSV import;
- synthetic and uploaded source-record references;
- persisted issue-intake workflow;
- provider-neutral structured classifier and recommendation agent;
- deterministic fallback for tests and unconfigured local environments;
- source citation and freshness validation;
- executive dashboard, operations queue, task detail, approval queue, workflow history, connector health;
- append-only audit trail, traces, connector/import run health;
- seed data, tests, local dependencies, and deployment/runbook documentation.

### Excluded

- production Acumatica, Pipedrive, Gmail, or Google Drive credentials;
- source-system writes or external message sends;
- payments, journals, customer/vendor master workflows;
- automatic record merging;
- final financial thresholds, retention periods, and permanent product name;
- advanced semantic retrieval until source corpus and provider decisions are approved;
- Phase 3 domain workflows beyond contract/fixture level.

## Acceptance slices

1. **Controlled intake:** authorized user creates an issue or imports CSV; validation and idempotency are visible.
2. **Traceable interpretation:** classification and recommendation are structured, versioned, and cite accessible source versions.
3. **Coordinated execution:** workflow state, owner, due date, blockers, approval state, and timeline are queryable.
4. **Management visibility:** dashboard answers attention, overdue, blocked, exposure, owner, recommendation, and health questions.
5. **Governed operation:** every mutation is audited; prohibited source writes cannot be invoked because no adapter capability exists.

## Delivery stages

### Stage A — Foundation

Establish workspace, database migration, configuration validation, local dependencies, CI checks, trace context, and shared schemas.

### Stage B — Identity and control plane

Implement OIDC adapter, local dev identity, memberships, RBAC/organization policy, audit writer, idempotency, and transactional outbox.

### Stage C — Issue intake vertical slice

Implement task/source CRUD, manual intake, CSV normalization, persisted issue workflow, deterministic priority rules, owner suggestion, and management queries.

### Stage D — Governed agents

Implement provider interface, prompt/model registry, classifier, recommendation agent, citation verifier, cost/latency logging, and low-confidence handling.

### Stage E — Operating surface

Implement executive dashboard, operations queue, task detail, intake, approval, source, workflow, connector health, and permissions screens.

### Stage F — Hardening and deployment

Add integration/evaluation tests, seed fixtures, authorization matrix tests, migrations in CI, observability dashboards, backup/restore steps, deployment docs, and security review.

## Exact first ten implementation tasks

1. Initialize pnpm/Turborepo configuration, shared TypeScript/lint/test settings, environment schema, and CI skeleton.
2. Apply and test the initial PostgreSQL migration for organizations, identity, sources, tasks, workflows, recommendations, approvals, actions, agent runs, audit, sync runs, idempotency, and outbox.
3. Implement the database access package with mandatory organization scope, transaction helpers, optimistic workflow versioning, and migration checks.
4. Implement Google Workspace OIDC and local-development auth adapters, session handling, user deactivation, organization memberships, and deny-by-default permission middleware.
5. Implement canonical hashing, append-only audit writes, transactional outbox publishing, idempotency claims, and mutation/replay tests.
6. Implement manual issue intake plus task/source repositories and the persisted Operational Issue Intake state machine.
7. Implement the provider-neutral agent runtime, prompt/model version registry,
   deterministic provider, structured classifier, telemetry, and budget limits.
8. Implement the cited recommendation and verification path, including
   source-scope, existence, freshness, confidence, unsupported-claim, and
   approval-policy checks.
9. Build the executive queue and task-detail history views backed by the real
   vertical-slice API.
10. Cover intake-to-queue behavior with unit, integration, authorization,
    idempotency, retry/dead-letter, transition, and schema-validation tests.

CSV import begins only after this vertical slice passes its acceptance suite.

## Test strategy

- unit tests begin with the first domain behavior and cover scoring, policy,
  normalization, state transitions, hashing, and schemas;
- integration tests against PostgreSQL/Redis/object storage containers;
- authorization matrix and cross-organization leakage tests;
- contract tests for every connector/provider;
- workflow tests for retry, duplicate delivery, stale expected version, failure, and replay;
- agent evaluations for missing/conflicting/stale data, ambiguous entity, low confidence, citation accuracy, and unsupported financial recommendations;
- browser tests for intake, queue, task detail, approval rejection, and audit history.

## Release gates

- all migrations apply forward on a clean database and a copy of the previous release;
- no high/critical security findings;
- organization-isolation suite passes;
- audit event coverage exists for every command;
- citation verifier rejects missing/out-of-scope source versions;
- prohibited risk-5/6 actions have no executable adapter;
- connector and agent failures are visible;
- backup restore and rollback runbooks are exercised;
- architecture/security review approves production deployment.

## Review checkpoint

After the controlled Phase 1 workflow is working with synthetic/manual/CSV inputs, stop for review before adding production connector credentials or any external write capability.
