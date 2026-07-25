BEGIN;

SET search_path TO operating_layer, public;

ALTER TABLE source_record_versions
  ADD COLUMN checksum_algorithm text NOT NULL DEFAULT 'sha256'
    CHECK (checksum_algorithm = 'sha256'),
  ADD COLUMN source_identity jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN schema_version text NOT NULL DEFAULT 'unknown',
  ADD COLUMN retention_classification text NOT NULL DEFAULT 'operational'
    CHECK (
      retention_classification IN (
        'transient',
        'operational',
        'financial_support',
        'legal_hold'
      )
    ),
  ADD COLUMN ingested_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE outbox_events
  DROP CONSTRAINT outbox_events_status_check,
  ADD CONSTRAINT outbox_events_status_check
    CHECK (
      status IN (
        'pending',
        'processing',
        'published',
        'failed',
        'dead_letter'
      )
    ),
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 3
    CHECK (max_attempts BETWEEN 1 AND 20),
  ADD COLUMN locked_at timestamptz,
  ADD COLUMN locked_by text,
  ADD COLUMN last_attempt_at timestamptz,
  ADD COLUMN last_error_code text,
  ADD COLUMN safe_error_message text,
  ADD COLUMN requested_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN request_id text;

CREATE TABLE workflow_allowed_transitions (
  workflow_type text NOT NULL,
  from_state text NOT NULL,
  to_state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workflow_type, from_state, to_state)
);

INSERT INTO workflow_allowed_transitions (
  workflow_type,
  from_state,
  to_state
)
VALUES
  ('issue_intake', 'received', 'normalized'),
  ('issue_intake', 'normalized', 'classified'),
  ('issue_intake', 'classified', 'recommended'),
  ('issue_intake', 'recommended', 'awaiting_approval'),
  ('issue_intake', 'recommended', 'completed'),
  ('issue_intake', 'received', 'blocked'),
  ('issue_intake', 'normalized', 'blocked'),
  ('issue_intake', 'classified', 'blocked'),
  ('issue_intake', 'recommended', 'blocked'),
  ('issue_intake', 'awaiting_approval', 'blocked'),
  ('issue_intake', 'received', 'failed'),
  ('issue_intake', 'normalized', 'failed'),
  ('issue_intake', 'classified', 'failed'),
  ('issue_intake', 'recommended', 'failed'),
  ('issue_intake', 'awaiting_approval', 'failed'),
  ('issue_intake', 'received', 'cancelled'),
  ('issue_intake', 'normalized', 'cancelled'),
  ('issue_intake', 'classified', 'cancelled'),
  ('issue_intake', 'recommended', 'cancelled'),
  ('issue_intake', 'awaiting_approval', 'cancelled');

CREATE OR REPLACE FUNCTION current_request_organization_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.organization_ids', true), '')::uuid[],
    '{}'::uuid[]
  );
$$;

CREATE OR REPLACE FUNCTION current_request_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION current_user_can_access_organization(
  requested_organization_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = operating_layer, public
AS $$
  SELECT
    requested_organization_id = ANY(current_request_organization_ids())
    AND EXISTS (
      SELECT 1
      FROM organization_memberships membership
      JOIN users app_user ON app_user.id = membership.user_id
      WHERE membership.organization_id = requested_organization_id
        AND membership.user_id = current_request_user_id()
        AND membership.status = 'active'
        AND app_user.status = 'active'
    );
$$;

CREATE OR REPLACE FUNCTION guard_workflow_state_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.current_state IS DISTINCT FROM OLD.current_state THEN
    IF current_setting('app.workflow_transition_guard', true)
       IS DISTINCT FROM 'transition_workflow:v1' THEN
      RAISE EXCEPTION 'workflow state must be changed through transition_workflow'
        USING ERRCODE = '55000';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM workflow_allowed_transitions allowed
      WHERE allowed.workflow_type = OLD.workflow_type
        AND allowed.from_state = OLD.current_state
        AND allowed.to_state = NEW.current_state
    ) THEN
      RAISE EXCEPTION 'transition % -> % is not allowed for workflow type %',
        OLD.current_state,
        NEW.current_state,
        OLD.workflow_type
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER workflows_require_transition_function
  BEFORE UPDATE OF current_state ON workflows
  FOR EACH ROW EXECUTE FUNCTION guard_workflow_state_update();

CREATE OR REPLACE FUNCTION guard_workflow_transition_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('app.workflow_transition_guard', true)
     IS DISTINCT FROM 'transition_workflow:v1' THEN
    RAISE EXCEPTION 'workflow transitions must be inserted through transition_workflow'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER workflow_transition_inserts_require_function
  BEFORE INSERT ON workflow_transitions
  FOR EACH ROW EXECUTE FUNCTION guard_workflow_transition_insert();

