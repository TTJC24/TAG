BEGIN;

SET search_path TO operating_layer, public;

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
    'FSI',
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
  ('30000000-0000-4000-8000-000000000002', 'issues.create'),
  ('30000000-0000-4000-8000-000000000002', 'tasks.read'),
  ('30000000-0000-4000-8000-000000000002', 'queue.read'),
  ('30000000-0000-4000-8000-000000000002', 'audit.read'),
  ('30000000-0000-4000-8000-000000000003', 'issues.create'),
  ('30000000-0000-4000-8000-000000000003', 'tasks.read'),
  ('30000000-0000-4000-8000-000000000003', 'queue.read'),
  ('30000000-0000-4000-8000-000000000003', 'audit.read'),
  ('30000000-0000-4000-8000-000000000004', 'issues.create'),
  ('30000000-0000-4000-8000-000000000004', 'tasks.read'),
  ('30000000-0000-4000-8000-000000000004', 'queue.read'),
  ('30000000-0000-4000-8000-000000000005', 'tasks.read'),
  ('30000000-0000-4000-8000-000000000005', 'queue.read'),
  ('30000000-0000-4000-8000-000000000005', 'approvals.decide'),
  ('30000000-0000-4000-8000-000000000006', 'tasks.read'),
  ('30000000-0000-4000-8000-000000000006', 'queue.read'),
  ('30000000-0000-4000-8000-000000000006', 'audit.read')
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
    'Local FSI Operator',
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

COMMIT;
