# Operating System — Handoff

For a technical partner picking this up cold. What it is, where it lives, what's
live, how to run it, and how to extend it. Companion docs:
`operating-system-blueprint.md` (intent), `system-context.md` (the business /
systems of record), `deploy-runbook.md` (deploy steps), `APPROVALS.md` (enabled
external wires).

---

## 1. What this is

A governed "operating system" for the Clark companies (**FS** — Fastening
Specialists, **BL/BLCS** — Big League Construction Supply, **USA** — Utility
Supply Associates, **Cultivus+**). It reads truth from the systems of record,
turns work that needs doing into governed **issues** in a control tower, and —
with a human approving every external action — drafts and tracks that work. The
first labor target is **AR collections**.

**Core principle: nothing external sends without a human "yes."** Every
capability ships OFF and is enabled deliberately. Every action is org-scoped,
idempotent, and lands in an immutable audit trail. Business rules live in policy
_data_, never in prompts; all model/external output is schema-validated before
it is trusted (fail-closed).

## 2. Where it lives

- **Host:** DigitalOcean droplet **`jerry-data`** (which also runs
  `company-brain`). The app lives at **`/opt/operating-layer`**.
- **URL:** **`https://ops.blcsops.com`**, behind **Cloudflare Access** (Zero
  Trust). Login is a work email on the Access allow-list (currently
  `tclark@bigleaguecs.com` and `tim@utilitysupplyassociates.com`). The origin
  publishes **no ports** — it is reachable only through the Cloudflare tunnel,
  which is what makes the header-based identity safe.
- **Repo:** GitHub **`TTJC24/tag`**, working branch
  **`claude/phase-1-implementation-review-ujy1z1`**.
- **Runtime:** Docker Compose (`compose.production.yaml`) — Postgres 16 + API
  (Fastify) + worker + web (Next.js) + `cloudflared`. All secrets live in
  **`/opt/operating-layer/.env.production`** (chmod 600). Never commit it.

## 3. Architecture

TypeScript monorepo (pnpm workspace, turbo). The **spine** is an intake
pipeline: every unit of work is an **issue** → classified → recommended →
(an approval policy decides) auto-approved or human-approved → executed →
**audited**. Postgres enforces the guarantees: row-level security (forced),
a three-role model (owner + two non-privileged runtime roles), guarded
state-machine transitions, an immutable append-only audit chain, idempotency
keys, and a transactional outbox with dead-letter/replay.

**Modules ("doorways")** feed the spine. Each is the same shape:
`source → policy (data) → governed issue → approve → audit`. **Adding a
department = adding a doorway.** They all ship inert behind an env flag.

## 4. What's live vs. built

| Capability                                                 | State                                                                                                                                                                                              |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The system itself (tower, DB, governance)                  | **Live** — deployed, 4 orgs seeded, owner + 2 work-email admins                                                                                                                                    |
| **Sales (Pipedrive)**                                      | **Live** — reads deals from both Pipedrive accounts (read-only), flags deals past expected close, raises governed follow-ups routed per company/owner                                              |
| **Collections (Acumatica)**                                | Connector **built & validated live** against the ERP (read 1,303 open AR docs, aged FS/BLC). Chases now arrive with the email **already drafted**; activation is `docs/collections-mvp-runbook.md` |
| **Customer read (Acumatica)**                              | Built — names + AR contact emails, so a chase names a real company and has a recipient. Probe the live instance first (step 2 of the runbook)                                                      |
| **Daily auto-refresh**                                     | Built, inert — set `COLLECTIONS_SCHEDULE_UTC` / `SALES_SCHEDULE_UTC` and the worker pulls each morning by itself                                                                                   |
| DemandStar bid doorway                                     | Built, inert                                                                                                                                                                                       |
| KPI exception scanner                                      | Built, inert (reads via company-brain)                                                                                                                                                             |
| TractionOS bridge, morning brief                           | Built, inert                                                                                                                                                                                       |
| **Outlook draft connector** (the "draft the email" output) | Built + hardened, inert — awaits a supervised pilot. Note the chase text is already composed and prefilled, so this step is now "put the draft in the mailbox", not "write the draft"              |

## 5. Data sources (wires)

- **Acumatica ERP = source of truth** (sales, AR, financials, orders). Read-only
  API user `agent.scoreboard` at `bigleaguecs.acumatica.com`, tenant
  **Production**, Default endpoint `24.200.001`. **One tenant; FS and BLC are
  branches** (the connector splits by branch: FS→FS, BLC→BLCS). It only reads
  AR today (the `Invoice` entity); the same connection extends to orders and the
  scorecard.
- **Pipedrive CRM = deal-status overlay** (two accounts:
  `bigleagueconstructionsupply` and `utilitysupplyassociates2`). Read-only
  tokens.
- Both are **read-only** — the system never writes back to the ERP or CRM.
  Credentials live in `.env.production`; every wire is logged in `APPROVALS.md`.

## 6. How to operate it

- **The tower:** browse `ops.blcsops.com`, sign in, work the queue
  (approve/deny). Every item shows its provenance and audit history.
