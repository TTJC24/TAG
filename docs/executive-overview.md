# The Operating System — Plain-Language Overview

_What we're building, where we are, how it works, and what it's worth._
_Prepared 2026-07-27._

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
  overdue they are, and **writes the chase email for each one**. The AR person
  opens a prioritized list where every message is already drafted — their job
  is to read it, adjust if needed, and approve. Built and tested against our
  live books; activation is a documented, staged checklist.

When we first pointed it at our real receivables it saw **roughly $340,000 past
due across FS and Big League.** One caveat we found and fixed: that first look
counted invoices but not the credits sitting on customer accounts, so the true
net is **lower** than $340K — we'll have the real number on the first live run.
Better to say that now than to chase a customer for money they've already been
credited.

## How it works (the simple version)

1. **It reads the truth from our real systems.** Money comes from Acumatica,
   deals from Pipedrive. It never guesses or makes numbers up — it reads the
   actual records.
2. **It turns "things that need doing" into a clear to-do list** in one screen
   (we call it the tower): which customer to chase, which deal is stalling,
   what needs your decision.
3. **It drafts the actual work** — the reminder email, the follow-up, the packet
   — so a person's whole job is _reading and clicking yes or no._
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

- **Today — the money we're owed.** Right now it reads **accounts receivable**
  (who owes us, how much, how overdue — netted against their credits) plus the
  **customer contact** to address a chase to. That is all it reads so far.
- **Next — actual sales.** The _same connection_ reaches our real
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

_One hard number so far, and it's not a savings estimate — it's what the system
saw when it read the real books: **on the order of $340K of receivables past due
across FS and Big League**, pending the credit netting described above. That's
current exposure, measured, not a projection. What the system does with it:_

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

- **Switch collections on.** The work is done and tested; what remains is a
  staged checklist against the live system — confirm the numbers reconcile with
  Acumatica's own aging report, look at real drafted chases, then let the
  morning refresh run itself.
- **Put the draft in the mailbox.** Today the system writes the chase and the
  AR person approves it; the last hop is depositing that text directly into the
  AR mailbox as a Outlook draft. Deliberately a separate decision, because it's
  the step that touches an outside system.
- **Light up the scoreboard** — pull revenue, margin, days-to-collect, and
  orders straight from Acumatica so the numbers are live, not hand-built.
- **Add a chat** you can just ask: _"What's our exposure with customer X?"_
  _"What needs my decision today?"_

## The bottom line

We've gone from an idea to a **live, secure system that reads our real money and
deals**, with the safety rail that a human approves everything. The collections
loop is now built end to end: it reads the books each morning, decides who to
chase and how firmly, and **writes each email** so the AR person reviews instead
of types. What's left is switching it on against the live system and checking
the numbers reconcile — not more building.
