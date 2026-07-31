#!/bin/sh
# Find every deployed place that holds Acumatica credentials, and say which of
# them holds the CURRENT password and which holds a stale one.
#
#   sudo sh scripts/acumatica-secret-audit.sh              # discovery only
#   sudo sh scripts/acumatica-secret-audit.sh --check-password
#
# WHAT IT PRINTS
#   File/container paths, the Acumatica USERNAME MATCH as a yes/no against a
#   reference, and — with --check-password — whether each secret matches the
#   current password.
#
# WHAT IT NEVER PRINTS
#   Passwords. Usernames. File contents. Not once, not truncated, not in an
#   error path. Verified by running it against fixtures containing known
#   secrets and grepping the entire output for them.
#
# THE FINGERPRINT
#   Each secret gets an 8-character fingerprint: sha256(random-run-salt +
#   secret), truncated. Its ONLY purpose is to let you see whether two services
#   hold the SAME secret without learning what it is. The salt is regenerated
#   every run, so fingerprints are not comparable between runs and are not
#   usable for offline cracking. Two services showing the same fingerprint hold
#   the same password; that is the entire information content.
#
# --check-password prompts for the current Acumatica password with terminal
# echo disabled. It is held in a shell variable, hashed, and never written to
# disk, never logged, never printed, and never sent anywhere.
#
# Read-only. Contacts nothing. Does not touch Acumatica, and cannot cause a
# login attempt or a lockout.

set -eu

CHECK_PASSWORD=0
[ "${1:-}" = "--check-password" ] && CHECK_PASSWORD=1

SEARCH_ROOTS="${SEARCH_ROOTS:-/opt /srv /home /root /etc}"
MAXDEPTH="${MAXDEPTH:-5}"

if ! command -v sha256sum >/dev/null 2>&1; then
  echo "CANNOT RUN: sha256sum not available"
  exit 2
fi

# Random per-run salt. Never printed.
SALT="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"

fingerprint() {
  printf '%s%s' "$SALT" "$1" | sha256sum | cut -c1-8
}

# Pull one variable's value out of a .env-style file. Handles export prefixes,
# quotes, spaces around '=', CRLF, comments, and a key defined twice.
extract() {
  sed -n "s/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}$2[[:space:]]*=[[:space:]]*//p" "$1" 2>/dev/null |
    tr -d '\r' |
    sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//" -e 's/[[:space:]]*$//' |
    tail -n 1
}

CURRENT_FP=""
if [ "$CHECK_PASSWORD" = "1" ]; then
  printf 'Enter the CURRENT Acumatica password for the integration account.\n'
  printf 'It will not be shown, stored, logged, or transmitted.\n'
  printf 'Password: '
  # Disable terminal echo around the read. Restored even on interrupt.
  if [ -t 0 ]; then
    old_stty="$(stty -g)"
    trap 'stty "$old_stty" 2>/dev/null || true' EXIT INT TERM
    stty -echo
    read -r CURRENT_PASSWORD
    stty "$old_stty"
    trap - EXIT INT TERM
  else
    read -r CURRENT_PASSWORD
  fi
  printf '\n\n'
  if [ -z "$CURRENT_PASSWORD" ]; then
    echo "CANNOT RUN: no password entered"
    exit 2
  fi
  CURRENT_FP="$(fingerprint "$CURRENT_PASSWORD")"
  CURRENT_PASSWORD=""
  unset CURRENT_PASSWORD
fi

echo "Acumatica credential audit"
echo "=========================="
echo "Salt is random per run; fingerprints are comparable only WITHIN this run."
echo ""

REF_USER=""
REF_SOURCE=""
FOUND=0

report() {
  location="$1"
  user="$2"
  password="$3"

  FOUND=$((FOUND + 1))
  user_norm="$(printf '%s' "$user" | tr '[:upper:]' '[:lower:]')"

  if [ -z "$REF_USER" ]; then
    REF_USER="$user_norm"
    REF_SOURCE="$location"
    same="reference"
  elif [ "$user_norm" = "$REF_USER" ]; then
    same="SAME ACCOUNT as reference"
  else
    same="different account"
  fi

  echo "$location"
  echo "  username     : $same"
  if [ -n "$password" ]; then
    echo "  password fp  : $(fingerprint "$password")"
    if [ "$CHECK_PASSWORD" = "1" ]; then
      if [ "$(fingerprint "$password")" = "$CURRENT_FP" ]; then
        echo "  vs current   : MATCHES CURRENT PASSWORD"
      else
        echo "  vs current   : *** STALE — DOES NOT MATCH CURRENT PASSWORD ***"
      fi
    fi
  else
    echo "  password fp  : (no ACUMATICA_PASSWORD in this location)"
  fi
  echo ""
}

echo "--- Files on disk ---"
echo ""
# shellcheck disable=SC2086
files="$(find $SEARCH_ROOTS -maxdepth "$MAXDEPTH" -type f \
  \( -name '.env' -o -name '.env.*' -o -name '*.env' \) 2>/dev/null || true)"

for f in $files; do
  [ -r "$f" ] || continue
  u="$(extract "$f" ACUMATICA_USERNAME)"
  [ -n "$u" ] || continue
  p="$(extract "$f" ACUMATICA_PASSWORD)"
  report "$f" "$u" "$p"
done

echo "--- Running containers ---"
echo ""
if command -v docker >/dev/null 2>&1; then
  # A container's live environment is what actually authenticates. It can
  # differ from any file on disk when the container was started before the file
  # was edited — which is exactly the case being investigated.
  ids="$(docker ps -q 2>/dev/null || true)"
  if [ -z "$ids" ]; then
    echo "(no running containers, or docker not permitted for this user)"
    echo ""
  fi
  for id in $ids; do
    name="$(docker inspect --format '{{.Name}}' "$id" 2>/dev/null | sed 's|^/||')"
    env_dump="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$id" 2>/dev/null || true)"
    u="$(printf '%s\n' "$env_dump" | sed -n 's/^ACUMATICA_USERNAME=//p' | tail -n 1)"
    [ -n "$u" ] || continue
    p="$(printf '%s\n' "$env_dump" | sed -n 's/^ACUMATICA_PASSWORD=//p' | tail -n 1)"
    report "container: $name (running since $(docker inspect --format '{{.State.StartedAt}}' "$id" 2>/dev/null))" "$u" "$p"
  done
else
  echo "(docker not installed or not on PATH)"
  echo ""
fi

echo "=========================="
if [ "$FOUND" = "0" ]; then
  echo "No Acumatica credentials found under: $SEARCH_ROOTS"
  echo "If a service lives elsewhere, re-run with SEARCH_ROOTS=/path"
  exit 2
fi
echo "$FOUND location(s) hold Acumatica credentials."
echo "Reference account taken from: $REF_SOURCE"
if [ "$CHECK_PASSWORD" = "1" ]; then
  echo ""
  echo "Any location marked STALE will fail to authenticate. If it retries,"
  echo "it will drive the failed-attempt counter toward lockout."
else
  echo ""
  echo "Re-run with --check-password to see which of these are stale."
fi
