#!/bin/bash
# Seeds the per-organization governed-intake infrastructure that every issue
# depends on: manual + CSV source systems, deterministic prompt versions, audit
# streams, and the behavior-preserving phase1-v1 approval policy (versions,
# rules, binding, activation). The local dev seed does all of this but wires the
# created_by / activated_by references to test users; production wires them to
# the owner. Runs after the owner (9002) and retention (9003) are in place.
set -euo pipefail
: "${OWNER_EMAIL:?OWNER_EMAIL is required}"
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
     -v owner_email="$OWNER_EMAIL" <<'SQL'
SET search_path TO operating_layer, public;
SELECT id AS owner_id FROM users WHERE lower(email) = lower(:'owner_email') LIMIT 1 \gset

BEGIN;

-- Source systems: manual intake + controlled CSV upload, per organization.
INSERT INTO source_systems (id, organization_id, name, type, connection_status, credential_mode, permissions)
VALUES
  ('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Manual issue intake','manual','healthy','none','{"read": true, "write_external": false}'::jsonb),
  ('40000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','Manual issue intake','manual','healthy','none','{"read": true, "write_external": false}'::jsonb),
  ('40000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000003','Manual issue intake','manual','healthy','none','{"read": true, "write_external": false}'::jsonb),
  ('40000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000004','Manual issue intake','manual','healthy','none','{"read": true, "write_external": false}'::jsonb),
  ('40000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000001','Controlled CSV upload','csv_upload','healthy','none','{"internal_upload": true, "write_external": false}'::jsonb),
  ('40000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000002','Controlled CSV upload','csv_upload','healthy','none','{"internal_upload": true, "write_external": false}'::jsonb),
  ('40000000-0000-4000-8000-000000000007','10000000-0000-4000-8000-000000000003','Controlled CSV upload','csv_upload','healthy','none','{"internal_upload": true, "write_external": false}'::jsonb),
  ('40000000-0000-4000-8000-000000000008','10000000-0000-4000-8000-000000000004','Controlled CSV upload','csv_upload','healthy','none','{"internal_upload": true, "write_external": false}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- Deterministic prompt versions (classification + recommendation).
INSERT INTO prompt_versions (id, agent_kind, version, template_hash, template_reference, output_schema_version, status, created_by_user_id)
VALUES
  ('50000000-0000-4000-8000-000000000001','classification','deterministic-v1',encode(digest('deterministic-classification-v1','sha256'),'hex'),'code://agents/deterministic-classification-v1','classification-output.v1','active',:'owner_id'),
  ('50000000-0000-4000-8000-000000000002','recommendation','deterministic-v1',encode(digest('deterministic-recommendation-v1','sha256'),'hex'),'code://agents/deterministic-recommendation-v1','recommendation-output.v1','active',:'owner_id')
ON CONFLICT (id) DO NOTHING;

-- One audit stream per organization.
INSERT INTO audit_streams (organization_id) SELECT id FROM organizations ON CONFLICT DO NOTHING;

-- Approval policy versions (behavior-preserving phase1-v1 as declarative data).
WITH policy_seed (organization_id, policy_version_id) AS (
  VALUES
    ('10000000-0000-4000-8000-000000000001'::uuid,'62000000-0000-4000-8000-000000000001'::uuid),
    ('10000000-0000-4000-8000-000000000002'::uuid,'62000000-0000-4000-8000-000000000002'::uuid),
    ('10000000-0000-4000-8000-000000000003'::uuid,'62000000-0000-4000-8000-000000000003'::uuid),
    ('10000000-0000-4000-8000-000000000004'::uuid,'62000000-0000-4000-8000-000000000004'::uuid)
),
policy_content AS (
  SELECT '[{"ordinal":10,"name":"Risk 6 prohibited","predicate":{"field":"recommendation.risk_level","operator":"gte","value":6},"outcome":{"effect":"blocked","approverCount":0,"approverPermission":null,"requesterMustBeDistinct":true,"approversMustBeDistinct":true},"reasonCode":"risk_6_prohibited"},{"ordinal":20,"name":"Risk 5 write prohibited","predicate":{"field":"recommendation.risk_level","operator":"eq","value":5},"outcome":{"effect":"blocked","approverCount":0,"approverPermission":null,"requesterMustBeDistinct":true,"approversMustBeDistinct":true},"reasonCode":"risk_5_write_prohibited_in_phase1"},{"ordinal":30,"name":"Risk 3 and 4 require approval","predicate":{"all":[{"field":"recommendation.risk_level","operator":"gte","value":3},{"field":"recommendation.risk_level","operator":"lte","value":4}]},"outcome":{"effect":"requires_approval","approverCount":1,"approverPermission":"approvals.decide","requesterMustBeDistinct":true,"approversMustBeDistinct":true},"reasonCode":"human_approval_required"},{"ordinal":40,"name":"Low-risk internal default","predicate":{"all":[]},"outcome":{"effect":"auto_approve","approverCount":0,"approverPermission":null,"requesterMustBeDistinct":false,"approversMustBeDistinct":false},"reasonCode":"low_risk_internal_action"}]'::jsonb AS rules
)
INSERT INTO approval_policy_versions (id, organization_id, policy_key, version_number, schema_version, human_label, description, content_hash, created_by_user_id)
SELECT policy_seed.policy_version_id, policy_seed.organization_id, 'issue_intake', 1, 'approval-policy.v1', 'phase1-v1-data', 'Behavior-preserving declarative form of phase1-v1', encode(digest(policy_content.rules::text,'sha256'),'hex'), :'owner_id'
FROM policy_seed CROSS JOIN policy_content
ON CONFLICT (id) DO NOTHING;

-- Approval policy rules.
WITH policy_seed (organization_id, policy_version_id) AS (
  VALUES
    ('10000000-0000-4000-8000-000000000001'::uuid,'62000000-0000-4000-8000-000000000001'::uuid),
    ('10000000-0000-4000-8000-000000000002'::uuid,'62000000-0000-4000-8000-000000000002'::uuid),
    ('10000000-0000-4000-8000-000000000003'::uuid,'62000000-0000-4000-8000-000000000003'::uuid),
    ('10000000-0000-4000-8000-000000000004'::uuid,'62000000-0000-4000-8000-000000000004'::uuid)
),
rule_seed (ordinal, name, predicate_json, outcome_json, reason_code) AS (
  VALUES
    (10,'Risk 6 prohibited','{"field":"recommendation.risk_level","operator":"gte","value":6}'::jsonb,'{"effect":"blocked","approverCount":0,"approverPermission":null,"requesterMustBeDistinct":true,"approversMustBeDistinct":true}'::jsonb,'risk_6_prohibited'),
    (20,'Risk 5 write prohibited','{"field":"recommendation.risk_level","operator":"eq","value":5}'::jsonb,'{"effect":"blocked","approverCount":0,"approverPermission":null,"requesterMustBeDistinct":true,"approversMustBeDistinct":true}'::jsonb,'risk_5_write_prohibited_in_phase1'),
    (30,'Risk 3 and 4 require approval','{"all":[{"field":"recommendation.risk_level","operator":"gte","value":3},{"field":"recommendation.risk_level","operator":"lte","value":4}]}'::jsonb,'{"effect":"requires_approval","approverCount":1,"approverPermission":"approvals.decide","requesterMustBeDistinct":true,"approversMustBeDistinct":true}'::jsonb,'human_approval_required'),
    (40,'Low-risk internal default','{"all":[]}'::jsonb,'{"effect":"auto_approve","approverCount":0,"approverPermission":null,"requesterMustBeDistinct":false,"approversMustBeDistinct":false}'::jsonb,'low_risk_internal_action')
)
INSERT INTO approval_policy_rules (organization_id, policy_version_id, ordinal, name, predicate_json, outcome_json, reason_code)
SELECT policy_seed.organization_id, policy_seed.policy_version_id, rule_seed.ordinal, rule_seed.name, rule_seed.predicate_json, rule_seed.outcome_json, rule_seed.reason_code
FROM policy_seed CROSS JOIN rule_seed
ON CONFLICT (policy_version_id, ordinal) DO NOTHING;

-- Bootstrap the first binding + activation under the one-time guard.
SELECT set_config('app.approval_policy_bootstrap_guard','deterministic-seed:v1',true);

WITH policy_seed (organization_id, policy_version_id) AS (
  VALUES
    ('10000000-0000-4000-8000-000000000001'::uuid,'62000000-0000-4000-8000-000000000001'::uuid),
    ('10000000-0000-4000-8000-000000000002'::uuid,'62000000-0000-4000-8000-000000000002'::uuid),
    ('10000000-0000-4000-8000-000000000003'::uuid,'62000000-0000-4000-8000-000000000003'::uuid),
    ('10000000-0000-4000-8000-000000000004'::uuid,'62000000-0000-4000-8000-000000000004'::uuid)
)
INSERT INTO approval_policy_bindings (organization_id, policy_key, active_policy_version_id, activated_by_user_id)
SELECT organization_id, 'issue_intake', policy_version_id, :'owner_id'
FROM policy_seed
ON CONFLICT (organization_id, policy_key) DO NOTHING;

WITH activation_seed (activation_id, organization_id, policy_version_id) AS (
  VALUES
    ('63000000-0000-4000-8000-000000000001'::uuid,'10000000-0000-4000-8000-000000000001'::uuid,'62000000-0000-4000-8000-000000000001'::uuid),
    ('63000000-0000-4000-8000-000000000002'::uuid,'10000000-0000-4000-8000-000000000002'::uuid,'62000000-0000-4000-8000-000000000002'::uuid),
    ('63000000-0000-4000-8000-000000000003'::uuid,'10000000-0000-4000-8000-000000000003'::uuid,'62000000-0000-4000-8000-000000000003'::uuid),
    ('63000000-0000-4000-8000-000000000004'::uuid,'10000000-0000-4000-8000-000000000004'::uuid,'62000000-0000-4000-8000-000000000004'::uuid)
)
INSERT INTO approval_policy_activations (id, organization_id, policy_key, previous_policy_version_id, activated_policy_version_id, activation_mode, binding_version, activated_by_user_id, reason, command_id, trace_id)
SELECT activation_id, organization_id, 'issue_intake', NULL, policy_version_id, 'bootstrap', 1, :'owner_id', 'Deterministic production bootstrap', 'bootstrap:phase1-v1-data:' || organization_id::text, 'trace-bootstrap-' || organization_id::text
FROM activation_seed
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.approval_policy_bootstrap_guard','',true);

COMMIT;
SQL
