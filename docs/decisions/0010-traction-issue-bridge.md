# ADR 0010: TractionOS Issue Bridge (Flagged, Read-Only, Inert by Default)

Status: Accepted and implemented; disabled by default
Date: 2026-07-26

## Context

TractionOS is the group's live L10 meeting platform (per-entity Scorecard,
Rocks, To-Dos, Issues; real-time collaboration; meeting copilot). It is where
humans surface problems. This control plane is where problems become governed
work. Until now the two did not connect: an issue raised in a meeting stayed a
meeting list item.

The repository survey settled the surrounding shape: `scoreboard` is, by its
own README, a KPI/control-spec feeder for TractionOS (its certified KPI and
exception definitions become a later, second doorway into intake, honoring its
promotion-evidence ledger); `company-brain` is the knowledge layer already
grounding this plane's agents (ADR 0009).

## Decision

A one-way, flagged-only, read-only bridge from Traction issues into the
existing manual-intake service:

- **Flagged-only.** Only issues whose status is in an explicitly configured
  list are synced. Recommended flag: `tabled` — the meeting's own "we cannot
  solve this here." Nothing syncs wholesale; the meeting stays in control of
  what enters the machine.
- **Strictly read-only.** The bridge pins one Traction connection and forces
  it `SESSION ... READ ONLY` for its lifetime; the live meeting tool is never
  written to. Deployments should additionally supply a read-only database role.
- **Idempotent.** The intake idempotency key is `traction:<issueId>`, so
  re-running the sync replays instead of duplicating. Cadence is therefore an
  operator choice (manual CLI now; cron later) with no correctness risk.
- **Real authorization.** The bridge acts as a configured, provisioned
  operating-layer user (resolved by email) and inherits that user's real
  permissions and RLS scoping — no service bypass.
- **Entity mapping.** Traction org codes map to operating-layer codes
  (default FS→FSI, BL→BLCS, USA→USA, configurable). Issues from unmapped
  organizations are skipped and reported, never guessed.
- **Provenance.** The created task's description carries the Traction issue
  id, meeting owner, priority, status, and root cause, so task detail traces
  back to the meeting.
- **Inert by default.** Enabling requires TRACTION_BRIDGE_ENABLED=true plus
  database URL, status list, and service-user email; anything less refuses.
  Operator entry point: `pnpm traction-bridge:sync`.

## Consequences

- A tabled meeting issue becomes a classified, brain-groundable,
  human-approved, executed, audited task; the executive queue shows its fate,
  closing the loop back into next week's meeting.
- Traction needs no change today. A first-class "send to ops" affordance in
  Traction can later replace the status-based flag without changing the
  bridge's contract.
- Scoreboard's certified exception definitions are the intended second
  doorway (auto-raised issues) once each definition clears its own promotion
  ledger; that work is deferred and separate.
