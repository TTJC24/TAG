# Phase 3 Handoff

Snapshot of the four-commit Phase 3 sequence that landed this session.
All slices ship behind the existing auth/org context — no cross-org
reads, every write goes through the audit log.

## What landed

| Commit | Slice |
|---|---|
| `d11a2b7` | `feat(me): readiness banner + next-meeting query` — closes `/me` acceptance. Pure `computeReadiness()` helper (9 tests) drives a green/yellow/red pre-meeting verdict at the top of `/me`, alongside the next scheduled L10. |
| `f1c694f` | `feat(admin): /admin/readiness page` — admin-only org-wide view sorted red-first; reuses the same readiness primitive plus a new `getOrgReadiness()` query. |
| `1e645de` | `feat(realtime): scorecard live sync via Liveblocks events` — `<LiveSync>` client component on `/me` and `/scorecard` calls `router.refresh()` on every broadcast. Also fixes a real bug: `broadcastScorecard()` was keying on the internal org UUID while `/api/liveblocks-auth` keyed on the Clerk org id, so events were broadcast into a room nobody listened on. |
| `9e867bd` | `feat(nudges): in-app pre-meeting nudges + adapter scaffolding` — **REMOVED (ADR-0011).** The entire `lib/nudges/` layer + the admin dry-run preview endpoint were deleted. The scorecard is manual-input-only; there is no automated reminder/nudge cadence. The sections below describing nudge rollout are retained only as historical record. |

Verification on each commit: `pnpm typecheck`, `pnpm lint`, `pnpm test`
(68 tests total), `pnpm build` — all green.

## Routes added or changed

| Route | Method | Auth | Notes |
|---|---|---|---|
| `/me` | page | signed-in | Now renders `<ReadinessBanner>` and `<LiveSync>`. Same data shape; org-scoped via `getAuthContext`. |
| `/scorecard` | page | signed-in | Now renders `<LiveSync>`. |
| `/admin/readiness` | page | signed-in **admin** | New. Non-admins are redirected to `/me`. Passive readiness view — does not send anything. |
| `/api/liveblocks-auth` | POST | signed-in | Unchanged on disk; broadcasts now correctly land in the room this endpoint authorizes. |

(`/api/admin/nudges/preview` was added this session and later removed in ADR-0011 along with the rest of the nudges layer.)

## Env flags involved

| Variable | Default | Behavior |
|---|---|---|
| `LIVEBLOCKS_SECRET_KEY` | unset | Required for live sync. When unset, `broadcastScorecard()` no-ops and the actor's own UI still re-renders via `revalidatePath`. |

The `NUDGES_TEAMS_ENABLED` / `NUDGES_RESEND_ENABLED` flags introduced
this session were removed with the nudges layer (ADR-0011). Microsoft
Graph and Resend wrappers (`lib/microsoft/graph.ts`,
`lib/email/client.ts`) remain for recaps and transcript pulls.

## Outbound rollout — cancelled (ADR-0011)

The nudge outbound rollout was never wired and has now been cancelled.
The scorecard is **manual human input only**: owners enter their own
numbers, and the platform never auto-populates a measurable or
auto-reminds anyone. Accountability is human-owned by design.

The `lib/nudges/` layer (`dispatch`, `compose-nudge`, `types`, the
three channels) and the `/api/admin/nudges/preview` endpoint were
deleted. `getOrgReadiness()` — the obligation-only wrapper consumed only
by the dispatcher — was removed from `lib/queries/org-readiness.ts`;
`getOrgTeamView()` stays and continues to power the passive
`/admin/readiness` view and Jerry's context. No schema, migration, or
external state was involved.

---

## Identity layer reset (post-Phase-3 follow-on)

After the Phase 3 commits above, the identity + roster layer was reset to
the canonical model in `DATA_MODEL_DECISION.md`. Three additional commits:

