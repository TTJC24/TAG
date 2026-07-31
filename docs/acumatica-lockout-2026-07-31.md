# Lockout of 2026-07-31 08:36 — investigation

## The evidence, as given

| Fact | Value |
|---|---|
| Last password change | 2026-07-30 21:55 |
| Last successful login | 2026-07-30 22:27 |
| Last lockout | 2026-07-31 08:36 |
| Unsuccessful password attempts | **exactly 3** |
| Current status | Online |
| Safeguards on production | **not deployed** |

## What this changes

My previous leading hypothesis was Contract API **seat contention**. That is now
demoted. It is still a real constraint on this instance — company-brain
documents it — but it does not explain this event.

Two facts move it:

1. A password change **ten hours before** the lockout. Seat exhaustion does not
   care about passwords.
2. **Exactly 3** unsuccessful attempts. Seat exhaustion produces an `API Login
   Limit` response, not a failed-password count.

The leading hypothesis is now: **a process holding the OLD password
authenticated once, and its client retried the login three times.**

## Why "exactly 3" is the strongest signal we have

Each candidate has a different, fixed failure count per triggering event. The
number 3 is not generic — it identifies the client.

### scoreboard — produces exactly 3, per HTTP request

`/home/user/scoreboard/backend/scoreboard/connectors/acumatica.py`

```python
retries: int = 2,                       # constructor default
...
for attempt in range(self.retries + 1): # 0, 1, 2 → THREE attempts
    ...
    except (error.HTTPError, ...):
        if attempt < self.retries:
            time.sleep(self.backoff_seconds * (2**attempt))
            continue                     # 0.5s, then 1.0s
        return self._failure(...)
```

`authenticate()` goes through this same `_request_json` wrapper as every read,
so **the login itself is retried**. A wrong password yields three `POST
/entity/auth/login` calls within about 1.5 seconds — one lockout event, three
failed attempts.

`api/routes.py:_build_dependencies()` constructs a **new** `AcumaticaClient` on
every request, with the default `retries=2` (never overridden). Any request to
`platform_status()` or `connector_status()` calls
`acumatica.fetch_branches(...)`, which authenticates from scratch.

The username is `agent.scoreboard`. The account is named after this application.

### company-brain — produces 1, and does not schedule Acumatica at all

`src/scheduler/index.ts`:

```ts
const DEFAULT_SCHEDULE: ScheduleEntry[] = [
  { sourceId: 'm365-calendar', cron: '*/30 * * * *' },
  { sourceId: 'm365-mail',     cron: '*/15 * * * *' },
  { sourceId: 'm365-sharepoint', cron: '0 */2 * * *' },
  { sourceId: 'm365-teams',    cron: '*/20 * * * *' },
  // Acumatica remains manual/capped until branch-scoped ERP data is QA'd for scheduling.
  { sourceId: 'pipedrive',     cron: '*/30 * * * *' },
];
```

Acumatica is **absent from the schedule by design**, and the scheduler filters
`SCHEDULER_SOURCES` against this list — so Acumatica cannot be scheduled even if
someone adds it to that variable. No API route touches Acumatica either; the
only path is a hand-run CLI.

Its client also does **one** login, no retry. A stale password there yields one
failed attempt, not three.

One caveat worth holding: company-brain caches its session cookie to disk and
reuses it. It can therefore run for a long time after a password change without
noticing, then attempt exactly one login whenever the cached session finally
expires — at an unpredictable time.

### operating-layer (TAG, this repo) — produces 1

No retry logic, and since this branch, one login per client instance enforced by
a latch. A stale password yields one failed attempt per run.

The deployed production code is **older than this branch** and has no breaker
and no unattended interlock — but it never had login retry either. It cannot
produce three attempts from one run.

### tractionos — produces 0

Checked: no Acumatica code, no calls to scoreboard, no Vercel cron. Not a
candidate.

### Summary

