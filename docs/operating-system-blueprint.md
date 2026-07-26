# The Company Operating System — Owner Blueprint

Status: Owner-directed (interview of 2026-07-26); gaps below carry explicit
defaults awaiting veto
Date: 2026-07-26

This document records how the owner wants the operating system to work, in
his words and decisions. It is the requirements north star for everything the
control plane builds next. Architecture decisions continue to live in ADRs;
this is the intent they serve.

## The vision (owner's words)

An interface the company can use as its operating system: give it answers,
have it do actions, and replace human labor — governed, audited, and under
human control at the gates the owner sets.

## Owner decisions (locked)

1. **Interface: chat + control tower, phased.** Managers and the owner live
   in a conversational surface ("what's our exposure with X?", "chase the
   overdue invoices") plus the queue/approvals tower. Staff feel the system
   through existing tools (Traction, Pipedrive, email, the WorkOS vault)
   first. The surfaces converge as trust grows.
2. **First labor replaced: collections / AR chasing.** The machine watches
   receivables, drafts every chase, tracks every promise; measured in cash.
3. **Autonomy level: drafts of everything.** The machine prepares complete
   external actions — emails, packets, follow-ups — without approval, so the
   human's entire job is reading and clicking yes/no. Nothing external SENDS
   without a human yes (the existing approval + Gmail-drafts.create
   architecture is exactly this shape). Autonomy beyond drafting is a future
   policy-version decision, not a code change.
4. **First 90 days' users: the owner + the manager/approver layer** of each
   company (the L10 room). Staff onboard indirectly until it is solid.
5. **AR reality:** there is a dedicated AR person today; the machine is built
   to take over the chasing mechanics. Entity AR/billing mailboxes mostly
   exist (some form per entity) and are the intended send identities.
6. **Chat must answer, day one, all of:** the customer money picture
   (invoices, aging, orders, deals, last contact); "what needs my decision";
   deal & order status; scorecard numbers with red/green state.
7. **Approvals: owner only, at first.** Every customer-facing send crosses
   the owner's desk for the calibration period; delegation to entity managers
   comes later via policy versions (the two-person policy machinery already
   supports this).
8. **Pipedrive is canonical for pursuit state** (bids, deals). The machine
   raises and tracks obligations; it does not duplicate deal state.

## Defaults where the interview stopped (owner may veto)

- **Chase ladder:** standard three-step — ~7 days past due: friendly reminder
  + invoice copy; ~30: firm follow-up + statement; ~60: final notice + human
  call task + hold-new-orders flag. Encoded as policy data (tunable), and to
  be reconciled with how the current AR person works before first send.
- **AR person's future:** during calibration they keep working as today; the
  intended end state is approver/exception-handler (calls, disputes) once the
  owner delegates approvals. Measured decision at 90 days.
- **AR truth source:** live Acumatica via company-brain's read-only
  connection once the brain wire is enabled; weekly aging-file ingest (CSV
  doorway) as the interim/fallback.
- **Success metric:** all three on a scorecard — DSO / past-due dollars down,
  100% of overdue invoices on-ladder (zero silent aging), and hours of human
  collections work freed. Certified like any other KPI.

## What this implies, in build order

1. **Deployment package** (gate for everything): Docker compose for
   API + worker + web + Postgres on the owner's droplet, behind Cloudflare
   Access alongside company-brain; real users seeded (owner + managers);
   runbook. Until this exists nobody but the builder can touch the system.
2. **Collections vertical** on the proven pipeline: AR aging in (file first,
   brain later) → ladder policy evaluates → machine drafts the chase (the
   existing Gmail drafts.create connector is the output channel — built,
   hardened, and waiting) → owner approves → draft materializes → outcome,
   promise-to-pay, and every touch audited. The ladder is policy data, never
   prompt text.
3. **Chat surface**: one conversational endpoint that composes what already
   exists — company-brain /ask (facts with citations), the executive queue
   (decisions pending), Pipedrive/Acumatica state via the brain, scorecard
   KPIs — with entity scoping and the same permission model as everything
   else. Answers cite sources; proposed actions route into governed intake.
4. **Delegation by policy**: as calibration completes, approval routing moves
   from "owner only" to entity managers via new approval-policy versions
   (two-person activation), not code.

## Constitutional constraints (unchanged by any of this)

Humans own the gates the policy names. Business rules live in policy data,
never prompts. All model/brain output is untrusted until schema-validated.
Every material act is idempotent, org-scoped, and lands in the immutable
audit trail. Everything ships inert and is enabled per the WorkOS contract's
stop-and-ask rules.
