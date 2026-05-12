# TractionOS — Project Kickoff Prompt (v3)

> Paste this into Claude Code at the root of an empty repo. Reference template: `./reference/TRACTION_MEETING_TEMPLATE.xlsx`. **This supersedes v1 and v2.**

---

## Mission

Replace the multi-sheet Excel L10 meeting template currently used to run the weekly Fastening Specialists / Big League Construction Supply / Utility Supply Associates leadership meeting with a real-time collaborative web platform driven by an AI meeting copilot.

Three pillars:

1. **Real-time collaborative editing** — Daniel, Nick, Andrew, Craig, Tom, Chip, Chris B, Mike all log in pre-meeting to update their own measurables, rocks, and to-dos. The facilitator (Tim) sees their changes live. During the meeting, everyone is editing simultaneously with presence and live cursors.
2. **Voice-driven AI copilot during the meeting** — push-to-talk or scribe mode. Tim says "set Daniel's revenue to one sixty-eight seven oh two" and the cell updates with a 3-second cancellable diff. Says "add a to-do for Craig to send the dead stock report by Friday" and the to-do appears with the right owner and date.
3. **Post-meeting transcript ingestion** — paste a meeting transcript, get a structured diff of all proposed updates across scorecard, rocks, to-dos, IDS, and rating. Accept all / per-section / per-row.

The current Excel template is functional but clunky: a new tab per meeting, no persistent history, no real-time anything, manual variance math, no visual status, notes crammed into data cells, Rocks/To-Dos re-typed every week, no way for owners to update before the meeting except by texting Tim. We're fixing all of it.

---

## What's broken in the current Excel template (fix all of these)

1. **One sheet per meeting** (4-27, 5-4, 5-11…). No continuity. Trends die.
2. **Wk-1 through Wk-4 columns mostly empty** because nobody backfills. Trailing history should be automatic.
3. **Goals encode direction in text** ("≤45", "≥30", "1 PER WEEK"). Parser-hostile. Need a real `goalDirection` enum.
4. **Goals stored inconsistently** — Gross Profit % goal is `0.5` in one row, implied as 50% elsewhere. Variance math is wrong.
5. **Notes embedded in actual cells** — Fill Rate row has "LBM 97.11%, MEP 99.13%, CONSUP 98.13%…" stuffed into Wk-1. Notes need their own field.
6. **Same KPI repeated per entity** as separate rows. Should be one measurable with per-entity actuals or grouped under an entity selector.
7. **No status shading at all** — leadership eyeballs every number to figure out what's red.
8. **Rocks listed manually in every meeting tab** — they should persist quarterly with status history.
9. **To-Dos repeat verbatim week-to-week** with no completion lifecycle. DEAD STOCK 5K appears in 4-27 as No, 5-4 as No, 5-11 as No. No one notices it's been open 3 weeks.
10. **IDS section is a text blob** — no priority sort, no aging, no resolution tracking, no link to spawned To-Dos.
11. **Agenda has segment durations but no timer** — nothing keeps the meeting to 120 minutes.
12. **No way for owners to update pre-meeting** — they either show up unprepared or text/email Tim with their numbers and he updates the sheet manually.
13. **Single editor at a time** — Excel file lives in OneDrive, one person at a time, conflict resolution by hand.

These are the user stories. Solving them is the bar.

---

## Domain vocabulary (use EOS terms exactly — these users are literate)

- **L10 Meeting** — weekly leadership meeting, self-scored 1–10
- **Scorecard** — 5–15 weekly measurables, the pulse of the business
- **Measurable** — a single KPI on the Scorecard
- **Rock** — quarterly priority, owned by one person, on/off track
- **To-Do** — 7-day action item, one owner, due date, done/not done
- **Issue** — anything to be IDS'd (Identify, Discuss, Solve)
- **IDS** — the structured problem-solving step
- **Segue** — opening round of personal/professional good news
- **Cascading Messages** — what gets communicated down after the meeting
- **V/TO** — Vision/Traction Organizer