- **Refresh a feed (manual today):** on the droplet, from `/opt/operating-layer`,
  run a CLI inside the api container —
  ```
  docker compose -f compose.production.yaml --env-file .env.production \
    exec api node apps/api/dist/<cli>.js
  ```
  - Sales: `pipedrive-sales-fetch-cli.js`
  - Collections (live ERP): `acumatica-collections-fetch-cli.js`
- **Enable a wire:** add its env vars to `.env.production`, then
  `docker compose … up -d --build api`.
- **Add a user:** insert into `users` + `organization_memberships`, and add the
  email to the Cloudflare Access policy (snippet in `deploy-runbook.md`).
- **Upgrades / new migrations:** `git pull`, apply the migration with `psql`,
  rebuild the services (initdb scripts only run on an empty volume — see the
  runbook).

## 7. Governance & safety (do not weaken these)

- Inert by default; each external wire is an explicit env flag.
- A human approves every external send; nothing auto-sends.
- All model/external output is schema-validated before use (fail-closed).
- Immutable audit chain, strict org isolation, idempotent everywhere.
- Runtime DB roles are non-privileged (not owner/superuser/BYPASSRLS) — the
  api/worker refuse to boot otherwise.
- `APPROVALS.md` is the log of every enabled external capability.

## 8. Key files

- `docs/operating-system-blueprint.md` — intent / north star.
- `docs/system-context.md` — entities, systems of record, how the money works,
  the source-of-truth decision (Acumatica).
- `docs/deploy-runbook.md` — deploy and operate.
- `APPROVALS.md` — enabled wires + hardening follow-ups.
- `workflows/issue-intake/src/` — the doorways (`ar-aging`, `ar-collections`,
  `pipedrive-sales`, `acumatica-aging`, `demandstar`, `kpi-exceptions`,
  `traction-bridge`, `brief`) and the spine (`service`, `approval`,
  `execution`, `idempotency`, `policy`).
- `packages/connectors/src/` — read connectors (`acumatica`, `pipedrive`,
  `company-brain`) + the Mail-draft credential envelope crypto.
- `apps/api`, `apps/worker`, `apps/web` — API, background worker, tower UI. The
  operator CLIs live in `apps/api/src/*-cli.ts`.
- `packages/schemas`, `packages/db`, `packages/auth` — shared schema/enums, DB
  pool + safety assertions, identity providers (incl. Cloudflare Access).
- `infrastructure/migrations/` (0001–0011) + `infrastructure/production/init/`
  (9000 runtime roles, 9001 governance core, 9002 owner, 9003 idempotency
  retention, 9004 governed-intake infrastructure).

## 9. How to extend it (the module pattern)

To add a department module, follow `ar-collections.ts` / `pipedrive-sales.ts`:

1. A **doorway** that reads the source deterministically (no model guessing at
   facts) and produces the normalized shape.
2. A **policy** expressed as data (e.g. the collections ladder, the sales
   attention rules) — tunable, never a prompt.
3. A thin **sync** that routes each record through `createManualIssue` (the
   proven governed-intake path), idempotent per a stable key.
4. Unit-test the pure logic; wire it behind an env flag so it ships inert.
5. If it reads an external service, put the client in `packages/connectors`
   (read-only, injectable `fetch` for testing) and log the wire in `APPROVALS.md`.

## 10. Open follow-ups / roadmap

1. **Go live on Collections** — follow `docs/collections-mvp-runbook.md`:
   apply migration 0012, probe the Customer entity, dry-run the pull, verify a
   prefilled chase in the tower, then turn on the schedule. Reconcile the aging
   basis against Acumatica's own report before treating buckets as
   authoritative.
2. **Outlook draft wire** — put an approved chase's (already composed) text into
   the entity AR mailbox as a draft. Separate stop-and-ask activation: one-org
   pilot claim, `mail.compose`-only credential, recipient allowlist.
3. **Harden:** rotate the Acumatica service password (currently weak); populate
   missing AR contact emails in Acumatica (the `unaddressable` count in a run
   tells you how many); provision the AR person as the Collections approver.
4. **Scorecard from Acumatica** — pull revenue, GP%, DSO/DPO/DIO, open orders,
   inventory; feed the money-picture answers and reconcile with TractionOS
   ("Jerry"), replacing today's manual export/keying.
5. **Chat surface** — one conversational endpoint composing company-brain, the
   approvals queue, Acumatica, and the scorecard.
6. **Scale** — onboard the manager/approver layer; move approvals from
   owner-only to entity managers via new approval-policy versions (no code).

## 11. Access Chris will need

- **GitHub:** collaborator on `TTJC24/tag`.
- **Droplet:** DigitalOcean access to `jerry-data` (console or SSH). The app is
  at `/opt/operating-layer`; secrets in `.env.production` (already on the box).
- **Cloudflare:** Zero Trust access on the account that owns `blcsops.com`
  (to manage the `operating-layer` tunnel and the Access application).
- **The systems of record:** knowledge of the read-only Acumatica user and the
  Pipedrive read-only tokens (values are in `.env.production`, not in git).

---

_Status as of 2026-07-27: system deployed and live; Sales feeding real deals;
Acumatica truth-wire built and validated live; Collections one command from
going live on real-time AR._
