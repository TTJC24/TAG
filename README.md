# Operating Layer

`operating-layer` is the neutral repository codename for the multi-entity
Operations Control Tower. Phase 1 now contains one working vertical slice:

```text
manual issue intake
  -> normalized task
  -> deterministic classification
  -> cited recommendation
  -> approval policy
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
It proves the audit chain on untampered history, detects privileged payload
tampering, rejects task-status drift, rejects RLS-bypassing runtime identities,
and preserves one trace ID through intake, worker transition, and audit.

GitHub Actions runs formatting, workspace type checks, the feature suite
against a clean PostgreSQL 16 database, and the production build in the
`verify` job. Making that check a merge gate remains blocked until this private
repository is upgraded to a GitHub plan that supports branch protection (or is
deliberately made public). See [the runbook](docs/runbook.md) for the exact
required settings and current evidence.

## Documentation

Start with [the current state](docs/current-state.md), [architecture](docs/architecture.md),
[security model](docs/security.md), and [Phase 1 implementation record](docs/phase1-implementation.md).

## Safety boundary

- Connectors are read-only in Phase 1.
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
- All state-changing commands must produce an audit event.

See [deployment.md](docs/deployment.md) for the environment outline.
