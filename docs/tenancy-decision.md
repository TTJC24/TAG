# "Each entity has its own brain and OS" — what that decides

Status: **draft for owner review.** Every line below is a default awaiting your
veto, in the same format as the blueprint. Strike what's wrong; what survives
becomes the locked answer.

Date: 2026-07-28

---

## Why this doc exists

"Each entity has its own brain and OS" is one sentence but six decisions. They
do not have to go the same way, and conflating them is what makes the
architecture hard to state. Below, each is separated, with what it costs to go
either way and a recommended default.

Two constraints to hold in mind while reading:

1. **Acumatica already made a version of this choice.** It is **one tenant**
   with FS and BLC as **branches** — one ledger, separated by entity inside it.
   The money truth is already "shared system, entity-separated." An OS split
   into five installations would be at odds with its own source of truth.
2. **"Own brain" is probably a guarantee, not a server.** The requirement is
   most likely _an FS question must never be answered from BLCS's documents._
   That is enforcement, and it does not require five separate brains — the same
   way row-level security already guarantees it for records without five
   databases.

---

## The six decisions

### 1. Knowledge (the "brain") — whose documents answer a question?

| Option                                        | What it means                                                                                                                        | Cost                                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| **A. One brain, entity-scoped (recommended)** | One knowledge service; every document is tagged to an entity; a query declares its entity and can only read that entity's documents. | Requires the brain to enforce scoping. **Open question — depends on how `company-brain` is built; needs a look.**                      |
| B. A brain per entity                         | Separate knowledge instance per company.                                                                                             | Five services to run, feed and back up. Shared knowledge (group policy, HR, the ERP's own conventions) has to be duplicated into each. |
| C. One brain, unscoped                        | What exists today.                                                                                                                   | An FS question can be answered from BLCS's documents. Almost certainly not what you want.                                              |

**Recommended: A.** It delivers the guarantee that matters. Note that the OS
side needs work either way — today `COMPANY_BRAIN_URL` is a single global
setting with no per-entity routing, so the wire must become per-entity
regardless of A or B.

**Worth deciding explicitly:** is there knowledge that _should_ be shared across
all entities (group policy, how the ERP is configured, safety rules)? If yes,
the model is "entity corpus + group corpus," not pure isolation.

### 2. Operating rules — chase ladders, approval thresholds, who approves

**Already per-entity, and should stay.** Policies are versioned per entity, so
Big League's ladder can differ from Fastening Specialists' with no code change.
This is the part that most deserves to be "its own OS," and it already is.

**Recommended: keep as built.**

### 3. Records — AR, deals, tasks, audit trail

**Already per-entity with row-level security _forced_** — one entity cannot read
another's rows even through an application bug. This is a hard guarantee at the
database, not a filter in code.

**Recommended: keep as built.**

### 4. Deployment — one installation or five?

| Option                             | Cost                                                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **One installation (recommended)** | One thing to deploy, patch, back up and secure. Entities separated by permission. Group-wide questions are a query.                                                |
| Five installations                 | Hardest isolation. Five upgrade paths, five backup regimes, five sets of secrets, five Cloudflare configs. Group-wide questions become a reporting project on top. |

**Recommended: one.** For a group with one COO and one technical partner, five
installations is the wrong trade — it multiplies the operational burden to buy
isolation you already have from RLS.

**The fear this usually answers:** _what if an entity gets sold or has to be
separated?_ Every row is stamped with its entity, so one entity's data can be
exported cleanly and handed over. Choosing one installation does not trap you.

### 5. Cross-entity view — can you see the group at once?

You are COO of all of them; "what's our total past-due" and "what needs my
decision anywhere" are real daily questions.

**Recommended: yes for money, scoped for operations.** Financial rollups
(cash, AR, revenue) group-wide; operational queues and approvals stay inside
each entity unless you hold a role in it. This falls out naturally from one
installation and is expensive under five.

### 6. Identity — who sees what

**Already per-entity** via memberships: a manager sees only the entities they
belong to; you see all. Delegation moves by policy version, not code.

**Recommended: keep as built.**

---

## What this adds up to

If you accept the defaults, the precise sentence is:

> **One operating system, one knowledge service, both strictly partitioned by
> entity.** Each company has its own queue, its own rules, its own records and
> its own knowledge, and cannot see another's. The owner sees across all of
> them. Entities are separated by enforced permission, not by separate
> installations — the same way Acumatica separates them by branch inside one
> tenant.

That is a defensible, checkable architecture, and it is close to what is already
built. The gap is decision 1: the brain is currently one global endpoint with no
entity scoping and no per-entity routing.

## If you disagree

The most likely place to disagree is decision 4. Reasons that would justify
five installations, and each is a real reason if it applies:

- An entity is likely to be **sold or spun out** on a timeline where a clean
  hand-over matters more than day-to-day convenience.
- An entity has a **compliance or audit regime** the others don't.
- An entity's operations are **so different** that shared infrastructure is a
  constant source of exceptions (Cultivus+ is the plausible candidate here).

If any of these are true, say which entity and why, and the answer changes.

## The one thing that needs investigation, not a decision

Whether `company-brain` can enforce per-entity scoping on its own corpus. If it
can, decision 1A is straightforward. If it cannot, the choice is to add scoping
to it or to run separate instances — and that is a build estimate, not a
preference. **Next step: look at how company-brain stores and retrieves
documents before committing to 1A.**
