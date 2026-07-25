BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS operating_layer;

SET search_path TO operating_layer, public;

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  code text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oidc_issuer text,
  oidc_subject text,
  name text NOT NULL,
  email text NOT NULL,
  status text NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited', 'active', 'deactivated')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_lower_unique
  ON users (lower(email));

CREATE UNIQUE INDEX users_oidc_identity_unique
  ON users (oidc_issuer, oidc_subject)
  WHERE oidc_issuer IS NOT NULL AND oidc_subject IS NOT NULL;

CREATE TABLE permission_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  is_system boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permission_set_grants (
  permission_set_id uuid NOT NULL
    REFERENCES permission_sets(id) ON DELETE RESTRICT,
  permission text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (permission_set_id, permission)
);

CREATE TABLE organization_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,
  permission_set_id uuid NOT NULL
    REFERENCES permission_sets(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id, permission_set_id)
);

CREATE INDEX organization_memberships_user_idx
  ON organization_memberships (user_id, status);

CREATE TABLE source_systems (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  name text NOT NULL,
  type text NOT NULL,
  connection_status text NOT NULL DEFAULT 'unconfigured'
    CHECK (
      connection_status IN (
        'unconfigured',
        'healthy',
        'degraded',
        'unavailable',
        'disabled'
      )
    ),
  credential_mode text NOT NULL DEFAULT 'read_only'
    CHECK (credential_mode IN ('none', 'read_only', 'controlled_write')),
  secret_reference text,
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, type, name),
  UNIQUE (id, organization_id)
);

CREATE TABLE source_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_system_id uuid NOT NULL,
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  external_id text NOT NULL,
  record_type text NOT NULL,
  canonical_url text,
  latest_version_id uuid,
  source_updated_at timestamptz,
  last_synced_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_system_id, record_type, external_id),
  UNIQUE (id, organization_id),
  FOREIGN KEY (source_system_id, organization_id)
    REFERENCES source_systems(id, organization_id) ON DELETE RESTRICT
);

CREATE INDEX source_records_org_type_idx
  ON source_records (organization_id, record_type);

CREATE TABLE source_record_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id uuid NOT NULL,
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  content_hash text NOT NULL,
  raw_payload_reference text NOT NULL,
  normalized_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL,
  source_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_record_id, content_hash),
  UNIQUE (id, organization_id),
  FOREIGN KEY (source_record_id, organization_id)
    REFERENCES source_records(id, organization_id) ON DELETE RESTRICT
);

ALTER TABLE source_records
  ADD CONSTRAINT source_records_latest_version_fk
  FOREIGN KEY (latest_version_id, organization_id)
  REFERENCES source_record_versions(id, organization_id)
  ON DELETE RESTRICT;

CREATE INDEX source_record_versions_record_observed_idx
  ON source_record_versions (source_record_id, observed_at DESC);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  task_type text NOT NULL,
  status text NOT NULL DEFAULT 'open'
    CHECK (
      status IN (
        'open',
        'in_progress',
        'blocked',
        'awaiting_approval',
        'completed',
        'cancelled'
      )
    ),
  priority text NOT NULL DEFAULT 'P3'
    CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
  priority_score numeric(12,4),
  owner_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  due_date date,
  financial_exposure numeric(20,2),
  financial_exposure_currency char(3),
  confidence numeric(5,4)
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  created_by_actor_type text NOT NULL
    CHECK (created_by_actor_type IN ('user', 'service', 'agent', 'system')),
  created_by_actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (id, organization_id),
  CHECK (
    (financial_exposure IS NULL AND financial_exposure_currency IS NULL)
    OR
    (financial_exposure IS NOT NULL AND financial_exposure_currency IS NOT NULL)
  )
);

CREATE INDEX tasks_org_status_due_idx
  ON tasks (organization_id, status, due_date);

CREATE INDEX tasks_org_owner_status_idx
  ON tasks (organization_id, owner_user_id, status);

CREATE TABLE task_source_records (
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  task_id uuid NOT NULL,
  source_record_id uuid NOT NULL,
  relationship_type text NOT NULL DEFAULT 'supports',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, source_record_id, relationship_type),
  FOREIGN KEY (task_id, organization_id)
    REFERENCES tasks(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_record_id, organization_id)
    REFERENCES source_records(id, organization_id) ON DELETE RESTRICT
);

