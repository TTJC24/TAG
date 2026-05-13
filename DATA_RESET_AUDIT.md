# Data Reset Audit

Read-only audit of the Postgres state immediately after the canonical
seed run. Source: `pnpm tsx --env-file=.env.local scripts/audit-data.ts`
against the production Neon database.

---

## 1. Canonical people per org

### Big League Construction Supply  (code=BL, 7 members)

| Name | Email | Role | person.id (short) |
|---|---|---|---|
| Tim Clark | `Tclark@bigleaguecs.com` | **admin** | `8f3dd749…` |
| Chip Bridges | `c.bridges@fasteningspecialists.com` | member | `0acc3dcd…` |
| Chris Booth | `chris.booth@bigleaguecs.com` | member | `79641cac…` |
| Cody Braden | `Cody.braden@bigleaguecs.com` | member | `12b99e41…` |
| Craig Zahner | `Craig.Zahner@bigleaguecs.com` | member | `826f6b98…` |
| Nick Dorfmueller | `Nicholas.Dorfmueller@bigleaguecs.com` | member | `fcfaf45a…` |
| Tyler Shinn | `tyler.shinn@bigleaguecs.com` | member | `ee721e98…` |

### Fastening Specialists  (code=FS, 6 members)

| Name | Email | Role | person.id (short) |
|---|---|---|---|
| Tim Clark | `Tclark@bigleaguecs.com` | **admin** | `8f3dd749…` |
| Chip Bridges | `c.bridges@fasteningspecialists.com` | member | `0acc3dcd…` |
| Chris Coghlan | `chris.coghlan@bigleaguecs.com` | member | `498d1830…` |
| Craig Zahner | `Craig.Zahner@bigleaguecs.com` | member | `826f6b98…` |
| Daniel Milavickas | `d.milavickas@fasteningspecialists.com` | member | `f0e2a011…` |
| Tom Fowler | `t.fowler@fasteningspecialists.com` | member | `a4166a7b…` |

### Utility Supply Associates  (code=USA, 5 members)

| Name | Email | Role | person.id (short) |
|---|---|---|---|
| Tim Clark | `Tclark@bigleaguecs.com` | **admin** | `8f3dd749…` |
| Andrew Sutt | `andrew@utilitysupplyassociates.com` | member | `3c2794fb…` |
| Bill Potts | `bill@utilitysupplyassociates.com` | member | `4a5cab62…` |
| Chris Coghlan | `chris.coghlan@bigleaguecs.com` | member | `498d1830…` |
| Mike Grant | `m.grant@fasteningspecialists.com` | member | `a6b3b079…` |

Total **13 unique people**, **18 org_memberships**.

---

## 2. org_memberships rows (canonical roster)

18 rows total. One per (org × person × role).

| Org | Role | Person |
|---|---|---|
| BL | admin | Tim Clark |
| BL | member | Chip Bridges |
| BL | member | Chris Booth |
| BL | member | Cody Braden |
| BL | member | Craig Zahner |
| BL | member | Nick Dorfmueller |
| BL | member | Tyler Shinn |
| FS | admin | Tim Clark |
| FS | member | Chip Bridges |
| FS | member | Chris Coghlan |
| FS | member | Craig Zahner |
| FS | member | Daniel Milavickas |
| FS | member | Tom Fowler |
| USA | admin | Tim Clark |
| USA | member | Andrew Sutt |
| USA | member | Bill Potts |
| USA | member | Chris Coghlan |
| USA | member | Mike Grant |

Note: cross-org members (Chip, Craig, Chris Coghlan, Tim) appear once
per org they belong to. Tim is admin in all three; everyone else is
member.

---

## 3. Email → person mapping

13 people rows, all with unique emails. Sorted alphabetically by email.

| Email | Person | clerk_user_id (short) |
|---|---|---|
| `andrew@utilitysupplyassociates.com` | Andrew Sutt | `user_3DgI3Kk…` |
| `bill@utilitysupplyassociates.com` | Bill Potts | `user_3DgI3Qw…` |
| `c.bridges@fasteningspecialists.com` | Chip Bridges | `user_3DgI304…` |
| `chris.booth@bigleaguecs.com` | Chris Booth | `user_3DgI2gU…` |
| `chris.coghlan@bigleaguecs.com` | Chris Coghlan | `user_3DgI3EM…` |
| `Cody.braden@bigleaguecs.com` | Cody Braden | `user_3DgI2aS…` |
| `Craig.Zahner@bigleaguecs.com` | Craig Zahner | `user_3DgI34j…` |
| `d.milavickas@fasteningspecialists.com` | Daniel Milavickas | `user_3DgI2rn…` |
| `m.grant@fasteningspecialists.com` | Mike Grant | `user_3DgI3M8…` |
| `Nicholas.Dorfmueller@bigleaguecs.com` | Nick Dorfmueller | `user_3DgI2U8…` |
| `t.fowler@fasteningspecialists.com` | Tom Fowler | `user_3DgI2nJ…` |
| `Tclark@bigleaguecs.com` | Tim Clark | `user_3DdiTn3…` |
| `tyler.shinn@bigleaguecs.com` | Tyler Shinn | `user_3DgI2ZG…` |