| Commit | Slice |
|---|---|
| `c7a4a02` | `feat(identity): org_memberships table, identity sourced from Postgres` — new `org_memberships(org_id, person_id, role)` table; `getAuthContext` reads role from there; `getOrgReadiness` rewritten to use the new table joined on "obligation owners only" (people with at least one measurable, open todo, or active rock); Liveblocks auth endpoint now reads display name from `people` (Clerk holds no names in this deployment). Drizzle migration `0001_swift_cassandra_nova.sql` applied to Neon. `people.role` retained as a transitional fallback. |
| `6967785` | `feat(seed): canonical roster + org_memberships writes` — replaces demo names (Daniel Hale, Nick Reyes, …) with the real roster (Daniel Milavickas, Nick Dorfmueller, Cody Braden, Tyler Shinn, Chip Bridges, Tim Clark, Craig Zahner, Chris Booth, Tom Fowler, Chris Coghlan, Mike Grant, Andrew Sutt, Bill Potts). Tim is admin in all three orgs. Seed deletes legacy demo Clerk users (8), creates 12 canonical Clerk users, writes 18 `org_memberships` rows, reassigns ownership on 21 measurables / 5 rocks / 5 issues, cleans up 8 orphan local people rows. |

### Clerk free-tier cap (known limitation)

Three Clerk per-org memberships were rejected by the free-tier ~5-member cap and **logged inline** by the seed:

- Chip Bridges → BL (Forbidden)
- Craig Zahner → BL (Forbidden)
- Chris Coghlan → FS (Forbidden)

These three people are present in the canonical Postgres `org_memberships` for those orgs and **will appear in `/admin/readiness`** if they own anything — but they **cannot sign in to those org contexts** until the Clerk plan is upgraded. Re-run `pnpm seed` after the upgrade to converge.

### Production deployment status (verified)

Latest production deployment: **`dpl_GazB8V4FC5bfUUfJEs2xtEpmQxGF`**
- Per-deployment URL: `https://tractionos-fvnv6lsal-tim-clarks-projects.vercel.app`
- Production alias: **`https://tractionos-two.vercel.app`**
- Status: `Ready`. Build completed in 37s, no errors.

Concrete HTTP checks against the production alias (the URL real users hit):

| Route | Status | Notes |
|---|---|---|
| `GET /` | 404 | Clerk middleware (test-mode dev-browser challenge) — by design for unauthenticated curl. |
| `GET /sign-in` | 200 | Renders. |

The per-deployment immutable URL returns 401 on every route (Vercel Deployment Protection / SSO challenge) — this is project-level access control, not a build or runtime failure.

Four remaining acceptance items require an authenticated browser session and cannot be exercised via CLI: signed-in `/me`, org switching, `/admin/readiness` admin gating, scorecard cross-tab live sync.

### Data-flow + identity docs

- `DATA_FLOW_AUDIT.md` — field-by-field audit of `/me` and `/admin/readiness` and what was wrong about the previous data flow.
- `DATA_MODEL_DECISION.md` — canonical identity rules: Clerk = auth only, Postgres = canonical names + memberships + domain. Defines how Clerk user IDs map to people, how org membership maps to people within an org, and the minimum changes needed (most of which are now applied via the two follow-on commits above).

### Non-blocking follow-ups (still open)

1. **Clerk plan upgrade** — to admit Chip Bridges (BL), Craig Zahner (BL), and Chris Coghlan (FS) into Clerk org memberships. Without this they're roster-only.
2. **Drop `people.role` column** — once every consumer is verified to read role from `org_memberships` and the seed populates it on every run, the transitional `people.role` fallback in `getAuthContext` can be removed in a follow-up migration.
3. **Spreadsheet bootstrap** — the user's reference spreadsheet remains the bootstrap source for measurables, owners, targets, rocks, todos, issues, and weekly history. Today the seed uses placeholder values; a follow-up slice should ingest the spreadsheet.
4. **Real "current week"** — `getRecentWeeks(N)` still returns the most recent rows in `weeks`. The `meetings` table is empty so "next L10" is always "not scheduled". Needs the meeting cadence + scheduler decision before readiness numbers reflect the upcoming meeting.
5. **`measurables.cadence` ignored by readiness** — monthly KPIs (Inventory Turns) currently count as "missing" every week. Single-line fix in `lib/readiness/compute-readiness.ts` once cadence enters the input shape.
