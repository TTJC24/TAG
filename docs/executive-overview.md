# The Operating System — Plain-Language Overview

*What we're building, where we are, how it works, and what it's worth.*
*Prepared 2026-07-27.*

---

## What we're trying to accomplish

We're building an **AI-powered operating system for the companies** — one place
that watches the business, tells you what needs a decision, and does the
repetitive work itself, with a person approving anything that leaves the
building.

The goal is simple: **stop paying people to do busywork.** Start with the work
that's pure repetition and pure dollars — **chasing overdue invoices** — and let
the system draft every reminder, track every promise, and make sure no invoice
ever quietly ages. Then expand from there.

Think of it as a tireless assistant who never forgets, never drops a follow-up,
and never sends anything to a customer without you saying "yes" first.

## Where we are today

It is **built and running live**, on our own secure server, behind a company
login. Two pieces already work on **real company data**:

- **Sales watch** — it reads our Pipedrive deals and flags the ones going stale
  or past their expected close date, so deals stop slipping through the cracks.
  This is **live right now.**
- **Collections** — it reads our **real accounts receivable straight out of
  Acumatica** (our accounting system), sees exactly who owes what and how
  overdue they are, and is ready to draft a chase for each one. The connection
  is **built and tested against our live books** — it's one switch from turning
  those into a daily worklist.

When we pointed it at our real receivables, it instantly saw **over $340,000
past due across FS and Big League** — every dollar now trackable and chase-able
automatically, instead of buried in a spreadsheet someone has to eyeball.

## How it works (the simple version)

1. **It reads the truth from our real systems.** Money comes from Acumatica,
   deals from Pipedrive. It never guesses or makes numbers up — it reads the
   actual records.
2. **It turns "things that need doing" into a clear to-do list** in one screen
   (we call it the tower): which customer to chase, which deal is stalling,
   what needs your decision.
3. **It drafts the actual work** — the reminder email, the follow-up, the packet
   — so a person's whole job is *reading and clicking yes or no.*
4. **Nothing goes out without a human.** It never sends an email or takes an
   outside action on its own. It prepares; you approve.
5. **It records everything** it does, permanently, so there's a clean trail.

The one rule that makes it safe: **it drafts, you approve.** A person is always
the final "send" button.

## What it can read from Acumatica — today, and next

The important thing to understand is what the **connection to Acumatica** is.
Acumatica is where the real numbers live, and we've built a secure, read-only
pipe into it. That pipe is the capability. What we point it at grows over time —
same pipe, more of the picture:

- **Today — the money we're owed.** Right now it reads **accounts receivable**:
  who owes us, how much, and how overdue. That's the live piece — the $340K+
  past due. It reads this and only this so far.
- **Next — actual sales.** The *same connection* reaches our real
  **sales and revenue** — what's actually been sold and invoiced, by company,
  not a salesperson's guess in the CRM. This is built to be turned on next; it
  isn't reading yet.
- **After that — the full scoreboard.** From the same pipe: open orders, margin,
  how long it takes us to collect. The live "how's the business doing" numbers,
  straight from the books instead of a hand-built spreadsheet.

A note on the CRM (Pipedrive): it is **only a status board for deals in
progress** — it tells us which deals are stalling. It is **not** where the real
sales numbers come from. **The truth is Acumatica; the CRM is just a nudge list.**
So when this doc says "reads the truth," today that means the receivables; the
sales and scoreboard numbers are the same capability, switched on in turn.

## What it changes

*One hard number so far, and it's not a savings estimate — it's what the system
saw when it read the real books: **$340K+ of receivables past due across FS and
Big League.** That's current exposure, verified, not a projection. What the
system does with it:*

- **Every overdue invoice gets worked systematically.** Each one goes on a chase
  ladder — a friendly nudge, then firmer, then a call task — instead of getting
  chased whenever someone gets to it. Whether that pulls cash in faster is
  something we'll measure once it's running, not something we're claiming up front.
- **The manual hunting goes away.** Today the AR person digs through the aging
  report and writes each email from scratch. The system hands them a prioritized
  list with the draft already written — they review and click. We haven't put an
  hours number on that; the point is the busywork moves off the person.
- **Nothing falls through.** Every overdue account and every stalling deal is
  surfaced automatically — no "we forgot to follow up on that one."
- **One version of the truth.** The numbers come straight from Acumatica,
  replacing the manual exporting and re-typing we do today.
- **Build once, reuse everywhere.** The same engine that runs collections will
  run the scoreboard, other departments, and the other companies. Each new use
  is an add-on, not a rebuild.

## What's next

- **Turn on email drafting** so an approved chase becomes a ready-to-send email
  in the right mailbox (the piece that actually replaces the typing).
- **Make it automatic** — the system refreshes itself every morning instead of
  someone running it.
- **Light up the scoreboard** — pull revenue, margin, days-to-collect, and
  orders straight from Acumatica so the numbers are live, not hand-built.
- **Add a chat** you can just ask: *"What's our exposure with customer X?"*
  *"What needs my decision today?"*

## The bottom line

We've gone from an idea to a **live, secure system that already reads our real
money and deals**, with the safety rail that a human approves everything. The
first payoff — turning **$340K+ of past-due receivables** into an automatic,
drafted, human-approved chase process — is one switch away. Everything after
that is expansion on the same foundation.
