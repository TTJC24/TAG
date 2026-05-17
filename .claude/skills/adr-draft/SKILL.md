---
name: adr-draft
description: Draft a new Architecture Decision Record in DECISIONS.md following the project's established ADR format. Use when the user has made a one-way-door technical decision worth locking in (provider swap, schema reshape, scope cut, library policy change).
disable-model-invocation: true
---

# Skill: adr-draft

When invoked, draft the next ADR entry in `DECISIONS.md` and stop for review before committing.

## Steps

1. Read `DECISIONS.md` end-to-end. Identify:
   - The highest ADR number currently in the file (the new one is N+1).
   - The exact section structure used by recent ADRs (headings, ordering, voice).
   - Any cross-references the new decision must respect (e.g. ADR-0010's LLM/STT provider abstraction).
2. Read `CLAUDE.md` for any rule the decision interacts with (stack table, working agreement, hard rules).
3. Ask the user for the decision in one sentence if it is not already obvious from context. Do not invent the decision.
4. Draft the new ADR appended to `DECISIONS.md`. Match the existing structure exactly. Default sections:
   - **Title** — `ADR-NNNN: <imperative-mood decision>`
   - **Status** — `Accepted` (or `Proposed` if not yet ratified)
   - **Date** — today's date in `YYYY-MM-DD`
   - **Context** — what forced the decision; cite the rule, incident, or constraint
   - **Decision** — what we will do, stated in the active voice
   - **Consequences** — what becomes easier, what becomes harder, what we are giving up
   - **Alternatives considered** — at least two, each with a one-line reason it was rejected
5. If the new decision contradicts something in `CLAUDE.md`, flag it explicitly at the end of the ADR draft so the user can update `CLAUDE.md` in the same change (CLAUDE.md wins per its own rule, so it must move first).
6. Show the draft to the user. Do not commit. Do not run any other command.

## Conventions

- One ADR per decision. If the user describes two decisions, ask which to draft first.
- Past ADRs are immutable; new context goes in a new ADR that supersedes the old one with an explicit `Supersedes: ADR-NNNN` line.
- Keep it short. Recent ADRs in this repo are typically under 40 lines.
