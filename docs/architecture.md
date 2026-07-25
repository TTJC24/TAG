# Architecture

Status: Approved through the Phase 2 controlled CSV intake slice
Date: 2026-07-25
Repository codename: `operating-layer` (not a permanent product name)

## Architecture decision

Build a modular TypeScript monorepo with separately deployable web, API, and worker applications. PostgreSQL owns operating-layer state. Source systems own their business records. Raw source payloads are versioned in object storage, while PostgreSQL stores identity, provenance, normalized operational fields, and immutable references.

The initial workflow engine is a persisted state machine with a transactional
outbox. PostgreSQL owns task state, transition state, attempts, leases,
dead-letter status, approvals, and completion. Redis may improve dispatch or
caching but never owns workflow truth or retry state. The workflow package
exposes an engine interface so Temporal can replace the dispatcher for
long-running Phase 3 workflows without changing domain contracts.

This choice keeps the operating surface small while retaining explicit states,
retries, idempotency, observability, and a credible Temporal migration path.

## System context and data flow

```text
Approved sources
  -> manual intake or controlled internal CSV upload
  -> immutable raw payload version in object storage
  -> normalized SourceRecord + provenance in PostgreSQL
  -> issue-intake command
  -> persisted workflow transition + audit event + outbox message
  -> retrieval/classification/recommendation agents
  -> recommendation with source citations and policy result
  -> approval queue when required
  -> immutable internal execution command
  -> deterministic internal executor
  -> immutable result + completed|execution_failed + audit event
```

No model receives source-system credentials. No model or queue owns permissions, task state, or workflow state.

## Deployable applications

### `apps/web`

Next.js App Router application. It provides login, server-rendered management views, issue intake, approval review, source-record metadata views, workflow history, connector health, and permission administration. Sensitive mutations call the API; browser code never talks directly to connectors.

### `apps/api`

Modular API and policy enforcement point. The vertical slice implements
identity, organizations, issue intake, tasks, workflows, recommendations,
approvals, source history, audit history, and health. Commands execute in
database transactions and emit audit/outbox records atomically.

### `apps/worker`

Runs idempotent ingestion, normalization, classification, recommendation, verification, import, and summary jobs. A worker receives record identifiers, not broad payloads or credentials. It reloads authorized context at execution time.

## Proposed monorepo structure

```text
apps/
  web/
  api/
  worker/
packages/
  agents/          provider-neutral agent and structured-output contracts
  audit/           append-only audit writer and canonical hashing
  auth/            identity, principal, RBAC, organization-scope policy
  connectors/      connector interfaces and capability declarations
  db/              schema, migrations, generated/query types
  executors/       provider-neutral execution contract; internal mock enabled
  observability/   trace, metrics, structured log contracts
  schemas/         shared command/event/domain schemas
  ui/              shared UI primitives
  workflows/       state-machine, policy, approval, and engine contracts
connectors/
  acumatica/
  pipedrive/
  gmail/
  google-drive/
  csv-import/
workflows/
  issue-intake/
  collections/
  order-stagnation/
  procurement-follow-up/
  crm-follow-up/
  media-production/
docs/
infrastructure/
  docker/
  migrations/
```

Manual intake, controlled CSV batch intake, internal approval resolution, and
deterministic internal execution are implemented. Real connectors, live
model/execution providers, external sends, and source-system write adapters
remain deferred.

## Domain and database model

PostgreSQL stores:

- `organizations`, `users`, and `organization_memberships`;
- `permission_sets` and role/action grants;
- `source_systems`, `source_records`, and immutable `source_record_versions`;
- `tasks` and many-to-many `task_source_records`;
- `workflows` and append-only `workflow_transitions`;
- `recommendations` and `recommendation_sources`;
- `approvals`, `actions`, and `action_verifications`;
- `prompt_versions` and `agent_runs`;
- append-only `audit_events`;
- immutable approval-policy versions/rules, guarded bindings, and activation
  history;
- immutable idempotency-retention versions and reaper history;
- immutable execution commands and terminal execution results;
- immutable CSV batches, parsed rows, and accepted/failed row results;
- `connector_sync_runs`, `outbox_events`, and idempotency records.

Every organization-scoped row carries `organization_id`, including derived
artifacts. Composite foreign keys and PostgreSQL row-level security enforce
database isolation in addition to application policy. Cross-entity records
must be represented as explicit authorized links rather than by removing or
implicitly widening organization scope.

External record identity is unique on `(source_system_id, record_type, external_id)`. Raw payload versions are append-only and carry content hashes, observed timestamps, source update timestamps, and object-storage references.

The controlled CSV slice keeps its exact raw upload bytes in the immutable
`csv_batches` record and links the corresponding immutable source version to
that payload. Each valid row calls the same normalized issue-intake service as
manual intake and has an independent outbox/idempotency boundary. CSV remains
an internal upload mode, not a connector.

Money uses `numeric(20,2)` plus ISO currency. Timestamps are `timestamptz`. User-facing statuses remain text with application schema validation to avoid brittle database enum migrations.

## Authentication and authorization

Google Workspace OIDC is the initial identity provider behind an adapter:

1. validate issuer, audience, hosted domain, nonce, and signature;
2. map identity using immutable `(issuer, subject)`, never email alone;
3. require an active local user and active organization membership;
4. establish a short-lived secure, HTTP-only session;
5. create a principal containing user ID, service identity when applicable, organization scopes, and permissions.

Authorization combines:

