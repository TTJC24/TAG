# ADR 0012: DemandStar Bid Doorway

Status: Accepted and implemented; disabled by default
Date: 2026-07-26

## Context

Municipal bid announcements and response-deadline reminders for USA arrive as
DemandStar emails (WorkOS source registry SRC-USA-DEMANDSTAR-001; ~201 threads
in the live mailbox at the time of building). Each bid is revenue with a hard
deadline, and nothing governed was catching them: a live reminder with a
deadline two business days out was sitting unread while this was built.

## Decision

A deterministic, inert-by-default doorway that turns exported DemandStar
messages into governed USA intake:

- Input is exported message JSON ({id, subject, from, date, body}); how the
  export is produced (manual, Microsoft Graph later) is deployment choice. Live
  mailbox OAuth is deliberately out of scope pending the owner's explicit
  approval per the WorkOS contract's stop-and-ask rules.
- Parsing is deterministic (labeled-field extraction from the real email
  shapes: Bid Identifier, Bid Name, Agency, Responses due by, Scope). The
  "you may also be interested" recommendations block is truncated before
  extraction so embedded other-bid fields cannot pollute the primary bid. No
  model guesses at bid numbers or deadlines; unparseable and non-bid messages
  (e.g. award notices) are skipped and reported.
- Only an allow-listed sender domain is accepted; impostor senders are
  skipped and reported.
- The response deadline becomes the task due date, so the executive queue and
  morning brief surface closing bids via the existing overdue machinery.
- Idempotency key demandstar:<bidNumber>: announcement and reminder for the
  same bid converge on one issue; re-runs replay; a drifted duplicate counts
  as a replay. Every description embeds the registry's provenance rule (bid
  number, issuing agency, announcement date, message id).
- Acts as a provisioned operating-layer user; entity defaults to USA.
- Operator entry point: pnpm demandstar:sync <messages.json>.

## Consequences

- A bid can no longer silently expire: it enters the queue with a deadline
  the moment its export is fed in, and an approval/no-bid decision is an
  auditable act.
- The fourth doorway (humans, meetings, numbers, now revenue mail) reuses the
  same governed pipeline; no parallel path.
- Automating the mailbox pull (Microsoft Graph read-only) is a follow-up requiring
  owner-approved OAuth; the parser and pipeline are unchanged by it.

## Amendment (2026-07-26): Pipedrive is canonical for pursuit state

Owner decision: the email feed is announcement intake only. Pipedrive is the
canonical record of which bids are being pursued and their state (consistent
with scoreboard's source-of-truth hierarchy: Pipedrive = sales/pipeline
truth). Consequences:

- No backfill of historical DemandStar mail into intake; current state is
  read from Pipedrive, not reconstructed from announcements.
- A bid task's job is to guarantee a timely bid/no-bid decision, recorded in
  Pipedrive; the task description directs the actor there and does not
  duplicate deal state.
- When brain grounding is enabled, recommendations naturally consult
  Pipedrive-backed brain data, closing the loop without a second integration.
