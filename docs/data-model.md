# Core Data Model

The canonical schema is the ordered set of forward-only migrations:

- `infrastructure/migrations/0001_core.sql` defines the core operating model.
- `infrastructure/migrations/0002_phase1_vertical_slice.sql` adds the approved
  Phase 1 provenance, transition, retry, and row-level-security controls.
- `infrastructure/migrations/0003_phase1_closeout.sql` adds the task-status
  projection guard, safe runtime role boundary, and narrow worker claim
  function.
- `infrastructure/migrations/0004_phase2_approval_resolution.sql` adds
  versioned idempotency retention, immutable declarative approval policy,
  guarded activation, approval resolution history, and approve/reject
  resolution.
- `infrastructure/migrations/0005_phase2_internal_execution.sql` adds immutable
  execution commands/results and guarded execution lifecycle transitions.
- `infrastructure/migrations/0006_phase2_csv_batch_intake.sql` adds immutable
  raw CSV batches, parsed rows, row outcomes, audit constraints, and forced
  organization RLS.
- `infrastructure/migrations/0007_phase3_gmail_draft.sql` adds immutable
  organization connector versions, exact previews, second authorizations,
  kill-switch abandonments, external-draft commands, and guarded transitions.

## Ownership

- Source systems own ERP, CRM, email, document, and media records.
- PostgreSQL owns operating-layer users, access, tasks, workflow state, recommendations, approvals, and audit facts.
- Object storage owns immutable raw payload and large artifact bytes.
- The queue owns no durable business state.
- Models own no state.

## Main relationships

```text
Organization
  -> Membership -> User + PermissionSet
  -> SourceSystem -> SourceRecord -> SourceRecordVersion
                 -> CsvBatch -> CsvBatchRow -> CsvBatchRowResult
  -> Task <-> SourceRecord
  -> Workflow -> WorkflowTransition
              -> Recommendation -> RecommendationSource -> SourceRecordVersion
              -> Approval -> ApprovalResolution
                          -> GmailDraftPreview -> GmailDraftAuthorization
                          -> ExecutionCommand -> ExecutionResult
                                              -> GmailDraftAbandonment
                          -> Action -> ActionVerification
  -> ApprovalPolicyVersion -> ApprovalPolicyRule
                           -> ApprovalPolicyActivation
  -> IdempotencyRetentionPolicyVersion -> IdempotencyKey
  -> AgentRun -> PromptVersion
  -> ConnectorSyncRun
  -> AuditStream -> AuditEvent
  -> OutboxEvent
```

## Required invariants

- Every derived or operational record is organization-scoped.
- A source record has stable external identity and immutable versions.
- Material recommendations point to exact source-record versions, not just mutable records.
- A workflow transition is unique by command ID and workflow version.
- Workflow state changes use optimistic version checks.
- An approval binds to a payload hash and policy version.
- A policy version and its rules are immutable; only the guarded binding
  function can activate a version.
- A new policy version requires a distinct requester and activator; a
  previously activated version may be restored by one authorized actor.
- Approval resolution is an immutable fact and may update the approval
  projection only through `resolve_approval_workflow()`.
- Approval is authorization, not completion. Internal commands use
  `enqueue_internal_execution()`; Gmail draft commands require an exact
  preview and second immutable authorization. Only a matching immutable
  command/result may guard entry to and exit from `executing`.
- An execution command and its single terminal result are immutable,
  organization-scoped, and linked to the exact workflow, task, approval,
  recommendation, action, provider, payload hash, and root trace.
- An action has an organization-scoped idempotency key.
- A CSV batch stores exact raw bytes and provenance immutably; every valid row
  has an independent idempotency/outbox boundary and every created task points
  back to the batch source record.
- Prompt content is versioned; terminal agent outputs cannot be overwritten and retries remain separately identifiable.
- Audit events are append-only for the application role and chain by
  organization sequence/hash. The verifier independently recomputes event
  hashes, linkage, sequence, and the stream head.
- `workflows.current_state` is authoritative; `tasks.status` is a
  transactionally guarded projection and must match at commit.
- State mutation, audit append, and outbox append occur in one database transaction.

## Implemented controls

- explicit application-role organization context and forced row-level security;
- an allow-listed transition graph and transactional transition function;
- triggers rejecting direct workflow-state/transition mutations;
- raw-source checksum, source identity/timestamp, ingestion timestamp, schema
  version, and retention classification;
- PostgreSQL-owned outbox leases, bounded attempts, errors, and dead-letter status.
- runtime boot rejection for superuser, `BYPASSRLS`, or protected-table-owner
  identities.
- immutable seven-day retention-policy versions and snapshotted expiries;
- bounded, recorded reaper batches using `FOR UPDATE SKIP LOCKED`;
- immutable approval-policy versions/rules with guarded organization bindings;
- internal approve/reject resolution with policy/actor/reason/trace history.
- approved-only deterministic internal execution with immutable results,
  typed provider-output validation, bounded retries, and terminal success or
  failure.
- immutable controlled CSV batches/rows/results, typed row validation, partial
  success, per-row bounded retries, source-linked tasks, and failed-row
  projection back to the batch result.
- immutable Gmail connector config versions, previews, authorizations, and
  abandonments with forced RLS; `drafts.create` output validation, stored draft
  ID replay, active-config/allowlist recheck, and kill-switch fallback.

## Deferred schema decisions

- organization-wide retention and deletion policy beyond idempotency replay
  records;
- embedding dimensions and vector indexes;
- cross-entity record-link model;
- financial threshold/policy tables;
- document chunking and access-control inheritance;
- connector-specific normalized projections.

These remain deferred because their authoritative requirements are not yet known.
