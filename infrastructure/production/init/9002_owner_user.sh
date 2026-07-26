#!/bin/bash
# Seeds the owner as an active admin of every organization. Managers are
# added later with the runbook's add-a-manager snippet.
set -euo pipefail
: "${OWNER_EMAIL:?OWNER_EMAIL is required}"
: "${OWNER_NAME:?OWNER_NAME is required}"
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
     -v owner_email="$OWNER_EMAIL" -v owner_name="$OWNER_NAME" <<'SQL'
SET search_path TO operating_layer, public;
INSERT INTO users (id, oidc_issuer, oidc_subject, name, email, status)
VALUES (
  gen_random_uuid(), 'cloudflare-access', lower(:'owner_email'),
  :'owner_name', lower(:'owner_email'), 'active'
)
ON CONFLICT DO NOTHING;
INSERT INTO organization_memberships (organization_id, user_id, permission_set_id, status)
SELECT organization.id, app_user.id, '30000000-0000-4000-8000-000000000001', 'active'
FROM organizations organization
CROSS JOIN users app_user
WHERE lower(app_user.email) = lower(:'owner_email')
ON CONFLICT DO NOTHING;
SQL
