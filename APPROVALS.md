# Approvals Log

Per the WorkOS contract, enabling any external capability (new service, new
credential, scheduled task, public exposure) is a stop-and-ask item recorded
here. Each entry: what was enabled, why, the posture (read-only vs. write), and
who approved.

## 2026-07-27 — Cloudflare Access + tunnel (production exposure)

- **What:** the operating layer exposed at `ops.blcsops.com` via a Cloudflare
  tunnel, behind a Cloudflare Access self-hosted application.
- **Posture:** origin publishes no ports (tunnel-only); Access enforces login
  and injects the identity header the app trusts.
- **Approved by:** owner (Tim Clark), during setup.

## 2026-07-27 — Pipedrive read wire (Sales doorway)

- **What:** the Sales doorway reads open deals from two Pipedrive accounts —
  `bigleagueconstructionsupply` (FS Sales -> FS, USA Sales -> USA) and
  `utilitysupplyassociates2` (BL Pipeline -> BLCS, USA Pipeline -> USA).
- **Posture:** **read-only.** `PipedriveClient` issues GET requests only and
  never writes back to Pipedrive; Pipedrive stays canonical for deal state. Two
  personal API tokens live in `.env.production` (chmod 600) on the droplet.
- **Why:** raise governed follow-ups for deals that are past expected close,
  gone quiet, or missing a next step — approved in the tower, nothing sends.
- **Approved by:** owner (Tim Clark), who provided the tokens.
- **Follow-up:** the tokens inherit the owner's permissions; a dedicated
  read-only Pipedrive user per account is the hardening step if/when desired.

## 2026-07-27 — Acumatica read wire (Collections / ERP source of truth)

- **What:** read-only connection to Acumatica (`bigleaguecs.acumatica.com`,
  tenant `Production`, Default endpoint 24.200.001) via a dedicated API user
  (`agent.scoreboard`), reading open AR (the `Invoice` entity) to feed
  Collections. Branches route FS -> FS, BLC -> BLCS.
- **Posture:** **read-only.** `AcumaticaClient` performs its own auth
  login/logout and GETs only — it never writes ERP data. Credential lives in
  `.env.production` (chmod 600).
- **Validated live (2026-07-27):** login OK (204), read 1,303 open AR docs,
  split cleanly into FS / BLC, aged — FS past-due ~$139K, BLC ~$202K.
  **Superseded figure:** that read filtered to `Balance gt 0M`, so it excluded
  credit memos and unapplied payments and is therefore **gross of credits**.
  The connector now reads all open AR documents and nets them per customer, so
  the true net past-due is lower by whatever credits are outstanding. Re-measure
  on the next live run before quoting a number.
- **Approved by:** owner (Tim Clark), who provided the read-only user.
- **Follow-ups (hardening, not blockers):** (1) the service password is weak —
  rotate `agent.scoreboard` to a strong secret. (2) the connector ages by
  document due date; reconcile against Acumatica's aging-report basis before
  treating buckets as authoritative — a wrong bucket picks a wrong tone, not
  just a wrong number. (3) _(done)_ customer names and AR contact emails now
  come from the Customer entity; probe the live instance per the MVP runbook.

## 2026-07-27 — Acumatica Customer read (chase addressing)

- **What:** the same read-only Acumatica connection additionally reads the
  `Customer` entity (`CustomerID`, `CustomerName`, `Status`,
  `MainContact/Email`) so a chase names a real company and carries an AR
  contact address instead of a raw customer code.
- **Posture:** **read-only**, same session and credential as the AR read; GETs
  only. Customer emails are stored in `collections_chase_proposals.recipient`
  (org-scoped, RLS-forced) and shown to holders of `tasks.read`.
- **Why:** without a name and address, every chase had to be looked up and
  addressed by hand, which is what made the doorway impractical to work daily.
- **Approved by:** owner (Tim Clark) — same read-only user already approved
  above; this widens what is read, not what is written.
- **Note:** a customer with no usable email on file is still chased; the draft
  is composed and the recipient left blank with a stated reason. No address is
  ever guessed.
