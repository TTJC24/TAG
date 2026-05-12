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

**Consequences.** TDD on this module is non-negotiable. Note classification is async (Claude call), so its result is cached on the entry and consumed synchronously by the function — keeps the function pure.
