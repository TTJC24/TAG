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
