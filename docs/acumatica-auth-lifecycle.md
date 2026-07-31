# Acumatica authentication: the guard, and the controlled production validation

## Why this document exists

This integration locked the production Acumatica service account out twice.

That is the whole reason for everything below. It is not defensive engineering
in the abstract — it is a specific response to a specific, repeated failure that
had a real cost: an ERP account unusable for everyone who shares it, cleared by
hand, twice.

Unattended production work stays halted. Validation now proceeds against
production directly — controlled, incremental, one operator-initiated request at
a time — because other integrations already read this instance successfully and
no sandbox is being provisioned. See the comparison against those integrations
in [`acumatica-integration-comparison.md`](acumatica-integration-comparison.md).

## What is established as fact, and what is not

Distinguishing these matters, because an earlier explanation of the lockout was
asserted with more confidence than the evidence supported.

**Established by reading the code:**

- There are exactly four places that can call `/entity/auth/login`:
  `apps/api/src/acumatica-probe-cli.ts`,
  `apps/api/src/acumatica-customer-export-cli.ts`,
  `workflows/issue-intake/src/feed-runner.ts`,
  `workflows/issue-intake/src/preflight.ts`.
- **No retry logic exists anywhere in the client.** No backoff loop, no
  re-authentication on 401, no automatic session refresh. This was true by
  inspection and is now true by construction: one login per client instance,
  latched before the network call.
- In the run that preceded a lockout, exactly one `/auth/login` was issued, and
  it **succeeded**. The failures that followed were `401`s on `/entity` reads.
- The root cause of those 401s is known and fixed: the cookie jar was being
  *replaced* on every `Set-Cookie` rather than merged by name, so the first
  response carrying any cookie evicted the session cookie. Signature: login OK,
  read #1 OK, reads #2..n all 401.

**NOT established — still open, and needing evidence from the ERP side:**

1. Correlating the run timestamps against Acumatica **Access History**.
2. Which requests Acumatica actually recorded as *failed logins*.
3. Whether a plain unauthenticated `/entity` request, with **no login attempt**,
   increments the lockout counter.

Item 3 is the crux. If an unauthenticated `/entity` read does not increment the
counter, then the 401 storm did not cause the lockout and something else did —
and we do not yet know what. Nothing here should be read as claiming the
mechanism is understood. The guard is built to be correct either way.

`SM201060` is system-wide and is **not** being changed. Weakening the lockout
policy for every user to accommodate an integration defect is not on the table.

## The guard

### Circuit breaker — `packages/connectors/src/auth-guard.ts`

Persistent, file-backed, and deliberately hard to clear.

- **Survives restarts.** The earlier in-memory latch died with the process, so a
  restarted container would authenticate straight back into the same failure.
  The account lockout it protects against survives a restart; so must the
  breaker.
- **Trips on the first tripping failure**, not after a threshold. The cost of a
  false stop is one operator command. The cost of a false continue is a locked
  production account.
- **Nothing in the runtime clears it.** Not a restart, not a redeploy, not a
  later success, not a scheduled retry. Only `clearByOperator`, reachable only
  from the operator CLI.

Failure kinds are **not** equivalent:

| Kind | Source | Trips? | Why |
|---|---|---|---|
| `unauthorized` | 401 | **yes** | The shape that preceded the lockout |
| `locked_out` | body says so | **yes** | Explicit; no ambiguity |
| `server_error` | 5xx | **yes** | May be a lockout wearing a 500 |
| `login_transport` | login got no answer | **yes** | May have reached the server anyway |
| `forbidden` | 403 | no | A permissions fact for a human to fix |
| `rate_limited` | 429 | no | Back-pressure is not a security event |
| `transport` | a *read* got no answer | no | Carries a session, not a credential |

An unanswered **login** trips. We cannot tell from this side whether it reached
the server and counted, so the assumption is not made. An unanswered **read**
does not trip: it presents a session rather than a credential, so it cannot
count against an authentication threshold.

**One login per client instance, enforced.** The latch is set before the network
call, so even a failed login cannot be retried. Recovery requires constructing a
new client, which re-checks the breaker. "There is no retry logic" was true by
inspection; this makes it true by construction.

One request records **one** failure. The classification from the status code
wins; the catch block only records when no response arrived at all.

### Run lock

`O_EXCL` acquisition, so it is atomic. A lock left by a killed process is
reclaimed by **age**, not by trusting a pid — pids get reused. Every entry point
that can log in runs inside it, so a scheduled feed and a hand-run command can
never authenticate at once.

### Environment separation

`ACUMATICA_ENVIRONMENT=sandbox` is the **only** value that disables enforcement.
Anything else — unset, misspelled, `staging`, `test` — is treated as production.
This fails safe: a host that forgot the variable is the production host.

