# Data-Flow Audit — `/me` + `/admin/readiness`

Snapshot of how every UI field on these two pages is sourced today, why
the output isn't trustworthy yet, and the proposed source-of-truth
design before any further work.

Scope: read-only audit. No code is changed by this document.

Files inspected: `app/me/page.tsx`, `app/admin/readiness/page.tsx`,
`lib/queries/me.ts`, `lib/queries/org-readiness.ts`,
`lib/auth/context.ts`, `lib/readiness/compute-readiness.ts`,
`lib/db/schema.ts`, `scripts/seed.ts`.

---

## 1. Field-by-field map

### 1a. `/me`

| UI field | Function supplying it | Source table / column | Join path | Org scoping path | Why output is wrong / untrusted |
|---|---|---|---|---|---|
| Org slug header (`FS · L10 prep`) | `getAuthContext()` → `orgSlug` | Clerk session `orgSlug` (fallback `organizations.code` lower-cased) | `auth()` → DB `organizations` by `clerkOrgId` | Read directly from active Clerk org | OK in principle. Lowercases `code` if Clerk slug missing — relies on seed setting `code = slug.toUpperCase()`. |
| First name (`Tim's view`) | `ctx.personName.split(" ")[0]` | `people.name` | `people` row by `clerk_user_id = userId` | n/a (per-user) | **`people.name` is a frozen mirror seeded from `PEOPLE_SPEC`. It is never re-synced from Clerk.** A user updating their Clerk profile name won't change this. Seed names like "Daniel Hale", "Nick Reyes" are placeholders, not the real operators. |
| Readiness banner — status pill, label, counts | `computeReadiness({ measurables, openTodos, today })` | `entries.actual` (current-week per measurable) + `todos.due_date` + JS `new Date()` | derived from `getMyMeasurables` and `getMyOpenTodos` | `measurables.org_id = ctx.orgId`, `todos.org_id = ctx.orgId` | **"Current week" = `getRecentWeeks(4)[3]`, the most-recent row in `weeks`. With seeded data this is the most recent already-filled Friday — every entry exists, so `missingMeasurables` is always 0. With no seeded todos, `overdueTodos` is always 0. Everyone is permanently green.** Cadence is ignored — monthly KPIs (Inventory Turns) count as missing every week they're not entered. |
| Readiness banner — "Next L10: …" | `getNextMeeting(ctx.orgId)` → `scheduledFor` | `meetings.scheduled_for` | `meetings` filtered by `org_id`, `status='scheduled'`, `scheduled_for >= now` | `meetings.org_id = ctx.orgId` | **`meetings` table is empty.** No scheduler creates meeting rows. Always renders "not scheduled". |
| Measurables table — KPI name | `getMyMeasurables` → `measurable.name` | `measurables.name` | n/a | `measurables.org_id = ctx.orgId AND owner_id = ctx.personId` | OK structurally. Names ("Revenue (Weekly)", "DSO", …) are seed strings — accurate vocabulary, but unverified against the real Excel template. |
| Measurables table — Goal | `formatGoal(goalDirection, goalValue, goalSecondary, formatHint)` | `measurables.goal_direction`, `goal_value`, `goal_secondary`, `format_hint` | n/a | inherited via measurable row | Goal values are seed values from `MEASURABLES_SPEC`. They were one-shot estimates, not authoritative. `goal_secondary` is never populated in the seed (no `between` measurables). |
| Measurables table — week column headers | `weekHeader(week.weekEndingDate)` | `weeks.week_ending_date` | n/a | n/a (weeks are global) | `weeks` is global — no `org_id`. The seed creates the last 3 Fridays at seed time and never advances them. **No process creates the next week.** |
| Measurables table — actual cell value | `getMyMeasurables` → `entriesByWeek[weekId].actual` | `entries.actual` (numeric) | `entries` joined on `measurable_id` IN (…) AND `week_id` IN (…) | inherited via measurable | Values are synthetic (`plausibleActual()` algorithm). They look real (e.g. `$237,500`) but trace to `(15% under) → trend toward goal`. **No real KPI feed.** |
| Measurables table — cell color | `computeStatus(entry, measurable, history)` | (pure derive) | n/a | n/a | Output is technically correct but only as good as the synthetic actuals + the seed goals. |
| Rocks card — description | `getMyRocks` → `rocks.description` | `rocks.description` | n/a | `rocks.org_id = ctx.orgId AND owner_id = ctx.personId` | Seed strings. Real for some ("Reduce DSO to ≤35 days") but not authoritative. |
| Rocks card — status pill | `RockStatusPill status={r.status}` | `rocks.status` enum | n/a | inherited | OK structurally. Initial values from seed; updates land via `updateRockStatus` server action. |
| Rocks card — quarter | `r.quarter` | `rocks.quarter` (text) | n/a | inherited | **Hard-coded "Q2 2026" by the seed.** Will not roll over automatically. |
| Rocks card — due date | `r.dueDate` | `rocks.due_date` | n/a | inherited | Hard-coded `'2026-06-30'` by the seed for every rock. |
| Rocks card — notes | `r.notes` | `rocks.notes` | n/a | inherited | Seed strings; mostly empty. |
| To-dos list | `getMyOpenTodos` → `todos.*` | `todos` | n/a | `todos.org_id = ctx.orgId AND owner_id = ctx.personId AND status IN ('open','rolled_over')` | **No to-dos are ever seeded.** List is always empty. The infrastructure (table, server action, checkbox) works; there's just nothing to display. |
| Issues list | `getMyIssues` → `issues.*` | `issues` | n/a | `issues.org_id = ctx.orgId AND owner_id = ctx.personId AND status IN ('open','ids_in_progress')` | Seed-only. 6 issues hard-coded. Not a real backlog. |

