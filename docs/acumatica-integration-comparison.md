# Acumatica authentication: how ours differs from the integrations that work

Required reading before the controlled production validation. The instruction
was: *locate and compare against the authentication pattern used by an existing
working connection, and identify every difference before sending a request.*

## The known-good integrations

Two other codebases on this machine read the same Acumatica instance.

| | **company-brain** | **scoreboard** | **TAG (this repo)** |
|---|---|---|---|
| Path | `/home/user/company-brain/src/sources/acumatica/client.ts` | `/home/user/scoreboard/backend/scoreboard/connectors/acumatica.py` | `packages/connectors/src/acumatica.ts` |
| Language | TypeScript (`fetch`) | Python (`urllib` + `HTTPCookieProcessor`) | TypeScript (`fetch`) |
| Status | Runs in production on the droplet, alongside this stack | Present; deployment not confirmed from here | Locked the account out twice |

**company-brain is the reference.** It is deployed, it reads this tenant, and
its README documents an operational encounter with the exact failure class we
are investigating. scoreboard is included because it is a second independent
implementation, but two of its choices are ones we must *not* copy (below).

## The single most important finding

company-brain's client carries this comment, at the top of the file:

> *Acumatica enforces a **per-user seat limit** on the Contract API.*

and its README says:

> *`API Login Limit` means the integration user has exhausted Acumatica API
> sessions/seats. **Do not retry-loop.** Ask the Acumatica admin/support to
> clear stale API sessions, confirm the integration user has Contract API
> access, and provision a dedicated read-only API user/session capacity.*

Its 401 handler says the quiet part explicitly:

> *This avoids retry loops that could contribute to API login-limit issues.*

So the constraint that governs this instance is **concurrent API sessions per
user**, and another team already hit it and wrote down the remedy.

This reframes our incident. The working integration's defence is not that it
authenticates carefully — it is that it **almost never authenticates at all**.
It caches the session cookie to disk (`state/.acumatica-session`) and reuses it
across processes and runs. Our client logs in fresh on every single command.

**This is a hypothesis, not a proven cause.** It is consistent with everything
observed, and it predicts something testable: if the two integrations share one
API user, they compete for the same seats. Step 1 of the validation is designed
to test the login in isolation, before any read, for exactly this reason.

**Open question only you can answer:** does company-brain use the same
Acumatica user as TAG's `agent.scoreboard`? Both real `.env` files live on the
droplet and neither is on this machine, so I cannot check. The username itself
(`agent.scoreboard`) suggests it was created for the *scoreboard* project and
then reused. If all three share one account, seat contention is very likely the
mechanism, and the fix is a dedicated API user per integration — which is what
company-brain's README already recommends.

## Every difference, field by field

### Identical — no change needed

| Item | Value |
|---|---|
| Base URL | `https://bigleaguecs.acumatica.com` |
| Tenant / company | `Production` |
| Endpoint version | `24.200.001`, Default endpoint |
| Login path | `POST /entity/auth/login` |
| Login payload | `{name, password, company}` |
| Login content-type | `application/json` |
| Read path shape | `/entity/Default/{version}/{Entity}` |
| Read method | `GET`, `Accept: application/json` |
| Field access | contract-API `{"Field":{"value":…}}` wrappers |

scoreboard defaults to endpoint version **`22.200.001`**, not `24.200.001`.
That is a difference between the two references, not between us and the working
one — we match company-brain, which is the deployed one.

### Different — and each one matters

**1. Session lifetime — the big one.**

| | company-brain | scoreboard | TAG |
|---|---|---|---|
| Session reuse | Cached to disk, reused across processes and runs | In-memory, per process | **None — fresh login every command** |
| Logins per day | Roughly one, until the session expires | One per process | **One per command, several per day** |

Every command we have — preflight, probe, customer export, the feed — opens its
own session. Against a per-user seat limit, we are the noisiest client on the
instance by a wide margin.

**2. Logout.**

| | company-brain | scoreboard | TAG |
|---|---|---|---|
| Calls `/entity/auth/logout` | **Never** | **Never** | **Always, after every run** |

We are the only one that logs out. Two readings, opposite conclusions:

- *In our favour:* logging out frees the seat, so we are the best-behaved
  client — abandoned sessions are what exhaust the pool.
- *Against us:* if the same user's session is shared, our logout may invalidate
  a session another integration is still holding, and its next read 401s.

Which is right depends on whether the account is shared. **Keep logout** for
now: freeing a seat we opened is correct behaviour on its own terms, and the
alternative — abandoning sessions — is what the working integration's own
README blames for the limit being hit.

**3. Branch selection — a real defect on our side.**

| | company-brain | scoreboard | TAG |
|---|---|---|---|
| Branch | `PX-CbApiBranch` header, per request | Not used | `branch` field in the **login payload** |