---

## Entities + people (seed reality)

Three operating companies run a combined L10:

| Entity | Code | Business |
|---|---|---|
| Fastening Specialists | FS | B2B fastener supply |
| Big League Construction Supply | BL | Construction materials, direct-to-jobsite |
| Utility Supply Associates | USA | Waterworks distribution |

Leadership team:

| Person | Role | Owns |
|---|---|---|
| Tim | Finance / IT / facilitator | DSO, DPO, AR, AI module, Acumatica migration |
| Daniel | FS GM | FS revenue, FS GP%, new FS accounts |
| Nick | BL GM | BL revenue, BL GP%, new BL accounts |
| Andrew | USA GM | USA revenue, USA GP% |
| Craig | Inventory | DIO, turns, Acumatica inventory rock |
| Tom | FS ops | FS fill rate |
| Chip | Ops | Open orders, on-time deliveries |
| Chris B | BL ops | BL fill rate |
| Mike | Logistics | Logistics partner onboarding |

---

## Seed scorecard (build this exact KPI set; pull formulas from the Appendix sheet of the reference workbook)

| KPI | Owner | Entity | Goal | Direction | Cadence |
|---|---|---|---|---|---|
| Revenue (Weekly) | Daniel | FS | $250,000 | gte | weekly |
| Revenue (Weekly) | Nick | BL | $100,000 | gte | weekly |
| Revenue (Weekly) | Andrew | USA | $312,000 | gte | weekly |
| Gross Profit % | Daniel | FS | 50% | gte | weekly |
| Gross Profit % | Nick | BL | 30% | gte | weekly |
| Gross Profit % | Andrew | USA | 15% | gte | weekly |
| DSO | Tim | ALL | 45 days | lte | weekly |
| DPO | Tim | ALL | 30 days | gte | weekly |
| DIO | Craig | ALL | 60 days | lte | weekly |
| Inventory Turns | Craig | ALL | 6× | gte | monthly |
| Fill Rate % | Tom | FS | 95% | gte | weekly |
| Fill Rate % | Chris B | BL | 95% | gte | weekly |
| AR Collections ($) | Tim | ALL | $250,000 | gte | weekly |
| Open Orders (Backlog) | Chip | ALL | declining trend | trend_down | weekly |
| New Accounts Opened | Daniel | FS | 1/week | gte | weekly |
| New Accounts Opened | Nick | BL | 1/week | gte | weekly |
| On-Time Deliveries | Chip | FS | 85% | gte | weekly |
| On-Time Deliveries | Chip | BL | 85% | gte | weekly |

Pull the formula definitions verbatim from the reference Appendix into `docs/kpi-definitions.md`.

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 14 App Router + TypeScript strict | Modern, server components, good Vercel story |
| UI | Tailwind + shadcn/ui + Geist font | Slate-neutral base, Geist Mono for tabular figures |
| Motion | Framer Motion | Restrained transitions, no demoware |
| Client state | Zustand | Local UI state |
| Server state | TanStack Query | Cache + invalidation |
| DB | Postgres (Neon) + Drizzle ORM | Serverless Postgres, type-safe ORM |
| Auth + multi-tenant | Clerk Organizations | FS/BL/USA = orgs; battle-tested |
| **Real-time collab** | **Liveblocks** | Presence, live cursors, optimistic shared state; purpose-built for this UX |
| **Speech-to-text** | **Deepgram Nova-3 streaming** | Sub-300ms latency, best-in-class for live meetings |
| AI brain | **Anthropic SDK — Claude Sonnet 4 with tool use** | Both the voice copilot and the transcript parser use the same tool definitions |
| **Teams integration** | **Microsoft Graph API + MSAL** | Pre-meeting reminders via Teams chat, post-meeting recaps to channels, optional native transcript pull |
| **Transcript sourcing** | **Adapter pattern: Fireflies (primary) → Teams native → manual paste** | Already in use by team; speaker diarization included; survives vendor changes |
| Email (fallback) | Resend | Email reminders for anyone who prefers it; PDF board packets |
| Tests | Vitest (unit) + Playwright (E2E for meeting runner) | |

