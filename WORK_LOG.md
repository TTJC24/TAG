# WORK_LOG — Company Brain iteration

> **Summary is at the top and updated last (see "## Final summary").** Everything
> below it is the working record of an autonomous session that built and iterated
> on `COMPANY_BRAIN.md`.

## Final summary

_(Filled in during finalize — see bottom-of-file pass log for the detail.)_

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