company-brain sets branch **per read request** via `PX-CbApiBranch`, with FS,
BLC and USA mapped from env. Our client accepts an optional `branch` in the
login body instead. That is a different mechanism, and it is not the one this
instance is known to accept.

In practice the option is unset in production, so we send no branch at all and
rely on `LinkBranch` in the returned rows. That works for AR. **But `branch` in
the login payload is untested against this instance and should be removed**
rather than left as a trap for whoever sets it next. If we ever need
branch-scoped reads, use the header.

**4. Cookie handling.**

| | company-brain | scoreboard | TAG |
|---|---|---|---|
| Mechanism | Parses `set-cookie` from the **login response only** | `http.cookiejar.CookieJar` | Name-keyed `Map`, merged from **every** response |
| Read responses may alter the session cookie | No — ignored entirely | Yes (standard jar semantics) | Yes |

This is where our original bug lived: the jar was *replaced* wholesale on any
`Set-Cookie`, so the first read that set any cookie evicted the auth cookie.
Signature: login OK, read #1 OK, reads #2..n all 401. Fixed — the jar now
merges by name.

Worth noting what company-brain does instead: it never lets a read response
touch the session cookie at all. That is strictly more robust than merging, and
it is the choice a client makes after being bitten. Our merge is correct, but
its correctness depends on the server never re-setting the auth cookie with a
different value mid-run. **Consider adopting the login-only rule** after
validation; changing it now would alter behaviour mid-experiment.

**5. Retry and re-authentication.**

| | company-brain | scoreboard | TAG |
|---|---|---|---|
| Login retried on failure | No | **Yes — up to 3 attempts, exponential backoff** | **No, and now structurally impossible** |
| Re-login on a 401 read | One re-login + one retry, then fail | No | **No** |

scoreboard retries the login itself, because `authenticate()` goes through the
same `_request_json` retry wrapper as every read. Against an account with a
lockout policy that is a genuine hazard, and it is the one pattern here we must
**not** copy.

We are now stricter than both: one login per client instance, enforced by a
latch set before the network call, so even a *failed* login cannot be retried.
Recovery requires constructing a new client, which re-checks the breaker. This
is deliberately stricter than company-brain's single re-login, and should stay
that way until the mechanism is understood.

**6. Page size.**

| | company-brain | scoreboard | TAG |
|---|---|---|---|
| `$top` | 100, hard cap | 200 | **500**, up to 40 pages |

Not an auth issue, but our AR read of 1,303 documents is 3 pages at 500 versus
14 at 100. Larger pages mean fewer requests, which is good; they also mean a
slower response per request and more time holding a seat.

**7. Query complexity on first contact.**

| | company-brain | TAG |
|---|---|---|
| First read | `Customer?$top=1` | `Invoice?$filter=Status eq 'Open'&$select=…` across all pages |

company-brain's readiness check does one login and one `Customer?$top=1` per
branch. Ours goes straight to a filtered, projected, paginated read of the
entire open AR ledger. The validation CLI now starts where company-brain
starts.

## What the comparison changes in our code

Already done in this branch:

- One login per client instance, enforced (was: true by inspection only).
- Login transport failures trip the breaker — an unanswered login may still
  have reached the server.
- Unattended feed gated behind a second interlock, default off.
- `acumatica-validate-cli` mirrors company-brain's readiness shape: one login,
  one `$top=1` read, stop on first non-success.

Recommended, **not** done, because changing behaviour mid-experiment would
confound the result:

- Remove `branch` from the login payload; use `PX-CbApiBranch` per request if
  branch scoping is ever needed.
- Adopt company-brain's login-only cookie rule.
- Cache and reuse the session across commands, the way company-brain does. This
  is the largest single reduction in login volume available to us, and if seat
  contention is the mechanism, it is the actual fix.
- Reduce `$top` from 500 to 100 to match.

## What to ask the Acumatica admin

Independent of anything in this repo, and it directly answers what the code
cannot:

1. Does `agent.scoreboard` serve more than one integration? Which?
2. What is the concurrent Contract API session limit for this user, and how
   many sessions are currently open?
3. In Access History for the lockout window, how many entries are recorded as
   *failed logins* versus unauthenticated requests?
4. Does an unauthenticated `/entity` GET — no login attempt — increment the
   failed-attempt counter?

Question 4 remains the crux. If the answer is no, the 401 storm did not cause
the lockout, and seat contention becomes the leading explanation rather than a
secondary one.

## The permanent direction

Unchanged: register this integration as an **OAuth Connected Application** and
use access and refresh tokens. A refresh token does not consume login attempts
and cannot lock a shared human account. company-brain's README arrives at the
adjacent conclusion from operational experience — *provision a dedicated
read-only API user/session capacity* — which is the same problem answered with
the tools available at the time.