---

## Phase 0 — Project brain (do this first, show me before anything else)

1. `CLAUDE.md` at root with:
   - Mission, stack + why
   - Domain glossary (EOS terms above)
   - File structure
   - "How shading works" in plain English
   - "How the AI copilot works" — voice path + transcript path share the same Claude tool definitions
   - "How real-time sync works" — Liveblocks rooms scoped per meeting, Postgres is the source of truth, Liveblocks pushes optimistic updates
   - Permissions model (below)
   - Definition of done

2. `.claude/`:
   - `commands/` — `/ingest-transcript`, `/snapshot-week`, `/add-measurable`, `/promote-issue-to-todo`
   - `agents/` — `transcript-parser`, `note-classifier`, `voice-command-router`

3. `docs/`:
   - `kpi-definitions.md` (from the reference Appendix)
   - `meeting-flow.md` (L10 agenda mapped to UI screens)
   - `ai-tools.md` (the Claude tool definitions shared between voice + transcript)
   - `permissions.md` (role matrix)

4. `DECISIONS.md` for ADRs.

**Stop after Phase 0. Wait for my approval.**

---

## Phase 1 — Scaffold + auth + multi-tenant + realtime infra

- Next.js bootstrap, shadcn init with custom slate theme, dark mode first-class
- Clerk wired with Organizations: FS, BL, USA, plus "Clark Holdings" parent org for combined views
- Drizzle schema + initial migration (see Phase 2)
- Liveblocks set up with a room-per-meeting model and a permanent room-per-scorecard for pre-meeting collab
- Deepgram client wired up but not yet connected to UI — just verify a working streaming transcription endpoint with a "hello world" mic test page
- Resend configured for transactional email fallback
- **Microsoft Graph API** wired with MSAL: admin consent flow for the tenant, scopes for `Chat.ReadWrite`, `OnlineMeetings.Read.All`, `OnlineMeetingTranscript.Read.All`. Verify with a "send a test message to Tim's Teams chat" smoke test.
- **Fireflies API** wired: store the workspace API key in env, set up the webhook endpoint at `/api/webhooks/fireflies` to receive `Transcription completed` events. Verify by triggering a test webhook.
- Seed script: 18 measurables, 9 people, 3 weeks of fake-but-plausible actuals, 9 rocks for Q2 2026, a starting issues list

---

## Phase 2 — Data model

```ts
// Drizzle sketch — flesh out fully

organizations: id, name, code, parentId           // FS, BL, USA, Clark Holdings
people: id, clerkUserId, name, email, defaultOrgId, role ('admin'|'member'|'viewer'), avatarUrl

measurables: id, name, ownerId, orgId, unit, formatHint,
             goalDirection ('gte'|'lte'|'eq'|'between'|'trend_down'|'trend_up'),
             goalValue, goalSecondary, cadence ('weekly'|'monthly'), formula, displayOrder

weeks: id, weekEndingDate, weekNumber, quarter, fiscalYear

entries: id, measurableId, weekId, actual (decimal|null), note (text|null),
         statusOverride ('green'|'yellow'|'red'|null), confidence (0-1),
         source ('manual'|'voice'|'transcript'), enteredByPersonId, enteredAt

rocks: id, description, ownerId, orgId, quarter, dueDate,
       status ('on_track'|'off_track'|'completed'),
       statusHistory (jsonb of {date, status, note, changedBy}), notes (text)

todos: id, description, ownerId, orgId, dueDate,
       status ('open'|'done'|'rolled_over'|'dropped'),
       rolloverCount (int), parentTodoId (nullable),
       createdInMeetingId, completedInMeetingId, parentIssueId (nullable)

issues: id, title, priority ('critical'|'high'|'medium'|'low'),
        ownerId, orgId, rootCause, resolution,
        status ('open'|'ids_in_progress'|'resolved'|'tabled'),
        createdAt, resolvedAt

meetings: id, scheduledFor, facilitatorId, scribeId, orgIds (array),
          meetingNumber, quarter, status ('scheduled'|'live'|'concluded'),
          rating (1-10), notes, cascadingMessages, transcriptId (nullable),
          liveblocksRoomId, linkedTeamsMeetingId (nullable)

meetingAttendees: meetingId, personId, present (bool), rating (1-10|null)

transcripts: id, meetingId, rawText, processedAt, summary, extractedJson (jsonb)

// Critical: audit trail
auditLog: id, personId, action, entityType, entityId, before (jsonb), after (jsonb),
          source ('manual'|'voice'|'fireflies'|'teams_native'|'transcript_manual'|'system'),
          attributedToPersonId (nullable, set when speaker diarization identified the source),
          createdAt
```

