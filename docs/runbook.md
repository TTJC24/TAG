# Local Runbook

## Prerequisites

- Node.js 22 LTS on `PATH`
- pnpm 11
- Docker Desktop with Compose

Copy `.env.example` to `.env`. All example values are local-only; never add
production credentials to this file or source control.

## Start

```powershell
pnpm install
docker compose up --detach --wait
pnpm --filter @operating-layer/api dev
pnpm --filter @operating-layer/worker dev
pnpm --filter @operating-layer/web dev
```

Run the three `pnpm` application commands in separate terminals. The web
application is at `http://localhost:3000`; API health is at
`http://localhost:3001/health`.

## Seed identities

| Identity                             | Scope                          |
| ------------------------------------ | ------------------------------ |
| `executive@local.operating-layer`    | all four seeded organizations  |
| `operator@local.operating-layer`     | Big League Construction Supply |
| `fsi-operator@local.operating-layer` | Fastening Specialists          |
| `approver@local.operating-layer`     | seeded approval role           |

Development authentication trusts `x-dev-user-email` and must never be enabled
in production. Production sets `AUTH_MODE=oidc` and configures issuer,
audience, hosted domain, and optionally an explicit JWKS URI.

## Verify

```powershell
pnpm check
pnpm build
pnpm test:feature
pnpm test:smoke
```

The feature test owns only the
`operating-layer-feature-test_feature-test-postgres` volume and always tears it
down. It covers successful intake, duplicate/conflicting idempotency keys,
typed agent output, approval routing, entity authorization/RLS, database
transition enforcement, immutable source/audit records, and retry exhaustion.

## Observe

- API request logs include a trace/request identifier.
- Workflow transitions, recommendations, approvals, and audit history appear
  on task detail.
- Failed/exhausted outbox work appears in the executive queue.
- PostgreSQL is authoritative for outbox attempts and workflow completion.
  Redis or process restarts do not decide either.

## Recover local services

Use `docker compose restart postgres` for a process restart that preserves the
local volume. Stop the stack with `docker compose down`.

To intentionally rebuild the local database from migrations, first confirm
that the Compose project is `operating-layer-local`, stop all application
processes, and then run:

```powershell
docker compose down --volumes
docker compose up --detach --wait
```

This deletes only the local Compose volumes and cannot be undone. Never use
this procedure against a shared or production environment.

## Known production blockers

- production hosting/network topology;
- Google Workspace OIDC client and group/role mapping;
- non-owner database identities and secret manager;
- backup, retention, audit-export, and recovery policy;
- approved model providers and data-handling rules;
- source-system schemas and read-only credentials.

Do not add a production connector, external send, or source-system write
without the next architecture and security review.
