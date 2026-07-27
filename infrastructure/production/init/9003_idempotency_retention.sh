#!/bin/bash
# Seeds per-organization idempotency retention (a seven-day window), which every
# governed intake path (createManualIssue) requires before it will create work.
# The local dev seed does this with test user IDs; production wires the
# created_by / activated_by references to the owner user instead. Runs after the
# owner is seeded (9002).
set -euo pipefail
: "${OWNER_EMAIL:?OWNER_EMAIL is required}"
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
     -v owner_email="$OWNER_EMAIL" <<'SQL'
SET search_path TO operating_layer, public;

WITH admin_user AS (
  SELECT id FROM users WHERE lower(email) = lower(:'owner_email') LIMIT 1
),
retention_seed (organization_id, policy_version_id) AS (
  VALUES
    ('10000000-0000-4000-8000-000000000001'::uuid, '61000000-0000-4000-8000-000000000001'::uuid),
    ('10000000-0000-4000-8000-000000000002'::uuid, '61000000-0000-4000-8000-000000000002'::uuid),
    ('10000000-0000-4000-8000-000000000003'::uuid, '61000000-0000-4000-8000-000000000003'::uuid),
    ('10000000-0000-4000-8000-000000000004'::uuid, '61000000-0000-4000-8000-000000000004'::uuid)
)
INSERT INTO idempotency_retention_policy_versions
  (id, organization_id, version, retention_seconds, assumption_summary, content_hash, created_by_user_id)
SELECT
  rs.policy_version_id, rs.organization_id, 1, 604800,
  'Approved seven-day maximum legitimate retry window',
  encode(digest(rs.organization_id::text || ':idempotency-retention:v1:604800', 'sha256'), 'hex'),
  (SELECT id FROM admin_user)
FROM retention_seed rs
ON CONFLICT (id) DO NOTHING;

WITH admin_user AS (
  SELECT id FROM users WHERE lower(email) = lower(:'owner_email') LIMIT 1
),
retention_seed (organization_id, policy_version_id) AS (
  VALUES
    ('10000000-0000-4000-8000-000000000001'::uuid, '61000000-0000-4000-8000-000000000001'::uuid),
    ('10000000-0000-4000-8000-000000000002'::uuid, '61000000-0000-4000-8000-000000000002'::uuid),
    ('10000000-0000-4000-8000-000000000003'::uuid, '61000000-0000-4000-8000-000000000003'::uuid),
    ('10000000-0000-4000-8000-000000000004'::uuid, '61000000-0000-4000-8000-000000000004'::uuid)
)
INSERT INTO idempotency_retention_policy_bindings
  (organization_id, active_policy_version_id, activated_by_user_id)
SELECT rs.organization_id, rs.policy_version_id, (SELECT id FROM admin_user)
FROM retention_seed rs
ON CONFLICT (organization_id) DO NOTHING;
SQL
