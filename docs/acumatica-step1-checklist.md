# Step 1 — pre-flight checks, execution, and results

One login. One logout. No reads. Then stop.

## The two mechanisms are separate and stay separate

This is the point of the whole exercise, so it is stated first:

| | **Failed-login counter** | **Concurrent API-session count** |
|---|---|---|
| What it counts | Rejected authentication attempts | Live Contract API sessions held by the user |
| Where | Acumatica → Users → the account's failed-attempt count | Acumatica → System → Management → **Active Users / API sessions** |
| What trips on it | `SM201060` account lockout | `API Login Limit` / seat exhaustion |
| Our evidence for it | 401s, rejected logins | company-brain's client and README |
| Our guard | Circuit breaker | Nothing yet — this is why we are measuring |

They can look alike from the client side — both end a run — and conflating them
is how the previous explanation went wrong. **Record them in separate columns.
Never sum them, never infer one from the other.**

## A. Before touching anything — IN THIS ORDER

The order is load-bearing. A1 is a **gate**, not a data-gathering step.

### A1. GATE — is `agent.scoreboard` shared? Answer this FIRST.

**Do not clear API sessions and do not run Step 1 until this is answered.**

Clearing sessions for a shared account would disrupt company-brain, which is a
working production integration. Fixing our unproven integration by breaking a
working one is not an acceptable trade, and it would also destroy the evidence:
a session count that another process is concurrently changing cannot serve as a
baseline for anything.

Three codebases read this instance: TAG (this repo), company-brain, scoreboard.
The real `.env` files live on their hosts, not in any repo, so this cannot be
answered from code:

```bash
# TAG
sudo grep -h '^ACUMATICA_USERNAME=' /opt/operating-layer/.env.production
# company-brain
sudo grep -h '^ACUMATICA_USERNAME=' /opt/company-brain/infra/.env
```

The username alone answers it. Do not paste passwords anywhere.

| Integration | Acumatica user | Same as TAG? |
|---|---|---|
| TAG (this repo) | `agent.scoreboard` (per APPROVALS.md) | — |
| company-brain | | |
| scoreboard | | |

**If the account IS shared — STOP HERE.**

- Do **not** clear API sessions.
- Do **not** unlock-and-run Step 1.
- Do **not** clear the breaker.

Provision a **dedicated read-only API account for TAG** first, then restart this
checklist from A1 with the new account. This is the same remedy company-brain's
own README arrives at from operational experience: *provision a dedicated
read-only API user/session capacity.*

A shared account is not merely an obstacle to the test — it is a strong
candidate for the mechanism itself. Three integrations competing for one user's
Contract API seats explains seat exhaustion without needing any bug on our side.

**Only if the account is separate, continue to A2.**

### A2. Clear stale API sessions

Ask the Acumatica admin to clear stale Contract API sessions for **TAG's own
account** (never a shared one — see A1). An abandoned session holds a seat until
it times out, so one left over from the lockout period would make Step 1 fail
for a reason that has nothing to do with Step 1.

Do this **before** taking the baseline in A3, so the baseline is a true floor.

### A3. Take the baseline — both numbers, separately

Immediately before running Step 1, and after A2:

| Measurement | Where | Value |
|---|---|---|
| Failed-login counter | Users → TAG's account | |
| Active API sessions (this user) | Active Users / API sessions | |
| Timestamp (UTC) | | |

## B. Local preconditions

### B1. Every unattended Acumatica process is disabled

There is exactly **one** unattended path in this codebase: the worker's
scheduled collections feed. Everything else that authenticates is an operator
CLI, run by hand.

Verified by audit:

- `runCollectionsFeed` has two callers: `apps/worker/src/main.ts` (the scheduled
  path) and `apps/api/src/acumatica-collections-fetch-cli.ts` (a hand-run
  command).
- Five `new AcumaticaClient` sites outside tests: feed-runner, preflight-cli,
  validate-cli, probe-cli, customer-export-cli. Only feed-runner is reachable
  unattended.
- No cron, no systemd timer, no `setInterval` touches Acumatica.

Confirm it **on the running host** rather than trusting the above. The **worker**
is the authoritative component here: it is the only one that can schedule a
feed, so its effective environment is what decides whether an unattended login
can happen. Checking only the api container answers a different question.

```bash
DC="docker compose -f compose.production.yaml --env-file .env.production"
```

**B1a — the worker container's environment** (what a restart would produce):

```bash
$DC exec worker node apps/api/dist/acumatica-breaker-cli.js status
```

Both images are built from the same `/repo` layer, so this CLI is present in the
worker too. Required:

```
→ collections feed scheduled : NO — no unattended Acumatica login can occur
```

**B1b — what the RUNNING worker process actually decided** (authoritative):

```bash
$DC logs worker | grep acumatica.unattended.status | tail -1
```

Required:

```json
{"event":"acumatica.unattended.status","unattendedEnvRaw":null,
 "unattendedPermitted":false,"collectionsScheduled":false,
 "startedAt":"…","pid":…}
```