| Service | Failed logins per triggering event | Schedules Acumatica? |
|---|---|---|
| **scoreboard** | **3** | No internal cron — fires on HTTP request |
| company-brain | 1 | **No** — excluded from the schedule by design |
| operating-layer | 1 | Only if `COLLECTIONS_SCHEDULE_UTC` is set on the old deployed code |
| tractionos | 0 | No Acumatica code at all |

**Only scoreboard produces exactly 3.**

## The honest gaps

State plainly what this does not establish:

- **Whether scoreboard is deployed at all.** Its repo has no Dockerfile, no
  compose file, no Procfile and no systemd unit. If it is running, it is running
  from somewhere not visible in the source tree. **This must be confirmed on the
  server** — the fingerprint below identifies the client, not the host.
- **What triggered it at 08:36.** scoreboard has no internal scheduler; its
  Acumatica calls fire on HTTP requests. Something called it — a monitor, a
  dashboard, a health check, a person opening a page. That caller is the actual
  scheduled process, and it has not been identified.
- **The timezone of 08:36.** Acumatica displays in the tenant/user timezone. If
  Eastern, 08:36 ET = 12:36 UTC. Log searches must use the right one.
- **Who logged in successfully at 22:27**, 32 minutes after the password change.
  Whichever service that was is holding the *current* password. Step 3 below
  identifies it without revealing anything.

"Online" and "locked out" are not contradictory: a session established before a
lockout survives it. Do not read Online as evidence that authentication
currently works.

## 1. Find every service using this account

```bash
sudo sh /opt/operating-layer/scripts/acumatica-secret-audit.sh
```

Searches `/opt /srv /home /root /etc` for `.env`-style files **and inspects the
environment of every running container** — which is what actually
authenticates, and which can differ from any file on disk when a container was
started before the file was edited. That divergence is precisely the situation
under investigation.

Prints locations, whether each uses the same account, and an 8-character
password fingerprint. **Never prints passwords, usernames, or file contents** —
verified against fixtures by grepping the full output for every known secret.

If a service lives elsewhere: `SEARCH_ROOTS=/path sudo sh …`

## 2. Identify what ran at 08:36

```bash
# Convert first: if Acumatica displays Eastern, 08:36 ET = 12:36 UTC.

# Every container's logs in that window
for c in $(docker ps -aq); do
  echo "=== $(docker inspect --format '{{.Name}}' $c) ==="
  docker logs --since 2026-07-31T08:20:00 --until 2026-07-31T08:50:00 "$c" 2>&1 | tail -40
done

# Host-level scheduled work
sudo journalctl --since "2026-07-31 08:20" --until "2026-07-31 08:50" | grep -Ei 'cron|systemd|timer'
sudo crontab -l; for u in $(cut -f1 -d: /etc/passwd); do sudo crontab -l -u "$u" 2>/dev/null; done
ls -la /etc/cron.d/ /etc/cron.daily/ /etc/cron.hourly/
systemctl list-timers --all

# Anything reaching scoreboard's API
sudo journalctl --since "2026-07-31 08:20" --until "2026-07-31 08:50" \
  | grep -Ei 'platform_status|connector_status|leadership_flash|scoreboard'
```

Also check any uptime monitor, status page, or dashboard that polls a
scoreboard endpoint on an interval — that is the shape of trigger that fits an
08:36 event with no cron entry.

## 3. Which secret holds the old password

```bash
sudo sh /opt/operating-layer/scripts/acumatica-secret-audit.sh --check-password
```

Prompts for the **current** password with terminal echo disabled. The value is
held in a shell variable, hashed with a random per-run salt, and never written
to disk, logged, printed, or transmitted. Each location is then reported as:

```
  vs current   : MATCHES CURRENT PASSWORD
  vs current   : *** STALE — DOES NOT MATCH CURRENT PASSWORD ***
```