Tim's local `people.email` is the BL email — `Tclark@bigleaguecs.com`.
The roster also lists `Tclark@fasteningspecialists.com` for FS, but
Clerk holds one primary email per user; the FS variant is treated as
a roster alias and is not a separate identity.

---

## 4. Scoreboard-obligated people per org

Definition: a member is obligated for `/admin/readiness` if they own at
least one **measurable**, **rock**, or **open todo** in that org. Issue
ownership is shown in parentheses for context but does not gate
obligation.

### Big League

| Member | Obligated? | Why |
|---|---|---|
| Chip Bridges | ✅ | 2 metrics (+1 issue) |
| Chris Booth | ✅ | 1 metric |
| Cody Braden | ❌ | no obligations |
| Craig Zahner | ✅ | 2 metrics |
| Nick Dorfmueller | ✅ | 3 metrics, 1 rock |
| Tim Clark | ✅ | 3 metrics, 1 rock (+1 issue) |
| Tyler Shinn | ❌ | no obligations |

5 of 7 members are obligated. **Cody Braden** and **Tyler Shinn** are
in the roster but currently own nothing — they will not surface on
`/admin/readiness` for BL until they're assigned a metric, rock, or
todo.

### Fastening Specialists

| Member | Obligated? | Why |
|---|---|---|
| Chip Bridges | ✅ | 2 metrics (+1 issue) |
| Chris Coghlan | ❌ | no obligations |
| Craig Zahner | ✅ | 2 metrics, 1 rock (+1 issue) |
| Daniel Milavickas | ✅ | 3 metrics, 2 rocks |
| Tim Clark | ✅ | 3 metrics, 2 rocks |
| Tom Fowler | ✅ | 1 metric (+1 issue) |

5 of 6 obligated. **Chris Coghlan** is roster-only in FS.

### USA

| Member | Obligated? | Why |
|---|---|---|
| Andrew Sutt | ✅ | 2 metrics (+1 issue) |
| Bill Potts | ❌ | no obligations |
| Chris Coghlan | ❌ | no obligations |
| Mike Grant | ✅ | 1 rock |
| Tim Clark | ✅ | 3 metrics, 1 rock |

3 of 5 obligated. **Bill Potts** and **Chris Coghlan** are roster-only
in USA.

---

## 5. What was actually imported

**No spreadsheet was provided to this agent in this conversation.**
The repo contains exactly one reference workbook —
`reference/TRACTION_MEETING_TEMPLATE.xlsx` (39 KB, last modified
2026-05-12) — but it was **not parsed and its rows were not imported
into Postgres**. Every row currently in the database came from the
specs in `scripts/seed.ts` (the canonical seed). Treat this as
placeholder structure until a real spreadsheet bootstrap lands.

### 5a. Metrics (measurables) — 30 total, all from `MEASURABLES_SPEC`

| Org | Count | Names |
|---|---|---|
| BL | 11 | Revenue (Weekly), Gross Profit %, DSO, DPO, DIO, Inventory Turns, Fill Rate %, AR Collections ($), Open Orders (Backlog), New Accounts Opened, On-Time Deliveries |
| FS | 11 | Revenue (Weekly), Gross Profit %, DSO, DPO, DIO, Inventory Turns, Fill Rate %, AR Collections ($), Open Orders (Backlog), New Accounts Opened, On-Time Deliveries |
| USA | 8 | Revenue (Weekly), Gross Profit %, DSO, DPO, DIO, Inventory Turns, AR Collections ($), Open Orders (Backlog) |

Source: `scripts/seed.ts` `MEASURABLES_SPEC`. **Not from a spreadsheet.**

### 5b. Rocks — 9 total, all from `ROCKS_SPEC`

| Org | Description | Owner | Status |
|---|---|---|---|
| FS | Implement Acumatica inventory module | Craig Zahner | off_track |
| FS | Fix labeling process and train team | Daniel Milavickas | on_track |
| FS | Reduce DSO to ≤35 days | Tim Clark | on_track |
| FS | CRM build-out completion for FS | Daniel Milavickas | on_track |
| FS | Company AI Module v1.0 | Tim Clark | on_track |
| BL | Update company SOPs | Nick Dorfmueller | on_track |
| BL | Complete COA migration to new structure | Tim Clark | on_track |
| USA | Onboard logistics partner(s) | Mike Grant | on_track |
| USA | Move USA to Acumatica | Tim Clark | on_track |

Source: `scripts/seed.ts` `ROCKS_SPEC`. **Not from a spreadsheet.**

### 5c. To-dos — **0 rows total across all orgs**