**B1a and B1b answer different questions and both are required.** `exec` starts
a *new* process and reads the container's current environment; the log line is
what the *live* worker resolved at its own startup. They diverge whenever the
environment changed without a restart — exactly the case where reading only one
of them misleads. Confirm the `startedAt`/`pid` correspond to the currently
running worker (`$DC ps worker`), not a previous boot.

The line is emitted unconditionally, before the database and credential checks,
so it appears even for a worker that is crash-looping. That matters because
*absence* of a log line is not evidence — a rotated log, a failed startup and a
correctly-disabled feed all look identical.

Also check the api container, since it is where the operator CLIs run:

```bash
$DC exec api node apps/api/dist/acumatica-breaker-cli.js status
```

### B2. `ACUMATICA_UNATTENDED_ENABLED` — exactly what is accepted

**The only accepted value is the exact string `true`.** Everything else — unset,
different case, numeric, whitespace-padded — leaves unattended authentication
**disabled**. Verified by running the real binary against each value:

| Value | Accepted? | Collections scheduled? |
|---|---|---|
| `<unset>` | NO | NO |
| `"true"` | **YES** | YES |
| `"TRUE"` | NO | NO |
| `"True"` | NO | NO |
| `"1"` | NO | NO |
| `"yes"` | NO | NO |
| `"on"` | NO | NO |
| `" true"` (leading space) | NO | NO |
| `"true "` (trailing space) | NO | NO |
| `"enabled"` | NO | NO |
| `""` (empty) | NO | NO |

This is a strict equality check (`=== "true"`), matching the existing
`COLLECTIONS_ENABLED` / `PIPEDRIVE_SALES_ENABLED` convention in this codebase.
It is a second, independent interlock: `COLLECTIONS_SCHEDULE_UTC` alone will not
schedule the feed.

### B3. Current breaker status

Read it on the droplet with the command in B1. The state file lives at
`/var/lib/operating-layer/acumatica/production-breaker.json`, on a named volume
shared by the api and worker containers, so it survives redeploys.

Required before Step 1: `tripped : false`.

*(Local checkouts and CI have their own state under `ACUMATICA_GUARD_DIR` and
say nothing about production. Only the droplet's answer counts.)*

### B4. The exact breaker-clear command

Run this **only after** A1 confirmed the account is NOT shared, stale sessions
were cleared (A2), the baseline was taken (A3), and the ERP account was
unlocked. Clearing it before the account is actually unlocked spends the next
login on a locked account, which is the failure the breaker exists to prevent.

```bash
docker compose -f compose.production.yaml --env-file .env.production \
  exec api node apps/api/dist/acumatica-breaker-cli.js clear \
  --who "Tim Clark" \
  --confirm I-CHECKED-THE-ERP-ACCOUNT
```

Both flags are mandatory. `--who` is recorded in the state file. The
confirmation string must match exactly; anything else exits 2 and changes
nothing.

If the breaker is already clear, this command is unnecessary — do not run it.

## C. Run Step 1, exactly once

Preconditions, all of which must hold:

- [ ] A1 — the account is **not** shared with company-brain or scoreboard
- [ ] A2 — stale API sessions cleared for TAG's own account
- [ ] A3 — both baseline numbers recorded, separately
- [ ] B1a — worker container reports the feed unscheduled
- [ ] B1b — the running worker's log line confirms `collectionsScheduled: false`
- [ ] B3 — breaker reports `tripped : false`
- [ ] ERP account unlocked

```bash
docker compose -f compose.production.yaml --env-file .env.production \
  exec api node apps/api/dist/acumatica-validate-cli.js \
  --step 1 --operator "Tim Clark"
```

What it sends, and nothing else:

1. `POST /entity/auth/login`
2. `POST /entity/auth/logout`

No entity read. No retry. If the login fails, the command stops and reports the
response verbatim — and the breaker will have tripped, so a second attempt is
refused before any network call.

**Do not run Step 2 or 3.** They are separate, operator-initiated decisions.

## D. Report — fill in and stop

| Item | Result |
|---|---|
| Ran at (UTC) | |
| Operator | |
| Login result | |
| Logout result | |
| Any request beyond login and logout? | |
| Command exit code | |

Access History entries for the window (list each, with how Acumatica recorded
it — successful login, failed login, or plain request):

| Time (UTC) | Entry | Recorded as |
|---|---|---|
| | | |

The two counters, kept apart:

| Measurement | Before | After | Moved? |
|---|---|---|---|
| Failed-login counter | | | |
| Active API sessions (this user) | | | |

Breaker state after the run:

| Field | Value |
|---|---|
| `tripped` | |
| `lastSuccessAt` | |
| `lastFailureKind` | |

### What each outcome means

- **Login OK, logout OK, neither counter moved.** Clean. Step 2 becomes a
  reasonable next request.
- **Login OK, but active sessions did not return to baseline after logout.**
  Our logout is not freeing the seat. That is a seat-leak on our side and must
  be understood before any further run.
- **Login OK, failed-login counter moved anyway.** Something records a success
  as a failure. That changes the whole model and Step 2 must not run.
- **Login failed.** Report the status and body verbatim. Do not re-run, do not
  clear the breaker. The response text distinguishes a credential problem from
  `API Login Limit` — and those are the two separate mechanisms above.