Two locations showing the **same fingerprint** hold the same password — so you
can see that, say, two services share one stale secret and need one rotation,
without learning either value. Salts are per-run, so fingerprints are not
comparable across runs and are not usable for offline cracking.

**Every STALE location using this account is a live lockout risk.** One that
retries is a lockout generator.

## 4. Stop everything scheduled on this account

Do this **before** the account is reset. Resetting first just feeds the next
lockout.

```bash
# scoreboard — stop the service AND whatever polls it. Stopping only one leaves
# the other retrying into a locked account.
# (deployment mechanism unknown from source; identify it in step 1/2 first)

# company-brain — Acumatica is not scheduled, but the scheduler can be stopped
# wholesale if you want certainty:
cd /opt/company-brain/repo/infra && docker compose stop company-brain-scheduler

# operating-layer — the worker is the only unattended path:
cd /opt/operating-layer
docker compose -f compose.production.yaml --env-file .env.production stop worker
```

Then confirm nothing is left: re-run step 1 and check that no *running
container* holds this account, or that every one that does is stopped.

## 5. Deploy the safeguards

They are on `claude/phase-1-implementation-review-ujy1z1` and **not** on
production — confirmed by the account-check script's absence there.

```bash
cd /opt/operating-layer
git fetch origin claude/phase-1-implementation-review-ujy1z1
git checkout claude/phase-1-implementation-review-ujy1z1
git pull

# Leave the interlock UNSET. Do not add ACUMATICA_UNATTENDED_ENABLED.
grep -c '^ACUMATICA_UNATTENDED_ENABLED' .env.production   # must print 0

docker compose -f compose.production.yaml --env-file .env.production build api worker
docker compose -f compose.production.yaml --env-file .env.production up -d api worker
```

This brings up: the persistent circuit breaker, the exclusive run lock, one
login per client instance, login-transport failures tripping the breaker, and
the unattended interlock defaulting to off.

Note what these do and do not do. They stop **operating-layer** from
contributing to a lockout. They have no effect on scoreboard or company-brain,
which are separate deployments. If scoreboard is the source, the safeguards do
not fix it — stopping it does.

## 6. Verify on the running containers

```bash
DC="docker compose -f compose.production.yaml --env-file .env.production"

# The worker is authoritative — it is the only component that can authenticate
# unattended.
$DC exec worker node apps/api/dist/acumatica-breaker-cli.js status
$DC logs worker | grep acumatica.unattended.status | tail -1
$DC ps worker            # confirm pid/startedAt match the line above

$DC exec api node apps/api/dist/acumatica-breaker-cli.js status
```

Required:

```
→ collections feed scheduled : NO — no unattended Acumatica login can occur
```

```json
{"event":"acumatica.unattended.status","unattendedPermitted":false,
 "collectionsScheduled":false,…}
```

Both are required and answer different questions: `exec` reads the container's
current environment (what a restart would produce); the log line is what the
live process decided at its own startup. They diverge whenever the environment
changed without a restart.

## 7. Likely source

**scoreboard, holding the pre-2026-07-30 password, triggered by an HTTP request
to a status endpoint at 08:36.**

Supporting it:

- Its client retries the login exactly 3 times (`retries=2`, `range(retries+1)`,
  0.5s and 1.0s backoff) — matching the observed count exactly.
- It builds a fresh client per request with the default retry count, so every
  request re-authenticates.
- `platform_status()` and `connector_status()` both call Acumatica — endpoints a
  monitor or dashboard polls.
- The account is literally named `agent.scoreboard`.
- No other candidate can produce three attempts from one event.

Not yet confirmed, and required before acting on it:

- That scoreboard is deployed and running (step 1).
- What called it at 08:36 (step 2).
- That its stored password is the stale one (step 3).

If step 3 shows scoreboard's secret **matches** the current password, this
hypothesis is wrong and the investigation returns to step 1's inventory — some
other holder of this account has the old secret.

**Order: stop the source (4), then reset the account. Not the reverse.**