Key principle: **measurables, rocks, todos, issues live across meetings**. A meeting is a *view* + a snapshot of decisions, not a new copy of the data.

---

## Phase 3 — Permissions, personal dashboards, pre-meeting workflow

Build this *before* the live meeting runner. It's the simpler use case and validates auth/permissions + realtime in a lower-stakes context.

### Permissions matrix

| Role | Scorecard | Rocks | To-Dos | Issues | Meeting Runner |
|---|---|---|---|---|---|
| Admin (Tim) | Edit any | Edit any | Edit any | Edit any | Full control |
| Member (owners) | Edit own measurables; view all | Edit own; view all | Edit own + check off; view all | Create + edit own; view all | Read + edit assigned cells |
| Viewer | Read only | Read only | Read only | Read only | Read only |

Every write goes through a server action that checks permissions and writes an `auditLog` row. **No exceptions.** Voice commands and transcript ingestion go through the same checks — they're acting on behalf of the logged-in user.

### Personal dashboard (`/me`)

What Daniel sees when he logs in Monday morning:
- "Your measurables this week" — only his rows, sorted by status (red first)
- Quick-entry mode: tab through actuals, add notes as you go, Cmd+S to save
- "Your rocks" — status pill, click to update with note
- "Your open to-dos" — checkbox to mark done, with "needs note?" prompt for late items
- "Issues you raised" — quick status updates
- A "Submit for meeting" button that locks his updates and pings Tim
- Mobile-optimized — most owners will do this on their phone

### Pre-meeting reminder workflow

- Sunday 6pm: Microsoft Graph posts a Teams chat to each attendee + Resend email backup: "L10 prep — your scorecard awaits" with a deep link to their personal dashboard
- Monday 9am: nudge via Teams chat for anyone who hasn't submitted
- Tim's admin dashboard shows readiness: green check per person, red dot for missing, click-to-poke (sends another Teams nudge)

### Real-time sync

- Liveblocks room per scorecard. When Daniel updates his Revenue cell on his phone, Tim's screen reflects it within 200ms.
- Presence indicators: avatar bubbles top-right showing who's currently viewing
- Live cell-edit indicators: subtle outline + tiny avatar on a cell another user is editing
- Optimistic UI with rollback on server reject

---

## Phase 4 — Live Meeting Runner

Single screen, segmented agenda rail left, content panel right, copilot dock at the bottom.

### 4.1 Top bar
- Combined meeting badge: `FS · BL · USA · Combined L10` (each pill clickable to filter)
- Live segment timer + total elapsed / 120 min budget
- Facilitator + Scribe avatars
- **Presence row**: avatar bubbles of everyone currently in the room
- "Start Meeting" → "End Meeting" state machine
- **Copilot toggle**: mic icon, color-coded (idle gray / listening green / processing amber)

