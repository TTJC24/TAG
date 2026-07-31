#!/bin/sh
# Answer exactly one question: do company-brain and operating-layer authenticate
# to Acumatica as the SAME Acumatica account, or different ones?
#
#   sudo sh scripts/acumatica-account-check.sh
#
# Prints exactly one of:
#
#   SAME ACCOUNT
#   DIFFERENT ACCOUNTS
#   CANNOT DETERMINE: <reason>
#
# It prints NOTHING ELSE. No usernames, no passwords, no file contents, no
# paths beyond the reason line when a file is missing. That is deliberate: the
# answer is one bit, and anything more is an unnecessary disclosure of
# production credentials material.
#
# Read-only. It opens two files and compares one variable. It changes nothing,
# contacts nothing, and touches Acumatica not at all.
#
# Why this exists: three codebases read the same Acumatica instance, and that
# instance enforces a per-user Contract API seat limit. If they share an
# account they compete for seats, and clearing "stale" sessions for one would
# disrupt the others. No further remediation is safe until this is known.

set -eu

# Override if the deployments live elsewhere:
#   OL_ENV=/path/to/.env.production CB_ENV=/path/to/.env sh acumatica-account-check.sh
OL_ENV="${OL_ENV:-/opt/operating-layer/.env.production}"
CB_ENV="${CB_ENV:-/opt/company-brain/infra/.env}"

# Extract one variable's value from a .env file.
#
# Handles the shapes these files actually take: an optional `export` prefix,
# spaces around `=`, single or double quotes, CRLF line endings, and the same
# key defined more than once (the last definition wins, as the shell would).
# Comments are skipped so a commented-out old value cannot be mistaken for the
# live one.
extract() {
  file="$1"
  key="$2"
  sed -n "s/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}${key}[[:space:]]*=[[:space:]]*//p" "$file" 2>/dev/null |
    tr -d '\r' |
    sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//" |
    sed -e 's/[[:space:]]*$//' |
    tail -n 1
}

for f in "$OL_ENV" "$CB_ENV"; do
  if [ ! -f "$f" ]; then
    echo "CANNOT DETERMINE: file not found: $f"
    exit 2
  fi
  if [ ! -r "$f" ]; then
    echo "CANNOT DETERMINE: file not readable (try sudo): $f"
    exit 2
  fi
done

ol_user="$(extract "$OL_ENV" ACUMATICA_USERNAME)"
cb_user="$(extract "$CB_ENV" ACUMATICA_USERNAME)"

if [ -z "$ol_user" ]; then
  echo "CANNOT DETERMINE: ACUMATICA_USERNAME not set in $OL_ENV"
  exit 2
fi
if [ -z "$cb_user" ]; then
  echo "CANNOT DETERMINE: ACUMATICA_USERNAME not set in $CB_ENV"
  exit 2
fi

# Compare case-insensitively. Acumatica logins are not case-sensitive, so
# "Agent.Scoreboard" and "agent.scoreboard" are ONE account competing for one
# set of seats. Treating them as different would give exactly the wrong answer
# to the question being asked.
ol_norm="$(printf '%s' "$ol_user" | tr '[:upper:]' '[:lower:]')"
cb_norm="$(printf '%s' "$cb_user" | tr '[:upper:]' '[:lower:]')"

if [ "$ol_norm" = "$cb_norm" ]; then
  echo "SAME ACCOUNT"
  exit 0
fi

echo "DIFFERENT ACCOUNTS"
exit 0
