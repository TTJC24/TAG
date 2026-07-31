# Acumatica authentication: guard, and the sandbox validation that must precede production

## Why this document exists

This integration locked the production Acumatica service account out twice.

That is the whole reason for everything below. It is not defensive engineering
in the abstract — it is a specific response to a specific, repeated failure that
had a real cost: an ERP account unusable for everyone who shares it, cleared by
hand, twice.

Production work is halted by operator direction until the items below are
complete and the lifecycle has been validated in a sandbox.

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
  re-authentication on 401, no automatic session refresh.
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
| `forbidden` | 403 | no | A permissions fact for a human to fix |
| `rate_limited` | 429 | no | Back-pressure is not a security event |
| `transport` | no response | no | See the caveat below |

**Known limitation, stated plainly:** an aborted or timed-out login may still
have reached the server and counted against the threshold, yet `transport` does
not trip. Tripping on every network blip would turn a transient outage into a
manual reset. This trade is only acceptable because a real lockout also produces
a 401 or a 5xx, both of which *do* trip. If sandbox testing shows a timed-out
login increments the counter, move `transport` into the tripping set.

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

## Sandbox validation — required before any production attempt

Run against a **sandbox tenant with a throwaway account**, never production.
Set `ACUMATICA_ENVIRONMENT=sandbox` so a trip is recorded but does not block,
and the lifecycle can be exercised repeatedly.

The point is to answer the open questions above with evidence, from a place
where being wrong is free.

1. **Happy path.** Log in, read, log out. Confirm the breaker stays clear and
   `lastSuccessAt` advances.
2. **Wrong password, once.** Confirm: the client sends exactly **one** login
   request; the breaker trips as `unauthorized`; `consecutiveFailures` is `1`,
   not 2.
3. **Blocked state.** With the breaker tripped, confirm a run makes **zero**
   network calls and exits non-zero. This is the behaviour that would have
   prevented the second lockout.
4. **Operator clear.** Confirm the breaker refuses to clear without both
   `--who` and the confirmation phrase, and that clearing is durable.
5. **Concurrency.** Start two runs at once. Confirm the second refuses with
   `ConcurrentRunError` and names the first as holder.
6. **Stale lock.** Kill a run mid-flight. Confirm the next run reclaims the lock
   after the stale window rather than wedging forever.
7. **Answer the open question.** Issue a plain unauthenticated `/entity` GET
   with **no login attempt**, then read Access History and the account's failed
   attempt counter. Does it increment? Record the answer here — it determines
   whether the 401 storm could have caused the lockout at all.
8. **Deliberate lockout.** Exhaust the sandbox account's attempt threshold on
   purpose. Confirm what the server returns (status and body), and that
   `classifyAuthFailure` sees it as `locked_out` rather than something softer.
   This is the only way to know the detection string is right.
9. **Timed-out login.** Force a login to time out. Read Access History: did it
   count? If yes, `transport` must become a tripping kind.

Record the outcomes of 7, 8 and 9 in this document. They are the facts the
production decision depends on.

## The preferred structural fix

Cookie-based username/password sessions are the wrong shape for an unattended
integration: every run re-authenticates with a password against an account with
a lockout policy, so any bug in session handling turns into an account outage.

The preferred fix is to register this integration as an **OAuth Connected
Application** in Acumatica and use access and refresh tokens. A refresh token
does not consume login attempts, cannot lock a human-shared account, and can be
revoked on its own without touching anyone else's access.

Not yet started. The guard above is the interim measure, not the destination.
