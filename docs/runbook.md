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

Local Compose initializes PostgreSQL with three distinct identities:

- `operating_layer` is the migration/administration identity and must never be
  used as `DATABASE_URL` by an application process.
- `operating_layer_runtime` is the non-owner, non-superuser, non-`BYPASSRLS`
  API identity configured by `.env.example`.
- `operating_layer_worker_runtime` is the separate non-owner worker login. It
  may assume `operating_layer_worker`, the only role granted access to load
  organization-scoped encrypted credential envelopes.

API and worker startup query PostgreSQL role and table-ownership metadata
before accepting work. Startup fails with an
`UnsafeRuntimeDatabaseIdentityError` if the connection is a superuser, has
`BYPASSRLS`, or owns any RLS-protected table. Production must provision a
credentialed runtime role with the same invariants; the worker additionally
requires membership in `operating_layer_worker`. Migrations remain a separate
deployment step under a migration identity.

## Connector encryption keys

Generate separate non-production RSA key material for local use; do not commit
the output or place production keys in `.env.example`.

```powershell
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out connector-private.pem
openssl pkey -in connector-private.pem -pubout -out connector-public.pem
openssl pkcs8 -topk8 -nocrypt -in connector-private.pem -outform DER |
  openssl base64 -A
openssl pkey -pubin -in connector-public.pem -outform DER |
  openssl base64 -A
```

Set the public output as `CONNECTOR_CREDENTIAL_PUBLIC_KEY_DER_B64` for the API.
Set the private output as `CONNECTOR_CREDENTIAL_PRIVATE_KEY_DER_B64` only for
the worker. Set `WORKER_DATABASE_URL` to the dedicated worker login. Delete the
temporary PEM files after transferring the keys into the local secret store.
API startup refuses a missing public key; worker startup refuses a missing
private key, a non-worker DB role, unsafe legacy references, or an enabled
connector without an active encrypted credential.

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
It additionally proves the disabled-by-default Mail-draft branch: exact
preview without materialization, approval/config/authorization gates,
recipient allowlist, API plus RLS isolation, stored-result replay without a
second provider call, kill-switch fallback to internal execution, trace/audit
continuity, bounded-retry dead-letter visibility, ciphertext-at-rest,
worker-only/RLS credential access, exact scope rejection, replay-safe rotation,
old-version invalidation, global kill across organizations, startup invariants,
and token absence from durable audit/trace data. Tests inject in-memory Mail
and OAuth-revocation transports and make no Google network request. The suite
also exercises the supervised-pilot operator path: one-org claim, second-org
rejection, exact-scope/ciphertext/allowlist preflight, out-of-allowlist
rejection, credential-level disable, claim release, and immutable lifecycle
evidence.

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
  refuses selection as the internal provider.
- Outlook draft creation is separately inert by default. No seeded organization
  has a connector binding, and the worker uses
  `DisabledMailDraftExecutionProvider` unless
  `MAIL_DRAFT_NETWORK_ENABLED=true`. Do not set that variable or create an
  enabled organization config without a production-enablement review,
  least-privilege credential, allowlist, and crash-window decision.
- The Mail adapter exposes only `drafts.create` under
  `https://graph.microsoft.com/Mail.ReadWrite`. There is no send route or
  send method, and the separate `mail.send`/broader Mail scopes are not
  requested. Google's compose scope can itself authorize sending; because no
  draft-only scope exists, the fixed drafts-create transport and credential
  controls are part of the safety boundary.
- Credential plaintext is RSA-OAEP/AES-256-GCM envelope-encrypted before
  persistence. PostgreSQL stores ciphertext plus non-secret fingerprint/scope
  metadata. Only the dedicated worker DB role can load a scoped envelope, and
  only the worker process receives the private key. Decryption occurs for one
  execution call; tokens never enter source, audit metadata, traces, prompts,
  browser state, or safe error fields.