### 4.2 Agenda rail (left, sticky)
Segments: Segue · Scorecard Review · Rock Review · Headlines · To-Do Review · IDS · Conclude.
Each shows planned minutes, elapsed, status. Clicking advances the right panel. Timer auto-runs.

### 4.3 Scorecard panel
- Sticky left col: KPI name, owner avatar, entity pill, goal formatted properly (`≥ 50%`, `≤ 45 days`, `≥ $250,000`)
- **13 trailing weeks** displayed, most recent on the right
- Tabular figures, generous row height, alternating zebra at ≤4% opacity
- Each cell: large number, tiny note dot if a note exists, hover expand
- Click cell → inline editor (actual + note + status override pills + confidence indicator if AI-derived)
- Hover row → sparkline at far right
- **Live edit indicators**: see exactly which cells other people are touching, with their avatar
- Filters: by entity, by owner, by status

### 4.4 Rock review panel
- Card per Rock with owner avatar, due date, status pill
- Status pill cycle captures `statusHistory` entry
- Filter by entity, group by owner

### 4.5 To-Do review panel
- Last week's To-Dos, quick-toggle done
- **One-click "Roll over"** for incomplete → auto-creates new To-Do with `parent` link and visible rollover count
- After 2 rollovers, the To-Do gets a yellow border; after 3, red; "Promote to Issue" surfaces

### 4.6 IDS panel
- Issues sorted by priority then age
- Three-column kanban: Identify → Discuss → Solve
- Each card: title, owner, age in days, priority chip
- "Resolved" archives with one-click "Create To-Do from resolution"
- Aged issues (>14 days open) get warning border; >30 days = red

### 4.7 Conclude panel
- Auto-populated: new To-Dos from this meeting, IDS resolutions, Rock status changes, voice copilot actions
- Cascading Messages textarea
- 1–10 rating per attendee → live average
- "End & Send Recap" — emails attendees, archives meeting, snapshots scorecard week

### Visual quality bar
- No emoji status icons, no kindergarten reds/greens — shading is muted and earned
- Keyboard-first: arrow keys + Enter + Esc + Cmd+S + spacebar (push-to-talk)
- Dark mode first-class
- Print/PDF view that looks board-ready

---

## Phase 5 — Contextual shading engine

Pure function: `computeStatus(entry, measurable, history): { status, intensity, reason }`. Testable in isolation. **Build tests first** — minimum 20 scenarios.

Signals:

1. **Threshold check** vs `goalDirection`. For `trend_down`/`trend_up`, slope over last 4 weeks.
2. **Variance magnitude** — intensity scales with how far off goal.
3. **Streak / trend** — third consecutive red darkens; recovery lightens.
4. **Note semantics** — Claude classifies the note into `explained_one_off` | `structural_issue` | `on_plan_to_recover` | `no_context`. Adjust intensity ±1 step. Cache the classification on the entry.
5. **Forecast tint** — if 4-week slope predicts next 2 weeks breach, add subtle warning border even on a green week.
6. **Goal-relative band** — within 5% in the wrong direction is yellow, not red.

Output drives `background-color: hsl(var(--status-{color}) / calc({intensity} * 1%))`. Hover reveals `reason`.

Same engine applies to:
- Scorecard cells (primary)
- Rock status (darkens with Off-Track age)
- To-Do age (rolled over 2× = yellow, 3× = red)
- Issue age (warning at 14d, red at 30d)

---

## Phase 6 — AI Meeting Layer (the headline feature)

Two modalities sharing the same Claude tool definitions.

### 6.1 Shared tool definitions (`docs/ai-tools.md`)

Define these as Anthropic tool-use schemas. Every modality calls the same backend functions, which run permission checks and write `auditLog`:

