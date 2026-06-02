# Company Brain v3 — `jerry-data` deployment

This directory holds the deployment scaffolding for running Company Brain on
the existing DigitalOcean droplet **`jerry-data`** alongside Jerry and Hermes,
strictly isolated under the `company-brain` namespace.

## Droplet facts

| Field | Value |
| --- | --- |
| Name | `jerry-data` |
| Public IP | `142.93.196.10` |
| Private IP | `10.116.0.4` |
| Region | NYC1 |
| OS | Ubuntu 24.04 LTS x64 |
| Size | 8 GB RAM / 160 GB disk |

## Isolation contract

Every artifact lives under `/opt/company-brain/` on the host or carries the
`company-brain-` prefix in Docker. Nothing here writes to `/opt/jerry`,
`/opt/hermes`, the host's apt-installed Postgres (if any), or any
non-namespaced Docker resource.

| Concept | Name |
| --- | --- |
| Host root | `/opt/company-brain/` |
| Docker Compose project | `company-brain` |
| Docker network | `company-brain-net` (subnet `172.30.0.0/16`) |
| Postgres database | `company_brain` |
| Postgres admin role | `company_brain_admin` |
| Postgres ingest role | `company_brain_ingest` (write — used by connectors) |
| Postgres reader role | `company_brain_reader` (SELECT only — used by `/query`) |
| Container: Postgres | `company-brain-postgres` |
| Container: ingest | `company-brain-ingest` (Bun scheduler) |
| Container: query | `company-brain-query` (read-only SQL endpoint) |
| Container: tunnel | `company-brain-cloudflared` |
| Host directory: logs | `/opt/company-brain/logs/` |
| Host directory: backups | `/opt/company-brain/backups/` |
| Host directory: static output | `/opt/company-brain/dist/` |
| Host directory: PG data | `/opt/company-brain/postgres-data/` (bind mount) |
| Host directory: state cache | `/opt/company-brain/state/` (Acumatica session, etc.) |
| Host directory: tunnel creds | `/opt/company-brain/cloudflared/` (mode 700) |

**No host ports are published.** All external traffic enters via cloudflared.
That means Postgres on `5432` stays available to any other tenant on the
droplet without conflict, and the SQL endpoint on internal `:4317` is only
reachable through Cloudflare Access.

## One-shot setup (run on the droplet)

```bash
ssh root@142.93.196.10

# Pull bootstrap directly (idempotent; safe to re-run)
curl -fsSL https://raw.githubusercontent.com/TTJC24/company-brain/main/infra/bootstrap.sh -o /tmp/cb-bootstrap.sh
chmod +x /tmp/cb-bootstrap.sh
/tmp/cb-bootstrap.sh
```

What it does:
1. Verifies you're root on Ubuntu 24.04
2. Creates `/opt/company-brain/{repo, dist, logs, backups, state,
   postgres-data, cloudflared, infra}` with sane permissions
3. Detects Docker; installs Docker Engine + compose v2 from Docker's
   official apt repo if absent
4. Cross-checks that no existing `company-brain-*` containers collide;
   logs (read-only) which `jerry-*` and `hermes-*` containers are present
5. Clones the repo to `/opt/company-brain/repo` (or pulls if already present)
6. Validates `docker-compose.yml` against the current `.env`
7. Prints the operator's next steps

## Bring-up checklist

After bootstrap finishes:

### 1. Populate `.env`

```bash
cp /opt/company-brain/repo/infra/.env.example /opt/company-brain/infra/.env
# Generate Postgres passwords:
openssl rand -hex 32  # -> POSTGRES_ADMIN_PASSWORD
openssl rand -hex 32  # -> POSTGRES_INGEST_PASSWORD
openssl rand -hex 32  # -> POSTGRES_READER_PASSWORD
# Edit the rest with real connector credentials.
chmod 600 /opt/company-brain/infra/.env
```

### 2. Configure Cloudflare Tunnel

The tunnel config under `/opt/company-brain/cloudflared/` is YOUR responsibility
(per the v3 deployment contract). Workflow:

