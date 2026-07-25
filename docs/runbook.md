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

## Database identities

Local Compose initializes PostgreSQL with two distinct identities:

- `operating_layer` is the migration/administration identity and must never be
  used as `DATABASE_URL` by an application process.
- `operating_layer_runtime` is the non-owner, non-superuser, non-`BYPASSRLS`
  API/worker identity configured by `.env.example`.

API and worker startup query PostgreSQL role and table-ownership metadata
before accepting work. Startup fails with an
`UnsafeRuntimeDatabaseIdentityError` if the connection is a superuser, has
`BYPASSRLS`, or owns any RLS-protected table. Production must provision a
credentialed runtime role with the same invariants; migrations remain a
separate deployment step under a migration identity.

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
transition enforcement, task-status projection drift, safe runtime identity,
audit immutability and chain verification/tamper detection, trace equality,
and retry exhaustion.

## Continuous integration and merge gate

`.github/workflows/ci.yml` runs one required job named `verify` for pull
requests targeting `main` and pushes to `main`. It installs from the frozen
lockfile, checks formatting, type-checks every workspace package, runs the
feature suite against a clean PostgreSQL 16 database (including all
migrations), and builds the workspace.

The `verify` workflow is green, but it is not yet a merge gate. GitHub rejected
the `main` protection request with `403` because private-repository branch
protection is unavailable on the repository's current plan. Do not describe CI
as enforced until an administrator upgrades the plan (or deliberately makes
the repository public), requires the exact `verify` check with strict
up-to-date branches and admin enforcement, and proves the gate with a
deliberately failing throwaway pull request. The proof must show GitHub
reporting the failing check and blocking merge; close the pull request without
merging afterward.

## Observe

- API request logs include a trace/request identifier.
- Workflow transitions, recommendations, approvals, and audit history appear
  on task detail.
- The audit verifier recomputes sequence, prior-hash linkage, canonical event
  hashes, and the stream head. A verification failure is an integrity incident;
  the Phase 1 verifier is not an external cryptographic anchor against an
  administrator who rewrites and re-hashes the complete database history.
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
- production runtime credentials and secret manager;
- backup, retention, audit-export, and recovery policy;
- approved model providers and data-handling rules;
- source-system schemas and read-only credentials.

Do not add a production connector, external send, or source-system write
without the next architecture and security review.
