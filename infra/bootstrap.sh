#!/usr/bin/env bash
#
# Company Brain v3 — one-shot bootstrap for the jerry-data droplet.
#
# Run this ONCE on a fresh droplet. Idempotent: re-running is safe and just
# reports what's already in place.
#
# WHAT IT DOES
#   1. Verifies host: Ubuntu 24.04, expected paths, no name collisions with
#      Jerry / Hermes services.
#   2. Creates /opt/company-brain/{repo, dist, logs, backups, state,
#      postgres-data, cloudflared} with the right ownership.
#   3. Detects Docker. If absent, installs from Docker's official apt repo
#      (idempotent; no-op if already present).
#   4. Verifies docker compose v2 is available.
#   5. Reports next steps for the operator (clone repo, populate .env,
#      configure cloudflared, docker compose up).
#
# WHAT IT DOES NOT DO
#   - Touch any /opt/jerry or /opt/hermes path
#   - Stop / restart anything that isn't tagged company-brain
#   - Modify firewall rules, ufw, fail2ban
#   - Install Postgres on the host (we run it in Docker)
#   - Configure cloudflared (you do that per infra/cloudflared/config.example.yml)
#
# USAGE
#   ssh root@142.93.196.10
#   curl -fsSL https://raw.githubusercontent.com/TTJC24/company-brain/main/infra/bootstrap.sh -o /tmp/cb-bootstrap.sh
#   chmod +x /tmp/cb-bootstrap.sh
#   /tmp/cb-bootstrap.sh
#
# Or after the repo is cloned:
#   sudo /opt/company-brain/repo/infra/bootstrap.sh

set -euo pipefail

CB_ROOT="/opt/company-brain"
CB_USER="${SUDO_USER:-${USER:-root}}"
CB_REPO_URL="${CB_REPO_URL:-https://github.com/TTJC24/company-brain.git}"

# -----------------------------------------------------------------------------
# 0. Pretty logging
# -----------------------------------------------------------------------------
log()  { printf "\033[1;34m[bootstrap]\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m[bootstrap]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[bootstrap]\033[0m %s\n" "$*" >&2; }
die()  { printf "\033[1;31m[bootstrap]\033[0m %s\n" "$*" >&2; exit 1; }

# -----------------------------------------------------------------------------
# 1. Sanity checks
# -----------------------------------------------------------------------------
log "Verifying host..."

if [[ "$(id -u)" -ne 0 ]]; then
  die "Run as root (sudo). Need to create /opt/company-brain and possibly install Docker."
fi

if ! command -v lsb_release >/dev/null 2>&1; then
  warn "lsb_release not found; skipping OS check."
else
  OS_ID="$(lsb_release -is 2>/dev/null || echo unknown)"
  OS_VER="$(lsb_release -rs 2>/dev/null || echo unknown)"
  log "OS: ${OS_ID} ${OS_VER}"
  if [[ "${OS_ID}" != "Ubuntu" ]]; then
    warn "Expected Ubuntu, found ${OS_ID}. Continuing but the apt steps may not apply."
  fi
fi

# Refuse to run if /opt/jerry or /opt/hermes belong to us. They do not.
for sibling in /opt/jerry /opt/hermes; do
  if [[ -d "${sibling}" ]]; then
    log "Detected sibling: ${sibling} (will NOT be touched)"
  fi
done

# -----------------------------------------------------------------------------
# 2. Filesystem layout under /opt/company-brain
# -----------------------------------------------------------------------------
log "Ensuring directory layout under ${CB_ROOT}..."
mkdir -p \
  "${CB_ROOT}" \
  "${CB_ROOT}/repo" \
  "${CB_ROOT}/dist" \
  "${CB_ROOT}/logs" \
  "${CB_ROOT}/backups" \
  "${CB_ROOT}/state" \
  "${CB_ROOT}/postgres-data" \
  "${CB_ROOT}/cloudflared" \
  "${CB_ROOT}/infra"

# Lock down credentials directory
chmod 700 "${CB_ROOT}/cloudflared"
ok "Filesystem layout in place."

# -----------------------------------------------------------------------------
# 3. Docker detection / install
# -----------------------------------------------------------------------------
DOCKER_PRESENT=0
if command -v docker >/dev/null 2>&1; then
  DOCKER_PRESENT=1
  DOCKER_VER="$(docker --version 2>/dev/null || true)"
  log "Docker detected: ${DOCKER_VER}"
fi

COMPOSE_PRESENT=0
if docker compose version >/dev/null 2>&1; then
  COMPOSE_PRESENT=1
  COMPOSE_VER="$(docker compose version --short 2>/dev/null || true)"
  log "docker compose v2 detected: ${COMPOSE_VER}"
fi

if [[ "${DOCKER_PRESENT}" -eq 0 || "${COMPOSE_PRESENT}" -eq 0 ]]; then
  log "Installing Docker Engine + compose from Docker's official apt repo..."

  # Idempotent: apt-get install is a no-op for already-installed packages.
  apt-get update -y >/dev/null
  apt-get install -y ca-certificates curl gnupg lsb-release >/dev/null

  install -m 0755 -d /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
  fi

  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${VERSION_CODENAME}") stable" \
    > /etc/apt/sources.list.d/docker.list

  apt-get update -y >/dev/null
  apt-get install -y \
    docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin >/dev/null

  systemctl enable --now docker >/dev/null 2>&1 || true
  ok "Docker installed."
