# Collections MVP — activation runbook

How to turn the daily collections loop on, in order, with a verification step
after each stage. Every stage is reversible by removing the env var and
restarting the service.

**What "on" means:** each morning the system reads AR from Acumatica, raises a
governed chase per past-due customer, and presents the AR person with a
prioritized queue where each chase already has the email written. They review,
edit if needed, and approve. **Nothing sends without two human actions.**

---

## 0. Prerequisites

- The stack is deployed and healthy at `ops.blcsops.com` (see `deploy-runbook.md`).
- Acumatica read-only credentials are in `.env.production` (see `APPROVALS.md`).
- You are on the droplet at `/opt/operating-layer`.

Shorthand used below:

```
DC="docker compose -f compose.production.yaml --env-file .env.production"
```

## 1. Apply the new migration

Migration `0012` adds the chase-proposal table. Init scripts only run on an
empty volume, so an existing deployment applies it by hand:

```
$DC exec -T postgres psql -U operating_layer -d operating_layer \
  < infrastructure/migrations/0012_collections_chase_proposals.sql
```

Verify:

```
$DC exec -T postgres psql -U operating_layer -d operating_layer \
  -c "SELECT count(*) FROM operating_layer.collections_chase_proposals;"
```

A `0` is success — the table exists and is empty.

## 2. Confirm the Acumatica Customer read works on the live instance

The chase needs a customer **name** and **email**, which live on the `Customer`
entity — not on `Invoice`. Field names vary by build, so probe before trusting:

```
$DC exec api node apps/api/dist/acumatica-probe-cli.js Customer
```

Expect `OK` for `CustomerID`, `CustomerName`, `Status`, `MainContact`, and
`MainContact/Email`. If `MainContact/Email` is **MISSING**, the loop still works
— chases are raised and drafted — but every one needs a recipient typed in by
hand. Fix that in Acumatica (populate AR contact emails) rather than in code.

## 3. Add the collections settings

Append to `.env.production` (keep it `chmod 600`):

```
COLLECTIONS_ENABLED=true
COLLECTIONS_USER_EMAIL=<the AR person's operating-layer login>
COLLECTIONS_MIN_PAST_DUE=250          # ignore trivial balances; tune to taste
COLLECTIONS_SENDER_NAME=<the AR person's real name>
COLLECTIONS_SENDER_CONTACT=<reply-to email / phone shown in the signature>
```

`COLLECTIONS_SENDER_NAME` appears in the email a customer reads. Leave it unset
and chases sign off as "Accounts Receivable" — never a placeholder name.

## 4. Dry-run the pull by hand

Before scheduling anything, run it once and read the output:

```
$DC up -d --build api worker
$DC exec api node apps/api/dist/acumatica-collections-fetch-cli.js
```

You get one JSON block per company. Read these fields:

| Field | Meaning |
|---|---|
| `scanned` | customers in the aging |
| `created` | chases raised this run |
| `replayed` | already raised (re-running is safe) |
| `proposed` | chases that have draft text recorded |
| `unaddressable` | chases with **no** AR email on file — a human must address these |
| `skipped` | anything that did not make it, with a reason |

**Sanity checks before going further:** `created + replayed` should roughly match
the number of past-due customers you expect; `skipped` should be empty; and
`proposed` should equal `created + replayed`.

## 5. Verify a chase in the tower

Open `ops.blcsops.com`, find a `Collections:` task, and confirm:

- The title names a **real customer**, not a raw code like `ACME01`.
- Once approved, the Gmail draft form is **prefilled** — recipient, subject, and
  a body itemizing the actual overdue invoices.
- A customer with no email shows an explicit warning, with the body still
  drafted and the recipient blank.

If names show as codes, step 2's `CustomerName` probe is the thing to fix.

## 6. Turn on the daily schedule

Add to `.env.production` and restart the worker:

```
COLLECTIONS_SCHEDULE_UTC=11:00        # 07:00 ET — before the AR person starts
SALES_SCHEDULE_UTC=11:30
```

```
$DC up -d worker
$DC logs worker | grep feed.schedule.configured
```

Times are **UTC**. Pick the hour so the queue is ready before the workday, and
remember the offset shifts by an hour across daylight-saving changes — the
schedule is fixed in UTC and does not follow local time.

Confirm the next morning:

```
$DC logs worker | grep feed.refresh
```

`feed.refresh.completed` with a `created` count is a healthy run.
`feed.refresh.failed` carries the reason; the worker keeps processing approvals
either way and retries the next day.

## 7. (Separate decision) Gmail drafting

Everything above stops at "the email is written and waiting." Turning an
approved chase into an actual Gmail draft is a **separate, deliberate
activation** with its own prerequisites — one-org pilot claim, a credential
scoped to `gmail.compose` only, a recipient allowlist, and
`GMAIL_DRAFT_NETWORK_ENABLED=true`. It is a stop-and-ask item under the WorkOS
contract: log it in `APPROVALS.md` before enabling.

Until then the loop is complete and useful without it — the AR person copies
the drafted text, which is still the whole labor saving minus one paste.

---

## Rolling back

| To undo | Do this |
|---|---|
| Stop the daily pulls | remove `*_SCHEDULE_UTC`, `$DC up -d worker` |
| Stop raising chases entirely | set `COLLECTIONS_ENABLED=false`, restart api+worker |
| Leave existing chases alone | they stay; they are governed tasks like any other |

The migration is additive and safe to leave in place — an unused table.

## What this does not do

- It does not send anything. Ever, at any stage above.
- It does not write to Acumatica or Pipedrive. Both wires are read-only.
- It does not decide *whether* to chase — the ladder is policy data
  (`DEFAULT_LADDER`), tuned by what the AR person approves and edits.
- It does not resolve disputes, apply credits, or change terms. Those stay human.