```ts
tools = [
  update_actual({ measurableId, weekId, actual, note?, confidence }),
  update_note({ measurableId, weekId, note }),
  override_status({ entryId, status, reason }),
  update_rock_status({ rockId, status, note }),
  complete_todo({ todoId, doneAt?, note? }),
  create_todo({ description, ownerHint, dueDate?, fromIssueId? }),
  rollover_todo({ todoId, newDueDate? }),
  create_issue({ title, priority, ownerHint, rootCause? }),
  resolve_issue({ issueId, resolution, createTodos? }),
  set_meeting_rating({ personId, rating }),
  add_cascading_message({ text }),
  advance_agenda_segment(),
  clarify({ question })   // when ambiguous, the AI asks back
]
```

Every tool that resolves a person ("Daniel", "Craig") or a measurable ("Daniel's revenue", "fill rate") uses fuzzy match against current org members + active measurables. Ambiguous → `clarify`.

### 6.2 Voice copilot (real-time)

**Trigger modes:**
- **Push-to-talk** (default): hold spacebar (or click the mic button), speak, release. Visual indicator at all times. Like a walkie-talkie. Safest.
- **Scribe mode** (optional): always listening, only acts on utterances starting with the wake word "TractionOS" or "Claude". Used hands-free for fast meetings.

**Flow:**
1. User holds spacebar → Deepgram streaming session opens
2. Audio streams to Deepgram; partial transcripts appear in a copilot dock
3. Release spacebar → final transcript sent to Claude with:
   - Current meeting context (active scorecard, open rocks/todos/issues, current agenda segment)
   - Tool definitions above
   - System prompt that knows EOS vocabulary + this team's specific people/entities
4. Claude returns tool calls
5. **Diff preview** appears in the copilot dock: highlighted cell, before/after value, 3-second auto-apply countdown with cancel button
6. Sub-0.8 confidence → no auto-apply, requires explicit click
7. Ambiguous reference → Claude calls `clarify` → TTS reads the question + shows text → user responds via voice
8. Applied changes flow through the standard write path (permissions check → DB write → Liveblocks broadcast → audit log row with `source='voice'`)

**Sample utterances to support out of the gate:**
- "Set Daniel's revenue for this week to one sixty-eight thousand seven hundred two"
- "Note on fill rate: LBM ninety-seven, MEP ninety-nine, hardware down to seventy-three"
- "Mark Daniel's labeling rock as completed"
- "Add a to-do for Craig to send the dead stock report by Friday"
- "Issue: premature invoices, high priority, owner Tim"
- "Resolve the special orders issue — receiving alert is active and email notification is active. Make a to-do for Chip to test it next week."
- "Set the meeting rating to eight"
- "Cascade: USA migration to Acumatica is on track for end of quarter"
- "Move to the next agenda segment"

**Safeguards:**
- Never auto-apply with confidence < 0.8
- Voice-driven changes are tagged with the speaker's identity (assumed = facilitator unless we wire per-mic identification later)
- Full undo: every voice action gets a one-click revert button that lives in the copilot dock log for the duration of the meeting

### 6.3 Transcript ingestion (post-meeting)

Build a **`TranscriptSource` adapter interface** so we don't hard-couple to any one vendor. Three implementations ship in v1:

```ts
interface TranscriptSource {
  name: 'fireflies' | 'teams_native' | 'manual';
  fetchTranscript(meetingId: string): Promise<NormalizedTranscript>;
  // NormalizedTranscript = { utterances: [{ speaker, text, ts }], rawText, durationSec }
}
```

**Path A — Fireflies (primary, already running on the team):**
1. Fireflies bot joins the L10 (via calendar auto-join — configured once at the workspace level)
2. When transcription completes, Fireflies fires webhook → `/api/webhooks/fireflies`
3. Match the webhook's meeting metadata (calendar event ID or title) to a `meetings` row in our DB
4. Pull the full transcript via the Fireflies API, normalize it, kick off Claude processing
5. **Speaker diarization is included** — voice/transcript-driven changes get attributed to the actual speaker, not just the facilitator. Daniel saying "my revenue is 168k" in the transcript writes to `auditLog` with Daniel's `personId`, not Tim's.
6. Tim gets a Teams chat: "L10 transcript ready — 14 proposed updates, click to review"

