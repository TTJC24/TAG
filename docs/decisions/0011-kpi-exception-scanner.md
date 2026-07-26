# ADR 0011: KPI Exception Scanner (Certified Definitions Only)

Status: Accepted and implemented; disabled by default
Date: 2026-07-26

## Context

Scoreboard owns the group's certified KPI/control specifications: rule locks
for stale opportunities (no qualifying activity in 7 days OR unchanged stage
14+ days), stuck orders (no movement 2+ days, excluding canceled/completed),
and dead stock (on hand > 90 days, no sales in 90 days) — governed by a
promotion-evidence ledger that forbids treating any definition as certified
before mappings, validation, freshness, and owner approval are recorded.

Until now an exception had to be noticed by a human. This scanner makes the
numbers raise their own issues, through the same governed pipeline as manual
and meeting intake.

## Decision

- Exception definitions are declarative data: id, entity, SQL, record-key
  column, title template, summary columns, and a `certified` flag — never
  prompts, never code forks per definition.
- The scanner runs a definition only if `certified: true`; anything else is
  skipped and reported. A development-only override
  (KPI_EXCEPTIONS_ALLOW_UNCERTIFIED=true) must be set explicitly. This encodes
  scoreboard's promotion ledger as a runtime gate.
- Data comes exclusively from company-brain's read-only SQL query service
  (`POST /query`); the client additionally refuses non-SELECT statements and
  schema-validates every response as untrusted. The scanner never contacts
  Acumatica or Pipedrive directly and can write to no source system.
- Each firing row becomes governed intake with idempotency key
  `kpi:<definitionId>:<recordKey>`. Within the retention window a re-scan
  replays; a drifted payload for the same record (e.g. days_stale grew) is
  counted as a replay of the still-firing exception, not an error. After
  retention (7 days, ADR 0002) an unresolved exception deliberately
  resurfaces.
- The scanner acts as a provisioned user (resolved by email) with real
  permissions and RLS scoping. Rows missing their record key, unknown
  entities, and invalid definitions are skipped and reported, never guessed.
- Inert by default: KPI_EXCEPTIONS_ENABLED=true, BRAIN_QUERY_URL, and
  KPI_EXCEPTIONS_USER_EMAIL are all required. Operator entry point:
  `pnpm kpi-exceptions:scan <definitions.json>`; a template definition ships
  in docs/kpi-exceptions/definitions.example.json with certified: false.

## Consequences

- The system now has three doorways into one governed pipeline: humans
  (manual/CSV), meetings (Traction bridge, ADR 0010), and numbers (this
  scanner) — all classified, brain-groundable, approval-gated, audited.
- Enabling a real definition is a data + certification exercise: write the
  SQL against company-brain's actual schema, validate it, record the evidence
  in scoreboard's ledger, set certified: true. No code change.
- Scan cadence is an operator choice (manual now, cron later) with no
  correctness risk, because re-scans are idempotent.
