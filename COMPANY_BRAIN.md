# Company Brain

> **Purpose:** project-context file so Claude starts any task already knowing who this
> company is, what it runs on, and how it works. Skim target: **< 3 minutes**.
>
> **How to read the markers:** plain text = grounded in this repo's real config/code.
> `[NEEDS TIM]` = a fact only Tim can supply; it has **not** been invented or guessed.
> Core identity, systems, and conventions are now filled in; remaining `[NEEDS TIM]` items
> (§7) are optional polish.
>
> _Built 2026-05-28 from repo evidence + Tim's answers. See `WORK_LOG.md` for sourcing._

---

## 1. The company — who & what

- **Structure:** a group of **three sister companies** sharing back-office systems (M365 /
  Acumatica / Pipedrive — see §2):
  1. **Fastening Specialists** — fasteners, sold to **resellers**.
  2. **Big League Construction Supply (BLCS)** — general construction supply, sold to **contractors**.
  3. **Utility Supply Associates (USA)** — **waterworks** distribution (utility / water-infrastructure supply).
- **Relationship to its software:** This repo (`company-brain`) is the group's own internal
  **knowledge platform** — it ingests the three companies' shared systems (§2) into one
  searchable "brain." Tim (COO) builds and owns it.
- **Out of scope:** the sibling repo `contractor-lead-response` (**LeadSprint AI**) is Tim's
  **personal side venture** — *unrelated* to the company group or this brain. Do not pull it
  into company context.

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

**Topology:** 1 Acumatica tenant → 3 branches (FS / BLCS / USA); **2** Pipedrive instances
(one FS, one shared by BLCS + USA); 1 shared M365 tenant. _(The repo's connector config
currently assumes a single Pipedrive token — wiring the second instance is a known follow-up.)_

**Not yet integrated:** **TrackPod** (delivery / route / proof-of-delivery management) holds
the group's logistics data — a future connector candidate, not in the brain yet.

Surfaces the platform exposes: **Query CLI** (`ask`/`search`), **HTTP API** (Hono, port
4317), **Web UI** (Vite SPA), **Scheduler** (`node-cron`, off by default).

## 3. People

- **Tim — COO** of the group. Sole administrator/owner of **all systems** (M365, Acumatica,
  Pipedrive, and this platform). Builds and runs these repos (GitHub `TTJC24`).
- **Other leadership / key contacts:** `[NEEDS TIM]` — optional; add names/roles if Claude
  should know who to attribute decisions or requests to.

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

**Business terms / acronyms:**
- **FS** — Fastening Specialists. **BLCS** — Big League Construction Supply. **USA** — Utility
  Supply Associates. (Note: "USA" internally means the sister company, not the country.)
- **Waterworks** — USA's product domain (water-infrastructure / utility supply).
- More internal jargon, branch codes, product names, customer tiers: `[NEEDS TIM]`.

## 5. Conventions, voice & non-negotiables

**Engineering conventions** *(observed in this repo):*
- **Dry-run first.** Connectors ship with `fixtures/<connector>/` stubs; real credentials are
  "wired last." Exercise the ingestion path with `--dry-run` before touching live APIs.
- **Secrets live only in `.env`** (gitignored); `.env.example` documents the keys. Never commit
  credentials.
- **Provenance is mandatory** — ingestion must thread source identity through, not drop it.
- **Pinned upstream** — `gbrain` is pinned to a specific git rev, not a floating range.

**Brand voice / tone:** **consistent across all three companies** — **polished and personal**.
Customer-facing writing (quotes, emails, follow-ups) should read professional but human, not
generic or templated.

**Customer-facing non-negotiables & compliance/legal constraints:** none specified as of
2026-05-28 (per Tim). Revisit if regulatory/spec rules emerge (e.g., waterworks material specs).

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
- **GitHub:** `github.com/TTJC24` — `company-brain` (this platform). The
  `contractor-lead-response` repo there is Tim's unrelated personal side project — not group context.
- **TrackPod** — the group's delivery / route / proof-of-delivery system; operational
  logistics data lives here (not yet ingested).
- **No separate wiki / Notion / shared-drive.** Documents live in **Teams / SharePoint**, and
  **this company-brain platform is the central knowledge base being built** to unify all of the above.

## 7. Open questions for Tim  *(optional — the brain is usable without these)*

- **Other key people / roles** beyond Tim (COO) — add if Claude should attribute requests or decisions.
- **More internal jargon** — branch codes, product categories, customer tiers, anything an outsider wouldn't know.
- **Rough size** — headcount and relative scale of FS / BLCS / USA, if useful for context.

_Resolved 2026-05-28: company identity & offerings, systems topology, brand voice,
leadership/admin ownership, LeadSprint scope (out), TrackPod, and where knowledge lives._