**Path B — Teams native (secondary):**
For meetings held in Teams when Fireflies didn't run, or if you migrate off Fireflies later. Same flow as Path A but pulls from Microsoft Graph (`GET /communications/onlineMeetings/{id}/transcripts`) on Graph webhook trigger. Requires Teams transcription enabled at the tenant policy level (Teams admin center → Meetings → Meeting policies → Allow transcription = On) and per-meeting or default-on activation.

**Path C — Manual paste/upload (fallback):**
Slash command `/ingest-transcript` in the meeting runner, or a file upload on the meeting summary page. Accepts `.txt`, `.vtt`, `.docx`, or paste-from-clipboard. For in-person-only meetings or when both A and B fall through.

**Shared processing (all three paths converge here):**
1. Normalized transcript + current scorecard schema + open Rocks + open To-Dos + open Issues sent to Claude Sonnet 4 with the tool definitions from 6.1
2. Claude makes a sequence of tool calls (batched, not auto-applied)
3. **Diff review screen**: proposed updates side-by-side with current state, each with a checkbox, sorted by confidence (lowest first so humans see the iffy ones). For Fireflies-sourced transcripts, each proposed change shows the speaker who said it.
4. Accept all / per-section / per-row → entries written, shading recomputes, audit log entries tagged with `source` (`fireflies` | `teams_native` | `transcript_manual`) and `attributedToPersonId` (when diarization is available)
5. Transcript stored linked to meeting; re-runnable if the extractor improves

**Prompt notes:**
- System prompt explains EOS / L10 format + this team's vocabulary
- Pass current Measurables + open Rocks/To-Dos/Issues as JSON context so Claude can match references precisely
- Few-shot examples from anonymized reference data
- Require `confidence` on every field
- **Never invent numbers** — if a measurable wasn't discussed, omit it. Hallucinated actuals would destroy trust.

---

## Phase 7 — History, cascading, polish

- Per-week snapshot views (linkable forever)
- Quarter view: all Rocks status over time, completion rate
- Owner view: every Measurable, Rock, To-Do, Issue assigned to one person across all entities
- **Cascading Messages auto-post to Teams channels** — each entity has a Teams channel (FS Leadership, BL Leadership, USA Leadership); the conclude step posts the cascade to the right channels with attribution
- **Recap digests via Teams chat + Resend email** — Monday recap with rating + key changes, Friday "open to-dos older than 3 days" nudge
- CSV export + beautifully formatted PDF for board packets
- Mobile: read-only meeting view + the personal dashboard (already mobile-first from Phase 3)
- Search across all meetings + transcripts (full-text on transcripts, structured on the rest)
- **(Future) Teams bot** — `@TractionOS what's our DSO this week?` answers from inside Teams without leaving chat

---

## Working agreement

- **Plan before you code.** Every phase: plan, approve, implement. No exceptions.
- Small commits, conventional commit messages.
- Every module gets tests. **Shading engine, voice command router, transcript parser are non-negotiable — write the test scenarios first.**
- After each phase: summarize what changed, what's tested, what I should click through.
- Two-way doors get decided fast. One-way doors stop and ask.
- New library not in the stack table above? Ask first.
- Permissions check on **every** write path. Voice and transcript ingestion do not bypass — they call the same server actions as manual UI edits.
- Audit log row on every write. Source field must be set (`manual` | `voice` | `fireflies` | `teams_native` | `transcript_manual` | `system`). When the source provides speaker info (Fireflies, Teams native with attendee mapping), set `attributedToPersonId` too.

---

**Start now with Phase 0.** Show me `CLAUDE.md`, the `.claude/` scaffold, all four files under `docs/`, and `DECISIONS.md`. Then wait for my green light.
