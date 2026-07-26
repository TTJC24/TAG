-- Production governance core: organizations, permission sets, grants.
-- Extracted from the reviewed local seed WITHOUT test users and WITHOUT
-- development role passwords. Real users are created by 9002_owner_user.sh
-- and the runbook's add-a-manager snippet.
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

COMMIT;