CREATE OR REPLACE FUNCTION transition_workflow(
  p_workflow_id uuid,
  p_organization_id uuid,
  p_command_id text,
  p_expected_version integer,
  p_to_state text,
  p_actor_type text,
  p_actor_id text,
  p_input_hash text,
  p_output_hash text,
  p_trace_id text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  workflow_id uuid,
  current_state text,
  workflow_version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = operating_layer, public
AS $$
DECLARE
  current_workflow workflows%ROWTYPE;
BEGIN
  IF NOT current_user_can_access_organization(p_organization_id) THEN
    RAISE EXCEPTION 'organization access denied'
      USING ERRCODE = '42501';
  END IF;

  IF p_actor_type NOT IN ('user', 'service', 'agent', 'system') THEN
    RAISE EXCEPTION 'invalid workflow actor type'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO current_workflow
  FROM workflows
  WHERE id = p_workflow_id
    AND organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'workflow not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF current_workflow.version <> p_expected_version THEN
    RAISE EXCEPTION 'workflow version conflict: expected %, actual %',
      p_expected_version,
      current_workflow.version
      USING ERRCODE = '40001';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM workflow_allowed_transitions allowed
    WHERE allowed.workflow_type = current_workflow.workflow_type
      AND allowed.from_state = current_workflow.current_state
      AND allowed.to_state = p_to_state
  ) THEN
    RAISE EXCEPTION 'transition % -> % is not allowed for workflow type %',
      current_workflow.current_state,
      p_to_state,
      current_workflow.workflow_type
      USING ERRCODE = '23514';
  END IF;

  PERFORM set_config(
    'app.workflow_transition_guard',
    'transition_workflow:v1',
    true
  );

  UPDATE workflows
  SET
    current_state = p_to_state,
    version = version + 1,
    approval_required = CASE
      WHEN p_to_state = 'awaiting_approval' THEN true
      ELSE approval_required
    END,
    approval_status = CASE
      WHEN p_to_state = 'awaiting_approval' THEN 'pending'
      WHEN p_to_state = 'completed' AND approval_required = false
        THEN 'not_required'
      ELSE approval_status
    END,
    completed_at = CASE
      WHEN p_to_state = 'completed' THEN now()
      ELSE completed_at
    END,
    updated_at = now()
  WHERE id = current_workflow.id
    AND organization_id = current_workflow.organization_id;

  INSERT INTO workflow_transitions (
    workflow_id,
    organization_id,
    command_id,
    from_state,
    to_state,
    workflow_version,
    actor_type,
    actor_id,
    input_hash,
    output_hash,
    trace_id,
    metadata
  )
  VALUES (
    current_workflow.id,
    current_workflow.organization_id,
    p_command_id,
    current_workflow.current_state,
    p_to_state,
    current_workflow.version + 1,
    p_actor_type,
    p_actor_id,
    p_input_hash,
    p_output_hash,
    p_trace_id,
    p_metadata
  );

  PERFORM set_config('app.workflow_transition_guard', '', true);

  RETURN QUERY
  SELECT
    current_workflow.id,
    p_to_state,
    current_workflow.version + 1;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'operating_layer_app'
  ) THEN
    CREATE ROLE operating_layer_app NOLOGIN NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;

  EXECUTE format('GRANT operating_layer_app TO %I', current_user);
END;
$$;

GRANT USAGE ON SCHEMA operating_layer TO operating_layer_app;
GRANT SELECT, INSERT, UPDATE
  ON ALL TABLES IN SCHEMA operating_layer
  TO operating_layer_app;
GRANT EXECUTE ON FUNCTION transition_workflow(
  uuid,
  uuid,
  text,
  integer,
  text,
  text,
  text,
  text,
  text,
  text,
  jsonb
) TO operating_layer_app;

REVOKE UPDATE ON source_record_versions FROM operating_layer_app;
REVOKE UPDATE ON workflow_transitions FROM operating_layer_app;
REVOKE UPDATE ON action_verifications FROM operating_layer_app;
REVOKE UPDATE ON audit_events FROM operating_layer_app;
REVOKE UPDATE ON workflows FROM operating_layer_app;

DO $$
DECLARE
  table_name text;
  isolated_tables text[] := ARRAY[
    'source_systems',
    'source_records',
    'source_record_versions',
    'tasks',
    'task_source_records',
    'workflows',
    'workflow_transitions',
    'recommendations',
    'recommendation_sources',
    'approvals',
    'actions',
    'action_verifications',
    'agent_runs',
    'connector_sync_runs',
    'idempotency_keys',
    'outbox_events',
    'audit_streams',
    'audit_events'
  ];
BEGIN
  FOREACH table_name IN ARRAY isolated_tables LOOP
    EXECUTE format(
      'ALTER TABLE operating_layer.%I ENABLE ROW LEVEL SECURITY',
      table_name
    );
    EXECUTE format(
      'ALTER TABLE operating_layer.%I FORCE ROW LEVEL SECURITY',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY organization_isolation ON operating_layer.%I
       FOR ALL
       USING (current_user_can_access_organization(organization_id))
       WITH CHECK (current_user_can_access_organization(organization_id))',
      table_name
    );
  END LOOP;
END;
$$;

COMMIT;
