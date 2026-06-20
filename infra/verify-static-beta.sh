#!/bin/sh
set -eu

APP_ROOT="${APP_ROOT:-/opt/company-brain}"
REPO_DIR="$APP_ROOT/repo"
INFRA_DIR="$REPO_DIR/infra"
ENV_FILE="$APP_ROOT/infra/.env"
HOSTNAME="${COMPANY_BRAIN_HOSTNAME:-brain.blcsops.com}"
AUTH_CHECK_EMAIL="${AUTH_CHECK_EMAIL:-verify-static-beta@company-brain.local}"
ACCESS_REQUIRED_MARKER="${ACCESS_REQUIRED_MARKER:-Company Brain Access Required}"

log() {
  printf '[verify-static-beta] %s\n' "$*"
}

fail() {
  printf '[verify-static-beta] ERROR: %s\n' "$*" >&2
  exit 1
}

assert_access_required_body() {
  body_file="$1"
  context="$2"

  if ! grep -q "$ACCESS_REQUIRED_MARKER" "$body_file"; then
    fail "$context did not render the branded access-required page"
  fi
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
origin_status="$(docker run --rm --network company-brain-net curlimages/curl:8.10.1 -sS -o /dev/null -w '%{http_code}' --max-time 10 http://company-brain-static:8080/)"
if [ "$origin_status" = "200" ]; then
  fail "origin served / without Cloudflare Access header"
fi
origin_body="$(docker run --rm --network company-brain-net curlimages/curl:8.10.1 -sS --max-time 10 http://company-brain-static:8080/)"
printf '%s' "$origin_body" | grep -q "$ACCESS_REQUIRED_MARKER" ||
  fail "origin / without Cloudflare Access header did not render the branded access-required page"

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
  if [ "$path" = "/" ]; then
    assert_access_required_body /tmp/company-brain-public-check-body "public https://$HOSTNAME/"
  fi
  log "public https://$HOSTNAME$path returned HTTP $status"
done

log "checking public hostname rejects forged Cloudflare Access header"
for path in / /search.html /search-index.json; do
  status="$(curl -sS -o /tmp/company-brain-public-check-body -w '%{http_code}' --max-time 20 \
    -H 'Cf-Access-Authenticated-User-Email: forged@example.com' \
    "https://$HOSTNAME$path")"
  if [ "$status" = "200" ]; then
    fail "public https://$HOSTNAME$path returned 200 with a forged Access email header"
  fi
  if [ "$path" = "/" ]; then
    assert_access_required_body /tmp/company-brain-public-check-body "public forged-header https://$HOSTNAME/"
  fi
  log "public forged-header https://$HOSTNAME$path returned HTTP $status"
done

log "PASS"