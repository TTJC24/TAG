# Architectural Decision Records

Each ADR is dated and numbered. Format: context → decision → consequences. Don't edit old ones; supersede with a new ADR.

---

## ADR-0001 — Phase 0 scaffold

**Date:** 2026-05-12
**Status:** Accepted

**Context.** The kickoff (v3) defines a Phase 0 "project brain" deliverable: `CLAUDE.md`, `.claude/commands/`, `.claude/agents/`, four docs, and this ADR log. The intent is to get alignment on vocabulary, stack, the AI tool surface, and permissions **before** writing code.

**Decision.** Build exactly the Phase 0 set and stop. No scaffolding of `app/`, `lib/`, Drizzle schema, or any runtime code. Wait for explicit approval before starting Phase 1.

**Consequences.** Phase 1 will start from an empty source tree but with a settled vocabulary and contracts. Future Claude sessions inherit a single source of truth (`CLAUDE.md`) and will not re-litigate stack choices.

---

## ADR-0002 — Liveblocks as the real-time coordination layer

**Date:** 2026-05-12
**Status:** Accepted

**Context.** The pre-meeting workflow and the live meeting runner both need multi-user presence + optimistic shared state with sub-200ms latency. Options considered: roll our own (Postgres LISTEN/NOTIFY + WebSocket), Supabase Realtime, Yjs + a generic backend, Liveblocks.

**Decision.** Liveblocks. Purpose-built for the presence/cursors/optimistic-state UX; the SDK gives us what we'd otherwise spend two weeks building. Postgres remains the source of truth — Liveblocks is the coordination layer.

**Consequences.** Vendor dependency. Mitigated by keeping all canonical state in Postgres and treating Liveblocks rooms as transient projections. If we switch later, the data is intact.

---

## ADR-0003 — One set of tool definitions for voice and transcript

**Date:** 2026-05-12
**Status:** Accepted

**Context.** Voice commands and transcript ingestion both produce structured edits. We could keep two separate models (a streaming voice grammar + a batch transcript extractor) or unify on one Anthropic tool-use surface.

**Decision.** Unify. Both modalities call Claude Sonnet 4 with the same tool definitions. The voice path emits 1–2 tool calls per utterance; the transcript path emits a batch. Both flow through the same server actions.

**Consequences.** Fewer prompts to maintain, fewer test surfaces, identical permission checks and audit semantics. The voice latency budget is tighter (sub-2s round trip target) — we'll need to keep system prompts compact and exploit prompt caching.

---

## ADR-0004 — Transcript sourcing is an adapter, not a vendor

**Date:** 2026-05-12
**Status:** Accepted

**Context.** Fireflies is the team's current bot. Microsoft Teams has its own native transcription. Both could move or break in the future.

**Decision.** Define a `TranscriptSource` interface with three implementations: Fireflies (primary), Teams native (secondary), manual paste/upload (fallback). All return the same `NormalizedTranscript` shape (`{ utterances: [{ speaker, text, ts }], rawText, durationSec }`). The downstream Claude pipeline is vendor-agnostic.

**Consequences.** Slightly more code than a Fireflies-only client. Pays back the first time a vendor changes — we swap an adapter, not a pipeline.

---

## ADR-0005 — Postgres is the source of truth, always

**Date:** 2026-05-12
**Status:** Accepted

**Context.** Liveblocks could be tempted into the role of database (their storage primitive is durable). It would be faster to build that way.

**Decision.** No. Postgres + Drizzle is the canonical store. Liveblocks rooms hold ephemeral state during a session, then their final state is converted to a static snapshot on meeting conclude. All reads outside an active room go to Postgres.

**Consequences.** Two writes per change (Liveblocks broadcast + Postgres) on the meeting runner. Worth it: it preserves auditability, makes history queries trivial, and avoids vendor lock for the part of the data that actually matters.

---

## ADR-0006 — Goal direction is a typed enum, not text

**Date:** 2026-05-12
**Status:** Accepted

**Context.** The Excel template encodes direction inside the target string (`≤45`, `≥30`, `1 PER WEEK`). The kickoff calls this "parser-hostile" and asks for a real `goalDirection` enum.

**Decision.** `goalDirection ∈ {gte, lte, eq, between, trend_down, trend_up}` on the `measurables` row. `goalValue` (numeric) and `goalSecondary` (numeric, for `between`) store the threshold(s). The human-readable Appendix target is kept as the `formula` string for display only.

**Consequences.** Variance math is unambiguous. Percent values stored as decimals (`0.50`, not `50` or `0.5` ambiguously) — see `docs/kpi-definitions.md`. The shading engine consumes the enum directly.

---

## ADR-0007 — Permissions checked in server actions, not middleware

