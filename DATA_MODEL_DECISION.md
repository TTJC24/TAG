# Data-Model Decision — Identity, Names, Org Membership

Decision document supersedes any conflicting recommendation in
`DATA_FLOW_AUDIT.md` §4a / §5 (which incorrectly proposed reading
display names from Clerk). The rule below is binding.

## Rules in effect

- **Clerk** is auth identity only: user ID, active-org ID, per-org
  membership existence + role. Nothing else.
- **Postgres** is canonical for people, names, emails, all domain
  records (measurables, rocks, issues, to-dos).
- **Current week + next meeting** are derived from the Postgres meeting
  model and the L10 cadence — not from "the latest row in `weeks`."
- **Seeded / demo data is non-authoritative** and must not be relied on
  to validate behavior.

---

## 1. Canonical source for names

**`people.name` in Postgres is the canonical display name. There is no
fallback to Clerk.**

- Clerk does not hold names in this deployment. `user.fullName`,
  `firstName`, `lastName` are not populated and must not be read.
- Every UI that shows a person's name reads from `people.name` joined
  through the appropriate relationship (own person via `clerk_user_id`,
  measurable owner via `measurables.owner_id`, etc.).
- Edits to `people.name` happen via an admin-curation path (UI not yet
  built; today only the seed writes). When that UI lands, it writes to
  `people.name` directly. Clerk is not touched.
- Same rule applies to `people.email` and `people.avatar_url` —
  Postgres is canonical. The seed populates initial values; subsequent
  edits go through the admin path.

Implication for the Liveblocks auth endpoint
(`app/api/liveblocks-auth/route.ts:30-39`), which currently constructs
its display name from `currentUser()`: that path must also read from
`people.name` (looked up by `clerk_user_id`). Captured here as a
required follow-up; not changed in this document.

---

## 2. How Clerk user IDs map to people records

**One row per human in `people`. The unique key is
`people.clerk_user_id`.** This already exists on the schema
(`people_clerk_user_id_unique` index in `lib/db/schema.ts:142`).

Mapping invariants:

- Every authenticated request resolves
  `clerk.userId → people row` via `people.clerk_user_id = userId`.
  This is what `getAuthContext()` does today
  (`lib/auth/context.ts:54-63`).
- A Clerk user with no matching `people` row is a hard error
  (`AuthContextError("person_not_seeded")`). Correct behavior — we do
  not auto-create.
- A `people` row may exist before any human signs in (the seed creates
  rows for users that haven't signed in yet). Sign-in then connects
  the Clerk user to the existing row by `clerk_user_id`.
- A `people` row's `clerk_user_id` is **immutable** once set. To move
  a person to a different Clerk identity, archive the old row and
  insert a new one — do not re-key.
- Onboarding a new human:
  1. Admin inserts a `people` row with `clerk_user_id` = the new
     Clerk user's ID (after creating the Clerk user via dashboard or
     `setup:clerk` / `setup:clerk-admin` scripts).
  2. Admin grants per-org Clerk membership.
  3. First sign-in resolves cleanly because the row already exists.

No webhook is required. No background sync is required. Postgres is
written by humans (admin path) or seed; never derived from Clerk
state.

---

## 3. How org membership maps to people within an org

**Today, per-org membership lives only in Clerk; there is no local
mirror table.** This is the gap that needs the smallest possible fix.

Decision: **mirror Clerk org membership into Postgres** with a new
`org_memberships` table:

```
org_memberships
─────────────────────────────────────────────
id              uuid PK
org_id          uuid → organizations.id
person_id       uuid → people.id
role            person_role enum (admin | member | viewer)
created_at      timestamp
unique (org_id, person_id)
index on org_id
index on person_id
```

Rationale:

- "People in this org" must be answerable by a join, not by walking
  ownership tables (`measurables`, `rocks`, …). The current
  `getOrgReadiness` derives the eligible set from
  `measurables.owner_id` — that excludes anyone who doesn't own a
  measurable, which is incorrect for a roster query.
- Per-org admin gating must be answerable from Postgres without a
  Clerk round-trip on every request.
- Drop `people.role` (the global role column). Role is per-org, not
  global. Tim being "admin everywhere" is expressed as three rows in
  `org_memberships`, not as a global flag.

Sync direction: **Clerk → Postgres.** Specifically:

- The seed writes `org_memberships` from `PEOPLE_SPEC.memberships`
  (today it only writes the Clerk side; needs to also write the
  Postgres side).
- A future Clerk webhook (`organizationMembership.created`,
  `.updated`, `.deleted`) keeps the mirror current. Until that lands,
  the seed re-run is the convergence mechanism.