Sandbox and production keep entirely separate state and lock files, so a sandbox
trip cannot block production and, more importantly, **clearing a sandbox breaker
cannot be mistaken for clearing the production one.**

No sandbox tenant exists today, so in practice this always resolves to
production and enforcement is always on. The mechanism stays because the cost of
keeping it is nil and the cost of a future host quietly defaulting to
unenforced is an account.

## Operator commands

```bash
# Inspect. Read-only, never authenticates. Exit 1 while blocked.
pnpm --filter @operating-layer/api acumatica-breaker

# Clear. The ONLY way a blocked production login is re-enabled.
pnpm --filter @operating-layer/api acumatica-breaker clear \
  --who "Your Name" --confirm I-CHECKED-THE-ERP-ACCOUNT
```

The confirmation phrase is not ceremony. Clearing without first checking the
ERP account's own lockout state (Acumatica → Users) just spends the next login
on an account that is still locked — the exact failure this prevents.

Environment:

| Variable | Default | Meaning |
|---|---|---|
| `ACUMATICA_ENVIRONMENT` | `production` | `sandbox` disables enforcement |
| `ACUMATICA_GUARD_DIR` | `/var/lib/operating-layer/acumatica` | Breaker + lock state |

## Controlled production validation

**Superseded:** an earlier version of this document required a sandbox tenant.
No sandbox is being provisioned. Other Acumatica integrations already operate
successfully against this production instance, so validation proceeds against
production — controlled, incremental, and operator-initiated.

**Read [`acumatica-integration-comparison.md`](acumatica-integration-comparison.md)
first.** It compares our client against the two working integrations field by
field and identifies every difference. The headline: the deployed integration
defends itself not by authenticating carefully but by **almost never
authenticating** — it caches its session cookie to disk and reuses it. We log in
fresh on every command, against an instance that enforces a per-user Contract
API seat limit.

### Preconditions

- All scheduled and background Acumatica jobs are off.
  `ACUMATICA_UNATTENDED_ENABLED` is unset, which leaves the collections feed
  unscheduled no matter what `COLLECTIONS_SCHEDULE_UTC` says.
- The breaker reports clear: `acumatica-breaker status`.
- The dedicated read-only account has been unlocked by the operator.

### The steps

Each step is **one login and at most one read**, then stop. Run them in order.

```bash
pnpm --filter @operating-layer/api acumatica-validate --step 1 --operator "Tim Clark"
```

| Step | What it sends | What it isolates |
|---|---|---|
| 1 | Login, logout. No read. | The login alone. If the counter moves here, no read is implicated. |
| 2 | Login + `Customer?$top=1` | The smallest read — the exact shape company-brain runs against this tenant without incident. |
| 3 | Login + `Invoice?$top=1` | First contact with the AR entity Collections needs, still one record, no filter or projection. |

The command refuses to run without `--operator`, refuses to run while the
breaker is tripped, sends exactly one login, and **stops on the first
non-success response**, reporting it verbatim with no retry and no further
request.

### After every single step, before the next one

1. **Acumatica → Access History** for this user: confirm exactly one login,
   and note how each request was recorded.
2. **Acumatica → Users**: confirm the failed-attempt counter did **not** move.
3. Only if both are clean, run the next step.

Record the outcome of each step below as it happens. These are the facts the
next decision depends on — not inference from our own logs, which is what went
wrong the first time.

| Step | Date | Access History | Failed-attempt counter | Verdict |
|---|---|---|---|---|
| 1 | | | | not yet run |
| 2 | | | | not yet run |
| 3 | | | | not yet run |

### The questions these steps answer

- Does a plain unauthenticated `/entity` GET, with no login attempt, increment
  the counter? **Still the crux.** If it does not, the 401 storm did not cause
  the lockout and seat contention becomes the leading explanation.
- Is `agent.scoreboard` shared with company-brain or scoreboard? If so, the
  integrations compete for the same seats, and a dedicated API user per
  integration is the fix — which is what company-brain's own README recommends.

### Only then, the unattended feed

Do **not** set `ACUMATICA_UNATTENDED_ENABLED=true` until multiple manual runs
across several days show no increase in failed-login activity. The interlock is
separate from the schedule precisely so that restoring a schedule time from an
old `.env` cannot switch unattended authentication back on by accident.

## The preferred structural fix

Cookie-based username/password sessions are the wrong shape for an unattended
integration: every run re-authenticates with a password against an account with
a lockout policy, so any bug in session handling turns into an account outage.

The preferred fix is to register this integration as an **OAuth Connected
Application** in Acumatica and use access and refresh tokens. A refresh token
does not consume login attempts, cannot lock a human-shared account, and can be
revoked on its own without touching anyone else's access.

Not yet started. The guard above is the interim measure, not the destination.
