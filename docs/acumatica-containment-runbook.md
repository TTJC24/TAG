# Containment runbook — Acumatica account `agent.scoreboard`

**For the server administrator.** Every command here is run by whoever
administers the droplet. Nothing in this document is for Tim to run, and no
step asks anyone to type the Acumatica password into a script.

**Do not reset or test `agent.scoreboard` until every section below is
complete.** Resetting first just feeds the next lockout.

Status: the scoreboard explanation is the **leading hypothesis, not a confirmed
mechanism.** Sections 1–4 are what would confirm it. All four are required; any
one of them failing sends the investigation back to the inventory.

---

## Confirmation — all four required

### C1. Identify the deployed scoreboard process or container

The scoreboard repository contains **no Dockerfile, no compose file, no
Procfile and no systemd unit**. If it is running in production, it is deployed
by a mechanism not present in its source tree. That has to be found, not
assumed.

```bash
# Containers whose image or name suggests scoreboard
docker ps -a --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}' | grep -i score

# Any Python process serving the scoreboard package
ps auxww | grep -Ei 'scoreboard|uvicorn|gunicorn|fastapi|flask' | grep -v grep

# Host services and timers
systemctl list-units --type=service --all | grep -i score
systemctl list-timers --all
sudo crontab -l; for u in $(cut -f1 -d: /etc/passwd); do sudo crontab -l -u "$u" 2>/dev/null; done
ls -la /etc/cron.d/ /etc/cron.daily/ /etc/cron.hourly/ 2>/dev/null

# Anything listening that might be it
sudo ss -lntp
```

Record: **process/container identity, how it is started, and what port it
serves.** If nothing is found, scoreboard is not deployed here and the
hypothesis is wrong — go back to C2's inventory across all services.

### C2. Confirm it uses `agent.scoreboard`, without displaying credentials

```bash
sudo sh /opt/operating-layer/scripts/acumatica-secret-audit.sh
```

Discovery mode. No password prompt, no password required. It searches
`/opt /srv /home /root /etc` for `.env`-style files **and inspects the
environment of every running container** — the live container environment is
what actually authenticates, and it diverges from files on disk whenever a
container was started before a file was edited. That divergence is exactly the
situation under investigation.

Output is locations, a same-account yes/no against a reference, and an
8-character salted password fingerprint. **It never prints passwords,
usernames, or file contents.** Verified against fixtures containing known
secrets by grepping the full output for each one.

Record: **which locations hold this account.**

### C3. Confirm it held a stale credential — administrator-controlled

```bash
sudo sh /opt/operating-layer/scripts/acumatica-secret-audit.sh --check-password
```

The administrator — who already holds the current Acumatica password — enters
it at a prompt with terminal echo disabled. The value is held in a shell
variable, hashed with a random per-run salt, and never written to disk, logged,
printed, or transmitted. Each location is then reported as:

```
  vs current   : MATCHES CURRENT PASSWORD
  vs current   : *** STALE — DOES NOT MATCH CURRENT PASSWORD ***
```

Two locations sharing a fingerprint hold the same secret, so one rotation may
fix several. Salts are per-run, so fingerprints are not comparable across runs
and are not usable for offline cracking.

Record: **stale or current, per location.**

**If scoreboard's secret MATCHES the current password, the hypothesis is
wrong.** Some other holder of this account has the stale secret; return to C2's
inventory.

### C4. Correlate an inbound request with the 08:36 window

`08:36` is in Acumatica's display timezone. Convert first — if Eastern,
08:36 EDT = **12:36 UTC** — and search using the timezone the logs are in.

```bash
# Adjust the window to the converted time.
FROM=2026-07-31T12:20:00; TO=2026-07-31T12:50:00

for c in $(docker ps -aq); do
  echo "=== $(docker inspect --format '{{.Name}}' $c) ==="
  docker logs --since "$FROM" --until "$TO" "$c" 2>&1 | tail -60
done

sudo journalctl --since "2026-07-31 12:20" --until "2026-07-31 12:50" --no-pager

# Access logs for whatever serves scoreboard
sudo grep -rE '2026.07.31.(08|12):3[0-9]' /var/log/nginx/*.log 2>/dev/null \
  | grep -Ei 'platform_status|connector_status|leadership_flash|status'
```

What you are looking for: **an inbound HTTP request to a scoreboard endpoint**,
or an outbound `/entity/auth/login` from a scoreboard process, inside the
window. scoreboard has no internal scheduler — its Acumatica calls fire on HTTP
requests — so whatever made that request **is the scheduled process**, and it
has not yet been identified. Check uptime monitors, status pages, dashboards,
and any browser left open on a refreshing page.

Record: **the caller, or "not found".**

---

