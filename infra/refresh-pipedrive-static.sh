#!/bin/sh
set -eu

APP_ROOT="/opt/company-brain"
REPO_DIR="$APP_ROOT/repo"
INFRA_DIR="$REPO_DIR/infra"
ENV_FILE="$APP_ROOT/infra/.env"
LOG_DIR="$APP_ROOT/logs"
STATE_DIR="$APP_ROOT/state"
DIST_DIR="$APP_ROOT/dist"
BACKUP_DIR="$APP_ROOT/dist-refresh-backup"
LOCK_DIR="$STATE_DIR/pipedrive-refresh.lock"

mkdir -p "$LOG_DIR" "$STATE_DIR"
LOG_FILE="$LOG_DIR/pipedrive-refresh-$(date -u +%Y%m%d).log"
exec >>"$LOG_FILE" 2>&1

stamp() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

log() {
  echo "[$(stamp)] $*"
}

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log "another refresh is already running; exiting"
  exit 0
fi

cleanup() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

cd "$INFRA_DIR"

log "starting Pipedrive refresh"
log "ingest pipedrive-fs"
docker compose --env-file "$ENV_FILE" run --rm company-brain-ingest bun run ingest pipedrive-fs --no-embed

log "ingest pipedrive-blcs-usa"
docker compose --env-file "$ENV_FILE" run --rm company-brain-ingest bun run ingest pipedrive-blcs-usa --no-embed

log "creating dist backup before pagegen"
rm -rf "$BACKUP_DIR"
mkdir -p "$BACKUP_DIR"
if [ -d "$DIST_DIR" ]; then
  cp -a "$DIST_DIR/." "$BACKUP_DIR/"
fi

restore_backup() {
  log "pagegen failed; restoring previous dist snapshot"
  mkdir -p "$DIST_DIR"
  find "$DIST_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  cp -a "$BACKUP_DIR/." "$DIST_DIR/" 2>/dev/null || true
}

log "running pagegen"
if ! docker compose --env-file "$ENV_FILE" run --rm company-brain-ingest bun run pagegen; then
  restore_backup
  exit 1
fi

log "checking static output contract"
if ! docker compose --env-file "$ENV_FILE" run --rm company-brain-ingest \
  bun run static:check --dist=/app/dist --min-search-entries=1 --expect-build-commit; then
  restore_backup
  exit 1
fi

rm -rf "$BACKUP_DIR"

log "verifying static output"
test -f "$DIST_DIR/index.html"
test -f "$DIST_DIR/search.html"
test -f "$DIST_DIR/search-index.json"
test -d "$DIST_DIR/customer"
test -d "$DIST_DIR/contact"
test -d "$DIST_DIR/deal"
test -d "$DIST_DIR/activity"

if docker compose --env-file "$ENV_FILE" ps company-brain-static >/dev/null 2>&1; then
  docker exec company-brain-static wget -qO- --tries=1 --timeout=5 http://127.0.0.1:8080/healthz >/dev/null
  docker exec company-brain-static wget -qO- --tries=1 --timeout=5 \
    --header='Cf-Access-Authenticated-User-Email: refresh-check@company-brain.local' \
    http://127.0.0.1:8080/ >/dev/null
  docker exec company-brain-static wget -qO- --tries=1 --timeout=5 \
    --header='Cf-Access-Authenticated-User-Email: refresh-check@company-brain.local' \
    http://127.0.0.1:8080/search-index.json >/dev/null
fi

log "refresh complete"
