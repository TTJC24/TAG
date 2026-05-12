# TractionOS — Project Bible

This file is loaded into every Claude Code session in this repo. Read it before doing anything. Anything that contradicts `KICKOFF.md` v3 — fix it here.

---

## Mission

Replace the multi-sheet Excel L10 meeting template with a real-time collaborative web platform driven by an AI meeting copilot. The platform serves **three independent operating companies** — Fastening Specialists (FS), Big League Construction Supply (BL), and Utility Supply Associates (USA). Each entity runs its own weekly L10 with its own Scorecard, Rocks, To-Dos, Issues, transcripts, and recaps. There is no combined meeting, no parent/holding organization, and no cross-entity rollup in v1.

Three pillars:

1. **Real-time collaborative editing** — owners log in pre-meeting to update their own measurables, rocks, to-dos. Live presence, live cursors, optimistic shared state during the meeting.
2. **Voice-driven AI copilot during the meeting** — push-to-talk (spacebar) or scribe mode. Utterances become tool calls (`update_actual`, `create_todo`, etc.) with a 3-second cancellable diff preview.
3. **Post-meeting transcript ingestion** — Fireflies (primary) / Teams native / manual paste, all flowing through one adapter and one Claude pass that emits the same tool calls. Diff review screen with per-row accept.

The Excel template is functional but clunky (new tab per meeting, no history, no presence, no shading, no pre-meeting workflow, single editor). Every shortcoming listed in `KICKOFF.md` §"What's broken" is a user story; solving them is the bar.

---

## Stack (and why)

Do not add a library that is not in this table without asking.

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 14 App Router + TypeScript (strict) | Server components, Vercel-native |
| UI | Tailwind + shadcn/ui + Geist font | Slate-neutral base; Geist Mono for tabular figures |
| Motion | Framer Motion | Restrained transitions only |
| Client state | Zustand | Local UI state |
| Server state | TanStack Query | Cache + invalidation |
| DB | Postgres (Neon) + Drizzle ORM | Serverless Postgres, type-safe ORM |
| Auth / multi-tenant | Clerk Organizations | Exactly three orgs: FS, BL, USA. No parent. |
| Real-time collab | **Liveblocks** | Presence, live cursors, optimistic shared state |
| Speech-to-text | **Deepgram Nova-3 streaming** | Sub-300ms latency |
| AI brain | **Anthropic SDK — Claude Sonnet 4 with tool use** | Same tool defs for voice + transcript |
| Teams integration | **Microsoft Graph + MSAL** | Pre-meeting Teams chat, recaps, optional native transcript |
| Transcript sourcing | Adapter: Fireflies (primary) / Teams native / manual paste | Survives vendor changes; Fireflies already in use |
| Email (fallback) | Resend | Reminders, PDF board packets |
| Tests | Vitest (unit) + Playwright (E2E for meeting runner) | |

---

## Domain glossary (EOS — use these terms exactly; users are literate)

- **L10 Meeting** — weekly leadership meeting, self-scored 1–10.
- **Scorecard** — 5–15 weekly measurables, the pulse of the business.
- **Measurable** — a single KPI on the Scorecard.
- **Rock** — quarterly priority, owned by one person, on/off track.
- **To-Do** — 7-day action item, one owner, due date, done/not done.
- **Issue** — anything to be IDS'd.
- **IDS** — Identify, Discuss, Solve — the structured problem-solving step.
- **Segue** — opening round of personal/professional good news.
- **Cascading Messages** — what gets communicated down after the meeting.
- **V/TO** — Vision/Traction Organizer.

Entities and people: see `KICKOFF.md` §"Entities + people" for the people list. Seed scorecard and goal directions: see `docs/kpi-definitions.md`.

**Where this file disagrees with `KICKOFF.md`, this file wins.** Specifically: `KICKOFF.md` refers to a "Clark Holdings parent org" and a "combined L10" — both have been dropped (ADR-0009). The three orgs are fully independent.

