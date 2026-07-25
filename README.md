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
  -> immutable audit history
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
- `pnpm test:feature` creates a clean PostgreSQL 16 database, applies both
  migrations and seed data, runs the vertical-slice feature suite, and removes
  the isolated test database.
- `pnpm test:smoke` starts the built API, worker, and production web server
  against another isolated database, exercises the slice over HTTP, and tears
  everything down.

The last command is the single acceptance-test entry point for this slice.

## Documentation

Start with [the current state](docs/current-state.md), [architecture](docs/architecture.md),
[security model](docs/security.md), and [Phase 1 implementation record](docs/phase1-implementation.md).

## Safety boundary

- Connectors are read-only in Phase 1.
- Risk-5 and risk-6 actions are structurally prohibited.
- External communication sending is absent.
- Credentials are represented only by secret references.
- PostgreSQL stores operating-layer state; source systems remain authoritative.
- All state-changing commands must produce an audit event.

See [deployment.md](docs/deployment.md) for the environment outline.
