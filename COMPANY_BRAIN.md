# Company Brain

> **Purpose:** project-context file so Claude starts any task already knowing who this
> company is, what it runs on, and how it works. Skim target: **< 3 minutes**.
>
> **How to read the markers:** plain text = grounded in this repo's real config/code.
> `[NEEDS TIM]` = a fact only Tim can supply; it has **not** been invented or guessed.
> Answer the `[NEEDS TIM]` items (consolidated in §7) to make this brain fully usable.
>
> _Built autonomously 2026-05-28 from repo evidence. See `WORK_LOG.md` for sourcing._

---

## 1. The company — who & what

- **Name:** `[NEEDS TIM]` — legal/trade name of the company this brain describes.
- **What it does:** `[NEEDS TIM]` — one or two sentences. (Repo evidence only shows the
  *shape* of a B2B operation: an ERP with customers/orders/invoices and multiple
  **branches**, plus a sales pipeline — but the actual industry and offering aren't stated.)
- **Who it serves:** `[NEEDS TIM]` — customer type / market.
- **Relationship to its software:** This repo (`company-brain`) is an internal **knowledge
  platform** that ingests the company's own systems (below) into one searchable "brain."
  A sibling repo, `contractor-lead-response` (product **"LeadSprint AI"**), also exists under
  the same GitHub owner. `[NEEDS TIM]` — is LeadSprint a product *of* this company, a
  separate venture, or unrelated? See §7.

## 2. Systems & tools Claude will encounter  *(repo-grounded — reliable)*

These are the systems the platform integrates, taken from real config (`.env.example`,
`src/config.ts`) and connectors (`src/sources/`), not from sample data:

| System | Role | Connector / evidence |
|---|---|---|
| **Microsoft 365** (Graph) | Email, calendar, SharePoint, Teams | `m365-mail`, `m365-calendar`, `m365-sharepoint`, `m365-teams` |
| **Acumatica** | ERP — customers, orders, invoices, items; multi-tenant + **multi-branch** | `acumatica` (REST contract API) |
| **Pipedrive** | CRM — deals, persons, orgs, activities, notes | `pipedrive` (v1 API) |
| **Postgres** | Datastore for the brain | `DATABASE_URL` |
| **ZeroEntropy** | Embeddings provider | `ZEROENTROPY_API_KEY` |
| **Anthropic** | LLM gateway (ask / query expansion) | `ANTHROPIC_API_KEY` |
| **gbrain** (`garrytan/gbrain`) | Upstream engine the platform is built on (pinned rev) | `package.json` |

Surfaces the platform exposes: **Query CLI** (`ask`/`search`), **HTTP API** (Hono, port
4317), **Web UI** (Vite SPA), **Scheduler** (`node-cron`, off by default).

## 3. People  *(Tim-only — fixtures are synthetic, so nothing is grounded here)*

- **Owner / operator:** Tim (GitHub `TTJC24`) — builds and runs these repos.
- **Team, roles, key contacts, decision-makers:** `[NEEDS TIM]` — who else, and who owns
  M365 / Acumatica / Pipedrive administration?

## 4. Terminology & acronyms

**Platform terms** *(repo-grounded — useful if Claude works in this codebase):*
- **gbrain** — the upstream knowledge-engine this app is built on.
- **Play A / Play B** — gbrain configuration lineages; this app uses the **Play B** app
  registration and the ZeroEntropy embedding switch, and a "Play B workaround" for upstream
  issue #1522 (direct-write ingestion bypassing the broken `ingest_capture` path).
- **Connector / `IngestionSource` / `IngestionEvent`** — the interface each integration
  implements and the events it emits.
- **Provenance** — `source_id` / `source_kind` / `source_uri` / `ingested_via`, threaded
  into `importFromContent` so every fact traces back to its origin.
- **Dry-run** — every connector runs against stub fixtures with no external calls.

**Business terms / acronyms / product names:** `[NEEDS TIM]` — internal jargon, branch
codes, product names, customer tiers, anything an outsider wouldn't know.

## 5. Conventions, voice & non-negotiables

**Engineering conventions** *(observed in this repo):*
- **Dry-run first.** Connectors ship with `fixtures/<connector>/` stubs; real credentials are
  "wired last." Exercise the ingestion path with `--dry-run` before touching live APIs.
- **Secrets live only in `.env`** (gitignored); `.env.example` documents the keys. Never commit
  credentials.
- **Provenance is mandatory** — ingestion must thread source identity through, not drop it.
- **Pinned upstream** — `gbrain` is pinned to a specific git rev, not a floating range.

**Possible company-wide standard to confirm:** the sibling `contractor-lead-response` repo is
held to a **react-doctor 100/100** quality bar. `[NEEDS TIM]` — is that a company-wide
engineering standard or specific to that product?

**Brand voice, tone, customer-facing non-negotiables, compliance/legal constraints:**
`[NEEDS TIM]` — none of this is derivable from code.

## 6. Where deeper context lives

- **This platform (once ingested):** the company-brain DB *is* the long-term memory across
  mail, calendar, SharePoint, Teams, ERP, and CRM. Query it directly:
  ```bash
  bun run ask "<question>" [--source <id>...] [--json]   # answer + citations
  bun run search "<query>" [--source <id>...] [--limit N] # ranked hits
  ```
  `--source` ids are the connectors: `m365-mail`, `m365-calendar`, `m365-sharepoint`,
  `m365-teams`, `acumatica`, `pipedrive`. Or run `bun run api` / `bun run web:dev` for the
  HTTP/Web surfaces.
- **Systems of record:** Acumatica (financial/operational truth), Pipedrive (sales truth),
  M365/SharePoint + Teams (documents & discussion).
- **Code:** `README.md` (architecture), `src/sources/` (per-connector behavior), `.env.example`
  (the full integration surface).
- **GitHub:** `github.com/TTJC24` — `company-brain` and `contractor-lead-response`.
- **Other knowledge stores** (wiki, Notion, Drive, runbooks): `[NEEDS TIM]`.

## 7. Open questions for Tim  *(answer these to finish the brain)*

1. Company legal/trade name and a one-line description of what it does + industry.
2. Who it serves (customer type / market) and rough size (people, branches).
3. Team & roles — and who administers M365 / Acumatica / Pipedrive.
4. Is **LeadSprint AI** (`contractor-lead-response`) a product of this company, a separate
   venture, or unrelated? Does company-brain serve Tim's own company, an employer, or a client?
5. Business terminology, acronyms, product names, branch codes.
6. Brand voice / tone and any customer-facing or compliance non-negotiables.
7. Is **react-doctor 100/100** a company-wide engineering standard?
8. Any other knowledge stores (wiki/Notion/Drive/runbooks) Claude should know about.
