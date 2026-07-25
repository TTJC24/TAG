# ADR 0002: Idempotency Key Retention

Status: Proposed — awaiting decision

Date: 2026-07-25

Decision owner: Phase 2 reviewer

## Decision requested

Choose the maximum period during which a legitimate retry must replay the
stored result instead of creating new work. This ADR recommends one option but
does not adopt it. Implementation is prohibited until the reviewer records an
accepted option.

## Context

Phase 1 keys idempotency records by organization, command scope, and client
key. A matching request hash replays the prior result; a different request hash
under the same live key is rejected. The schema already has `expires_at`, but
Phase 1 leaves it null because no retention policy was approved.

Indefinite retention minimizes duplicate work but retains request hashes and
cached response envelopes forever. Short retention reduces that footprint but
eventually permits a late duplicate to act again. The choice must therefore be
made against the longest legitimate client retry window, not against storage
cost alone.

This protection applies only when a caller reuses the same organization,
scope, and idempotency key. It does not deduplicate two independently generated
keys that happen to describe the same business intent.

## Threat model and governing assumption

The relevant duplicate sources for the first Phase 2 slice are browser/API
retries, worker redelivery, operator retry after an ambiguous response, and a
restarted internal import. There are no external writes in the candidate
slices.

The recommended option assumes:

- well-behaved clients retry automatically for no more than 24 hours;
- an operational incident or weekend handoff can delay a deliberate retry up
  to 48 hours; and
- retries later than 48 hours should require an operator to review the current
  state and submit a new intent.

If the business expects an offline client, unattended import, or incident
recovery process to legitimately replay the same key after 48 hours, the
recommended option is invalid and the reviewer should choose seven days or
provide a different measured bound.

## Retention options

| Option                     | Maximum assumed legitimate retry window                                          | Benefit                                                                                              | Residual risk                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 24 hours                   | Every legitimate duplicate arrives within the same operating day                 | Smallest retained cache and quickest removal                                                         | Overnight incidents, weekends, and next-day operator retries can double-act                                      |
| **72 hours — recommended** | Legitimate retries arrive within 48 hours; the extra 24 hours is a safety margin | Covers normal retry storms, incident response, and most weekend handoffs without week-long retention | A retry delayed more than 72 hours is treated as new                                                             |
| 7 days                     | Offline or manually resumed work may retry for up to one week                    | Lowest late-retry risk among these options                                                           | Longer retention of request hashes/results and a longer period in which stale client intent is silently replayed |

### Recommendation

Approve **72 hours** only if the reviewer accepts the 48-hour maximum
legitimate retry assumption above. This is the single recommended option.

## Post-expiry behavior

Expiry changes semantics deliberately:

1. Before expiry, the same key and request hash returns the stored prior result.
2. Before expiry, the same key with a different request hash remains a
   conflict.
3. At or after expiry, the old claim no longer reserves the key. A request with
   that key is treated as a **new intent**, regardless of its request hash.

The residual risk is explicit: a very late network or operator retry can create
the operation a second time. The retention window must be at least as long as
the real maximum retry window for every client allowed to use that scope.
Business-semantic duplicate detection may warn about similar records, but it
must not silently merge them or change this idempotency contract.

Changing the configured window never extends, shortens, or otherwise
reinterprets an existing key. Each claim keeps the expiry calculated from the
policy version stamped when that claim becomes terminal.

## Proposed lifecycle

- A new claim starts in `claimed` with no reapable expiry.
- When it becomes `completed` or terminal `failed`, the same transaction stores
  the replayable response envelope, stamps the selected retention-policy
  version, and sets `expires_at = terminal_at + retention_window`.
- A stuck `claimed` row is not retention-expired or reaped. Lease recovery for
  abandoned in-flight claims is a separate reliability rule; deleting one
  could allow concurrent execution.
- Domain records, source versions, workflow history, approvals, and audit
  events are never deleted by this retention process. Only the idempotency row
  and an idempotency-owned cached response envelope are eligible.

## Reaper design

Run a PostgreSQL-backed reaper every 15 minutes. Redis may wake the worker but
does not own the schedule, cursor, attempt count, or completion state.

Each bounded batch:

1. selects terminal rows whose `expires_at` is at or before the database
   transaction timestamp;
2. locks those rows with `FOR UPDATE SKIP LOCKED`;
3. removes the idempotency-owned cached response envelope, if any;
4. deletes the locked idempotency rows in the same transaction; and
5. records a structured batch result with trace ID, command idempotency key,
   cutoff, policy-version counts, deleted count, and errors.

The replay path locks the same primary-key row before deciding whether to
replay, conflict, or create a new claim. Consequently, replay and reaping have
a single database serialization point:

- if replay locks an unexpired row first, it returns the prior result and the
  reaper skips that locked row until a later batch;
- if the reaper locks an expired row first, it deletes and commits, after which
  replay creates a new intent; and
- if replay sees an expired row first, it replaces that expired claim
  transactionally rather than racing a separate delete/insert.

The reaper has bounded retries and visible dead-letter state. A failure delays
deletion but never changes command correctness because an expired row is
treated as expired by the replay path even before physical cleanup.

## Configuration and audit shape

Recommendation: use an explicit organization-scoped policy version, initially
seeded from one system template. Do not resolve a nullable organization setting
through an invisible runtime fallback.

Conceptual configuration:

```text
idempotency_retention_policy_versions
  id
  organization_id
  version
  retention_seconds
  assumption_summary
  content_hash
  created_by
  created_at
  supersedes_version_id

idempotency_retention_policy_binding
  organization_id
  active_policy_version_id
  binding_version
  activated_by
  activated_at
```

- Policy-version rows are immutable.
- Each organization receives an explicit initial version containing the
  reviewer-selected default.
- An organization may receive an override only through the same permissioned
  version-and-activation path; cross-organization changes are never inferred.
- The active binding is a guarded projection. Activation creates an immutable
  activation fact and an audit event containing old/new version IDs, content
  hashes, actor, reason, and trace ID.
- Every idempotency claim stamps the effective policy-version ID and its fixed
  `expires_at`.
- Retention changes affect new terminal claims only. Existing expiries remain
  stable and reviewable.

Per-command-scope retention is intentionally excluded from the first design.
Add it only if measured client retry behavior proves that one organization-wide
window is insufficient.

## Alternatives rejected for this proposal

- **Never expire:** safest for duplicate prevention but violates the Phase 2
  requirement to adopt an intentional retention policy.
- **Expire from claim creation:** a long-running claim could expire while work
  is still executing and permit concurrency.
- **Use Redis TTL:** Redis is not authoritative and eviction/restart would
  change correctness.
- **Recompute all expiries when configuration changes:** retroactively changes
  the contract under which prior requests were accepted.
- **Delete immutable domain/audit records with a key:** confuses ephemeral
  replay state with the durable operating record.

## Approval record

Reviewer must record:

- selected window: `24h`, `72h`, `7d`, or a separately justified value;
- accepted maximum legitimate retry assumption;
- whether organization-specific overrides are allowed;
- approver and decision date.

Until then, this ADR remains proposed and Phase 2 implementation remains
blocked.