**Date:** 2026-05-12
**Status:** Accepted

**Context.** Next.js App Router gives us both middleware and server actions. We could centralize perm checks in middleware.

**Decision.** Check inside server actions. Middleware handles auth (who is this?) but not authorization (can they do this?). Authorization needs the target entity, which middleware doesn't have ergonomically.

**Consequences.** Per-action `checkPermission(actor, action, target)` helper enforces the contract. Slight repetition; massive clarity win when reviewing diffs. Voice and transcript ingestion go through the same actions, so they get the same checks automatically.

---

## ADR-0010 — Free-tier LLM + STT providers behind a provider abstraction

**Date:** 2026-05-12
**Status:** Accepted (revises the brand choices in ADR-0003 and the stack table in `KICKOFF.md`)

**Context.** Pay-per-call APIs are out of scope for v1. The AI surface (voice copilot + transcript intelligence) must run on free tiers. We also want a clean upgrade path: if Tim later decides quality is worth a few dollars a month, swapping in Claude or hosted Whisper should be a 20-line change, not a refactor.

**Decision.**

- **Primary LLM:** **Gemini 2.5 Flash** via Google AI Studio (`@google/generative-ai`). Free tier 1,500 requests/day. Default for transcript ingestion (batch).
- **Fallback LLM:** **Groq — Llama 3.3 70B** via `groq-sdk`. Free tier 14,400 requests/day. Default for voice copilot calls (latency-sensitive).
- **STT:** **Web Speech API** (browser-native `SpeechRecognition`). No key, no package. Documented limits: works best with clear speech in quiet rooms; Chrome's implementation sends audio to Google's servers — flag for privacy-sensitive meetings.
- **Provider abstraction ships from day one.** Two interfaces live in `lib/`:
  - `lib/llm/LLMProvider` — `complete(messages, tools): Promise<ToolCall[]>` plus `name` and `health()`. v1 implementations: `GeminiProvider`, `GroqProvider`. Future: `ClaudeProvider`, `OllamaProvider`.
  - `lib/stt/STTProvider` — start / stop / interim + final transcript events. v1 implementations: `WebSpeechProvider`. Future: `LocalWhisperProvider`, `DeepgramProvider`.
- A small `lib/llm/router.ts` picks the provider per call based on (a) the caller's `latency` requirement (`voice` → Groq, `batch` → Gemini), (b) the cached rate-limit state per provider, and (c) explicit config overrides.
- **Anthropic SDK and Deepgram are removed from the stack table** for v1. They remain valid future drop-ins.

**Consequences.**

- One indirection layer between AI features and any specific vendor. Pays for itself the first time we swap providers. The tool-definition format (`docs/ai-tools.md`) is unchanged — it was always vendor-neutral in shape.
- Web Speech API has real accuracy limits. v1 surfaces this in the copilot dock UI (a "noisy room? type instead" affordance) and in the dev mic-test page.
- Privacy: Chrome's Web Speech sends audio to Google. For privacy-sensitive meetings the v2 plan is local Whisper via `STTProvider`.
- Phase 6 (AI Meeting Layer) is **back in scope** for v1, implemented against the abstraction.
- Rate-limit caching belongs in the router (Redis-or-equivalent later; in-memory for v1). Treat a 429 from one provider as a signal to flip to the other for the next N seconds.

---

## ADR-0009 — Three independent orgs, no parent, no combined meetings

**Date:** 2026-05-12
**Status:** Accepted (supersedes any combined-org references in `KICKOFF.md`)

**Context.** Phase 0 initially modeled the platform with a "Clark Holdings" parent org running a combined L10 across FS, BL, and USA. The user clarified that the three operating companies are fully independent in the platform: each entity has its own Scorecard, Rocks, To-Dos, Issues, weekly L10 meetings, transcripts, and recaps.

**Decision.**

- Clerk has exactly three Organizations: **FS, BL, USA**. No parent org. No "Clark Holdings".
- Every domain row (`measurables`, `rocks`, `todos`, `issues`, `meetings`, `entries`, `transcripts`, `weekSnapshots`) has a single `orgId` foreign key — not an `orgIds` array. There is no `meetingType` field.
- The seed script gives Tim a membership in each of the three orgs with `admin` role. Everyone else holds membership in exactly one org. Clerk's built-in org switcher handles toggling for multi-org users.
- KPIs that were originally scoped "ALL" (DSO, DPO, DIO, Inventory Turns, AR Collections, Open Orders) become **three measurables — one per org** — owned by the same person across orgs. See `docs/kpi-definitions.md` §"Per-entity replication".
- No combined UI, no entity pills, no cross-org filters.

**Consequences.**