```bash
# On your local machine:
cloudflared tunnel login
cloudflared tunnel create company-brain         # prints UUID + path to credentials.json
cloudflared tunnel route dns company-brain brain.<your-domain>

# Copy credentials to droplet:
scp ~/.cloudflared/<UUID>.json \
    root@142.93.196.10:/opt/company-brain/cloudflared/credentials.json

# Customize the config template on the droplet:
ssh root@142.93.196.10
cp /opt/company-brain/repo/infra/cloudflared/config.example.yml \
   /opt/company-brain/cloudflared/config.yml
# Edit /opt/company-brain/cloudflared/config.yml: replace <UUID> and <HOSTNAME>
chmod 700 /opt/company-brain/cloudflared
chmod 600 /opt/company-brain/cloudflared/*
```

### 3. Create the Cloudflare Access application

In the Cloudflare Zero Trust dashboard:
- Access → Applications → Add an application → Self-hosted
- Application domain: `brain.<your-domain>`
- Policy: emails ending in your company domain, OR Entra OIDC group
  membership for `admins-and-power-users`

The query service ALSO validates the `CF-Access-Authenticated-User-Email`
header server-side, so a misconfigured Access policy results in a clean
401 from the service rather than an open door.

### 4. Bring up the stack

```bash
cd /opt/company-brain/repo/infra
docker compose --env-file /opt/company-brain/infra/.env up -d
docker compose ps
```

You should see (state = `running` and health = `healthy` for postgres):

```
NAME                       STATUS                    NAMES
company-brain-postgres     Up 30 seconds (healthy)
company-brain-ingest       Up 25 seconds
company-brain-query        Up 25 seconds
company-brain-cloudflared  Up 25 seconds
```

### 5. Verify isolation

These commands should NOT include any `jerry-*` or `hermes-*` items:

```bash
docker ps --filter "name=company-brain-"
docker network ls --filter "name=company-brain"
docker volume ls --filter "name=company-brain"   # (we use bind mounts, so likely empty)
```

These commands should still work and show Jerry/Hermes services intact:

```bash
docker ps --filter "name=jerry-"
docker ps --filter "name=hermes-"
```

## Day-2 operations

### Tail logs

```bash
cd /opt/company-brain/repo/infra
docker compose logs -f company-brain-postgres    # Postgres init script output, slow queries
docker compose logs -f company-brain-ingest      # scheduler + connector runs
docker compose logs -f company-brain-query       # /query traffic
docker compose logs -f company-brain-cloudflared # tunnel up/down events
```

### Manual Postgres backup

```bash
docker exec company-brain-postgres \
  pg_dump -U company_brain_admin -d company_brain --no-owner --clean --if-exists \
  > /opt/company-brain/backups/company_brain-$(date -u +%Y%m%d-%H%M%SZ).sql
```

### Stop only Company Brain services (Jerry / Hermes untouched)

```bash
cd /opt/company-brain/repo/infra
docker compose down                    # stop, keep volumes
docker compose down --remove-orphans   # also clean stale company-brain-* containers
# NEVER use `docker compose down -v` (that would delete the postgres-data bind mount metadata)
# NEVER use `docker stop $(docker ps -q)` (would stop jerry / hermes too)
```

### Update to latest main

```bash
cd /opt/company-brain/repo
git pull --ff-only origin main
cd infra
docker compose build              # rebuild company-brain-bun image
docker compose up -d              # rolling restart only the changed services
docker image prune -f             # reclaim space
```

### Rotate Postgres passwords

```bash
# Generate new
NEW_INGEST=$(openssl rand -hex 32)
NEW_READER=$(openssl rand -hex 32)

# Apply in DB
docker exec -i company-brain-postgres psql -U company_brain_admin -d company_brain <<SQL
ALTER ROLE company_brain_ingest WITH PASSWORD '${NEW_INGEST}';
ALTER ROLE company_brain_reader WITH PASSWORD '${NEW_READER}';
SQL

# Update .env, then restart only the consumers
# Edit /opt/company-brain/infra/.env: POSTGRES_INGEST_PASSWORD, POSTGRES_READER_PASSWORD
cd /opt/company-brain/repo/infra
docker compose up -d --no-deps company-brain-ingest company-brain-query
```

## Phase 2B — page generator

