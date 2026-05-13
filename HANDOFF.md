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