- Permissions are simpler: every check is single-org. No "is this a Clark Holdings admin?" branch.
- Tim's accounting workflow is somewhat heavier — he updates DSO three times instead of once. Acceptable: each entity has its own AR balance, so the three numbers were always conceptually separate even when the Excel rolled them up.
- A future "cross-entity dashboard" (Tim sees all three DSOs on one screen) is a *read-only* feature layered on top of this model. It is not in v1 and does not change the data model.
- The kickoff document (`KICKOFF.md`) still references "Clark Holdings" and "combined L10" in places; `CLAUDE.md` and this ADR override those references.

---

## ADR-0008 — Shading is a pure function with tests written first

**Date:** 2026-05-12
**Status:** Accepted

**Context.** Status shading is the most visible feature; getting it wrong destroys trust. It also combines 6 signals (threshold, variance, streak, note semantics, forecast, goal-relative band), which is exactly the kind of code that grows untestable bug haunts.

**Decision.** `computeStatus(entry, measurable, history): { status, intensity, reason }` is a pure function in `lib/shading/`. Minimum 20 test scenarios are written **before** the implementation. The function depends only on its inputs — no DB, no `Date.now()` (history is passed in).

**Consequences.** TDD on this module is non-negotiable. Note classification is async (an LLM call), so its result is cached on the entry and consumed synchronously by the function — keeps the function pure.

---

## ADR-0011 — Scorecard is manual-input-only; the automated nudge layer is removed

**Date:** 2026-05-29
**Status:** Accepted (supersedes the pre-meeting reminder/nudge workflow in `KICKOFF.md` and `docs/meeting-flow.md`; removes the nudges slice landed in commit `9e867bd`. Does **not** affect ADR-0005 — Postgres remains the source of truth.)

**Context.** The admin nudge-preview endpoint failed because `DATABASE_URL` was unset, which forced the question of how the scorecard should be populated and chased. The decision: **accountability requires human intention.** If numbers populate automatically — or if the platform chases people to enter them — no one truly owns the result. This is a decision about *behavior*, not *persistence*: the database is not what makes numbers "auto-appear", so removing the nudge/automation layer (not Postgres) is the correct fix.

**Decision.**

- The scorecard is **manual human input only**. No path auto-populates a measurable's actual; owners enter their own numbers before the meeting.
- The automated nudge/reminder layer is **removed entirely**: `lib/nudges/` (`dispatch`, `compose-nudge`, `types`, and the `in-app` / `teams` / `resend` channels) and the `/api/admin/nudges/preview` endpoint are deleted. No scheduler will be built — the previously-planned `app/api/cron/nudges/route.ts` is cancelled.
- `getOrgReadiness()` — the obligation-only wrapper consumed only by the dispatcher — is removed from `lib/queries/org-readiness.ts`. `getOrgTeamView()` is retained.
- `/admin/readiness` **stays** as a **passive, read-only** visibility view: it shows who has and hasn't entered their numbers but sends nothing and pokes no one. Human-initiated visibility is accountability; automated outreach is not.
- Postgres, Drizzle, and `DATABASE_URL` are **untouched** (ADR-0005 unaffected). Manually-entered numbers persist normally, every write still hits the audit log.
- The Microsoft Graph and Resend wrappers remain for meeting recaps and transcript pulls — not reminders. The `NUDGES_TEAMS_ENABLED` / `NUDGES_RESEND_ENABLED` env flags are gone.

**Consequences.**

- Owners are responsible for entering their own numbers; the platform will not chase them. Social accountability — the readiness view plus the meeting itself — replaces automated nudging.
- The original `DATABASE_URL` error disappears because the endpoint that threw is deleted, not because the env var was provisioned.
- Reversible by intent: re-introducing reminders later would be a new ADR. Nothing in the data model blocks it; the wrappers and audit-log `source` taxonomy still exist.

---

## ADR-0012 — Weeks are lazily generated; only the current week is editable

**Date:** 2026-05-29
**Status:** Accepted (extends ADR-0011 — manual entry — with *when* and *which week*. Builds on ADR-0005: Postgres stays the source of truth.)

**Context.** Manual entry (ADR-0011) needs two guarantees to feel intentional rather than chaotic: (1) a slot for "this week" must always be ready — nobody should hit a "create week" button or find a missing week; and (2) entry must target an unambiguous *this week*, not an open-ended historical editor where someone can quietly rewrite a number from three weeks ago. Intentional human accountability requires a clear, single "this week."

**Decision.**