### 1b. `/admin/readiness`

| UI field | Function supplying it | Source table / column | Join path | Org scoping path | Why output is wrong / untrusted |
|---|---|---|---|---|---|
| Header counts (`N not ready / almost / ready`) | `rows.reduce(...)` over `getOrgReadiness` | derived from `computeReadiness` per row | n/a | inherited | Everyone permanently green — see /me readiness banner row above. Same root cause. |
| "Next L10: …" | `getNextMeeting(ctx.orgId)` | `meetings.scheduled_for` | filtered by org + scheduled status | `meetings.org_id = ctx.orgId` | Always "not scheduled" — `meetings` table is empty. |
| "week ending YYYY-MM-DD" | `getRecentWeeks(1)[0].week_ending_date` | `weeks.week_ending_date` | n/a | n/a (global) | Stale. The most-recent Friday from the seed never advances. |
| Owner row — name | `getOrgReadiness` → `person.name` | `people.name` | `measurables` ⨝ `people` on `measurables.owner_id = people.id` | join filter `measurables.org_id = ctx.orgId` | Same name-source problem as `/me`: seeded mirror, not Clerk-current. |
| Owner row — email | `person.email` | `people.email` | same | inherited | Seed emails like `daniel.fs+tractionos-seed@example.com` — fake placeholder addresses. |
| Owner row — `admin` chip | `person.role === "admin"` | `people.role` enum | n/a | n/a | **Wrong source.** `people.role` is a single global role set by the seed (Tim=admin, all others=member). The actual per-org `org:admin` vs `org:member` lives in Clerk membership and is **ignored**. So someone who is admin in FS but member in BL is treated identically in both places. |
| Owner row — status dot + label | `readiness.status`, `readiness.label` | derived | n/a | inherited | Same readiness-pipeline problem. |
| Owner row — Measurables (`X/Y`) | `readiness.totalMeasurables - readiness.missingMeasurables / readiness.totalMeasurables` | derived from `entries.actual IS NOT NULL` for the current week | per row | inherited | Same. With seeded data, always `Y/Y`. |
| Owner row — Overdue to-dos | `readiness.overdueTodos` | `todos.due_date < today AND status IN ('open','rolled_over')` | per row | inherited | Always `0` — no seeded todos. |
| Eligible-people set | `selectDistinct people` joined to `measurables` where `measurables.org_id = ctx.orgId` | `measurables` ⨝ `people` | inner join | join filter | **Implicit definition: "L10 prep matters for measurable owners only."** Rock-only or todo-only owners are excluded. This is a policy decision baked into the query rather than declared. |

---

## 2. Where names come from today

A single string field, `people.name`, populated by `scripts/seed.ts` from
the hard-coded `PEOPLE_SPEC` array. The seed runs once (idempotent). No
code path syncs from Clerk after creation.

