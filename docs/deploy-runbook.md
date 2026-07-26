# Deploy Runbook — Operating Layer on the Droplet

Goal: the control tower (web + API + worker + Postgres) running on the same
droplet as company-brain, behind Cloudflare Access, for the owner + managers.
Everything risky stays off; enabling each wire is a separate, logged decision
per the WorkOS contract.

## 0. Prerequisites

- Droplet with Docker + docker compose (the company-brain host qualifies).
- Cloudflare Zero Trust account already used for company-brain.
- The repo cloned on the droplet (read-only deploy key is fine).

## 1. Cloudflare: tunnel + Access app (one time)

1. Zero Trust → Networks → Tunnels → create tunnel `operating-layer`; copy
   the tunnel token.
2. Public hostnames on that tunnel:
   - `ops.<your-domain>` → `http://web:3000`
   - `ops-api.<your-domain>` → `http://api:3001` (optional; only if CLIs
     should reach the API remotely)
3. Zero Trust → Access → Applications: protect both hostnames; policy =
   allow the owner + manager emails. Access injects
   `Cf-Access-Authenticated-User-Email` after login — that header IS the
   login for the app, which is safe ONLY because the origin publishes no
   ports and is reachable exclusively through this tunnel. Do not add port
   mappings to the compose file.

## 2. Secrets

On the droplet, in the repo directory:

```bash
cp .env.production.example .env.production && chmod 600 .env.production
# strong random passwords:
openssl rand -base64 24   # POSTGRES_PASSWORD
openssl rand -base64 24   # RUNTIME_DB_PASSWORD
openssl rand -base64 24   # WORKER_DB_PASSWORD
# connector envelope keys:
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out /tmp/priv.pem
openssl rsa -in /tmp/priv.pem -pubout -outform DER | base64 -w0   # PUBLIC key value
openssl pkcs8 -topk8 -nocrypt -in /tmp/priv.pem -outform DER | base64 -w0  # PRIVATE key value
shred -u /tmp/priv.pem
```

Fill OWNER_EMAIL (the email Cloudflare Access authenticates), OWNER_NAME,
TUNNEL_TOKEN. Every value is mandatory; first boot fails loudly on gaps.

## 3. First boot

```bash
docker compose -f compose.production.yaml --env-file .env.production up -d --build
docker compose -f compose.production.yaml logs -f api worker
```

First Postgres boot applies migrations 0001–0010, then the production init
scripts: runtime-role passwords, governance core (organizations, permission
sets, grants — NO test users), and the owner as admin of every organization.
The api/worker boot assertions verify they are NOT running as superuser,
BYPASSRLS, or table owner — if they refuse to start, the role wiring is
wrong; fix it rather than working around it.

## 4. Smoke check

1. Browse `https://ops.<your-domain>` → Cloudflare Access login → the tower.
2. Create a test issue; watch it classify, recommend, and reach the queue.
3. Approve it; confirm task detail shows the audit history.
4. `docker compose -f compose.production.yaml exec postgres psql -U $POSTGRES_USER -d $POSTGRES_DB -c "select count(*) from operating_layer.audit_events;"`

## 5. Add a manager

```sql
-- docker compose -f compose.production.yaml exec postgres \
--   psql -U <admin> -d operating_layer
SET search_path TO operating_layer, public;
INSERT INTO users (id, oidc_issuer, oidc_subject, name, email, status)
VALUES (gen_random_uuid(), 'cloudflare-access', lower('manager@company.com'),
        'Manager Name', lower('manager@company.com'), 'active');
INSERT INTO organization_memberships (organization_id, user_id, permission_set_id, status)
SELECT o.id, u.id, '30000000-0000-4000-8000-000000000002', 'active'  -- executive set
FROM organizations o, users u
WHERE o.code = 'BLCS' AND lower(u.email) = lower('manager@company.com');
```

Also add their email to the Cloudflare Access policy. Permission sets:
...0001 admin, ...0002 executive, ...0003 operator (see
infrastructure/production/init/9001_governance_core.sql).

## 6. Upgrades (migrations after first boot)

Initdb scripts run only on an empty volume. For a new migration NNNN:

```bash
git pull
docker compose -f compose.production.yaml exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U $POSTGRES_USER -d $POSTGRES_DB \
  < infrastructure/migrations/NNNN_name.sql
docker compose -f compose.production.yaml up -d --build api worker web
```

## 7. Enabling the wires (each one a logged decision)

All OFF by default. Per the WorkOS contract, enabling each is a stop-and-ask
item logged in APPROVALS.md. In recommended order:

1. Brain grounding: MODEL_PROVIDER=company_brain + COMPANY_BRAIN_URL
   (brain runs on the same droplet network; use its internal address).
2. Morning brief: cron on the vault machine or droplet running
   `pnpm brief:generate --out .../shared/ai-handoffs/reports/operating-layer-brief.md`.
3. Traction bridge: read-only Postgres role on Traction's DB + the four
   TRACTION_BRIDGE_* variables; run `pnpm traction-bridge:sync`.
4. DemandStar doorway: export messages JSON; `pnpm demandstar:sync`.
5. KPI exceptions: certify a definition per the scoreboard ledger first.
6. Gmail draft live pilot: docs/runbook.md supervised procedure.

## 8. Backups

```bash
docker compose -f compose.production.yaml exec -T postgres \
  pg_dump -U $POSTGRES_USER -Fc $POSTGRES_DB > backups/operating-layer-$(date +%F).dump
```

Nightly cron + copy off the droplet. The audit chain makes tampering
detectable, not data loss survivable — backups do that.

## Hardening follow-ups (tracked, not blockers)

- Verify the Cf-Access-Jwt-Assertion signature in
  CloudflareAccessIdentityProvider instead of trusting the header alone.
- Move connector envelope keys from .env.production into a secret manager.
- Web image on Next standalone output to shrink the container.