- **Lazy week generation.** Loading the scorecard calls `ensureCurrentWeek()`, which inserts the current week's row if it doesn't exist and returns it. The *act of loading the page* is the trigger — no cron, no external scheduler, no manual "create week" button.
- **Idempotent + concurrency-safe.** The insert is `onConflictDoNothing` against the `weeks.week_ending_date` unique index, so two simultaneous loads can't create duplicate weeks.
- **Monday-anchored slot.** A week's key is the Monday of the current week (`currentWeekEndingDate()`), matching the imported workbook convention (its `weekEndingDate`s — 2026-04-27 / 05-04 / 05-11 — are all Mondays on a 7-day cadence). Quarter/fiscal year/ISO week are derived to match. *(The original ask floated "Sunday"; the existing data is Monday, and "match it exactly" wins.)*
- **Current week only is editable.** The scorecard anchors its editable hero on the current week; prior weeks appear only inside the display-only wave/sparkline. The editable hero shows a subtle affordance (cursor + faint hover); locked values are plain ink — no cursor, no hover, no click target.
- **Unambiguous "this week."** The scorecard shows an explicit "Entering for week ending {date}" banner, and the masthead dateline is computed from the same `currentWeekEndingDate()` so the two never disagree.

**Consequences.**

- The scorecard intentionally anchors on the *calendar* current week, not merely the most-recent row — so future-dated rows (e.g. seed data ahead of the server clock) don't capture the editable hero. History shown is the weeks ≤ the current week.
- The lock is enforced in the UI (the only editable target is the current-week hero). The `updateActual` server action is unchanged; if a hard server-side guard becomes warranted (e.g. once transcript ingestion can target arbitrary weeks), that's a follow-up.
- Backfilling skipped weeks is out of scope: lazy generation creates only the *current* week, so a gap can appear in the wave if the app wasn't loaded during an intervening week. Acceptable — the snapshot/import paths own historical rows.

---

## ADR-0013 — Weeks are entity-local; entities have independent cadences; CULTIVUS+ has no weekly cadence

**Date:** 2026-05-29
**Status:** Accepted (supersedes ADR-0012's "weeks are global / Monday-anchored" specifics; keeps its lazy-generation and current-week-only-entry principles. Refines ADR-0009 — the per-org isolation now extends to the week itself.)

**Context.** The three operating companies don't close their books on the same day, and one (CULTIVUS+) doesn't run on a weekly rhythm at all. The original model had a single **global** `weeks` table (one row per date, shared by all orgs) — which cannot represent "week ending Thursday for BLCS" and "week ending Sunday for FS" simultaneously, and which forces a weekly cadence on entities that don't have one. Forcing one global cadence misrepresents how the businesses actually operate.

**Decision.**

- **The week is entity-local, not global.** `weeks` gains `orgId`; its uniqueness moves from `(weekEndingDate)` to `(orgId, weekEndingDate)`. Each entity has its own week rows.
- **Per-entity cadence config lives on `organizations`** (columns, not Clerk metadata): `weekEndsOn`, `meetingDay`, `entryCutoffDay`, `entryCutoffTime` — all nullable. `entryCutoff*` is a **visual indicator only — no enforcement yet**.
- **Week generation is config-aware.** `ensureCurrentWeek(orgId, weekEndsOn)` creates the slot for the **upcoming occurrence** of the entity's `weekEndsOn`. A **null `weekEndsOn` generates no week** — the scorecard renders a manual log, never a forced weekly grid.
- **The dateline reflects the active entity's week.** It's computed from `ctx.weekEndsOn`; switching the Clerk org switches the dateline. Null cadence shows "no weekly cadence".
- **CULTIVUS+ has no enforced weekly cadence** (`weekEndsOn`/`meetingDay` null) and is configurable later.
- **Initial config:** FS — ends Sunday, meets Monday, cutoff Monday morning. BLCS — ends Thursday, meets Friday, cutoff Thursday EOD. USA — ends Thursday, meets Friday, cutoff Thursday EOD. CULTIVUS+ — null.

**Migration (chosen: preserve history, new convention forward).**

- The existing global weeks were **cloned per-org on their original dates** and each org's `entries` + `weekSnapshots` were repointed to its clone; the orphaned global rows were then deleted (`scripts/migrate-entity-weeks.ts`). Result: 3 global weeks → 9 per-org weeks, all 75 entries repointed, zero loss.
- **History keeps the exact dates it was reported on** (the imported Mondays); only weeks generated from now on adopt each entity's `weekEndsOn`. We explicitly rejected re-dating historical entries onto the new cutoff days as semantically lossy.

**Consequences.**

- A deliberate mixed history: pre-migration weeks sit on Mondays, new weeks on each entity's cutoff day. This is honest (it reflects when numbers were actually reported) and self-corrects as new weeks accrue.
- `scripts/import-workbook.ts` still writes orgless weeks (it predates this change). It must be updated to write per-org weeks, or the clone migration re-run after any future import — flagged as a follow-up.
- `entryCutoff` enforcement is intentionally deferred; today it only drives visual "expected by" indicators.
