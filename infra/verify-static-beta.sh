#!/bin/sh
set -eu

APP_ROOT="${APP_ROOT:-/opt/company-brain}"
REPO_DIR="$APP_ROOT/repo"
INFRA_DIR="$REPO_DIR/infra"
ENV_FILE="$APP_ROOT/infra/.env"
HOSTNAME="${COMPANY_BRAIN_HOSTNAME:-brain.blcsops.com}"
AUTH_CHECK_EMAIL="${AUTH_CHECK_EMAIL:-verify-static-beta@company-brain.local}"

log() {
  printf '[verify-static-beta] %s\n' "$*"
}

fail() {
  printf '[verify-static-beta] ERROR: %s\n' "$*" >&2
  exit 1
}

cd "$INFRA_DIR"

log "checking compose services"
docker compose --env-file "$ENV_FILE" ps company-brain-postgres company-brain-static company-brain-cloudflared

log "checking generated static contract"
docker compose --env-file "$ENV_FILE" run --rm company-brain-ingest \
  bun run static:check --dist=/app/dist --min-search-entries=1 --expect-build-commit

log "checking static container health endpoint"
docker exec company-brain-static wget -qO- --tries=1 --timeout=5 \
  http://127.0.0.1:8080/healthz >/dev/null

log "checking origin denies unauthenticated static content"
if docker exec company-brain-static wget -qO- --tries=1 --timeout=5 \
  http://127.0.0.1:8080/ >/dev/null 2>&1; then
  fail "origin served / without Cloudflare Access header"
fi

log "checking origin serves content with Cloudflare Access header"
docker exec company-brain-static wget -qO- --tries=1 --timeout=5 \
  --header="Cf-Access-Authenticated-User-Email: $AUTH_CHECK_EMAIL" \
  http://127.0.0.1:8080/ >/dev/null
docker exec company-brain-static wget -qO- --tries=1 --timeout=5 \
  --header="Cf-Access-Authenticated-User-Email: $AUTH_CHECK_EMAIL" \
  http://127.0.0.1:8080/search-index.json >/dev/null

log "checking public hostname does not serve unauthenticated content"
for path in / /search.html /search-index.json; do
  status="$(curl -sS -o /tmp/company-brain-public-check-body -w '%{http_code}' --max-time 20 "https://$HOSTNAME$path")"
  if [ "$status" = "200" ]; then
    fail "public https://$HOSTNAME$path returned 200 without Access authentication"
  fi
  log "public https://$HOSTNAME$path returned HTTP $status"
done

log "PASS"