Concretely:

- **Tim** → `findExistingTim(fsOrgId)` locates the Clerk admin user by
  membership; the local row is inserted with name `"Tim Clark"` from
  the spec (not from Clerk's profile).
- **Everyone else** → `findOrCreateClerkUser(spec)` creates the Clerk
  user (if missing) using `spec.name`, then inserts a local `people` row
  using the same `spec.name`. Both are frozen at seed time.
- A user updating their Clerk profile name later does **not** propagate.
- The displayed first name on `/me` (`ctx.personName.split(" ")[0]`)
  trusts whatever was inserted — same source.
- The owner column on `/admin/readiness` (`person.name`) — same source.

The Clerk session payload contains `firstName`, `lastName`, `fullName`
(via `currentUser()`). None of that is currently consulted by `/me` or
`/admin/readiness`.

---

## 3. Where readiness numbers come from today

Three independent inputs, combined by the pure
`computeReadiness({ measurables, openTodos, today })` helper:

1. **`measurables[].currentActual`** — for each measurable owned by the
   person in the active org, look up `entries.actual` keyed by
   `(measurable_id, current_week_id)`. **`null` ⇒ "missing."** Where
   `current_week_id` is `getRecentWeeks(1)[0].id` for `/admin/readiness`
   or `getRecentWeeks(4)[3].id` for `/me`.
2. **`openTodos[].dueDate`** — `todos.due_date` for the person's open or
   rolled-over to-dos in the active org. `dueDate < today` ⇒ "overdue."
3. **`today`** — `new Date().toISOString().slice(0,10)` on the server at
   request time.

The verdict ladder:
- any missing measurable → `red` (label `"N measurables missing"`)
- else any overdue to-do → `yellow`
- else `green`

Implications of the current sourcing:
- Cadence is not respected. A `monthly` measurable (e.g. Inventory
  Turns) has no entry on most weeks; current logic counts that as
  missing every week.
- "Current week" = "most recent row in `weeks`," which the seed sets to
  the most recent Friday at the time of seeding and never advances.
  There is no concept of "this week" relative to the upcoming meeting.
- A measurable with no entry record at all and a measurable with an
  entry whose `actual IS NULL` are treated identically (both "missing").
- Status overrides on entries (`status_override`) and the shading
  engine's "yellow band" are not consulted by readiness — a measurable
  that's filled in but red still counts as "ready."
- To-dos are never seeded, so `overdueTodos` is structurally always 0
  in the current data set.
- There's no "rocks needing status update" or "issues needing root
  cause" gate, even though the meeting flow doc treats those as
  pre-meeting prep too.

---

## 4. Proposed source-of-truth design

### 4a. People / names

- **Identity & per-org membership: Clerk.** `clerk_user_id` and
  per-org `org:admin | org:member` are authoritative. The single
  `people.role` global enum should be removed (or kept only as the
  app-wide "is platform admin" flag — separate from per-org role).
- **Display name & email: Clerk profile.** The local `people` row keeps
  a `clerk_user_id` PK and treats `name`, `email`, `avatar_url` as a
  **cache** populated either lazily (on first auth) or via a Clerk
  webhook (`user.updated`). Server pages should pull display name from
  the cached row but invalidate when stale.
- **Seed becomes initial-state-only.** Seed inserts placeholder names
  for non-Clerk users; once a real human signs in, the cache is
  refreshed from Clerk.

### 4b. Measurables

- **Definition (name, owner, goal, cadence, formula): `measurables`
  table — admin-curated.** Stays in Postgres; surfaces in an
  admin-only "manage measurables" UI (not yet built; Phase 3 add-on).
- **Owner: `measurables.owner_id` → `people.id`.** Add a constraint
  that the owner has Clerk membership in the same org (or accept
  cross-membership ownership and document it — current seed allows it
  for Tim's accounting KPIs across all three orgs).
- **Cadence: `measurables.cadence` enum is already there
  (`weekly | monthly`).** Honor it everywhere — the readiness gate
  must skip non-due measurables.
- **Format hint: `measurables.format_hint`** — fine, but the set
  (`currency_usd | percent | days | turns | count |
  currency_usd_trend`) should become an enum, not free text.

### 4c. Rocks

- **Definition: `rocks` table.** Owner, quarter, due date, status,
  notes. Quarterly entity, not weekly.
- **Status history: `rocks.status_history` jsonb.** Already in schema;
  the server action appends.
- **Quarter & due date: derived, not hard-coded.** Quarter should come
  from the rock's `created_at` or an explicit `quarter` field set by
  the admin when planning the quarter. The seed currently hard-codes
  "Q2 2026" / "2026-06-30" for everything.

### 4d. Issues / to-dos

- **Issues: `issues` table.** Org-scoped, owner-scoped. Status moves
  `open → ids_in_progress → resolved | tabled` during the meeting.
  Source-of-truth is the table; mutations come from the meeting
  runner (Phase 4) and from `promote-issue-to-todo`.
- **To-dos: `todos` table.** Org-scoped, owner-scoped, due-dated.
  Created in three ways: meeting runner, voice copilot, transcript
  parser. Each path writes via the same server action.
- **`parent_issue_id`** (already in schema) wires "to-do came from
  IDS resolution" — not yet exercised by any UI.

### 4e. Readiness state

A clean derivation needs three explicit inputs:

1. **The week that matters.** Defined as the week the upcoming L10
   will review. Today this is implicit ("most recent row in `weeks`")
   and wrong. Two clean options:
   - **`weeks` table is anchored on weekly L10 date.** A scheduled
     cron creates the next `weeks` row on Friday afternoon (or whatever
     the cadence cutoff is). The "current week" is the latest one
     whose `week_ending_date` ≤ next L10 date.
   - **Derive purely from a fixed weekly cadence per org** (e.g. "L10
     every Tuesday 10:00"). `weeks` table goes away or becomes a
     pure cache; "current week" is `floor(now / 7d)` from a known
     anchor.
2. **The set of obligations per person.**
   - For each `measurables` row owned by the person where
     `cadence = 'weekly'`, expect an entry for the current week.
     (`monthly` measurables expected once per month — needs a
     `last_entered_week` lookup, not a per-week check.)
   - For each open/rolled-over `todos` row owned by the person with
     `due_date < today`: counts as overdue.
   - **Open question** (blocked, see §5): rocks status freshness, open
     issues without root cause — should they gate "ready"?
3. **The "submitted" predicate.** Today: `entries.actual IS NOT NULL`
   for the row. Cleaner: an explicit `entries.submitted_at` timestamp
   or a unique `(measurable_id, week_id)` row existing at all. The
   nullable `actual` is acceptable for measurables that legitimately
   record zero this week, but the conflation of "no row" vs "row with
   null actual" is a foot-gun.

### 4f. Meeting context / current week

**There is no source of truth today.** `meetings` table is empty;
`weeks` advances only by re-running the seed.

Required:

- **`meetings`** is the source of truth for an upcoming L10. A
  scheduled job (or admin "schedule next L10" action) inserts a row
  per org with `scheduled_for`, `facilitator_id`, `quarter`. The
  scheduler also creates the corresponding `weeks` row if missing.
- **`weeks`** table stays as the "what week ending date are we
  reviewing?" record. Either advance it via a cron (Friday 6pm:
  insert the next Friday if missing) or derive on the fly and only
  materialize on first need.
- **Org-scoping on `weeks`** — currently `weeks` has no `org_id`.
  This is fine if all orgs share the same Friday-cadence; brittle if
  any org runs a different schedule. Worth confirming. (Note the
  current `unique_index` on `week_ending_date` would block per-org
  variation outright.)

---

## 5. Per-field disposition

Legend: **K** = keep, **R** = remap, **X** = remove,
**B** = blocked pending missing data model.

### `/me`

| Field | Disposition | Note |
|---|---|---|
| Org slug header | K | Once `organizations.code` is curated. |
| First name | R | Read from Clerk `currentUser()` (cached) instead of `people.name`. |
| Readiness pill / counts | B | Requires "current week," cadence-aware obligation set, and a real submission predicate — none of which exist yet. |
| Next L10 date | B | Requires a meeting scheduler / `meetings` row. |
| Measurables table — KPI name | K | Subject to admin-curation UI later. |
| Measurables table — Goal | R | Source from a curated measurable definition (admin UI), not the seed. |
| Measurables week headers | B | Requires real `weeks` advancement. |
| Measurables actual cell | R | Replace synthetic seed actuals with real entries (manual, voice, transcript). The cell itself is fine; the data isn't. |
| Cell color | K | Pure derivation; correct once inputs are real. |
| Rocks — description | K | |
| Rocks — status pill | K | |
| Rocks — quarter | R | Derive from a quarterly-planning step, not a seed constant. |
| Rocks — due date | R | Same. |
| Rocks — notes | K | |
| To-dos list | K | Structurally fine; needs real data sources to populate. |
| Issues list | K | Same. |

### `/admin/readiness`

| Field | Disposition | Note |
|---|---|---|
| Header counts | B | Inherits readiness-pipeline blockers. |
| Next L10 / week ending | B | Same as `/me`. |
| Owner — name | R | From Clerk cache, not seed. |
| Owner — email | R | Same. |
| Owner — `admin` chip | R | **Use Clerk per-org membership role**, not `people.role`. |
| Owner — status dot + label | B | Inherits. |
| Owner — Measurables `X/Y` | B | Inherits — and must respect cadence. |
| Owner — Overdue to-dos | K | Logic is correct; needs real to-dos. |
| Eligible-people set | R | Decide explicitly: measurable owners only, or anyone with any org responsibility (measurable, rock, or todo). Today this is implicit. |

---

## 6. No broad refactors

This document does not propose to start any refactor yet. The
changes implied above are tracked here for the next planning
conversation. The codebase is left as-is until the source-of-truth
direction in §4 is approved.

---

## 7. Quick obvious wrong mappings (low-risk fixes when ready)

These are isolated and reversible — they don't depend on the data-model
work above. Listed for visibility only; no edits today.

1. **`people.role` is consulted for admin gating instead of Clerk's
   per-org role.** `app/admin/readiness/page.tsx:22`
   (`if (ctx.role !== "admin") redirect("/me")`) and
   `components/top-bar.tsx:15` both use the global role. Tim happens
   to be `admin` everywhere so it works for his account; for any
   other person, per-org admin status is invisible to the app.
2. **`getRecentWeeks(N)` returns "most recent N rows" with no awareness
   of the upcoming meeting.** Two related issues:
   - On `/me`, the "current week" is `weeks[3]` (4th of 4 returned).
     If the seed has 3 rows (which it does), `weeks[3]` is `undefined`
     and `mostRecentWeek` is `undefined` — every cell falls through
     to `{ actual: null }`. Worth verifying live.
   - On `/admin/readiness`, the "current week" is `weeks[0]` of a
     `getRecentWeeks(1)` call — the most recent existing week, which
     may already be in the past relative to the next L10.
3. **`weeks.week_ending_date` has a unique index but no `org_id`.**
   Locks all three orgs into the same Friday cadence; if one ever
   diverges this becomes a migration problem. ADR-worthy decision
   point.
4. **`getOrgReadiness` excludes `viewer`-role people implicitly** by
   requiring measurable ownership. If a viewer is supposed to see
   "their" readiness — they wouldn't surface here. Probably fine,
   but undocumented.
5. **`computeReadiness` ignores `measurables.cadence`.** Monthly
   measurables (Inventory Turns) count as "missing" every week.
   Single-line fix: filter to `cadence = 'weekly'` before counting,
   and add a separate monthly-due check.
6. **`entries.actual IS NOT NULL` is the submitted predicate, but
   "no entry row" and "entry row with null actual" are
   indistinguishable.** A measurable with no `entries` row at all
   for the week shows as "missing"; an entry row with `actual = null`
   also shows as "missing." Fine if the only writer creates the row
   on first save, but the unique index `(measurable_id, week_id)`
   plus a nullable `actual` invites the second case via partial
   writes. Either make `actual` not-null, or treat the row's
   existence as the predicate.
7. **`getNextMeeting` requires `status = 'scheduled'` AND
   `scheduled_for >= now`.** With `meetings` empty, this is moot.
   When meetings exist, also consider `status = 'live'` for the
   "now in progress" case so the banner doesn't go silent during
   the meeting.
8. **No reverse map from Clerk membership to local `people` rows on
   sign-in.** The seed inserts both. A real user signing in via
   Clerk SSO who has no seeded row will hit
   `AuthContextError("person_not_seeded")`. Acceptable for the
   internal pilot; needs a webhook before any external onboarding.

---

End of audit. No code changed.
