# Meeting Flow

L10 agenda mapped to UI. The agenda is fixed; the UI follows it segment by segment. Each Clerk org (FS, BL, USA) runs its own weekly L10 — there is no combined meeting (ADR-0009). A meeting belongs to exactly one org.

Total meeting budget: **120 minutes**. The segment timer auto-runs; the facilitator can advance manually.

---

## Segment order, durations, UI screens

| # | Segment | Default minutes | UI screen | Key actions |
|---|---|---|---|---|
| 1 | Segue | 5 | `MeetingRunner` → `<SegueScreen>` | Each attendee shares personal/professional good news. No data entry; the screen shows the attendee list with a "spoken" checkbox so we can later compute who-skipped trends. |
| 2 | Scorecard Review | 10 | `<ScorecardPanel>` (the marquee screen) | Review 18 measurables × current week. Cells already populated from pre-meeting workflow; facilitator's job is to focus on red/yellow and "off-trend green". Spawn issues for outliers ("park it"). |
| 3 | Rock Review | 5 | `<RockReviewPanel>` | Each owner reports On Track / Off Track on their Rocks. Status changes hit `rocks.statusHistory`. Off-Track Rocks queue an Issue automatically (one-click). |
| 4 | Headlines | 5 | `<HeadlinesPanel>` | Customer / employee headlines. Free-form text; transcript parser is good at extracting these. Optional in v1. |
| 5 | To-Do Review | 5 | `<TodoReviewPanel>` | Quick toggle Done / Not Done on last week's To-Dos. Incomplete → "Roll over" button. Twice rolled-over = yellow border, thrice = red + "Promote to Issue" surfaces. |
| 6 | IDS | 60 | `<IDSPanel>` | Three-column kanban: Identify → Discuss → Solve. Issues sorted by priority then age. Aged issues (>14d open) get warning border; >30d red. Resolution can spawn To-Dos. |
| 7 | Conclude | 5 | `<ConcludePanel>` | Auto-populated recap (new To-Dos, IDS resolutions, Rock status changes, voice copilot actions). Cascading Messages textarea. Per-attendee 1–10 rating. "End & Send Recap" finalizes. |
|   | **Total** | **95 base + 25 slack = 120** | | |

Rock is used everywhere (EOS-standard terminology). The Excel template uses "Anchor" in places; ignore that — Rock is correct.

---

## State machine

```
                ┌──────────────┐
                │ scheduled    │  meeting row created (cron or manual)
                └──────┬───────┘
                       │ "Start Meeting" clicked
                       ▼
                ┌──────────────┐
                │ live         │  Liveblocks room created; agenda timer running
                └──────┬───────┘
                       │ "End & Send Recap" clicked
                       ▼
                ┌──────────────┐
                │ concluded    │  recap sent; scorecard snapshot frozen; transcript hook armed
                └──────────────┘
```

A meeting in `live` state writes to a Liveblocks room scoped per meeting. On `concluded`, that room is archived (Liveblocks data is converted to a static snapshot stored on the meeting row). The permanent Scorecard room continues to receive writes through the normal pre-meeting flow.

---

## Pre-meeting workflow (sequence)

The scorecard is **manual human input only** — owners enter their own numbers; nothing is auto-populated, and there is no automated reminder/nudge cadence (ADR-0011). Accountability is human-owned: if a number is on the board, a person put it there.

| When | Trigger | Channel | What happens |
|---|---|---|---|
| Any time before the meeting | owner opens the app | — | Owners enter their own measurables, rocks, and to-dos on `/me`. Human-entered; never auto-filled. |
| On load | server-side readiness calc | Tim's `/admin/readiness` | Passive admin view: green check per person who's submitted, red dot for missing. Read-only visibility — it does not send anything. |
| Meeting start | facilitator clicks "Start Meeting" | Liveblocks | Room state machine flips to `live`. Pre-meeting submissions are locked (an attempt to edit is gated by "meeting is live — use the meeting runner"). |

---

## Post-meeting workflow

| When | Trigger | What happens |
|---|---|---|
| On "End & Send Recap" | UI button | Snapshot the week's scorecard entries; freeze `meetings.notes` and `cascadingMessages`; compute `rating` average; send recap email + Teams cascade. |
| When Fireflies webhook fires | external | Match to meeting (calendar event ID or title); fetch + normalize; queue LLM pass; notify Tim in Teams with "N proposed updates — review here". |
| Diff review accepted | Tim | Updates write via the same server actions as manual edits; `source` set on every audit row. |

---

## Keyboard map (Meeting Runner)

| Key | Action |
|---|---|
| `→` / `←` | Next / previous agenda segment |
| `Space` (hold) | Push-to-talk (voice copilot) |
| `Enter` | Confirm cell edit |
| `Esc` | Cancel cell edit / cancel pending voice diff |
| `Cmd/Ctrl + S` | Save (rarely needed — autosave) |
| `Cmd/Ctrl + Z` | Undo last action (works on voice/transcript writes too) |
| `Cmd/Ctrl + K` | Command palette (jump to measurable, person, rock, todo, issue) |

Voice push-to-talk on `Space` only fires when no input is focused, so typing notes never triggers the mic.

---

## Single-org scope

Every meeting is scoped to one Clerk org. The top bar shows the org name and the org switcher (visible only to users who are members of multiple orgs — i.e. Tim). Attendees only see the org they're in; cross-org reads and writes are blocked at every query.

There are no entity pills or combined views. If Tim wants to look at FS and BL side-by-side, he switches orgs — they are separate apps wearing the same skin.
