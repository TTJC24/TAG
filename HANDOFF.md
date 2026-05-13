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
| `9e867bd` | `feat(nudges): in-app pre-meeting nudges + adapter scaffolding` — pure `composeNudge()` (9 tests), `NudgeChannel` interface, `InAppChannel` (audit-log delivery), `TeamsChannel` + `ResendChannel` stubs gated behind env flags (throw if invoked while disabled), `dispatchNudges()` orchestrator (5 tests), admin dry-run preview endpoint. **No outbound delivery.** |

Verification on each commit: `pnpm typecheck`, `pnpm lint`, `pnpm test`
(68 tests total), `pnpm build` — all green.

## Routes added or changed

| Route | Method | Auth | Notes |
|---|---|---|---|
| `/me` | page | signed-in | Now renders `<ReadinessBanner>` and `<LiveSync>`. Same data shape; org-scoped via `getAuthContext`. |
| `/scorecard` | page | signed-in | Now renders `<LiveSync>`. |
| `/admin/readiness` | page | signed-in **admin** | New. Non-admins are redirected to `/me`. |
| `/api/admin/nudges/preview` | GET | signed-in **admin** | New. Returns dry-run JSON for `?window=sunday_evening\|monday_morning\|pre_meeting`. Hardcodes `dryRun: true` — cannot deliver. |
| `/api/liveblocks-auth` | POST | signed-in | Unchanged on disk; broadcasts now correctly land in the room this endpoint authorizes. |

## Env flags involved

| Variable | Default | Behavior |
|---|---|---|
| `LIVEBLOCKS_SECRET_KEY` | unset | Required for live sync. When unset, `broadcastScorecard()` no-ops and the actor's own UI still re-renders via `revalidatePath`. |
| `NUDGES_TEAMS_ENABLED` | unset (treated as `false`) | `TeamsChannel.isEnabled()` returns `false`. `send()` throws if invoked. |
| `NUDGES_RESEND_ENABLED` | unset (treated as `false`) | `ResendChannel.isEnabled()` returns `false`. `send()` throws if invoked. |

No other new env vars. Microsoft Graph and Resend wrappers exist
(`lib/microsoft/graph.ts`, `lib/email/client.ts`) and remain unused by
the nudges layer.

## What remains for outbound rollout

The send paths are deliberately not wired. To deliver:

1. **`TeamsChannel.send()`** (`lib/nudges/channels/teams.ts`) — currently
   throws. Needs to:
   - Resolve the recipient's AAD user id (likely a `people.aadUserId`
     column or a Graph lookup by email).
   - POST a `chatMessage` via the existing
     `lib/microsoft/graph.ts` wrapper.
   - Return `{ delivered: true, externalId: chatMessageId }`.
2. **`ResendChannel.send()`** (`lib/nudges/channels/resend.ts`) —
   currently throws. Needs to call `sendEmail()` from
   `lib/email/client.ts` with `subject = nudge.headline`,
   `text = nudge.body`.
3. **Cron / scheduling** — none today. Options on the table:
   - **Vercel Cron** via `vercel.json` triggering a new
     `app/api/cron/nudges/route.ts`. Native to the deploy target.
   - **External scheduler** (GitHub Actions) POSTing to a protected
     endpoint. Works locally without Vercel.
4. **Admin UI for the dry-run preview** — endpoint exists; no page
   surfaces it yet. Curl works:
   ```
   curl -H "Cookie: <session>" \
     "$BASE/api/admin/nudges/preview?window=sunday_evening"
   ```
5. **De-duplication policy** — once outbound is on, decide whether to
   block re-nudging the same person within the same window. The audit
   log already records every `nudge_sent`; the dispatcher would need a
   pre-check against it.

## Exact approval points required before any live sends

Treat each as a one-way door — confirm explicitly before flipping.

- **A1. Approve Teams outbound** → flip `NUDGES_TEAMS_ENABLED=true`
  *and* land the `TeamsChannel.send()` implementation in the same PR.
  Setting the flag without the implementation will start producing
  thrown errors with no delivery.
- **A2. Approve Resend outbound** → flip `NUDGES_RESEND_ENABLED=true`
  *and* land the `ResendChannel.send()` implementation in the same PR.
  Same risk as A1 if the flag is set alone.
- **A3. Approve scheduler** → pick host (Vercel Cron vs. GitHub
  Actions), agree on cadence (Sunday 6pm, Monday 9am, T-5min). Until
  this lands, dispatches happen only when the preview endpoint or a
  manual script invokes them.
- **A4. Approve de-dup policy** → before A1 or A2 flips, agree on the
  rule that prevents duplicate sends in a window. Otherwise an
  enthusiastic cron + a re-dispatched window can double-nudge.

Until A1–A4 are approved one at a time, the slice is reversible by
deleting `lib/nudges/`, `app/api/admin/nudges/`,
`components/readiness-banner.tsx`, `lib/readiness/`,
`lib/queries/org-readiness.ts`, and `app/admin/readiness/` —
no schema, migration, or external state to roll back.

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
| `GET /api/admin/nudges/preview` | 404 | Clerk middleware — admin endpoint, no session. By design. |

The per-deployment immutable URL returns 401 on every route (Vercel Deployment Protection / SSO challenge) — this is project-level access control, not a build or runtime failure.

Five remaining acceptance items require an authenticated browser session and cannot be exercised via CLI: signed-in `/me`, org switching, `/admin/readiness` admin gating, scorecard cross-tab live sync, in-app nudges preview JSON.

### Data-flow + identity docs

- `DATA_FLOW_AUDIT.md` — field-by-field audit of `/me` and `/admin/readiness` and what was wrong about the previous data flow.
- `DATA_MODEL_DECISION.md` — canonical identity rules: Clerk = auth only, Postgres = canonical names + memberships + domain. Defines how Clerk user IDs map to people, how org membership maps to people within an org, and the minimum changes needed (most of which are now applied via the two follow-on commits above).

### Non-blocking follow-ups (still open)

1. **Clerk plan upgrade** — to admit Chip Bridges (BL), Craig Zahner (BL), and Chris Coghlan (FS) into Clerk org memberships. Without this they're roster-only.
2. **Drop `people.role` column** — once every consumer is verified to read role from `org_memberships` and the seed populates it on every run, the transitional `people.role` fallback in `getAuthContext` can be removed in a follow-up migration.
3. **Spreadsheet bootstrap** — the user's reference spreadsheet remains the bootstrap source for measurables, owners, targets, rocks, todos, issues, and weekly history. Today the seed uses placeholder values; a follow-up slice should ingest the spreadsheet.
4. **Real "current week"** — `getRecentWeeks(N)` still returns the most recent rows in `weeks`. The `meetings` table is empty so "next L10" is always "not scheduled". Needs the meeting cadence + scheduler decision before readiness numbers reflect the upcoming meeting.
5. **`measurables.cadence` ignored by readiness** — monthly KPIs (Inventory Turns) currently count as "missing" every week. Single-line fix in `lib/readiness/compute-readiness.ts` once cadence enters the input shape.