CREATE TABLE workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_type text NOT NULL,
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  task_id uuid,
  current_state text NOT NULL,
  assigned_agent text,
  approval_required boolean NOT NULL DEFAULT false,
  approval_status text NOT NULL DEFAULT 'not_required'
    CHECK (
      approval_status IN (
        'not_required',
        'pending',
        'approved',
        'rejected',
        'expired',
        'cancelled'
      )
    ),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  FOREIGN KEY (task_id, organization_id)
    REFERENCES tasks(id, organization_id) ON DELETE RESTRICT
);

CREATE INDEX workflows_org_state_idx
  ON workflows (organization_id, current_state);

CREATE TABLE workflow_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL,
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  command_id text NOT NULL,
  from_state text,
  to_state text NOT NULL,
  workflow_version integer NOT NULL CHECK (workflow_version > 0),
  actor_type text NOT NULL
    CHECK (actor_type IN ('user', 'service', 'agent', 'system')),
  actor_id text NOT NULL,
  input_hash text,
  output_hash text,
  trace_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, command_id),
  UNIQUE (workflow_id, workflow_version),
  FOREIGN KEY (workflow_id, organization_id)
    REFERENCES workflows(id, organization_id) ON DELETE RESTRICT
);

CREATE TABLE recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  task_id uuid NOT NULL,
  recommendation_type text NOT NULL,
  summary text NOT NULL,
  reasoning_summary text NOT NULL,
  confidence numeric(5,4) NOT NULL
    CHECK (confidence >= 0 AND confidence <= 1),
  risk_level smallint NOT NULL CHECK (risk_level BETWEEN 0 AND 6),
  requires_approval boolean NOT NULL,
  status text NOT NULL DEFAULT 'proposed'
    CHECK (
      status IN (
        'proposed',
        'accepted',
        'rejected',
        'superseded',
        'expired'
      )
    ),
  agent_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  FOREIGN KEY (task_id, organization_id)
    REFERENCES tasks(id, organization_id) ON DELETE RESTRICT
);

CREATE TABLE recommendation_sources (
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  recommendation_id uuid NOT NULL,
  source_record_id uuid NOT NULL,
  source_record_version_id uuid NOT NULL,
  locator text NOT NULL,
  excerpt_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (
    recommendation_id,
    source_record_version_id,
    locator
  ),
  FOREIGN KEY (recommendation_id, organization_id)
    REFERENCES recommendations(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_record_id, organization_id)
    REFERENCES source_records(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_record_version_id, organization_id)
    REFERENCES source_record_versions(id, organization_id) ON DELETE RESTRICT
);

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  workflow_id uuid NOT NULL,
  requested_from_user_id uuid NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,
  requested_by_actor_type text NOT NULL
    CHECK (requested_by_actor_type IN ('user', 'service', 'agent', 'system')),
  requested_by_actor_id text NOT NULL,
  action_type text NOT NULL,
  target_reference text NOT NULL,
  payload_reference text NOT NULL,
  payload_hash text NOT NULL,
  policy_version text NOT NULL,
  risk_level smallint NOT NULL CHECK (risk_level BETWEEN 0 AND 6),
  status text NOT NULL DEFAULT 'pending'
    CHECK (
      status IN (
        'pending',
        'approved',
        'rejected',
        'expired',
        'cancelled'
      )
    ),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  expires_at timestamptz,
  comments text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (id, organization_id),
  FOREIGN KEY (workflow_id, organization_id)
    REFERENCES workflows(id, organization_id) ON DELETE RESTRICT
);

CREATE INDEX approvals_org_status_idx
  ON approvals (organization_id, status, requested_at);

CREATE TABLE actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  workflow_id uuid NOT NULL,
  approval_id uuid,
  action_type text NOT NULL,
  risk_level smallint NOT NULL CHECK (risk_level BETWEEN 0 AND 6),
  target_system text NOT NULL,
  target_reference text NOT NULL,
  payload_reference text NOT NULL,
  payload_hash text NOT NULL,
  requested_by_actor_type text NOT NULL
    CHECK (requested_by_actor_type IN ('user', 'service', 'agent', 'system')),
  requested_by_actor_id text NOT NULL,
  executed_by_actor_type text
    CHECK (
      executed_by_actor_type IS NULL
      OR executed_by_actor_type IN ('user', 'service', 'system')
    ),
  executed_by_actor_id text,
  status text NOT NULL DEFAULT 'proposed'
    CHECK (
      status IN (
        'proposed',
        'awaiting_approval',
        'approved',
        'executing',
        'executed',
        'verified',
        'failed',
        'cancelled',
        'rolled_back'
      )
    ),
  idempotency_key text NOT NULL,
  executed_at timestamptz,
  rollback_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (id, organization_id),
  FOREIGN KEY (workflow_id, organization_id)
    REFERENCES workflows(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (approval_id, organization_id)
    REFERENCES approvals(id, organization_id) ON DELETE RESTRICT
);