- role-based permissions for common capabilities;
- organization membership for entity-level access;
- action/risk policy for approvals;
- object checks for ownership or restricted records;
- segregation of duties so requesters cannot self-approve where policy prohibits it.

The API denies by default. Every repository query requires an explicit
organization scope. PostgreSQL row-level security is enforced for the
application role as defense-in-depth, not as a substitute for service checks.

Initial role templates are `system_admin`, `executive`, `operations_manager`, `operator`, `approver`, and `auditor`. Their exact grants require business approval.

## Workflow engine

The deployed slices use a durable explicit state machine. The implemented
approval and internal-execution branch is:

```text
received -> normalized -> classified -> recommended -> awaiting_approval
awaiting_approval -> approved -> executing -> completed
                                     \-----> execution_failed
awaiting_approval -> rejected
```

Transitions require a command ID, expected current version, policy result,
actor, input/output hashes, and trace ID. A database function checks the
approved transition graph and optimistic version; triggers reject direct state
updates and transition inserts. Entry to `executing` additionally requires the
referenced immutable execution command, and a terminal transition requires the
referenced immutable execution result. The calling transaction also appends
its audit and outbox records. Workers are at-least-once, so handlers are
idempotent, leased, bounded by an attempt policy, and dead-lettered visibly
when exhausted.

No execution path reaches an external adapter. Temporal remains deferred until
schedules, human waits measured in days, and multi-system compensation become
common. The `WorkflowEngine` port prevents domain code from importing a future
engine directly.

## Execution provider abstraction

Execution uses a provider-neutral `ExecutionProvider` contract over a typed
action and trace/idempotency context. Only `deterministic_internal` resolves at
runtime. It returns untrusted structured output that passes the same runtime
schema boundary required of a future provider. The disabled external provider
interface has `enabled=false`; selecting any non-internal provider refuses
worker startup, the database rejects non-internal commands, and no connector
or network adapter exists.

## Agent abstraction

Agents are typed capabilities, not autonomous state owners:

```ts
interface Agent<TInput, TOutput> {
  readonly kind: AgentKind;
  run(context: AgentContext, input: TInput): Promise<AgentResult<TOutput>>;
}
```

`AgentContext` contains a principal/scoped policy result, prompt version, model
route, trace ID, budget, and cited source excerpts. Model responses are
untrusted. `AgentResult` exists only after runtime schema validation and
contains citations, confidence, risk, usage, model/provider identifiers,
concise decision summary, and hashes.

Provider adapters implement completion/embedding capabilities. Business rules,
priority scoring, risk levels, and workflow transitions live in versioned
code/configuration, not only in prompts. Agent runs are reproducible from
prompt version, model metadata, input hash, and source version references.
Terminal outputs must not be overwritten; any retry creates a separately
identifiable attempt. Private chain-of-thought is not requested or persisted.

Initial agents:

- deterministic preprocessing plus a structured classification agent;
- recommendation agent that must return at least one valid supporting citation for material claims;
- verification pass that checks citation existence, organization scope, freshness, and policy compliance.

## Connector interface

Connectors declare capabilities. Read capability is separate from future write capability so a read-only deployment cannot accidentally expose write methods.

Required read methods:

```text
connect
healthCheck
listSupportedObjects
fetchRecords
fetchRecord
normalizeRecord
getRecordUrl
getLastSync
syncIncremental
```

Future write adapters are separate and must implement:

```text
validateAction
previewAction
requestApproval
executeAction
verifyAction
rollbackAction
```

Each operation accepts organization scope, trace ID, idempotency key, and secret reference. Results include source identity, observed/source timestamps, cursor, content hash, and structured errors. Connector tokens are resolved by the connector runtime and never cross into agent context.

## Audit-log design

Audit events are append-only facts, not mutable application logs. Each event includes organization, actor, event type, workflow, source references, trace/request IDs, canonical input/output hashes, metadata, timestamp, and a per-stream chain (`previous_hash`, `event_hash`).

Sensitive payloads remain in encrypted object storage; audit metadata records references and hashes. State-changing commands fail if the matching audit event and outbox record cannot commit in the same transaction. Database permissions prohibit update/delete for the application role, and a trigger rejects mutation as defense in depth.

The independent verifier recomputes the canonical event hash, sequence,
prior-hash linkage, and stream head. It detects partial history tampering but
does not replace a future external signed anchor against a fully privileged
database re-chain.

Production design adds periodic signed audit manifests exported to separate immutable storage. Audit exports and retention periods require explicit policy approval.

## Observability

Every request and job propagates `trace_id`, `request_id`, `workflow_id`, `agent_run_id`, and source record IDs. Structured telemetry covers connector health, cursor lag, workflow duration, queue retries, approval delay, task aging, model latency/usage/cost, citation failures, and policy denials. Logs contain identifiers and hashes rather than credentials or raw business payloads.

## Failure and recovery principles

- optimistic workflow versions prevent concurrent lost updates;
- idempotency keys prevent duplicate imports/actions;
- the outbox prevents committed work from being invisible to workers;
- dead-lettered jobs remain visible and replay requires permission;
- connector cursors advance only after raw and normalized records commit;
- external calls use timeouts, bounded retries, and circuit breakers;
- no automatic destructive merge;
- future writes require preview, approval, verification, and a documented compensation path.

## Deployment topology

The web app may run on Vercel. API and worker must run in a service environment with private access to PostgreSQL, Redis, object storage, and secrets management. Managed services are preferred, but every dependency uses standard protocols to remain portable. See `docs/deployment.md`.