- Reads always hit Postgres; Clerk's per-org role is consulted only by
  Clerk's own session middleware.

Org-scoping path (the way every page already does it) is unchanged:
`getAuthContext()` reads the active `clerkOrgId` from the session,
resolves to `organizations.id`, and downstream queries filter by
`org_id`. Adding `org_memberships` lets those queries join cleanly
to "people in this org" instead of inferring from ownership.

---

## 4. What the current name path gets wrong

Listed in order of severity. Each is concrete and isolated.

1. **`/me` first-name display** (`app/me/page.tsx:104`):
   `ctx.personName.split(" ")[0]` — uses `people.name` already.
   **Already correct under this decision.** No change needed beyond
   making sure `people.name` is real (not a seed placeholder).
2. **`/admin/readiness` owner column** (`app/admin/readiness/page.tsx:91`):
   `person.name` from `getOrgReadiness` → `people.name` join. **Already
   correct.** Same caveat: depends on `people.name` being real.
3. **Liveblocks auth endpoint**
   (`app/api/liveblocks-auth/route.ts:30-39`): builds the display name
   from `currentUser()` (Clerk profile). **Wrong path.** Must read
   `people.name` by `clerk_user_id` instead. This name flows into
   presence avatars and live cell-edit indicators, so getting it from
   Clerk produces the same blanks the user just flagged.
4. **`getOrgReadiness` eligible-people set** is derived from
   `measurables` ownership. Wrong shape for a "people in this org"
   query — it silently drops anyone without a measurable. Will be
   fixed by joining on the new `org_memberships` table.
5. **Top-bar admin gate** (`components/top-bar.tsx:15`) and
   **`/admin/readiness` redirect** (`app/admin/readiness/page.tsx:22`)
   both read `ctx.role` (the global `people.role`). After
   `org_memberships` lands, both must read the per-org role for
   the active org — `org_memberships.role WHERE org_id = ctx.orgId
   AND person_id = ctx.personId`.

---

## 5. Minimum changes for `/me` and `/admin/readiness` to show the right people and right numbers

Two work units, in order. Each is small and self-contained.

### Unit A — Local org membership table (unblocks "right people")

1. Add `org_memberships` table per §3 in a new Drizzle migration.
2. Update `scripts/seed.ts` to write `org_memberships` rows from
   `PEOPLE_SPEC.memberships` (today it only writes the Clerk side).
3. Drop `people.role` in the same migration (or leave temporarily and
   stop reading it). Add `getAuthContext()` call to look up the active
   org's row in `org_memberships` and surface that as `ctx.role`.
4. Rewrite `getOrgReadiness` so the eligible-people set is
   `org_memberships WHERE org_id = ctx.orgId` joined to `people`.
   (The per-person measurable + to-do lookup stays the same — it's
   the *roster* that was wrong, not the per-person math.)

After Unit A:
- Top-bar admin link and `/admin/readiness` redirect resolve correctly
  per active org.
- `/admin/readiness` lists every member of the org (not just measurable
  owners). People with no measurables appear with `0/0 measurables`
  and any overdue to-dos.
- `/me` is unchanged in behavior but now consistent with how membership
  is sourced.

### Unit B — Real "current week" + real measurement obligations (unblocks "right numbers")

1. Define "current week" as a function of the upcoming L10 date, not
   the latest row in `weeks`. Two parts:
   - Decide the cadence per org (probably stored on `organizations`:
     `meeting_day_of_week`, `meeting_time`).
   - On every page load, compute "the week leading into the next L10"
     and look up (or insert) the matching `weeks` row.
2. Honor `measurables.cadence` in the readiness math. Weekly
   measurables are required every week; monthly ones are required only
   in the week containing month-end (or per a per-measurable cadence
   anchor). Single change in `lib/readiness/compute-readiness.ts` —
   accept the cadence and a "is-due-this-week" predicate per
   measurable.
3. Make submission unambiguous: an `entries` row's *existence* is the
   submitted predicate. `actual` may be null for legitimate zero
   reporting later, but for now a row means "submitted." Update the
   readiness computer to use row presence, not `actual IS NOT NULL`.

After Unit B:
- The readiness verdict reflects the upcoming meeting, not a stale
  Friday from seed time.
- Monthly KPIs stop counting as "missing" every week.
- The numbers shown on `/me` and `/admin/readiness` are derived from
  real `entries` rows scoped to the right week.

### Out of scope for this document

- Replacing the synthetic seed actuals with real KPI feeds.
- The Liveblocks auth name fix (called out in §4 item 3 — small
  separate change).
- Clerk webhooks for membership sync (post-MVP; seed re-run is the
  current convergence path).
- Rocks / issues readiness gates.

---

End of decision document. No code changed.