CREATE TABLE action_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  action_id uuid NOT NULL,
  verified boolean NOT NULL,
  observed_hash text,
  verifier_actor_type text NOT NULL
    CHECK (verifier_actor_type IN ('user', 'service', 'system')),
  verifier_actor_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (action_id, organization_id)
    REFERENCES actions(id, organization_id) ON DELETE RESTRICT
);

CREATE TABLE prompt_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_kind text NOT NULL,
  version text NOT NULL,
  template_hash text NOT NULL,
  template_reference text NOT NULL,
  output_schema_version text NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'retired')),
  created_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_kind, version)
);

CREATE TABLE agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  workflow_id uuid,
  task_id uuid,
  agent_kind text NOT NULL,
  prompt_version_id uuid NOT NULL
    REFERENCES prompt_versions(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  model text NOT NULL,
  status text NOT NULL
    CHECK (status IN ('running', 'succeeded', 'failed', 'rejected')),
  input_hash text NOT NULL,
  output_hash text,
  reasoning_summary text,
  confidence numeric(5,4)
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  risk_level smallint CHECK (risk_level IS NULL OR risk_level BETWEEN 0 AND 6),
  input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cost_usd numeric(16,8) CHECK (cost_usd IS NULL OR cost_usd >= 0),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  trace_id text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (id, organization_id),
  FOREIGN KEY (workflow_id, organization_id)
    REFERENCES workflows(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (task_id, organization_id)
    REFERENCES tasks(id, organization_id) ON DELETE RESTRICT
);

ALTER TABLE recommendations
  ADD CONSTRAINT recommendations_agent_run_fk
  FOREIGN KEY (agent_run_id, organization_id)
  REFERENCES agent_runs(id, organization_id)
  ON DELETE RESTRICT;

CREATE TABLE connector_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  source_system_id uuid NOT NULL,
  status text NOT NULL
    CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  cursor_before text,
  cursor_after text,
  records_read integer NOT NULL DEFAULT 0 CHECK (records_read >= 0),
  records_created integer NOT NULL DEFAULT 0 CHECK (records_created >= 0),
  records_updated integer NOT NULL DEFAULT 0 CHECK (records_updated >= 0),
  records_failed integer NOT NULL DEFAULT 0 CHECK (records_failed >= 0),
  error_code text,
  safe_error_message text,
  trace_id text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (source_system_id, organization_id)
    REFERENCES source_systems(id, organization_id) ON DELETE RESTRICT
);

CREATE INDEX connector_sync_runs_source_started_idx
  ON connector_sync_runs (source_system_id, started_at DESC);

CREATE TABLE idempotency_keys (
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL
    CHECK (status IN ('claimed', 'completed', 'failed')),
  response_reference text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, scope, idempotency_key)
);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  topic text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload_reference text NOT NULL,
  payload_hash text NOT NULL,
  idempotency_key text NOT NULL,
  trace_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'published', 'failed', 'dead_letter')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, topic, idempotency_key)
);

CREATE INDEX outbox_events_pending_idx
  ON outbox_events (status, available_at)
  WHERE status IN ('pending', 'failed');

CREATE TABLE audit_streams (
  organization_id uuid PRIMARY KEY
    REFERENCES organizations(id) ON DELETE RESTRICT,
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  last_event_hash text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  stream_sequence bigint NOT NULL CHECK (stream_sequence > 0),
  actor_type text NOT NULL
    CHECK (actor_type IN ('user', 'service', 'agent', 'system')),
  actor_id text NOT NULL,
  event_type text NOT NULL,
  workflow_id uuid,
  source_record_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  input_hash text,
  output_hash text,
  trace_id text NOT NULL,
  request_id text NOT NULL,
  previous_hash text,
  event_hash text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, stream_sequence),
  UNIQUE (organization_id, event_hash),
  FOREIGN KEY (workflow_id, organization_id)
    REFERENCES workflows(id, organization_id) ON DELETE RESTRICT
);

CREATE INDEX audit_events_org_time_idx
  ON audit_events (organization_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION reject_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'immutable table % does not permit %', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER source_record_versions_are_immutable
  BEFORE UPDATE OR DELETE ON source_record_versions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE TRIGGER workflow_transitions_are_immutable
  BEFORE UPDATE OR DELETE ON workflow_transitions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE TRIGGER action_verifications_are_immutable
  BEFORE UPDATE OR DELETE ON action_verifications
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE TRIGGER audit_events_are_immutable
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

COMMIT;