The `todos` table is empty. The seed never seeded any. No spreadsheet
import has populated them either.

### 5d. Issues — 6 total, all from `ISSUES_SPEC`

| Org | Title | Owner | Priority |
|---|---|---|---|
| FS | Fill rate at 95% is unachievable with current safety stock min/max | Tom Fowler | high |
| FS | Need to know when special orders are received | Chip Bridges | high |
| FS | Dead stock report parameters and cadence | Craig Zahner | medium |
| BL | Premature invoices | Tim Clark | critical |
| BL | How do we reduce cycle time on receiving? | Chip Bridges | medium |
| USA | Quote → product-on-ground (POD) scoreboard | Andrew Sutt | medium |

Source: `scripts/seed.ts` `ISSUES_SPEC`. **Not from a spreadsheet.**

### 5e. Weekly meeting history

`weeks` table: 3 rows.

| Week ending | Quarter | ISO week | Entries |
|---|---|---|---|
| 2026-04-24 | Q2 2026 | 17 | 30 |
| 2026-05-01 | Q2 2026 | 18 | 30 |
| 2026-05-08 | Q2 2026 | 19 | 30 |

90 entries total — all synthetic values from `plausibleActual()` in
`scripts/seed.ts`. **No real weekly history was imported.**

`meetings` table: **0 rows.** No L10 has been scheduled or recorded.
`/me`'s "Next L10" displays "not scheduled" until this is populated.

---

## 6. Mismatches and duplicates

| Check | Result |
|---|---|
| Duplicate emails (case-insensitive) | **0** |
| Duplicate names | **0** |
| Duplicate `clerk_user_id` (uniqueness invariant) | **0** |
| People with no `org_membership` | **0** |
| Rocks owned by non-members of their org | **0** |
| Issues owned by non-members of their org | **0** |
| **Measurables owned by non-members of their org** | **3 — see below** |

### 6a. Measurables owned by non-members of their org (3 rows)

| Org | Measurable | Owner | Owner is member of |
|---|---|---|---|
| USA | DIO | Craig Zahner | BL, FS — **not USA** |
| USA | Inventory Turns | Craig Zahner | BL, FS — **not USA** |
| USA | Open Orders (Backlog) | Chip Bridges | BL, FS — **not USA** |

Three USA measurables are owned by people who are not in the USA
org_membership roster. This was inherited from the original seed (Craig
and Chip own these KPIs cross-entity by convention) but it was not
reconciled when the canonical USA roster (Andrew, Bill, Chris Coghlan,
Mike, Tim) landed.

Consequences in the current UI:
- These three measurables **do not appear in /admin/readiness for USA**,
  because the readiness query treats only org members as the eligible
  set. The metrics belong to USA but no USA member is responsible
  for them.
- Craig Zahner and Chip Bridges, when they sign in to BL or FS, do
  **not** see these USA metrics on their /me view (they're scoped to
  the active org).
- Net effect: these three USA metrics are **owned by nobody for
  readiness purposes**.

Resolution options (decision required, not auto-fixed here):
1. **Add Craig and Chip to USA org_memberships** (matches original
   "cross-org accounting/inventory ownership" intent; uses 2 of USA's
   remaining Clerk seats — USA is currently at 5/5).
2. **Reassign these USA metrics to a USA member** (Tim is already
   USA admin and owns DSO/DPO/AR Collections; could absorb DIO and
   Inventory Turns. Open Orders could go to Andrew Sutt as the USA
   commercial lead, or stay with Chip if he's added to USA).
3. **Drop the three measurables from USA** if they aren't actually
   reviewed in USA's L10.

### 6b. Other observations (informational, not mismatches)

- 3 members are roster-only with no obligations: **Cody Braden** (BL),
  **Tyler Shinn** (BL), **Bill Potts** (USA). They will not appear on
  `/admin/readiness` until assigned a metric/rock/todo. Confirm whether
  this is intentional or whether they need scorecard ownership.
- **Chris Coghlan** is roster-only in both FS and USA — appears in
  neither readiness view.
- **`todos` table is empty** for every org. No to-do data exists.
- **`meetings` table is empty.** "Next L10" cannot be computed from
  data; the UI shows "not scheduled" everywhere.
- Three Clerk per-org memberships were rejected by the free-tier cap
  during the seed (logged inline at seed time, recorded in HANDOFF.md):
  Chip Bridges → BL, Craig Zahner → BL, Chris Coghlan → FS. **The
  Postgres canonical roster (above) is unaffected and correct.** These
  three people simply cannot Clerk-sign-in to those org contexts until
  the Clerk plan is upgraded.

---

## Verdict

The identity + roster layer matches the canonical spec. No duplicates,
no orphans, no FK violations. **One real ownership inconsistency** (3
USA measurables owned by non-members) requires a decision. Three
informational gaps (no todos, no meetings, no spreadsheet import yet)
are scope items, not bugs.

End of audit.
