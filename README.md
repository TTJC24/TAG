# Operating Layer

`operating-layer` is the neutral repository codename for the multi-entity
Operations Control Tower. The implemented Phase 2 slices close the governed
internal loop and add controlled batch intake:

```text
manual issue intake
  or controlled CSV batch -> independently validated rows
  -> normalized task
  -> deterministic classification
  -> cited recommendation
  -> declarative, immutable approval policy
  -> internal approve or reject
  -> approved internal execution command
  -> deterministic internal executor
  -> completed or execution_failed
  -> database-enforced workflow state
  -> append-only, verifiable audit history
  -> executive queue and task detail
```

Production connectors, live model calls, external communication, and
ERP/accounting writes are intentionally absent.

## Local development

Prerequisites are Node.js 22 LTS, pnpm 11, and Docker Desktop.

1. Copy `.env.example` to an untracked `.env`.
2. Install dependencies with `pnpm install`.
3. Start PostgreSQL, Redis, and local object storage with
   `docker compose up --detach --wait`.
4. In separate terminals run:
   - `pnpm --filter @operating-layer/api dev`
   - `pnpm --filter @operating-layer/worker dev`
   - `pnpm --filter @operating-layer/web dev`
5. Open `http://localhost:3000`.

Development authentication uses a seeded local identity. The web defaults to
`executive@local.operating-layer`, which may access all four seeded
organizations. See [the runbook](docs/runbook.md) for identities, reset
instructions, and operational checks.

## Validation

- `pnpm check` runs workspace type checks and unit tests.
- `pnpm build` creates all application and package builds.
- `pnpm test:feature` creates a clean PostgreSQL 16 database, applies every
  forward migration and seed data, runs the vertical-slice feature suite, and
  removes the isolated test database.
- `pnpm test:smoke` starts the built API, worker, and production web server
  against another isolated database, exercises the slice over HTTP, and tears
  everything down.

`pnpm test:feature` is the single acceptance-test entry point for this slice.
It proves seven-day idempotency replay/reaping and its lock race, declarative
policy equivalence and two-person activation, approve/reject resolution,
approved-only execution, success and exhausted-retry terminal paths,
controlled CSV partial success, batch/row idempotency, immutable raw-file
evidence, CSV downstream dead-letter visibility, cross-organization rejection,
audit integrity, and trace continuity.

GitHub Actions runs formatting, workspace type checks and unit tests, the
feature suite against a clean PostgreSQL 16 database, and the production build
in the `verify` job. A single-human-committer exception currently waives strict
hosted protection while preserving PR-only flow and requiring green `verify`
before merge. See [the runbook](docs/runbook.md) for the forcing trigger and
exact protection steps.

## Documentation

Start with [the current state](docs/current-state.md), [architecture](docs/architecture.md),
[security model](docs/security.md), [Phase 1 implementation record](docs/phase1-implementation.md),
and [Phase 2 decision](docs/phase2-scope-proposal.md).

## Safety boundary

- Production connectors remain absent.
- Risk-5 and risk-6 actions are structurally prohibited.
- External communication sending is absent.
- Credentials are represented only by secret references.
- PostgreSQL stores operating-layer state; source systems remain authoritative.
- `workflows.current_state` is authoritative; `tasks.status` is updated only by
  the guarded transition function and is checked for projection drift.
- API and worker processes refuse to start as a PostgreSQL superuser,
  `BYPASSRLS` role, or owner of an RLS-protected table.
- Each audit event links to the prior stored hash and hashes its canonical
  event payload. The independent verifier checks linkage, event hashes,
  sequence, and stream head.
- Idempotency claims snapshot an immutable seven-day retention version.
- Controlled CSV uploads preserve exact raw bytes and provenance in immutable,
  organization-scoped records. Valid rows reuse the manual issue pipeline;
  rejected and exhausted rows remain visible without rolling back siblings.
- Approval decisions use an immutable organization policy version. Approval
  stops at `approved`; only an immutable internal execution command/result can
  move the workflow through `executing` to `completed` or
  `execution_failed`.
- `deterministic_internal` is the only enabled execution provider. The external
  provider contract is inert, and execution results explicitly record that no
  external effect occurred.
- All state-changing commands must produce an audit event.

See [deployment.md](docs/deployment.md) for the environment outline.
