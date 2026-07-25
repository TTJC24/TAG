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
down. It covers successful intake, seven-day idempotency retention and reaping,
typed agent output, declarative policy equivalence and activation controls,
internal approve/reject resolution, approved-only deterministic execution,
execution success and exhausted-retry failure, entity authorization/RLS,
database transition enforcement, task-status projection drift, safe runtime
identity, audit immutability and chain verification/tamper detection, trace
equality, and dead-letter visibility. It also uploads a mixed CSV batch,
proves exact immutable raw-file evidence and source linkage, rejects malformed
rows without rolling back valid siblings, replays duplicate batch/row
commands, and exhausts a real downstream CSV row job into a visible failure.

## Continuous integration and merge gate

`.github/workflows/ci.yml` runs one check named `verify` for pull
requests targeting `main` and pushes to `main`. It installs from the frozen
lockfile, checks formatting, type-checks every workspace package, runs the
workspace unit tests, runs the feature suite against a clean PostgreSQL 16
database (including all migrations), and builds the workspace.

### Accepted single-committer exception

Strict hosted branch protection is waived only while this repository has
exactly one human committer and is not a dependency for other work. The team
still uses pull requests: do not push directly to `main`, and do not merge a PR
unless its exact `verify` check is green.

The exception ends immediately when either condition occurs:

1. a second human receives commit access; or
2. another repository, deployment, or team begins depending on this repository.

At that trigger, a repository administrator must enable strict protection on
`main` (and any other default PR target) in one settings change:

1. Open **Settings → Branches → Add branch protection rule**.
2. Set the branch name pattern to `main`.
3. Enable **Require a pull request before merging**.
4. Enable **Require status checks to pass before merging**.
5. Select the check with the exact name **`verify`**.
6. Enable **Require branches to be up to date before merging**.
7. Enable **Do not allow bypassing the above settings** (including
   administrators), then save.

Immediately prove the gate rather than trusting the setting: open a throwaway
PR that deliberately fails typecheck or formatting, wait for `verify` to fail,
confirm GitHub disables merge, and close the PR without merging. Then open a
passing PR and confirm the normal path. If the plan still returns `403` for
private-repository protection, upgrade the plan before the trigger condition
is allowed to persist.

## Observe

- API request logs include a trace/request identifier.
- Workflow transitions, recommendations, approvals, execution commands/results,
  and audit history appear on task detail.
- The audit verifier recomputes sequence, prior-hash linkage, canonical event
  hashes, and the stream head. A verification failure is an integrity incident;
  the Phase 1 verifier is not an external cryptographic anchor against an
  administrator who rewrites and re-hashes the complete database history.
- Failed/exhausted outbox work appears in the executive queue.
- Controlled CSV intake is available at `/csv-batches/new`. It accepts only
  the documented `csv-issue.v1` columns and a 1 MB maximum file. Batch result
  pages refresh while valid rows are pending and retain rejected/failed
  reasons. This is an internal upload path; it has no connector or external
  effect.
- PostgreSQL is authoritative for outbox attempts and workflow completion.
  Redis or process restarts do not decide either.
- The worker runs the bounded idempotency reaper at startup and every 15
  minutes. Reaper runs are recorded in `idempotency_reaper_runs`; failure only
  delays cleanup because PostgreSQL expiry remains authoritative.
- Approval outcomes are internal facts. Approval stops at `approved`.
  `completed` means the deterministic internal executor stored a successful
  internal outcome; it never implies that an external system was changed.
- `EXECUTION_PROVIDER` defaults to `deterministic_internal`. Any other value
  refuses worker startup. The database also rejects commands naming another
  provider.
- An execution enters `executing` before provider invocation. A successful
  result reaches `completed`; an executor failure retries at most three times,
  then atomically records `execution_failed`, an immutable failure result and
  audit event, and a visible `issue.execute` dead-letter.

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
