# ADR 0002: Idempotency Key Retention

Status: Accepted and implemented

Date: 2026-07-25

Decision owner: Phase 2 reviewer

## Decision

Retain terminal idempotency claims and their replayable prior results for
**seven days**. The default is exactly `604800` seconds.

The governing assumption is that a legitimate duplicate may arrive after a
weekend, an operational incident, or a manually resumed internal process, but
not more than seven days after the original command becomes terminal. Before
expiry, the same organization, command scope, key, and request hash replay the
stored result. A different request hash conflicts.

At or after expiry, the old key no longer reserves the intent. Reusing it is a
**new intent** and may create new work. This is deliberate and leaves a
residual risk: a very late retry can double-act. Any future client with a
legitimate retry horizon longer than seven days requires a new reviewed
retention-policy version before deployment.

## Versioned configuration

Retention is explicit and organization-scoped:

- `idempotency_retention_policy_versions` is immutable and stores the window,
  assumption, content hash, author, version, and predecessor.
- `idempotency_retention_policy_bindings` identifies the active version for an
  organization.
- Every new idempotency claim snapshots both the policy-version ID and
  retention seconds.
- Expiry is calculated from the terminal timestamp, not claim creation.
- Changing the active version affects new terminal claims only. Existing
  expiries are not reinterpreted.

The local seed creates version 1 with `604800` seconds for each seeded
organization. There is no invisible global runtime fallback and Redis TTL is
not involved.

## Replay and reaping

The worker invokes the PostgreSQL reaper at startup and every 15 minutes. Each
run is bounded to 100 rows by default; the database function rejects a batch
outside 1–1000. `idempotency_reaper_runs` records the trace ID, cutoff, batch
limit, and deleted count.

The reaper:

1. selects terminal rows whose expiry is at or before the transaction
   timestamp;
2. locks them with `FOR UPDATE SKIP LOCKED`;
3. deletes the idempotency row and its inline replay result in one transaction;
4. never deletes a `claimed` row or domain, workflow, approval, source, or
   audit history.

Replay and reaping serialize on the same idempotency row. If replay holds the
row lock, the reaper skips it. If reaping commits first, a later request
creates a new claim. If the command path encounters an expired terminal row
first, it removes that locked row and creates the new intent transactionally.
The database remains authoritative throughout.

## Proof

The clean-PostgreSQL feature test
`retains idempotency results for seven days and reaps without racing replay`
proves:

- a duplicate inside seven days returns the stored prior result;
- every claim carries the `604800`-second snapshot;
- the reaper skips a row locked by replay;
- the row is removed after the competing lock is released; and
- reuse after expiry creates a distinct task as new intent.

## Consequences

- Seven days of request hashes and response envelopes are retained.
- Reaper failure delays deletion but does not change expiry semantics.
- Abandoned in-flight claims require a separate lease-recovery design; the
  retention reaper intentionally cannot remove them.
- A future retention change is a new immutable version and reviewed binding
  change, never an update to version 1.
