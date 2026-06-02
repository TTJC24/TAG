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

## Phase 2B+ (page generator) addition

When the page generator lands (Week 2B of v3), it will run inside the
existing `company-brain-ingest` container at the end of each scheduler tick,
writing HTML to `/opt/company-brain/dist/`. Publishing to Cloudflare Pages
will be a separate `wrangler pages deploy` step driven by either:
- a host-side cron that runs `wrangler` on the host (not in compose), or
- an additional one-shot compose service that runs after the page
  generator completes.

The choice is deferred until the page generator is in place.

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
