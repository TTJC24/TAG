# Security and Control Model

Status: Approved for Phase 1 with provisional role assignments
Date: 2026-07-25

## Security objectives

1. Prevent cross-organization disclosure.
2. Prevent unauthorized or silent source-system changes.
3. Preserve attribution, provenance, and an immutable action trail.
4. Keep secrets and broad credentials outside model and browser runtimes.
5. Minimize data sent to model providers.
6. Make failures, retries, approvals, and policy denials observable.

## Trust boundaries

- The browser is untrusted and receives only authorized view models.
- The web server may hold a user session but not connector credentials.
- The API is the authorization and command boundary.
- Workers are service principals with narrow job capabilities.
- Connector runtimes resolve secret references and have per-source, per-environment scopes.
- Model providers receive curated excerpts, not raw credentials or unrestricted source payloads.
- PostgreSQL owns normalized operating state; object storage owns immutable raw artifacts.

## Identity

Production identity uses Google Workspace OIDC with issuer/audience/domain validation and local user activation. Users are keyed by provider issuer and subject. Email changes do not create a new identity. User deactivation invalidates active sessions and prevents new work.

Service identities are separate from people and cannot approve. Connector jobs identify both the service principal and the initiating user/workflow when applicable.

## Authorization

Every request evaluates:

- authenticated principal and active status;
- active organization membership;
- named permission;
- object scope;
- risk/action policy;
- segregation-of-duties constraints.

No endpoint infers organization access from a request body alone. Repository methods require an authorization scope. Batch operations enumerate exact targets and never hide affected records.

### Initial risk policy

| Risk | Capability                                  | Phase 1 behavior                                                |
| ---- | ------------------------------------------- | --------------------------------------------------------------- |
| 0    | read, summarize, classify                   | automatic, logged                                               |
| 1    | draft communication                         | draft only, logged                                              |
| 2    | create/update internal operating-layer task | allowed by permission, logged                                   |
| 3    | update CRM                                  | adapter absent; approval required in a later phase              |
| 4    | send external message                       | adapter absent; approval required in a later phase              |
| 5    | financial/ERP write                         | prohibited in Phase 1; explicit approval and verification later |
| 6    | payment, journal, customer/vendor master    | prohibited                                                      |

Agent output never raises its own permission. Policy code determines the effective risk and approval rule.

Model output is always treated as hostile input. It must pass a typed runtime
schema, citation-scope checks, confidence bounds, and policy evaluation before
storage or workflow use. Prompt text cannot define permissions, risk policy, or
valid workflow transitions.

## Approval integrity

An approval binds to:

- exact action type and target;
- normalized preview;
- payload hash;
- policy/risk version;
- requester and approver identities;
- expiration time when configured.

Changing the payload invalidates the approval. A requester may not satisfy a two-person approval rule. Execution verifies that authorization, approval, payload hash, and target version are still current. Post-action verification is a separate recorded event.

## Audit integrity

Audit records are append-only for the application role and hash-chained per
organization stream. The genesis row links to `NULL`; each later event stores
the preceding event hash and a SHA-256 hash of its canonical event payload,
sequence, and link. The independent verifier recomputes every event, linkage,
sequence, and stream head. The feature suite performs privileged payload
tampering and proves that verification fails deterministically.

The application role receives insert/select but not update/delete, and a
database trigger rejects mutation. This chain detects partial history
tampering; it is not an external anchor against a fully privileged
administrator who rewrites and re-hashes the complete history. Production
exports should therefore be periodically signed and written to immutable
storage controlled separately from the application.

Concise reasoning summaries may be stored. Hidden chain-of-thought is neither requested nor persisted.

## Secrets

- Commit only environment variable names and secret references.
- Store production secrets in a managed secret manager.
- Separate read and write credentials.
- Scope connector credentials by source, organization/company/branch, environment, and capability.
- Rotate and revoke independently.
- Redact secrets in logs, errors, traces, and agent context.
- Never store a token in a prompt, source record, task description, or audit metadata.

## Data protection

- TLS for every network hop; encryption at rest for database, object storage, backups, and queues.
- Raw payloads are versioned and encrypted separately from normalized records.
- Every raw version carries a SHA-256 checksum, immutable source identity,
  source timestamp when available, ingestion timestamp, schema version, and
  retention classification.
- Source viewers use authorized, short-lived access and default to metadata/redacted views.
- Model context is minimized and labeled with source version IDs.
- Backups are encrypted and restore tests are scheduled.
- Retention and deletion schedules remain unset until approved.
- Company data is not used for provider training unless explicitly approved by policy and contract.

## Tenant and entity isolation tests

Required tests include:

- user from organization A cannot list, fetch, cite, approve, or infer organization B records;
- a source record cannot be attached across organizations without an explicit authorized cross-entity link;
- connector cursors and health are scoped by source system and organization;
- agent retrieval cannot return out-of-scope chunks;
- audit export cannot be requested outside scope;
- deactivated users and revoked service principals fail closed.
- direct database access through the application role is constrained by
  row-level security even when application filtering is absent;
- requests spanning multiple entities require an explicit authorized
  organization set and never perform automatic cross-entity joins.

## Secure development gates

Before production:

- threat model and data-flow review;
- dependency, secret, static-analysis, and container scans;
- authorization tests on every route and repository;
- migration review and backup/restore exercise;
- connector least-privilege evidence;
- model-provider data handling review;
- incident response contacts and runbook;
- recovery objectives and retention policy approval.

## Runtime database identity

API and worker startup fails closed when `current_user` is a superuser, has
`BYPASSRLS`, or owns an RLS-protected table. Runtime uses the non-owner
`operating_layer_runtime` role; migration ownership remains separate. Workers
claim jobs only through the narrow `claim_outbox_job` security-definer
function and process each claimed job under an explicit organization scope.

## Explicit Phase 1 prohibitions

- no Acumatica, accounting, payment, journal, customer-master, or vendor-master writes;
- no external communication sends;
- no production secrets in source control or local example files;
- no automatic duplicate merging;
- no agent-controlled permission or workflow-state changes;
- no unlogged state mutation.
- no private chain-of-thought persistence;
- no unvalidated model output persistence.
