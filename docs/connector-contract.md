# Connector Contract

The executable TypeScript contract is in `packages/connectors`.

## Rules

- Read capability and controlled-write capability are separate interfaces.
- The only implemented write capability is Gmail `drafts.create`, behind its
  accepted ADR and disabled by default. Every other adapter remains read-only
  or a placeholder.
- Every call carries organization, source-system, trace, idempotency, and secret references.
- The connector runtime resolves secrets; connector results and agent inputs never contain credentials.
- External IDs and source timestamps are preserved.
- Raw payload bytes are written as immutable versions before the sync cursor advances.
- Incremental cursors advance only after raw, normalized, audit, and sync-run state commits.
- Connector errors are structured, redacted, and visible on connector health.
- Retries are bounded and idempotent.

## Adapter readiness checklist

Before implementing a production adapter, document:

- API/version and supported objects;
- tenant/company/branch and organization mapping;
- read scopes and rate limits;
- cursor/change-tracking semantics;
- source URL format;
- deletion/tombstone behavior;
- payload size and attachment handling;
- authoritative identifiers and timestamps;
- credential owner, rotation, and incident contact;
- contract fixtures with sensitive data removed.

The Acumatica, Pipedrive, and Google Drive adapter directories remain
placeholders until these facts are approved. Gmail draft creation is a narrow
execution provider, not a general Gmail connector: it declares only
`drafts.create`, uses the compose scope, and has no send operation.