## Remediation

### R1. Stop the scoreboard Acumatica connector and its poller

Stop **both**. Stopping only the poller leaves a service that re-authenticates
on the next request from any source.

```bash
# Using the identity found in C1, e.g.:
docker stop <scoreboard-container>
# or
sudo systemctl stop <scoreboard-service> && sudo systemctl disable <scoreboard-service>

# Then the caller found in C4 — monitor, cron entry, dashboard, or status page.
```

Confirm nothing scoreboard-shaped is still running, and re-run the C2 discovery
to confirm no *running container* still holds this account.

### R2. Apply the scoreboard code fix

The fix is committed in the local scoreboard checkout and exported as a patch.
It is **not** pushed: that repository's `origin` currently points at
`TTJC24/TAG`, which is not its real remote, and pushing there would be wrong.
Route it through scoreboard's actual repository.

```bash
cd /path/to/scoreboard
git apply --check /opt/operating-layer/docs/patches/scoreboard-acumatica-containment.patch
git apply       /opt/operating-layer/docs/patches/scoreboard-acumatica-containment.patch
python3 -m pytest tests/ -q     # expect 43 passed
```

What it changes:

1. **Authentication is never retried.** `_request_json` takes a per-call
   `retries` override; `authenticate()` passes `0`. Data reads keep retrying —
   they carry a session, not a credential. This removes the three-attempt
   signature.
2. **A rejected credential latches for the process.** Removing retries alone is
   not enough: with a client built per HTTP request, an endpoint polled every
   30 seconds would still spend one attempt per poll and reach the threshold in
   minutes.
3. **The connector is disabled by default.** `SCOREBOARD_ACUMATICA_ENABLED`
   must be exactly `"true"`. Fails closed, so a deploy that forgets it cannot
   resume authenticating.
4. **Status endpoints no longer authenticate.** `platform_status()` and
   `connector_status()` use `status_snapshot()`, which reports connector state
   without contacting Acumatica and without disclosing credential material.

Note a deliberate behaviour change: `platform_status()` no longer reads
branches, so it reports `branch_mapping_state` as
`"not_verified_no_acumatica_read"` instead of deriving `"governed_complete"`
from an empty branch list. An empty list is not evidence that every branch is
mapped, and a status endpoint reporting unearned green is worse than one
reporting unknown. Anything consuming that field needs to handle the new value.

**Deploy with `SCOREBOARD_ACUMATICA_ENABLED` unset.** Do not set it until the
account has been reset and the credential updated.

### R3. Deploy the operating-layer safeguards

Pushed code absent from the server provides no protection. These are on
`claude/phase-1-implementation-review-ujy1z1` and are confirmed **not** on
production.

```bash
cd /opt/operating-layer
git fetch origin claude/phase-1-implementation-review-ujy1z1
git checkout claude/phase-1-implementation-review-ujy1z1
git pull

# The interlock must remain UNSET.
grep -c '^ACUMATICA_UNATTENDED_ENABLED' .env.production    # must print 0

DC="docker compose -f compose.production.yaml --env-file .env.production"
$DC build api worker
$DC up -d api worker
```

Be clear about scope: these constrain **operating-layer only**. They have no
effect on scoreboard or company-brain, which are separate deployments. If
scoreboard is the source, deploying this does not fix it — stopping it does.
Deploy it so operating-layer cannot become a second contributor.

### R4. Verify on the running containers

```bash
DC="docker compose -f compose.production.yaml --env-file .env.production"

$DC exec worker node apps/api/dist/acumatica-breaker-cli.js status
$DC logs worker | grep acumatica.unattended.status | tail -1
$DC ps worker
$DC exec api node apps/api/dist/acumatica-breaker-cli.js status
```

Required from the worker — it is the only component that can authenticate
unattended:

```
→ collections feed scheduled : NO — no unattended Acumatica login can occur
```

```json
{"event":"acumatica.unattended.status","unattendedPermitted":false,
 "collectionsScheduled":false,"startedAt":"…","pid":…}
```

Both checks are required and answer different questions. `exec` reads the
container's current environment — what a restart would produce. The log line is
what the live process decided at its own startup. Confirm `pid`/`startedAt`
match the running worker from `$DC ps worker`; if they do not, you are reading
a previous boot.

None of these commands authenticate to Acumatica. `acumatica-breaker-cli`
reads a local state file only.

---

## Only after all of the above

Reset `agent.scoreboard`, update the credential in **every** location C2/C3
identified as stale, then run Step 1 from
[`acumatica-step1-checklist.md`](acumatica-step1-checklist.md) — one login, one
logout, nothing else.

Do not re-enable `SCOREBOARD_ACUMATICA_ENABLED` until Step 1 is clean.