---

## File structure (target)

```
/
  CLAUDE.md                     this file
  DECISIONS.md                  ADR log
  KICKOFF.md                    source of truth for scope
  reference/                    the Excel template we're replacing
  docs/
    kpi-definitions.md          KPI formulas (pulled from reference Appendix)
    meeting-flow.md             L10 agenda mapped to UI screens
    ai-tools.md                 Anthropic tool defs shared by voice + transcript
    permissions.md              role matrix + write-path contract
  .claude/
    commands/                   slash commands for in-session use
    agents/                     subagent definitions
  app/                          Next.js App Router (Phase 1+)
  components/                   shadcn-derived UI (Phase 1+)
  lib/
    db/                         Drizzle schema, migrations, queries
    auth/                       Clerk wrappers
    liveblocks/                 room providers, presence helpers
    ai/
      tools.ts                  the Anthropic tool definitions (single source)
      voice-router.ts           Deepgram → Claude → tool-call pipeline
      transcript/
        source.ts               TranscriptSource adapter interface
        fireflies.ts            Path A
        teams.ts                Path B
        manual.ts               Path C
        parser.ts               normalized transcript → Claude → diff
    shading/
      compute-status.ts         pure function: entry, measurable, history → status
      compute-status.test.ts    >=20 scenarios, written first
  app/api/
    webhooks/
      fireflies/route.ts        webhook receiver
      teams/route.ts            Graph subscription callback
```

---

## How shading works (in plain English)

Every cell — scorecard entry, rock card, to-do age, issue age — runs through one pure function: `computeStatus(entry, measurable, history) → { status, intensity, reason }`.

Status is `green | yellow | red`. Intensity is 0–100, driving `background-color: hsl(var(--status-{color}) / calc({intensity} * 1%))`. So a barely-missed goal is a pale yellow; a third-week-in-a-row miss with no note is a deep red. Hover reveals `reason`.

Signals that combine:

1. **Threshold vs `goalDirection`** (`gte` | `lte` | `eq` | `between` | `trend_down` | `trend_up`). For trend directions, the slope over the last 4 weeks decides.
2. **Variance magnitude** — how far off goal scales intensity.
3. **Streak / trend** — third consecutive red darkens; a recovery week lightens.
4. **Note semantics** — Claude classifies each note as `explained_one_off | structural_issue | on_plan_to_recover | no_context` (cached on the entry). Adjusts intensity ±1 step. An "explained one-off" red is muted; a "no context" red is louder.
5. **Forecast tint** — if the 4-week slope predicts a breach in the next 2 weeks, add a subtle warning border even on a green week.
6. **Goal-relative band** — within 5% in the wrong direction is yellow, not red.

The function is pure, lives in `lib/shading/`, and has test scenarios written before the implementation. No exceptions.

---

## How the AI copilot works

**Voice path and transcript path share one set of Anthropic tool definitions** (`docs/ai-tools.md` / `lib/ai/tools.ts`). Whatever the modality, Claude emits the same tool calls; every tool call hits the same server actions that handle permission checks, DB writes, Liveblocks broadcasts, and audit logging.

```
        ┌──────────────────────────────────────┐
        │   Voice (Deepgram stream → Claude)   │
        │   Transcript (Fireflies / Teams /    │──┐
        │   manual paste → Claude)             │  │
        └──────────────────────────────────────┘  │  same tool calls
                                                   ▼
                                       ┌────────────────────────┐
                                       │  Server action         │
                                       │  - permission check    │
                                       │  - DB write (Drizzle)  │
                                       │  - audit log row       │
                                       │  - Liveblocks broadcast│
                                       └────────────────────────┘
```

**Voice path:** spacebar → Deepgram streaming session → final transcript → Claude with meeting context + tool defs → tool calls → diff preview in copilot dock → 3s auto-apply countdown (cancellable). Confidence < 0.8 requires explicit click. Ambiguous references trigger the `clarify` tool, which speaks the question back. Tagged `source='voice'`.