- Organization disable, explicit revoke, and rotation synchronously invalidate
  the active credential before queuing bounded OAuth revocation. The global
  Mail kill switch invalidates every organization binding. Clearing it never
  resurrects credentials.
- Preview stores the exact recipient, subject, body, and hash but queues no
  external command. A second authorized action creates the Mail command.
  The worker rechecks the active config and allowlist immediately before the
  call. If the config is disabled or replaced, it records abandonment, makes
  no Mail call, and returns the task to `approved` for internal execution.
- An execution enters `executing` before provider invocation. A successful
  result reaches `completed`; an executor failure retries at most three times,
  then atomically records `execution_failed`, an immutable failure result and
  audit event, and a visible `issue.execute` dead-letter.

## First supervised Outlook draft

This is a manual, attended smoke procedure for exactly one named organization,
one internal recipient, and one draft. It is not a CI procedure and it does
not authorize general production use. Read ADR 0007 and make a working copy of
`docs/evidence/mail-draft-live-pilot-template.md` in the approved evidence
store before starting.

### Required people and system posture

- One operator has `connectors.admin` for the target organization and
  `admin.manage` for every active organization.
- One authorized approver/authorizer can inspect and approve the exact draft.
- An independent observer watches the Mail mailbox and teardown.
- API and worker runtime database identities pass the non-owner,
  non-superuser, non-`BYPASSRLS` startup checks.
- Production RSA key material is loaded from the secret manager: public key
  only in the API, private key only in the worker.
- The approved Google Workspace OAuth flow requests exactly
  `https://graph.microsoft.com/Mail.ReadWrite`. Reject a consent/token
  response that contains another Mail scope. Do not use `mail.send`,
  `Mail.Send`, or `Mail.ReadWrite` beyond the pinned grant.
- `MAIL_DRAFT_NETWORK_ENABLED` is absent or `false` on every worker.
- The global Mail kill is clear but remains reachable.
- No connector token, private key, or bearer token is placed in command
  arguments, source files, tickets, evidence, or chat.

Stop if any condition is untrue.

### 1. Set non-secret identifiers and operator secrets

Use a fresh PowerShell session with history disabled or protected according to
the organization's workstation policy. Inject
`OPERATING_LAYER_OPERATOR_BEARER_TOKEN`,
`OPERATING_LAYER_AUTHORIZER_BEARER_TOKEN`, and
`MAIL_DRAFT_OAUTH_ACCESS_TOKEN` directly from the approved secret manager;
do not type their values into the command line. Set only the non-secret values
manually:

```powershell
$env:API_BASE_URL = "https://<api-host>"
$pilotOrgId = "<organization-uuid>"
$pilotOrgCode = "<organization-code>"
$pilotRecipient = "<single-internal-test-address>"
$enableOperationId = [guid]::NewGuid().ToString()
if (-not $env:OPERATING_LAYER_OPERATOR_BEARER_TOKEN) { throw "Missing operator token" }
if (-not $env:OPERATING_LAYER_AUTHORIZER_BEARER_TOKEN) { throw "Missing authorizer token" }
if (-not $env:MAIL_DRAFT_OAUTH_ACCESS_TOKEN) { throw "Missing Mail OAuth token" }
```

The OAuth access token is read only from
`MAIL_DRAFT_OAUTH_ACCESS_TOKEN`. The CLI intentionally has no token flag and
never returns token plaintext.

### 2. Claim, credential, enable, and preflight

From the repository release commit:

```powershell
pnpm mail-draft:pilot enable `
  --organization-id $pilotOrgId `
  --organization-code $pilotOrgCode `
  --recipient $pilotRecipient `
  --reason "First supervised Outlook drafts.create smoke" `
  --operation-id $enableOperationId `
  --confirm-one-org `
  --confirm-drafts-create-only
