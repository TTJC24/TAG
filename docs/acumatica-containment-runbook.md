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

Committed in the local scoreboard checkout and exported as a two-commit patch.
**Not pushed:** that repository's `origin` currently points at `TTJC24/TAG`,
which is not its real remote. Route it through scoreboard's actual repository.

```bash
cd /path/to/scoreboard
git am --3way < /opt/operating-layer/docs/patches/scoreboard-acumatica-containment.patch
python3 -m pytest tests/ -q          # expect 76 passed
```

Verified: the patch applies cleanly to the unmodified tree and the suite passes
afterwards.

**What it changes**

1. **On-demand authentication is prohibited.** `allow_authentication` defaults
   to `False`; only the refresh job sets it. Reads no longer authenticate
   implicitly — that implicit login is what made every data endpoint a
   credential attempt — and are never followed by automatic re-authentication.
2. **Every HTTP route holds a `CachedAcumaticaReader`**: same read interface, no
   credential, no opener, no code path to the network. `leadership_flash` and
   the financial endpoints are covered too, since they reach Acumatica only via
   `AcumaticaFinancialExtractor.fetch_ar_invoices`. Routes serve cached
   last-known state labelled with its age; a cache miss is reported as a miss,
   not as an empty result set.
3. **The auth latch is a shared file**, not an object attribute. A client per
   request and several worker processes mean an in-object or in-process latch
   dies before it can protect anything — the account's failed-attempt counter is
   global to the tenant, so the guard is too. A success does not clear it; only
   an operator does.
4. **Login is never retried**, and read retries are classified: 401/403
   terminal, 429 honouring `Retry-After` (capped at 30s), transport and 5xx
   bounded.
5. **`SCOREBOARD_ACUMATICA_ENABLED` stays disabled by default**, exact string
   `"true"` only.

**Required environment for the deploy**

```bash
# Do NOT set SCOREBOARD_ACUMATICA_ENABLED. Deploy with Acumatica disabled.

# Shared across every scoreboard process and container — see below.
SCOREBOARD_ACUMATICA_STATE_DIR=/var/lib/scoreboard/acumatica
SCOREBOARD_ACUMATICA_CACHE_DIR=/var/lib/scoreboard/acumatica/cache
```

**The state directory must be shared.** If scoreboard runs more than one
process or container, they must all mount the same path — a Docker named volume
or a host bind mount. If they do not, the latch degrades to per-process, which
is weaker than intended. The service reports which it has:

```bash
python3 -m backend.scoreboard.cli.refresh_acumatica 2>&1 | head -1
# "auth latch coordination: shared:/var/lib/scoreboard/acumatica"   <- good
# "auth latch coordination: process-local-only:..."                 <- fix the mount
```

**Behaviour change to communicate:** `platform_status()` no longer reads
branches, so `branch_mapping_state` reports `"not_verified_no_acumatica_read"`
rather than deriving `"governed_complete"` from an empty branch list. An empty
list is not evidence that branches are mapped, and a status endpoint reporting
unearned green is worse than one reporting unknown. Anything consuming that
field needs to handle the new value. Financial and dashboard endpoints will
serve cache misses until the refresh job has run, which cannot happen until the
account is reset — so expect explicit "no cached data" responses in the interim
rather than silently empty ones.

**Verify on the running production service**

```bash
# 1. The flag is off.
<exec into the scoreboard service> printenv SCOREBOARD_ACUMATICA_ENABLED
# expect: empty / unset

# 2. Routes hold a cache-backed reader with no credential.
<exec> python3 -c "
from backend.scoreboard.api import routes
from backend.scoreboard.connectors.acumatica_cache import CachedAcumaticaReader
_,_,acu,_,_ = routes._build_dependencies()
assert isinstance(acu, CachedAcumaticaReader), type(acu)
assert not hasattr(acu, 'password') and not hasattr(acu, '_opener')
print('OK: routes cannot authenticate')"

# 3. A status endpoint returns without contacting Acumatica.
curl -s localhost:<port>/connector-status | head -c 400
```

None of these authenticate to Acumatica.

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
