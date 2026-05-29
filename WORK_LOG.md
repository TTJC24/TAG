# WORK_LOG — Company Brain iteration

> **Summary is at the top and updated last (see "## Final summary").** Everything
> below it is the working record of an autonomous session that built and iterated
> on `COMPANY_BRAIN.md`.

## Final summary

**What changed.** Created two files in the `company-brain` repo: `COMPANY_BRAIN.md` (a new
business-context "brain" doc for Claude) and this `WORK_LOG.md`. No existing files were
modified or deleted; no code, config, or other repos were touched. Two local commits, **no push**.

**What's usable now.** The brain is rubric-complete in structure and **fully grounded** on
the things the repo actually proves: the company's tooling/systems (M365, Acumatica ERP,
Pipedrive CRM, Postgres, ZeroEntropy, Anthropic, gbrain), the platform's surfaces, the exact
commands to query the brain, and observed engineering conventions.

**What's left.** The *business identity* sections can't be completed from the repo without
inventing facts (forbidden). They're left as a precise scaffold. Answering the 11 `[NEEDS TIM]`
questions below turns this from a strong skeleton into a finished brain — that's the only
remaining work, and it needs Tim.

**Every `[NEEDS TIM]` flag (consolidated):**
- Company legal/trade name + one-line description of what it does + industry.
- Who it serves (customer type / market) and rough size (people, branches).
- Team & roles, and who administers M365 / Acumatica / Pipedrive.
- Is **LeadSprint AI** (`contractor-lead-response`) a product of this company, a separate venture, or unrelated?
- Does company-brain serve Tim's own company, an employer, or a client?
- Business terminology, acronyms, product names, branch codes.
- Brand voice / tone.
- Customer-facing or compliance/legal non-negotiables.
- Is **react-doctor 100/100** a company-wide engineering standard or specific to LeadSprint?
- Any other knowledge stores (wiki / Notion / Drive / runbooks) Claude should know about.

**Repo state:** left on a clean local commit on the current branch. Run `git log --oneline`
to see the two added commits; nothing is staged or dirty.

---

## Run context

- **Mode:** autonomous iteration, no human in the loop during the loop itself.
- **Target repo:** `company-brain` (`github.com/TTJC24/company-brain.git`).
- **Artifact built:** `COMPANY_BRAIN.md` (new) — a *business* context document about
  the company, intended to be usable as a project-context file for Claude.
- **Commits:** local only. **Nothing was pushed** to GitHub (not requested).
- **Scope discipline:** only `COMPANY_BRAIN.md` and this `WORK_LOG.md` are created/edited.
  No source code, config, or unrelated files touched. No ingestion run, no credentials
  read, no live systems contacted.

## Candidate-file survey (Step 1)

There was **no pre-existing "company brain" / context document** to iterate on. Files
considered as the target:

| Candidate | What it is | Decision |
|---|---|---|
| `README.md` (exists) | Technical architecture readme for the company-brain *app* | **Not chosen.** It's the public-facing technical doc; reshaping it into a Claude context file would change its character. Left untouched. |
| `CLAUDE.md` (absent) | Would be a context file about the *codebase* | Not chosen. Tim's instruction is a *business* brain, not a codebase guide. |
| `COMPANY_BRAIN.md` (created) | A *business* context document about the company itself | **Chosen** per Tim's explicit selection. |

**Decision rationale:** Tim selected the "business company brain" interpretation — a doc
about the actual company, not the codebase. The repo contains very little *real* business
fact (fixtures are synthetic stubs), so the honest output is a strong, rubric-complete
**structure** with repo-grounded facts filled in and every unknowable marked `[NEEDS TIM]`.
Inventing people/financials/clients/systems is explicitly disallowed.

## What is genuinely repo-grounded (safe to state)

Evidence comes from `.env.example`, `src/config.ts`, `src/sources/registry.ts`, connector
files, `package.json`, `README.md`, and the sibling `contractor-lead-response` repo.

- **Tooling/systems the company runs** (from real config + connectors, not stub data):
  - Microsoft 365 / Graph — mail, calendar, SharePoint, Teams
  - Acumatica — ERP (REST contract API; customers/orders/invoices/items; tenant + **branch** → multi-branch)
  - Pipedrive — CRM (deals/persons/orgs/activities/notes)
  - Postgres (datastore), ZeroEntropy (embeddings), Anthropic (LLM gateway)