```

Save the non-secret JSON output in the evidence store. Do not continue unless
`readyForLiveDraft` is `true` and every named check is `true`:

- target pilot claim and connector enabled;
- active structurally valid credential envelope and matching SHA-256
  fingerprint;
- stored/configured scope sets exactly `mail.compose`;
- one exact recipient address, no recipient domains, and the expected address
  accepted;
- zero other enabled organizations;
- global kill clear and reachable; and
- structural no-send.

Re-run the read-only check at any point with:

```powershell
pnpm mail-draft:pilot preflight `
  --organization-id $pilotOrgId `
  --organization-code $pilotOrgCode `
  --recipient $pilotRecipient
```

The database claim and trigger reject an enabled config for another
organization until teardown. If enable fails partway, the command attempts
config disable/credential invalidation and claim release. Treat any cleanup
error as an incident: invoke the disable command in step 8 and, if necessary,
set the global kill.

### 3. Create and approve one test task

In the web application:

1. Create one issue in the claimed organization with a unique title beginning
   `LIVE MAIL DRAFT SMOKE - <UTC timestamp>`.
2. Use non-sensitive test content. The recommendation must be
   `draft_external_follow_up`.
3. Wait for classification/recommendation and inspect all citations.
4. Resolve the internal approval as approved with a recorded reason.
5. Record the task, workflow, approval, policy version, and root trace IDs.

Do not reuse a customer escalation, real receivable, or other operational task
for this smoke.

### 4. Render and inspect the exact preview

On task detail, create one Mail preview addressed exactly to
`$pilotRecipient`. Use a unique subject containing the task ID and UTC
timestamp. Before proceeding, the operator and observer compare the rendered
recipient, subject, and body with the intended smoke content and record the
preview ID and payload hash.

Preview persists the exact payload and moves the workflow to
`awaiting_external_authorization`; it does not create an external command or
call Google.

### 5. Prove a quiet execution queue

Stop all ordinary workers. Using the migration/operations read-only database
session—not an application runtime credential—run:

```sql
SELECT
  command.id,
  command.organization_id,
  command.task_id,
  command.trace_id
FROM operating_layer.execution_commands AS command
LEFT JOIN operating_layer.execution_results AS result
  ON result.organization_id = command.organization_id
 AND result.execution_command_id = command.id
LEFT JOIN operating_layer.mail_draft_execution_abandonments AS abandonment
  ON abandonment.organization_id = command.organization_id
 AND abandonment.execution_command_id = command.id
WHERE command.provider_name = 'mail_draft'
  AND result.id IS NULL
  AND abandonment.id IS NULL;
```

The result must be empty because authorization has not happened. If any row is
present, do not start a network-enabled worker; disable the pilot and
investigate.

Choose and record one fresh authorization idempotency key. Use the explicit API
procedure in step 7 so the key can be replayed exactly; preserve the root trace
as `X-Trace-Id`.

### 6. Start one supervised live worker

In a dedicated terminal with the approved worker database URL and private key
already loaded from the secret manager:

```powershell
$env:MAIL_DRAFT_NETWORK_ENABLED = "true"
$env:WORKER_ID = "supervised-mail-draft-<change-id>"
pnpm --filter @operating-layer/worker start
```

Run exactly one network-enabled worker. It must remain attended until teardown.
Do not start the worker until the quiet-queue check is empty.

### 7. Authorize once and verify

Authorize the immutable preview with an explicit, recorded idempotency key. Set
the non-secret IDs from task detail and run:

```powershell
$previewId = "<preview-uuid>"
$rootTraceId = "<task-root-trace-id>"
$authorizationKey = [guid]::NewGuid().ToString()
$authorizationHeaders = @{
  Authorization = "Bearer $env:OPERATING_LAYER_AUTHORIZER_BEARER_TOKEN"
  "Content-Type" = "application/json"
  "Idempotency-Key" = $authorizationKey
  "X-Trace-Id" = $rootTraceId
}
$authorizationBody = @{
  organizationId = $pilotOrgId
  reason = "Authorize exactly one supervised unsent Outlook draft"
} | ConvertTo-Json
$authorizationResult = Invoke-RestMethod `
  -Method Post `
  -Uri "$env:API_BASE_URL/v1/mail-draft-previews/$previewId/authorization" `
  -Headers $authorizationHeaders `
  -Body $authorizationBody
$authorizationResult | ConvertTo-Json -Depth 10
```

