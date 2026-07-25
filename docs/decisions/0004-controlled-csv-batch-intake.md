# ADR 0004: Controlled CSV Batch Intake

Status: Accepted and implemented

Date: 2026-07-25

Decision owner: Phase 2 reviewer

## Decision

The second Phase 2 slice accepts an internal CSV file upload and turns each
valid row into an issue through the existing governed intake pipeline. CSV is
an intake format, not a connector. The slice performs no external reads,
sends, or writes.

The accepted file contract is `csv-issue.v1`:

- required columns: `title`, `description`;
- optional columns: `task_type`, `due_date`, `financial_exposure`,
  `financial_exposure_currency`;
- UTF-8 text, `.csv` filename, maximum encoded request content of 1 MB;
- RFC 4180-style quoted fields, escaped quotes, CRLF, and quoted newlines;
- one explicit source timestamp and retention classification per batch.

Unsupported or duplicate headers reject the batch before persistence. Row
shape and typed-domain failures reject only that row. No task is created until
the row has passed the typed schema boundary.

## Immutable source and result model

One accepted upload creates:

- an organization-scoped `csv_batch` source record and immutable source
  version;
- an immutable `csv_batches` row holding the exact raw bytes, SHA-256
  checksum, checksum algorithm, source and ingestion timestamps, source
  identity, schema version, retention classification, importer, trace, and
  counts;
- one immutable `csv_batch_rows` record per input row with raw values, input
  hash, validation outcome, normalized input when valid, and rejection
  reasons; and
- an immutable `csv.batch.imported` audit event referencing the batch source.

Valid rows are queued separately. Each invokes the same
`createNormalizedIssueFromSource()` path used by manual intake for normalized
task creation, deterministic classification, cited recommendation,
declarative approval policy, workflow transitions, audit, and executive-queue
visibility. Every created task and recommendation cites the originating batch
source.

Per-row terminal facts are append-only `accepted` or `failed` result rows.
Rejected validation rows remain immutable input facts with
`csv.row.rejected` audit history. Database triggers and grants reject update or
delete of batches, parsed rows, and row results.

## Partial failure and idempotency

The batch command uses the existing seven-day idempotency policy. The same
organization, scope, key, and request hash replay the live prior batch result;
the same key with a different request conflicts.

Each valid row has a deterministic batch/row idempotency key and one independent
outbox command. At-least-once redelivery observes the immutable row result and
does not create a second task or audit event. One malformed or failed row does
not roll back accepted siblings.

Downstream classification or recommendation work retains the existing bounded
three-attempt policy. If exhausted, the originating row is resolved back to
the batch, the task/workflow moves through the database transition guard to
`failed` when permitted, and one immutable `csv.row.failed` result and audit
event are recorded. The dead letter remains visible in the executive queue,
and the batch result shows the row error.

## Authorization and isolation

Upload requires `csv_batches.create`; result access requires
`csv_batches.read`. Both are checked by the application for the requested
organization. `csv_batches`, `csv_batch_rows`, and `csv_batch_row_results`
carry organization IDs, composite organization foreign keys, forced RLS, and
non-owner runtime grants. A caller outside the organization receives API
`403`, while a direct cross-organization lookup under the runtime role returns
zero rows.

## Consequences and boundary

- This slice stores the exact internal upload in PostgreSQL. It does not add
  object-storage transport or a production file connector.
- A syntactically valid but operationally duplicated row with a different
  batch/row identity is a new intent. Seven-day command idempotency is not
  business-semantic duplicate detection.
- There is no batch rollback or external side effect to compensate.
- CSV export, scheduled import, connectors, live models, Temporal, and
  external execution remain outside this decision.

## Proof

The parser unit suite proves quoting and mixed-row validation. The clean
PostgreSQL 16 feature suite proves:

- mixed valid and invalid rows with partial success;
- exact raw-file metadata, checksum, append-only enforcement, batch audit, and
  source linkage;
- batch replay plus row redelivery without duplicate tasks/results/audits;
- API authorization and query-layer RLS;
- the complete normalize/classify/recommend/policy path with trace equality;
  and
- a real downstream classification failure through bounded retries to a
  visible dead letter and immutable failed row result.
