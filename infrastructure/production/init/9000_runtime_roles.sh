#!/bin/bash
# Grants LOGIN with strong, deployment-supplied passwords to the two
# RLS-forced runtime roles the migrations created as NOLOGIN. Fails the first
# boot loudly if the passwords are not provided — no defaults, ever.
set -euo pipefail
: "${RUNTIME_DB_PASSWORD:?RUNTIME_DB_PASSWORD is required (api runtime role)}"
: "${WORKER_DB_PASSWORD:?WORKER_DB_PASSWORD is required (worker runtime role)}"
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<SQL
ALTER ROLE operating_layer_runtime LOGIN PASSWORD '${RUNTIME_DB_PASSWORD}';
ALTER ROLE operating_layer_worker_runtime LOGIN PASSWORD '${WORKER_DB_PASSWORD}';
SQL