Save only the non-secret response in the evidence store. The authorization
creates one outbox command; the worker may then call only
`users.drafts.create`.

Wait for task detail to reach `completed`, then verify all of the following:

1. Mail Drafts contains exactly one item with the expected recipient, subject,
   and body.
2. Task detail contains one immutable `mail_draft.created` audit event whose
   metadata includes the returned draft ID, preview ID, authorization ID,
   command ID, payload hash, and `drafts.create` capability.
3. The root trace is unchanged across intake, approval, preview,
   authorization, outbox/worker processing, execution result, and audit.
4. The audit chain verifier succeeds for the organization.

Replay the authorization with the _same_ idempotency key and identical body:

```powershell
$replayResult = Invoke-RestMethod `
  -Method Post `
  -Uri "$env:API_BASE_URL/v1/mail-draft-previews/$previewId/authorization" `
  -Headers $authorizationHeaders `
  -Body $authorizationBody
$replayResult | ConvertTo-Json -Depth 10
```

It must return `duplicate: true` with the stored prior IDs, and Mail must
still contain exactly one matching draft. Never retry with a new key after an
ambiguous timeout. Google does not accept the operating layer's idempotency
key; first inspect Mail by exact subject and draft ID.

Search API, worker, trace, and audit output for the token fingerprint and, in a
controlled secret-scanning tool, the token value. Record only the negative
result and query reference; never paste the token into evidence or a general
log-search field.

### 8. Tear down immediately

Whether the draft succeeds or fails, disable the pilot before ending the
session:

```powershell
$disableOperationId = [guid]::NewGuid().ToString()
pnpm mail-draft:pilot disable `
  --organization-id $pilotOrgId `
  --organization-code $pilotOrgCode `
  --reason "End first supervised Outlook draft smoke" `
  --operation-id $disableOperationId
```

The command first writes a disabled config and synchronously invalidates the
credential, then releases the one-org claim. Do not stop until its preflight
reports:

- `pilotClaimActive: false`;
- `targetConnectorEnabled: false`;
- `activeCredentialPresent: false`;
- `allOtherOrganizationsDisabled: true`; and
- `disabledByDefault: true`.

Allow the bounded OAuth revocation job to finish, then stop the live worker:

```powershell
Remove-Item Env:MAIL_DRAFT_NETWORK_ENABLED -ErrorAction SilentlyContinue
Remove-Item Env:MAIL_DRAFT_OAUTH_ACCESS_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:OPERATING_LAYER_OPERATOR_BEARER_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:OPERATING_LAYER_AUTHORIZER_BEARER_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:CONNECTOR_CREDENTIAL_PRIVATE_KEY_DER_B64 -ErrorAction SilentlyContinue
```

Close the terminal and confirm the normal worker environment still has network
execution disabled. A previously active credential version must now fail local
load even if provider revocation is delayed.

### 9. Roll back the draft

Rollback is deliberately manual because the connector has no delete or send
capability:

1. Open the exact mailbox in Mail.
2. Open **Drafts**.
3. Find the item by the recorded unique subject and confirm its Outlook draft ID
   when available.
4. Open it, choose **Discard draft**, and confirm it no longer appears.
5. Record the UTC time and observer in the evidence copy.

Nothing was sent, so no recipient-side compensation is needed. Do not add a
delete capability merely to automate this one rollback.

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

The Outlook draft code path must remain disabled until the production-enablement
items above are approved. Do not add an external send, another connector
mutation, or an ERP/accounting write without a separate architecture and
security review.