- **The company-brain platform itself** is built on `garrytan/gbrain` (pinned rev) and is
  intended to be the searchable memory across the above systems.
- **Sibling repo** under the same GitHub owner: `contractor-lead-response` = product
  **"LeadSprint AI"** (done-for-you AI lead response for contractors; $2,500 setup /
  $497–$1,500/mo). Relationship to the company-brain company is **not established** → `[NEEDS TIM]`.

## What is NOT repo-grounded (must come from Tim — never invented)

- Company legal/trade name, what the company actually does, industry, size.
- Real people / team / roles (fixture names like alice/bob/carol and "Acme/Globotech" are stubs).
- Any financials, customer names, contract terms (stub `$48k`, `NET30`, `$250k` are fake).
- Business-specific terminology, acronyms, product names, brand voice, non-negotiables.
- Whether company-brain serves Tim's own company, an employer, or a client.

## Rubric (Step 2) — a "usable" company brain must:

1. **(a) Entity & purpose** — identify the entity/entities and what they do.
2. **(b) Terminology** — define key terms/acronyms unique to the business.
3. **(c) People, tools, systems** — list what Claude will encounter.
4. **(d) Conventions, voice, non-negotiables** — capture how the company operates.
5. **(e) Pointers** — point to where deeper context lives.
6. **(f) Skimmable** — readable in under 3 minutes.

Scoring is 1–5 per item. Note: items (a), (b), (d) are inherently capped by available
evidence — they cannot honestly reach 4+ from the repo alone, because the real content is
Tim-only. For those, "done" = the *scaffold and prompts* are excellent and every gap is a
specific, answerable `[NEEDS TIM]` question (not a vague placeholder).

---

## Pass log

_(Each pass: score, identify weakest, improve, re-score, commit.)_

### Pass 0 — baseline scaffold (commit 8894f51)

| Item | Score | Justification |
|---|---|---|
| (a) Entity & purpose | 2 | Name/what-it-does are `[NEEDS TIM]`; only the B2B *shape* is inferable from ERP+CRM evidence. |
| (b) Terminology | 3 | Platform terms (gbrain, Play B, provenance, dry-run) are real & useful; business jargon is `[NEEDS TIM]`. |
| (c) People, tools, systems | 4 | Tools/systems table is complete and grounded; only "people" is missing (and honestly unknowable). |
| (d) Conventions, voice | 3 | Engineering conventions captured from repo; brand voice / non-negotiables are `[NEEDS TIM]`. |
| (e) Pointers | 4 | Strong list of where context lives; lacked the concrete *commands* to query the brain. |
| (f) Skimmable | 4 | ~900 words, tables + headers; under 3 min to skim. |

**Weakest repo-improvable item:** (e) — it named the platform as a context store but didn't
say *how* to query it.

### Pass 1 — make pointers actionable (this commit)

- Added concrete `bun run ask` / `bun run search` usage (verified against `src/cli/ask.ts`
  and `src/cli/search.ts`) plus the valid `--source` connector ids, to §6.
- Re-score: **(e) 4 → 5.** All other items unchanged.

| Item | Score |
|---|---|
| (a) Entity & purpose | 2 *(capped — Tim-only)* |
| (b) Terminology | 3 *(capped — Tim-only)* |
| (c) People, tools, systems | 4 |
| (d) Conventions, voice | 3 *(capped — Tim-only)* |
| (e) Pointers | **5** |
| (f) Skimmable | 4 |

### Convergence (stopped before 8 passes — by design)

Every item that **can** be raised by repo evidence — (c), (e), (f) — is at 4+. Items (a),
(b), (d) are gated entirely on facts only Tim has; raising them further would require
**inventing** company identity, jargon, people, or voice, which is explicitly forbidden.
Their "done" bar (excellent scaffold + specific, answerable questions) is met. Continuing to
8 mechanical passes would be busywork or fabrication, so the loop stops here. The 11
`[NEEDS TIM]` items in `COMPANY_BRAIN.md` §7 are the exact unlock.
