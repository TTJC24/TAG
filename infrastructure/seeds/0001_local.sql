BEGIN;

SET search_path TO operating_layer, public;

ALTER ROLE operating_layer_runtime
  LOGIN PASSWORD 'local-runtime-only';
ALTER ROLE operating_layer_worker_runtime
  LOGIN PASSWORD 'local-worker-only';

INSERT INTO organizations (id, name, code, status)
VALUES
  (
    '10000000-0000-4000-8000-000000000001',
    'Big League Construction Supply',
    'BLCS',
    'active'
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    'Fastening Specialists',
    'FS',
    'active'
  ),
  (
    '10000000-0000-4000-8000-000000000003',
    'Utility Supply Associates',
    'USA',
    'active'
  ),
  (
    '10000000-0000-4000-8000-000000000004',
    'Cultivus+',
    'CULTIVUS',
    'active'
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO permission_sets (
  id,
  code,
  name,
  description,
  is_system
)
VALUES
  (
    '30000000-0000-4000-8000-000000000001',
    'system_admin',
    'System administrator',
    'Platform configuration without implicit financial approval',
    true
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    'executive',
    'Executive',
    'Cross-entity operating visibility by explicit membership',
    true
  ),
  (
    '30000000-0000-4000-8000-000000000003',
    'operations_manager',
    'Operations manager',
    'Issue intake, task operations, and approval requests',
    true
  ),
  (
    '30000000-0000-4000-8000-000000000004',
    'operator',
    'Operator',
    'Authorized issue intake and assigned task access',
    true
  ),
  (
    '30000000-0000-4000-8000-000000000005',
    'approver',
    'Approver',
    'Provisional risk-three and risk-four approval role',
    true
  ),
  (
    '30000000-0000-4000-8000-000000000006',
    'auditor',
    'Auditor',
    'Read-only history and audit access',
    true
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO permission_set_grants (permission_set_id, permission)
VALUES
  ('30000000-0000-4000-8000-000000000001', 'admin.manage'),
  ('30000000-0000-4000-8000-000000000001', 'issues.create'),
  ('30000000-0000-4000-8000-000000000001', 'tasks.read'),
  ('30000000-0000-4000-8000-000000000001', 'queue.read'),
  ('30000000-0000-4000-8000-000000000001', 'audit.read'),
  ('30000000-0000-4000-8000-000000000001', 'approval_policy.author'),
  ('30000000-0000-4000-8000-000000000001', 'approval_policy.activate'),
  ('30000000-0000-4000-8000-000000000001', 'executions.trigger'),
  ('30000000-0000-4000-8000-000000000001', 'executions.replay'),
  ('30000000-0000-4000-8000-000000000001', 'csv_batches.create'),
  ('30000000-0000-4000-8000-000000000001', 'csv_batches.read'),
  ('30000000-0000-4000-8000-000000000001', 'connectors.admin'),
  ('30000000-0000-4000-8000-000000000001', 'external_actions.preview'),
  ('30000000-0000-4000-8000-000000000001', 'external_actions.authorize'),
  ('30000000-0000-4000-8000-000000000002', 'issues.create'),
  ('30000000-0000-4000-8000-000000000002', 'tasks.read'),
  ('30000000-0000-4000-8000-000000000002', 'queue.read'),
  ('30000000-0000-4000-8000-000000000002', 'audit.read'),
  ('30000000-0000-4000-8000-000000000002', 'approvals.decide'),
  ('30000000-0000-4000-8000-000000000002', 'approval_policy.activate'),
  ('30000000-0000-4000-8000-000000000002', 'executions.trigger'),
  ('30000000-0000-4000-8000-000000000002', 'csv_batches.create'),
  ('30000000-0000-4000-8000-000000000002', 'csv_batches.read'),
  ('30000000-0000-4000-8000-000000000002', 'external_actions.preview'),
  ('30000000-0000-4000-8000-000000000002', 'external_actions.authorize'),
  ('30000000-0000-4000-8000-000000000003', 'issues.create'),
  ('30000000-0000-4000-8000-000000000003', 'tasks.read'),
  ('30000000-0000-4000-8000-000000000003', 'queue.read'),
  ('30000000-0000-4000-8000-000000000003', 'audit.read'),
  ('30000000-0000-4000-8000-000000000003', 'executions.trigger'),
  ('30000000-0000-4000-8000-000000000003', 'csv_batches.create'),
  ('30000000-0000-4000-8000-000000000003', 'csv_batches.read'),
  ('30000000-0000-4000-8000-000000000003', 'external_actions.preview'),
  ('30000000-0000-4000-8000-000000000004', 'issues.create'),
  ('30000000-0000-4000-8000-000000000004', 'tasks.read'),
  ('30000000-0000-4000-8000-000000000004', 'queue.read'),
  ('30000000-0000-4000-8000-000000000004', 'csv_batches.create'),
  ('30000000-0000-4000-8000-000000000004', 'csv_batches.read'),
  ('30000000-0000-4000-8000-000000000004', 'external_actions.preview'),
  ('30000000-0000-4000-8000-000000000005', 'tasks.read'),
  ('30000000-0000-4000-8000-000000000005', 'queue.read'),
  ('30000000-0000-4000-8000-000000000005', 'approvals.decide'),
  ('30000000-0000-4000-8000-000000000005', 'executions.trigger'),
  ('30000000-0000-4000-8000-000000000005', 'external_actions.authorize'),
  ('30000000-0000-4000-8000-000000000006', 'tasks.read'),
  ('30000000-0000-4000-8000-000000000006', 'queue.read'),
  ('30000000-0000-4000-8000-000000000006', 'audit.read'),
  ('30000000-0000-4000-8000-000000000006', 'csv_batches.read')
ON CONFLICT DO NOTHING;

INSERT INTO users (
  id,
  oidc_issuer,
  oidc_subject,
  name,
  email,
  status
)
VALUES
  (
    '20000000-0000-4000-8000-000000000001',
    'local',
    'local-admin',
    'Local Administrator',
    'admin@local.operating-layer',
    'active'
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    'local',
    'local-executive',
    'Local Executive',
    'executive@local.operating-layer',
    'active'
  ),
  (
    '20000000-0000-4000-8000-000000000003',
    'local',
    'local-operator',
    'Local BLCS Operator',
    'operator@local.operating-layer',
    'active'
  ),
  (
    '20000000-0000-4000-8000-000000000004',
    'local',
    'local-fsi-operator',
    'Local FS Operator',
    'fsi-operator@local.operating-layer',
    'active'
  ),
  (
    '20000000-0000-4000-8000-000000000005',
    'local',
    'local-approver',
    'Local Approver',
    'approver@local.operating-layer',
    'active'
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO source_systems (
  id,
  organization_id,
  name,
  type,
  connection_status,
  credential_mode,
  permissions
)
VALUES
  (
    '40000000-0000-4000-8000-000000000005',
    '10000000-0000-4000-8000-000000000001',
    'Controlled CSV upload',
    'csv_upload',
    'healthy',
    'none',
    '{"internal_upload": true, "write_external": false}'::jsonb
  ),
  (
    '40000000-0000-4000-8000-000000000006',
    '10000000-0000-4000-8000-000000000002',
    'Controlled CSV upload',
    'csv_upload',
    'healthy',
    'none',
    '{"internal_upload": true, "write_external": false}'::jsonb
  ),
  (
    '40000000-0000-4000-8000-000000000007',
    '10000000-0000-4000-8000-000000000003',
    'Controlled CSV upload',
    'csv_upload',
    'healthy',
    'none',
    '{"internal_upload": true, "write_external": false}'::jsonb
  ),
  (
    '40000000-0000-4000-8000-000000000008',
    '10000000-0000-4000-8000-000000000004',
    'Controlled CSV upload',
    'csv_upload',
    'healthy',
    'none',
    '{"internal_upload": true, "write_external": false}'::jsonb
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO organization_memberships (
  organization_id,
  user_id,
  permission_set_id,
  status
)
SELECT
  organization.id,
  '20000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  'active'
FROM organizations organization
ON CONFLICT DO NOTHING;

INSERT INTO organization_memberships (
  organization_id,
  user_id,
  permission_set_id,
  status
)
SELECT
  organization.id,
  '20000000-0000-4000-8000-000000000005',
  '30000000-0000-4000-8000-000000000005',
  'active'
FROM organizations organization
ON CONFLICT DO NOTHING;

INSERT INTO organization_memberships (
  organization_id,
  user_id,
  permission_set_id,
  status
)
SELECT
  organization.id,
  '20000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000002',
  'active'
FROM organizations organization
ON CONFLICT DO NOTHING;

INSERT INTO organization_memberships (
  organization_id,
  user_id,
  permission_set_id,
  status
)
VALUES
  (
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000003',
    '30000000-0000-4000-8000-000000000004',
    'active'
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000004',
    '30000000-0000-4000-8000-000000000004',
    'active'
  )
ON CONFLICT DO NOTHING;

INSERT INTO source_systems (
  id,
  organization_id,
  name,
  type,
  connection_status,
  credential_mode,
  permissions
)
VALUES
  (
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'Manual issue intake',
    'manual',
    'healthy',
    'none',
    '{"read": true, "write_external": false}'::jsonb
  ),
  (
    '40000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002',
    'Manual issue intake',
    'manual',
    'healthy',
    'none',
    '{"read": true, "write_external": false}'::jsonb
  ),
  (
    '40000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000003',
    'Manual issue intake',
    'manual',
    'healthy',
    'none',
    '{"read": true, "write_external": false}'::jsonb
  ),
  (
    '40000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000004',
    'Manual issue intake',
    'manual',
    'healthy',
    'none',
    '{"read": true, "write_external": false}'::jsonb
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO prompt_versions (
  id,
  agent_kind,
  version,
  template_hash,
  template_reference,
  output_schema_version,
  status,
  created_by_user_id
)
VALUES
  (
    '50000000-0000-4000-8000-000000000001',
    'classification',
    'deterministic-v1',
    encode(digest('deterministic-classification-v1', 'sha256'), 'hex'),
    'code://agents/deterministic-classification-v1',
    'classification-output.v1',
    'active',
    '20000000-0000-4000-8000-000000000001'
  ),
  (
    '50000000-0000-4000-8000-000000000002',
    'recommendation',
    'deterministic-v1',
    encode(digest('deterministic-recommendation-v1', 'sha256'), 'hex'),
    'code://agents/deterministic-recommendation-v1',
    'recommendation-output.v1',
    'active',
    '20000000-0000-4000-8000-000000000001'
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO audit_streams (organization_id)
SELECT id FROM organizations
ON CONFLICT DO NOTHING;

-- Seven-day idempotency retention is explicit and versioned per organization.
WITH retention_seed (
  organization_id,
  policy_version_id
) AS (
  VALUES
    (
      '10000000-0000-4000-8000-000000000001'::uuid,
      '61000000-0000-4000-8000-000000000001'::uuid
    ),
    (
      '10000000-0000-4000-8000-000000000002'::uuid,
      '61000000-0000-4000-8000-000000000002'::uuid
    ),
    (
      '10000000-0000-4000-8000-000000000003'::uuid,
      '61000000-0000-4000-8000-000000000003'::uuid
    ),
    (
      '10000000-0000-4000-8000-000000000004'::uuid,
      '61000000-0000-4000-8000-000000000004'::uuid
    )
)
INSERT INTO idempotency_retention_policy_versions (
  id,
  organization_id,
  version,
  retention_seconds,
  assumption_summary,
  content_hash,
  created_by_user_id
)
SELECT
  policy_version_id,
  organization_id,
  1,
  604800,
  'Approved seven-day maximum legitimate retry window',
  encode(
    digest(
      organization_id::text || ':idempotency-retention:v1:604800',
      'sha256'
    ),
    'hex'
  ),
  '20000000-0000-4000-8000-000000000001'
FROM retention_seed
ON CONFLICT (id) DO NOTHING;

WITH retention_seed (
  organization_id,
  policy_version_id
) AS (
  VALUES
    (
      '10000000-0000-4000-8000-000000000001'::uuid,
      '61000000-0000-4000-8000-000000000001'::uuid
    ),
    (
      '10000000-0000-4000-8000-000000000002'::uuid,
      '61000000-0000-4000-8000-000000000002'::uuid
    ),
    (
      '10000000-0000-4000-8000-000000000003'::uuid,
      '61000000-0000-4000-8000-000000000003'::uuid
    ),
    (
      '10000000-0000-4000-8000-000000000004'::uuid,
      '61000000-0000-4000-8000-000000000004'::uuid
    )
)
INSERT INTO idempotency_retention_policy_bindings (
  organization_id,
  active_policy_version_id,
  activated_by_user_id
)
SELECT
  organization_id,
  policy_version_id,
  '20000000-0000-4000-8000-000000000002'
FROM retention_seed
ON CONFLICT (organization_id) DO NOTHING;

-- Bootstrap the behavior-preserving phase1-v1 policy. The seed writes the
-- first binding directly under a one-time migration guard. Runtime roles have
-- no insert/update grant on binding or activation tables.
WITH policy_seed (
  organization_id,
  policy_version_id
) AS (
  VALUES
    (
      '10000000-0000-4000-8000-000000000001'::uuid,
      '62000000-0000-4000-8000-000000000001'::uuid
    ),
    (
      '10000000-0000-4000-8000-000000000002'::uuid,
      '62000000-0000-4000-8000-000000000002'::uuid
    ),
    (
      '10000000-0000-4000-8000-000000000003'::uuid,
      '62000000-0000-4000-8000-000000000003'::uuid
    ),
    (
      '10000000-0000-4000-8000-000000000004'::uuid,
      '62000000-0000-4000-8000-000000000004'::uuid
    )
),
policy_content AS (
  SELECT
    '[
      {
        "ordinal": 10,
        "name": "Risk 6 prohibited",
        "predicate": {
          "field": "recommendation.risk_level",
          "operator": "gte",
          "value": 6
        },
        "outcome": {
          "effect": "blocked",
          "approverCount": 0,
          "approverPermission": null,
          "requesterMustBeDistinct": true,
          "approversMustBeDistinct": true
        },
        "reasonCode": "risk_6_prohibited"
      },
      {
        "ordinal": 20,
        "name": "Risk 5 write prohibited",
        "predicate": {
          "field": "recommendation.risk_level",
          "operator": "eq",
          "value": 5
        },
        "outcome": {
          "effect": "blocked",
          "approverCount": 0,
          "approverPermission": null,
          "requesterMustBeDistinct": true,
          "approversMustBeDistinct": true
        },
        "reasonCode": "risk_5_write_prohibited_in_phase1"
      },
      {
        "ordinal": 30,
        "name": "Risk 3 and 4 require approval",
        "predicate": {
          "all": [
            {
              "field": "recommendation.risk_level",
              "operator": "gte",
              "value": 3
            },
            {
              "field": "recommendation.risk_level",
              "operator": "lte",
              "value": 4
            }
          ]
        },
        "outcome": {
          "effect": "requires_approval",
          "approverCount": 1,
          "approverPermission": "approvals.decide",
          "requesterMustBeDistinct": true,
          "approversMustBeDistinct": true
        },
        "reasonCode": "human_approval_required"
      },
      {
        "ordinal": 40,
        "name": "Low-risk internal default",
        "predicate": {
          "all": []
        },
        "outcome": {
          "effect": "auto_approve",
          "approverCount": 0,
          "approverPermission": null,
          "requesterMustBeDistinct": false,
          "approversMustBeDistinct": false
        },
        "reasonCode": "low_risk_internal_action"
      }
    ]'::jsonb AS rules
)
INSERT INTO approval_policy_versions (
  id,
  organization_id,
  policy_key,
  version_number,
  schema_version,
  human_label,
  description,
  content_hash,
  created_by_user_id
)
SELECT
  policy_seed.policy_version_id,
  policy_seed.organization_id,
  'issue_intake',
  1,
  'approval-policy.v1',
  'phase1-v1-data',
  'Behavior-preserving declarative form of phase1-v1',
  encode(digest(policy_content.rules::text, 'sha256'), 'hex'),
  '20000000-0000-4000-8000-000000000001'
FROM policy_seed
CROSS JOIN policy_content
ON CONFLICT (id) DO NOTHING;

WITH policy_seed (
  organization_id,
  policy_version_id
) AS (
  VALUES
    (
      '10000000-0000-4000-8000-000000000001'::uuid,
      '62000000-0000-4000-8000-000000000001'::uuid
    ),
    (
      '10000000-0000-4000-8000-000000000002'::uuid,
      '62000000-0000-4000-8000-000000000002'::uuid
    ),
    (
      '10000000-0000-4000-8000-000000000003'::uuid,
      '62000000-0000-4000-8000-000000000003'::uuid
    ),
    (
      '10000000-0000-4000-8000-000000000004'::uuid,
      '62000000-0000-4000-8000-000000000004'::uuid
    )
),
rule_seed (
  ordinal,
  name,
  predicate_json,
  outcome_json,
  reason_code
) AS (
  VALUES
    (
      10,
      'Risk 6 prohibited',
      '{"field":"recommendation.risk_level","operator":"gte","value":6}'::jsonb,
      '{"effect":"blocked","approverCount":0,"approverPermission":null,"requesterMustBeDistinct":true,"approversMustBeDistinct":true}'::jsonb,
      'risk_6_prohibited'
    ),
    (
      20,
      'Risk 5 write prohibited',
      '{"field":"recommendation.risk_level","operator":"eq","value":5}'::jsonb,
      '{"effect":"blocked","approverCount":0,"approverPermission":null,"requesterMustBeDistinct":true,"approversMustBeDistinct":true}'::jsonb,
      'risk_5_write_prohibited_in_phase1'
    ),
    (
      30,
      'Risk 3 and 4 require approval',
      '{"all":[{"field":"recommendation.risk_level","operator":"gte","value":3},{"field":"recommendation.risk_level","operator":"lte","value":4}]}'::jsonb,
      '{"effect":"requires_approval","approverCount":1,"approverPermission":"approvals.decide","requesterMustBeDistinct":true,"approversMustBeDistinct":true}'::jsonb,
      'human_approval_required'
    ),
    (
      40,
      'Low-risk internal default',
      '{"all":[]}'::jsonb,
      '{"effect":"auto_approve","approverCount":0,"approverPermission":null,"requesterMustBeDistinct":false,"approversMustBeDistinct":false}'::jsonb,
      'low_risk_internal_action'
    )
)
INSERT INTO approval_policy_rules (
  organization_id,
  policy_version_id,
  ordinal,
  name,
  predicate_json,
  outcome_json,
  reason_code
)
SELECT
  policy_seed.organization_id,
  policy_seed.policy_version_id,
  rule_seed.ordinal,
  rule_seed.name,
  rule_seed.predicate_json,
  rule_seed.outcome_json,
  rule_seed.reason_code
FROM policy_seed
CROSS JOIN rule_seed
ON CONFLICT (policy_version_id, ordinal) DO NOTHING;

SELECT set_config(
  'app.approval_policy_bootstrap_guard',
  'deterministic-seed:v1',
  true
);

WITH policy_seed (
  organization_id,
  policy_version_id
) AS (
  VALUES
    (
      '10000000-0000-4000-8000-000000000001'::uuid,
      '62000000-0000-4000-8000-000000000001'::uuid
    ),
    (
      '10000000-0000-4000-8000-000000000002'::uuid,
      '62000000-0000-4000-8000-000000000002'::uuid
    ),
    (
      '10000000-0000-4000-8000-000000000003'::uuid,
      '62000000-0000-4000-8000-000000000003'::uuid
    ),
    (
      '10000000-0000-4000-8000-000000000004'::uuid,
      '62000000-0000-4000-8000-000000000004'::uuid
    )
)
INSERT INTO approval_policy_bindings (
  organization_id,
  policy_key,
  active_policy_version_id,
  activated_by_user_id
)
SELECT
  organization_id,
  'issue_intake',
  policy_version_id,
  '20000000-0000-4000-8000-000000000002'
FROM policy_seed
ON CONFLICT (organization_id, policy_key) DO NOTHING;

WITH activation_seed (
  activation_id,
  organization_id,
  policy_version_id
) AS (
  VALUES
    (
      '63000000-0000-4000-8000-000000000001'::uuid,
      '10000000-0000-4000-8000-000000000001'::uuid,
      '62000000-0000-4000-8000-000000000001'::uuid
    ),
    (
      '63000000-0000-4000-8000-000000000002'::uuid,
      '10000000-0000-4000-8000-000000000002'::uuid,
      '62000000-0000-4000-8000-000000000002'::uuid
    ),
    (
      '63000000-0000-4000-8000-000000000003'::uuid,
      '10000000-0000-4000-8000-000000000003'::uuid,
      '62000000-0000-4000-8000-000000000003'::uuid
    ),
    (
      '63000000-0000-4000-8000-000000000004'::uuid,
      '10000000-0000-4000-8000-000000000004'::uuid,
      '62000000-0000-4000-8000-000000000004'::uuid
    )
)
INSERT INTO approval_policy_activations (
  id,
  organization_id,
  policy_key,
  previous_policy_version_id,
  activated_policy_version_id,
  activation_mode,
  binding_version,
  activated_by_user_id,
  reason,
  command_id,
  trace_id
)
SELECT
  activation_id,
  organization_id,
  'issue_intake',
  NULL,
  policy_version_id,
  'bootstrap',
  1,
  '20000000-0000-4000-8000-000000000002',
  'Deterministic Phase 2 bootstrap',
  'bootstrap:phase1-v1-data',
  'trace-bootstrap-phase1-v1-data'
FROM activation_seed
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.approval_policy_bootstrap_guard', '', true);

COMMIT;