else
  ok "Docker + compose already present; skipping install."
fi

# -----------------------------------------------------------------------------
# 4. Check for project-name collisions with existing containers
# -----------------------------------------------------------------------------
log "Checking for existing company-brain-* containers (would be from a prior bootstrap)..."
EXISTING=$(docker ps -a --filter "name=company-brain-" --format '{{.Names}}' || true)
if [[ -n "${EXISTING}" ]]; then
  warn "Existing company-brain containers found:"
  echo "${EXISTING}" | sed 's/^/    /'
  warn "If this is intentional (re-bootstrap), continue. If unexpected, stop NOW."
else
  ok "No prior company-brain containers."
fi

# Verify NO jerry-* or hermes-* containers would collide with our network
log "Cross-checking against jerry-* and hermes-* containers (read-only)..."
JERRY=$(docker ps -a --filter "name=jerry-" --format '{{.Names}}' | head -3 || true)
HERMES=$(docker ps -a --filter "name=hermes-" --format '{{.Names}}' | head -3 || true)
if [[ -n "${JERRY}" ]]; then
  log "Jerry containers present (will NOT be touched): $(echo "${JERRY}" | tr '\n' ' ')"
fi
if [[ -n "${HERMES}" ]]; then
  log "Hermes containers present (will NOT be touched): $(echo "${HERMES}" | tr '\n' ' ')"
fi

# -----------------------------------------------------------------------------
# 5. Repo clone (idempotent)
# -----------------------------------------------------------------------------
if [[ -d "${CB_ROOT}/repo/.git" ]]; then
  log "Repo already cloned at ${CB_ROOT}/repo; pulling latest main..."
  git -C "${CB_ROOT}/repo" fetch origin
  git -C "${CB_ROOT}/repo" checkout main
  git -C "${CB_ROOT}/repo" pull --ff-only origin main
else
  log "Cloning ${CB_REPO_URL} to ${CB_ROOT}/repo..."
  git clone "${CB_REPO_URL}" "${CB_ROOT}/repo"
fi
ok "Repo synced."

# -----------------------------------------------------------------------------
# 6. Compose pre-flight (no `up` yet)
# -----------------------------------------------------------------------------
log "Validating docker-compose.yml..."
if [[ -f "${CB_ROOT}/infra/.env" ]]; then
  ENV_OK=1
  log ".env already present at ${CB_ROOT}/infra/.env"
else
  ENV_OK=0
  warn ".env not yet at ${CB_ROOT}/infra/.env — copy from ${CB_ROOT}/repo/infra/.env.example and fill in real values before running compose."
fi

(
  cd "${CB_ROOT}/repo/infra"
  docker compose --project-directory "${CB_ROOT}/repo/infra" config --quiet \
    || warn "docker compose config reported issues (likely missing env vars). Populate ${CB_ROOT}/infra/.env and re-run."
)

# -----------------------------------------------------------------------------
# 7. Next steps
# -----------------------------------------------------------------------------
cat <<EOF

================================================================================
  Bootstrap complete.
================================================================================

Layout:
  ${CB_ROOT}/
    repo/             (cloned git repo; pull here for updates)
    infra/.env        (copy from repo/infra/.env.example and fill in)
    postgres-data/    (Postgres bind mount; persists across compose down)
    dist/             (page generator output, Week 2B)
    logs/             (application logs)
    backups/          (manual pg_dump target)
    state/            (Acumatica session cache, etc.)
    cloudflared/      (tunnel config + credentials.json -- 700)

Next steps:
  1) cp ${CB_ROOT}/repo/infra/.env.example ${CB_ROOT}/infra/.env
     # Fill in real values. Generate Postgres passwords with:
     #   openssl rand -hex 32

  2) Create the Cloudflare tunnel + Access policy per
     ${CB_ROOT}/repo/infra/cloudflared/config.example.yml header comments.
     Then place the tunnel UUID + credentials at:
       ${CB_ROOT}/cloudflared/config.yml
       ${CB_ROOT}/cloudflared/credentials.json
     (chmod 600 ${CB_ROOT}/cloudflared/credentials.json)

  3) Bring up the stack:
       cd ${CB_ROOT}/repo/infra
       docker compose --env-file ${CB_ROOT}/infra/.env up -d
       docker compose ps

  4) Tail logs to confirm health:
       docker compose logs -f company-brain-postgres
       docker compose logs -f company-brain-ingest

  5) Verify isolation (none of these should show jerry-* or hermes-*):
       docker ps --filter "name=company-brain-"
       docker network ls | grep company-brain

EOF

if [[ "${ENV_OK}" -eq 0 ]]; then
  warn "Reminder: ${CB_ROOT}/infra/.env not yet populated. Step 1 above."
fi