**Transcript path:** webhook (Fireflies / Teams) or manual upload → adapter normalizes to `{ utterances: [{ speaker, text, ts }], rawText, durationSec }` → Claude pass with the same tool defs + current scorecard schema + open Rocks/To-Dos/Issues as JSON context → batched tool calls (never auto-applied) → diff review screen sorted by confidence ascending → accept all / per-section / per-row → tagged `source='fireflies' | 'teams_native' | 'transcript_manual'`. When the source includes diarization, `attributedToPersonId` is set to the actual speaker, not the facilitator.

**Hard rule:** Claude never invents numbers. If a measurable wasn't discussed, it stays untouched. The system prompt enforces this and the diff review surfaces low-confidence proposals first so humans see the iffy ones.

---

## How real-time sync works

- **Source of truth: Postgres.** Liveblocks is a coordination layer, not a database.
- **One Liveblocks room per scorecard** for pre-meeting collaboration (permanent), plus **one room per meeting** for the live meeting runner (created at meeting start, archived at conclude).
- Writes follow the same pipeline regardless of modality: client mutation → optimistic Liveblocks update → server action → Drizzle write → audit log → Liveblocks broadcast (canonical). On server reject, the optimistic update rolls back.
- Presence indicators show avatars at the top of each room; live cell-edit indicators outline cells currently being edited with the editor's avatar.
- Latency budget: a Daniel-on-phone update is visible on Tim's screen within 200ms.

---

## Permissions model (summary; full matrix in `docs/permissions.md`)

All permissions are **scoped to a single Clerk org**. There is no cross-entity read or write in v1.

| Role | Scorecard | Rocks | To-Dos | Issues | Meeting Runner |
|---|---|---|---|---|---|
| Admin | Edit any (within this org) | Edit any | Edit any | Edit any | Full control |
| Member (owners) | Edit own; view all within org | Edit own; view all | Edit own + tick off; view all | Create + edit own; view all | Read + edit assigned cells |
| Viewer | Read only (within org) | Read only | Read only | Read only | Read only |

Tim is a member of all three orgs (FS, BL, USA) with the `admin` role in each — three separate Clerk memberships. Everyone else is a member of exactly one org. The Clerk org switcher (top-right) lets Tim toggle which entity he's looking at; for single-org users the switcher does not appear.

**Every write — manual, voice, transcript — goes through a server action that checks permissions (within the active org) and writes an `auditLog` row with `source` set.** No path bypasses this. Voice and transcript ingestion are *acting on behalf of* the logged-in user (voice = facilitator; transcript = whoever the diarization identified, falling back to the meeting facilitator).

---

## Definition of done (per phase)

A phase is done when **all** are true:

1. The kickoff's deliverables for that phase are present.
2. Tests exist where the kickoff says they must (shading engine, voice command router, transcript parser are non-negotiable — scenarios written **first**).
3. No `any` in TypeScript that wasn't explicitly justified in a code comment.
4. `pnpm typecheck`, `pnpm lint`, `pnpm test` all pass.
5. A short summary message: what changed, what's tested, what to click through.
6. New libraries (if any) were approved before adding.
7. Every write path checks permissions and writes audit log.

---

## Working agreement

- **Plan → approve → implement.** Every phase. No exceptions.
- Small commits, conventional commit messages.
- Two-way doors: decide fast. One-way doors: stop and ask.
- Don't add features beyond the task. Don't refactor opportunistically inside a bug fix.
- Don't add comments that restate code. Only when *why* is non-obvious.
- Audit log row on every write; `source` must be set; `attributedToPersonId` set when diarization is available.

---

## Phase 0 status

This file, `.claude/commands/`, `.claude/agents/`, the four `docs/` files, and `DECISIONS.md` are in place. **Waiting on user approval before starting Phase 1.**