The page generator (`src/page-gen/index.ts`) renders the brain's
`public.pages` rows into a static site under `/opt/company-brain/dist/`.
No server runtime is required to view the output -- open `dist/index.html`
in a browser, or push the folder to Cloudflare Pages.

The generator runs INSIDE the `company-brain-ingest` container so it
shares the same image and the bind mount to `/opt/company-brain/dist/`.
It connects to Postgres as `company_brain_reader` (read-only) via the
existing `QUERY_DATABASE_URL` -- the ingest container inherits that env
var from `.env`.

### Manual page generation

```bash
# On jerry-data, after ingest has populated pages:
docker compose exec company-brain-ingest bun run pagegen

# Output:
# [pagegen] output directory: /app/dist
# [pagegen] loaded 217 pages from public.pages
# [pagegen] classified: customers=42 orders=18 invoices=23 items=11 vendors=0 reps=0 other=123
# [pagegen] wrote styles.css + search.js
# [pagegen] wrote index.html + search.html
# [pagegen] wrote /customer/index.html + 42 detail pages
# ... etc
# [pagegen] done in 184ms -- 94 detail pages + 6 listings + home + search.

# The container's /app/dist is bind-mounted to the host's /opt/company-brain/dist
# so the output is immediately visible on the host:
ls /opt/company-brain/dist
```

### Publishing to Cloudflare Pages (deferred)

Today this is a manual step from your local machine OR the droplet, using
the Wrangler CLI:

```bash
# One-time: install wrangler
npm i -g wrangler
wrangler login

# Each publish:
scp -r root@142.93.196.10:/opt/company-brain/dist ./dist-snapshot
wrangler pages deploy ./dist-snapshot --project-name company-brain
```

Eventually this gets wrapped in a host cron after each ingest cycle. Not
in scope for v1.

### Generated layout

```
dist/
  index.html               home (section counts + recent activity)
  search.html              client-side search shell
  search-index.json        Lunr index covering customer/order/invoice/item/vendor/rep
  styles.css               shared stylesheet (light + dark, mobile-friendly)
  search.js                Lunr-driven search client
  customer/
    index.html             listing of all customer records
    <id>.html              one page per customer with key fields + related orders/invoices + source markdown body
  order/
    index.html
    <id>.html
  invoice/                 (same pattern)
  item/                    (same pattern)
  vendor/                  index.html only (empty-state placeholder; no vendor connector yet)
  rep/                     index.html only (empty-state placeholder; no rep connector yet)
```

Every detail page surfaces:
- Entity name, ID, type
- Source system + system of record
- Last refreshed (UTC) + upstream updated (UTC, when known)
- Freshness badge (`fresh` / `recent` / `stale` / `unknown`)
- Structured fields extracted from the markdown body bullets
- Related records (customer pages link to that customer's orders + invoices)
- The full source markdown body as ingested

The page generator runs against an empty `public.pages` cleanly -- it
emits a "brain is empty, run ingest" home page rather than failing.

## Failure modes and recovery

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `company-brain-postgres` healthcheck failing | Old `postgres-data/` from a previous experiment | `docker compose down && rm -rf /opt/company-brain/postgres-data/* && docker compose up -d` (only on a fresh setup; this deletes data!) |
| `company-brain-ingest` keeps restarting | Missing or wrong connector env vars | `docker compose logs company-brain-ingest` → fix `.env` → `docker compose up -d` |
| `/query` returns 502 from Cloudflare | Tunnel not connected | `docker compose logs company-brain-cloudflared` |
| `/query` returns 401 even with valid session | Access policy not configured or wrong domain in Access app | Verify in Cloudflare Zero Trust dashboard |
| Disk fills up | `/opt/company-brain/logs/` or `/opt/company-brain/dist/` growing | Add `logrotate` or a `tmpfiles.d` entry; rotate dist on each publish |

## Out of scope for this directory

These belong elsewhere and are intentionally NOT scaffolded here:

- `src/page-gen/` — the page renderer itself (Week 2B)
- `src/query/server.ts` — the SQL service implementation (Week 3)
- `wrangler.toml` — Cloudflare Pages deploy config (separate `web-dist/`
  repo or Pages project)
- Host firewall hardening — assumed already handled per the droplet's
  existing posture for Jerry / Hermes
