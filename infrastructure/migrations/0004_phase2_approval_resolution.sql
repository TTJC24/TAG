BEGIN;

SET search_path TO operating_layer, public;

-- Phase 2 closes the internal approval loop. Rejection is terminal; approval
-- advances through an explicit approved state and then completes internally.
ALTER TABLE tasks
  DROP CONSTRAINT tasks_status_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_status_check
  CHECK (
    status IN (
      'received',
      'normalized',
      'classified',
      'recommended',
      'awaiting_approval',
      'approved',
      'action_queued',
      'completed',
      'rejected',
      'blocked',
      'failed',
      'cancelled'
    )
  );

INSERT INTO workflow_allowed_transitions (
  workflow_type,
  from_state,
  to_state
)
VALUES
  ('issue_intake', 'awaiting_approval', 'approved'),
  ('issue_intake', 'approved', 'completed'),
  ('issue_intake', 'awaiting_approval', 'rejected')
ON CONFLICT DO NOTHING;

-- Idempotency retention is versioned per organization. A claim pins the
-- version and duration in force when the claim is created.
CREATE TABLE idempotency_retention_policy_versions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  retention_seconds integer NOT NULL CHECK (retention_seconds > 0),
  assumption_summary text NOT NULL,
  content_hash text NOT NULL CHECK (length(content_hash) = 64),
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  supersedes_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  UNIQUE (organization_id, version),
  FOREIGN KEY (supersedes_version_id, organization_id)
    REFERENCES idempotency_retention_policy_versions(id, organization_id)
    ON DELETE RESTRICT
);

CREATE TABLE idempotency_retention_policy_bindings (
  organization_id uuid PRIMARY KEY
    REFERENCES organizations(id) ON DELETE RESTRICT,
  active_policy_version_id uuid NOT NULL,
  binding_version integer NOT NULL DEFAULT 1 CHECK (binding_version > 0),
  activated_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  activated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (active_policy_version_id, organization_id)
    REFERENCES idempotency_retention_policy_versions(id, organization_id)
    ON DELETE RESTRICT
);

CREATE TRIGGER idempotency_retention_versions_are_immutable
  BEFORE UPDATE OR DELETE ON idempotency_retention_policy_versions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

ALTER TABLE idempotency_keys
  ADD COLUMN retention_policy_version_id uuid,
  ADD COLUMN retention_seconds_snapshot integer
    CHECK (
      retention_seconds_snapshot IS NULL
      OR retention_seconds_snapshot > 0
    ),
  ADD COLUMN terminal_at timestamptz,
  ADD CONSTRAINT idempotency_keys_retention_policy_fk
    FOREIGN KEY (retention_policy_version_id, organization_id)
    REFERENCES idempotency_retention_policy_versions(id, organization_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT idempotency_keys_terminal_expiry_check
    CHECK (
      (
        status = 'claimed'
        AND terminal_at IS NULL
        AND expires_at IS NULL
      )
      OR
      (
        status IN ('completed', 'failed')
        AND terminal_at IS NOT NULL
        AND expires_at IS NOT NULL
        AND expires_at > terminal_at
        AND retention_policy_version_id IS NOT NULL
        AND retention_seconds_snapshot IS NOT NULL
      )
    );

CREATE INDEX idempotency_keys_expiry_idx
  ON idempotency_keys (expires_at)
  WHERE status IN ('completed', 'failed');

CREATE TABLE idempotency_reaper_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id text NOT NULL,
  batch_limit integer NOT NULL CHECK (batch_limit BETWEEN 1 AND 1000),
  deleted_count integer NOT NULL CHECK (deleted_count >= 0),
  cutoff_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER idempotency_reaper_runs_are_immutable
  BEFORE UPDATE OR DELETE ON idempotency_reaper_runs
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE OR REPLACE FUNCTION reap_expired_idempotency_keys(
  p_batch_limit integer,
  p_trace_id text
)
RETURNS TABLE (
  reaper_run_id uuid,
  deleted_count integer,
  cutoff_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = operating_layer, public
AS $$
DECLARE
  v_run_id uuid := gen_random_uuid();
  v_deleted_count integer;
  v_cutoff timestamptz := transaction_timestamp();
BEGIN
  IF p_batch_limit < 1 OR p_batch_limit > 1000 THEN
    RAISE EXCEPTION 'reaper batch limit must be between 1 and 1000'
      USING ERRCODE = '22023';
  END IF;

  IF p_trace_id IS NULL OR btrim(p_trace_id) = '' THEN
    RAISE EXCEPTION 'reaper trace id is required'
      USING ERRCODE = '22023';
  END IF;

  WITH candidates AS (
    SELECT
      key_row.organization_id,
      key_row.scope,
      key_row.idempotency_key
    FROM idempotency_keys key_row
    WHERE key_row.status IN ('completed', 'failed')
      AND key_row.expires_at <= v_cutoff
    ORDER BY key_row.expires_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_batch_limit
  ),
  deleted AS (
    DELETE FROM idempotency_keys key_row
    USING candidates
    WHERE key_row.organization_id = candidates.organization_id
      AND key_row.scope = candidates.scope
      AND key_row.idempotency_key = candidates.idempotency_key
    RETURNING 1
  )
  SELECT count(*)::integer
  INTO v_deleted_count
  FROM deleted;

  INSERT INTO idempotency_reaper_runs (
    id,
    trace_id,
    batch_limit,
    deleted_count,
    cutoff_at
  )
  VALUES (
    v_run_id,
    p_trace_id,
    p_batch_limit,
    v_deleted_count,
    v_cutoff
  );

  RETURN QUERY SELECT v_run_id, v_deleted_count, v_cutoff;
END;
$$;

REVOKE ALL ON FUNCTION reap_expired_idempotency_keys(integer, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reap_expired_idempotency_keys(integer, text)
  TO operating_layer_runtime;

-- Declarative approval policies are immutable data. The active binding is a
-- guarded projection; activation history is append-only.
CREATE TABLE approval_policy_versions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  policy_key text NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  schema_version text NOT NULL,
  human_label text NOT NULL,
  description text NOT NULL,
  content_hash text NOT NULL CHECK (length(content_hash) = 64),
  supersedes_version_id uuid,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  UNIQUE (organization_id, policy_key, version_number),
  FOREIGN KEY (supersedes_version_id, organization_id)
    REFERENCES approval_policy_versions(id, organization_id)
    ON DELETE RESTRICT
);

CREATE TABLE approval_policy_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  policy_version_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  name text NOT NULL,
  predicate_json jsonb NOT NULL
    CHECK (jsonb_typeof(predicate_json) = 'object'),
  outcome_json jsonb NOT NULL
    CHECK (jsonb_typeof(outcome_json) = 'object'),
  reason_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (policy_version_id, ordinal),
  UNIQUE (id, organization_id),
  FOREIGN KEY (policy_version_id, organization_id)
    REFERENCES approval_policy_versions(id, organization_id)
    ON DELETE RESTRICT
);

CREATE TABLE approval_policy_bindings (
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  policy_key text NOT NULL,
  active_policy_version_id uuid NOT NULL,
  binding_version integer NOT NULL DEFAULT 1 CHECK (binding_version > 0),
  activated_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  activated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, policy_key),
  FOREIGN KEY (active_policy_version_id, organization_id)
    REFERENCES approval_policy_versions(id, organization_id)
    ON DELETE RESTRICT
);

CREATE TABLE approval_policy_activation_requests (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  policy_key text NOT NULL,
  target_policy_version_id uuid NOT NULL,
  requested_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 3),
  command_id text NOT NULL,
  trace_id text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, command_id),
  UNIQUE (id, organization_id),
  FOREIGN KEY (target_policy_version_id, organization_id)
    REFERENCES approval_policy_versions(id, organization_id)
    ON DELETE RESTRICT
);

CREATE TABLE approval_policy_activations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  policy_key text NOT NULL,
  previous_policy_version_id uuid,
  activated_policy_version_id uuid NOT NULL,
  activation_request_id uuid,
  activation_mode text NOT NULL
    CHECK (activation_mode IN ('bootstrap', 'new_version', 'revert')),
  binding_version integer NOT NULL CHECK (binding_version > 0),
  activated_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL,
  command_id text NOT NULL,
  trace_id text NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, command_id),
  UNIQUE (activation_request_id),
  UNIQUE (id, organization_id),
  FOREIGN KEY (previous_policy_version_id, organization_id)
    REFERENCES approval_policy_versions(id, organization_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (activated_policy_version_id, organization_id)
    REFERENCES approval_policy_versions(id, organization_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (activation_request_id, organization_id)
    REFERENCES approval_policy_activation_requests(id, organization_id)
    ON DELETE RESTRICT
);

CREATE TRIGGER approval_policy_versions_are_immutable
  BEFORE UPDATE OR DELETE ON approval_policy_versions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE TRIGGER approval_policy_rules_are_immutable
  BEFORE UPDATE OR DELETE ON approval_policy_rules
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE TRIGGER approval_policy_activation_requests_are_immutable
  BEFORE UPDATE OR DELETE ON approval_policy_activation_requests
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE TRIGGER approval_policy_activations_are_immutable
  BEFORE UPDATE OR DELETE ON approval_policy_activations
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE OR REPLACE FUNCTION current_request_user_has_permission(
  p_organization_id uuid,
  p_permission text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = operating_layer, public
AS $$
  SELECT
    current_user_can_access_organization(p_organization_id)
    AND EXISTS (
      SELECT 1
      FROM organization_memberships membership
      JOIN permission_set_grants grant_row
        ON grant_row.permission_set_id = membership.permission_set_id
      WHERE membership.organization_id = p_organization_id
        AND membership.user_id = current_request_user_id()
        AND membership.status = 'active'
        AND grant_row.permission = p_permission
    );
$$;

CREATE OR REPLACE FUNCTION guard_approval_policy_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_setting('app.approval_policy_bootstrap_guard', true)
       IS DISTINCT FROM 'deterministic-seed:v1' THEN
      RAISE EXCEPTION 'initial policy binding is bootstrap-only'
        USING ERRCODE = '55000';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF current_setting('app.approval_policy_activation_guard', true)
       IS DISTINCT FROM 'activate_approval_policy:v1' THEN
      RAISE EXCEPTION 'policy binding must be changed through activation'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'policy bindings cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER approval_policy_bindings_require_guard
  BEFORE INSERT OR UPDATE OR DELETE ON approval_policy_bindings
  FOR EACH ROW EXECUTE FUNCTION guard_approval_policy_binding();

CREATE OR REPLACE FUNCTION create_approval_policy_version(
  p_policy_version_id uuid,
  p_organization_id uuid,
  p_policy_key text,
  p_version_number integer,
  p_schema_version text,
  p_human_label text,
  p_description text,
  p_content_hash text,
  p_supersedes_version_id uuid,
  p_rules jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = operating_layer, public
AS $$
DECLARE
  v_rule jsonb;
BEGIN
  IF NOT current_request_user_has_permission(
    p_organization_id,
    'approval_policy.author'
  ) THEN
    RAISE EXCEPTION 'approval policy author permission denied'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(p_rules) <> 'array'
     OR jsonb_array_length(p_rules) = 0 THEN
    RAISE EXCEPTION 'approval policy requires a non-empty rule array'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO approval_policy_versions (
    id,
    organization_id,
    policy_key,
    version_number,
    schema_version,
    human_label,
    description,
    content_hash,
    supersedes_version_id,
    created_by_user_id
  )
  VALUES (
    p_policy_version_id,
    p_organization_id,
    p_policy_key,
    p_version_number,
    p_schema_version,
    p_human_label,
    p_description,
    p_content_hash,
    p_supersedes_version_id,
    current_request_user_id()
  );

  FOR v_rule IN SELECT value FROM jsonb_array_elements(p_rules) LOOP
    INSERT INTO approval_policy_rules (
      organization_id,
      policy_version_id,
      ordinal,
      name,
      predicate_json,
      outcome_json,
      reason_code
    )
    VALUES (
      p_organization_id,
      p_policy_version_id,
      (v_rule ->> 'ordinal')::integer,
      v_rule ->> 'name',
      v_rule -> 'predicate',
      v_rule -> 'outcome',
      v_rule ->> 'reasonCode'
    );
  END LOOP;

  RETURN p_policy_version_id;
END;
$$;

CREATE OR REPLACE FUNCTION request_approval_policy_activation(
  p_request_id uuid,
  p_organization_id uuid,
  p_policy_key text,
  p_target_policy_version_id uuid,
  p_reason text,
  p_command_id text,
  p_trace_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = operating_layer, public
AS $$
BEGIN
  IF NOT (
    current_request_user_has_permission(
      p_organization_id,
      'approval_policy.author'
    )
    OR current_request_user_has_permission(
      p_organization_id,
      'approval_policy.activate'
    )
  ) THEN
    RAISE EXCEPTION 'approval policy activation-request permission denied'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM approval_policy_activations activation
    WHERE activation.organization_id = p_organization_id
      AND activation.policy_key = p_policy_key
      AND activation.activated_policy_version_id = p_target_policy_version_id
  ) THEN
    RAISE EXCEPTION 'previously activated policy versions use revert mode'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO approval_policy_activation_requests (
    id,
    organization_id,
    policy_key,
    target_policy_version_id,
    requested_by_user_id,
    reason,
    command_id,
    trace_id
  )
  VALUES (
    p_request_id,
    p_organization_id,
    p_policy_key,
    p_target_policy_version_id,
    current_request_user_id(),
    p_reason,
    p_command_id,
    p_trace_id
  );

  RETURN p_request_id;
END;
$$;

CREATE OR REPLACE FUNCTION activate_approval_policy(
  p_activation_id uuid,
  p_organization_id uuid,
  p_policy_key text,
  p_target_policy_version_id uuid,
  p_activation_request_id uuid,
  p_reason text,
  p_command_id text,
  p_trace_id text
)
RETURNS TABLE (
  activation_id uuid,
  previous_policy_version_id uuid,
  activated_policy_version_id uuid,
  activation_mode text,
  binding_version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = operating_layer, public
AS $$
DECLARE
  v_binding approval_policy_bindings%ROWTYPE;
  v_target approval_policy_versions%ROWTYPE;
  v_request approval_policy_activation_requests%ROWTYPE;
  v_was_previously_active boolean;
  v_mode text;
  v_next_binding_version integer;
BEGIN
  IF NOT current_request_user_has_permission(
    p_organization_id,
    'approval_policy.activate'
  ) THEN
    RAISE EXCEPTION 'approval policy activation permission denied'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
  INTO v_binding
  FROM approval_policy_bindings
  WHERE organization_id = p_organization_id
    AND policy_key = p_policy_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval policy binding not found'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT *
  INTO v_target
  FROM approval_policy_versions
  WHERE id = p_target_policy_version_id
    AND organization_id = p_organization_id
    AND policy_key = p_policy_key;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'target approval policy version not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_binding.active_policy_version_id = p_target_policy_version_id THEN
    RAISE EXCEPTION 'target approval policy version is already active'
      USING ERRCODE = '23514';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM approval_policy_activations activation
    WHERE activation.organization_id = p_organization_id
      AND activation.policy_key = p_policy_key
      AND activation.activated_policy_version_id = p_target_policy_version_id
  )
  INTO v_was_previously_active;

  IF v_was_previously_active THEN
    IF p_activation_request_id IS NOT NULL THEN
      RAISE EXCEPTION 'revert activation must not use a new-version request'
        USING ERRCODE = '23514';
    END IF;
    v_mode := 'revert';
  ELSE
    IF p_activation_request_id IS NULL THEN
      RAISE EXCEPTION 'new policy activation requires a second-actor request'
        USING ERRCODE = '23514';
    END IF;

    SELECT *
    INTO v_request
    FROM approval_policy_activation_requests
    WHERE id = p_activation_request_id
      AND organization_id = p_organization_id
      AND policy_key = p_policy_key
      AND target_policy_version_id = p_target_policy_version_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'matching activation request not found'
        USING ERRCODE = 'P0002';
    END IF;

    IF v_request.requested_by_user_id = current_request_user_id() THEN
      RAISE EXCEPTION 'new policy activation requires two distinct actors'
        USING ERRCODE = '42501';
    END IF;

    IF v_target.created_by_user_id = current_request_user_id() THEN
      RAISE EXCEPTION 'policy author cannot activate the authored version'
        USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM approval_policy_activations activation
      WHERE activation.activation_request_id = p_activation_request_id
    ) THEN
      RAISE EXCEPTION 'activation request was already consumed'
        USING ERRCODE = '23505';
    END IF;

    v_mode := 'new_version';
  END IF;

  v_next_binding_version := v_binding.binding_version + 1;
  PERFORM set_config(
    'app.approval_policy_activation_guard',
    'activate_approval_policy:v1',
    true
  );

  UPDATE approval_policy_bindings
  SET
    active_policy_version_id = p_target_policy_version_id,
    binding_version = v_next_binding_version,
    activated_by_user_id = current_request_user_id(),
    activated_at = now()
  WHERE organization_id = p_organization_id
    AND policy_key = p_policy_key;

  INSERT INTO approval_policy_activations (
    id,
    organization_id,
    policy_key,
    previous_policy_version_id,
    activated_policy_version_id,
    activation_request_id,
    activation_mode,
    binding_version,
    activated_by_user_id,
    reason,
    command_id,
    trace_id
  )
  VALUES (
    p_activation_id,
    p_organization_id,
    p_policy_key,
    v_binding.active_policy_version_id,
    p_target_policy_version_id,
    p_activation_request_id,
    v_mode,
    v_next_binding_version,
    current_request_user_id(),
    p_reason,
    p_command_id,
    p_trace_id
  );

  PERFORM set_config('app.approval_policy_activation_guard', '', true);

  RETURN QUERY
  SELECT
    p_activation_id,
    v_binding.active_policy_version_id,
    p_target_policy_version_id,
    v_mode,
    v_next_binding_version;
END;
$$;

-- Approval decisions are immutable facts. approvals.status is a guarded
-- current-state projection updated only by resolve_approval_workflow.
ALTER TABLE approvals
  ADD COLUMN policy_version_id uuid,
  ADD COLUMN policy_content_hash text,
  ADD COLUMN decided_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN decision_reason text,
  ADD COLUMN decision_trace_id text,
  ADD CONSTRAINT approvals_policy_version_fk
    FOREIGN KEY (policy_version_id, organization_id)
    REFERENCES approval_policy_versions(id, organization_id)
    ON DELETE RESTRICT;

CREATE TABLE approval_resolutions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  approval_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  task_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason text NOT NULL CHECK (length(btrim(reason)) >= 3),
  resolved_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  policy_version_id uuid NOT NULL,
  policy_content_hash text NOT NULL CHECK (length(policy_content_hash) = 64),
  resulting_workflow_state text NOT NULL
    CHECK (resulting_workflow_state IN ('completed', 'rejected')),
  command_id text NOT NULL,
  trace_id text NOT NULL,
  request_id text NOT NULL,
  resolved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, command_id),
  UNIQUE (id, organization_id),
  FOREIGN KEY (approval_id, organization_id)
    REFERENCES approvals(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (workflow_id, organization_id)
    REFERENCES workflows(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (task_id, organization_id)
    REFERENCES tasks(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (policy_version_id, organization_id)
    REFERENCES approval_policy_versions(id, organization_id) ON DELETE RESTRICT
);

CREATE TRIGGER approval_resolutions_are_immutable
  BEFORE UPDATE OR DELETE ON approval_resolutions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE OR REPLACE FUNCTION guard_approval_resolution_projection()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
     OR NEW.decided_by_user_id IS DISTINCT FROM OLD.decided_by_user_id
     OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason
     OR NEW.decision_trace_id IS DISTINCT FROM OLD.decision_trace_id THEN
    IF current_setting('app.approval_resolution_guard', true)
       IS DISTINCT FROM 'resolve_approval_workflow:v1' THEN
      RAISE EXCEPTION 'approval decision must use resolve_approval_workflow'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER approvals_resolution_requires_guard
  BEFORE UPDATE OF
    status,
    decided_at,
    decided_by_user_id,
    decision_reason,
    decision_trace_id
  ON approvals
  FOR EACH ROW EXECUTE FUNCTION guard_approval_resolution_projection();

-- Update the sole workflow-state writer with Phase 2 approval projections.
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
      WHEN p_to_state = 'approved' THEN 'approved'
      WHEN p_to_state = 'rejected' THEN 'rejected'
      WHEN p_to_state = 'completed' AND approval_required = false
        THEN 'not_required'
      ELSE approval_status
    END,
    completed_at = CASE
      WHEN p_to_state IN ('completed', 'rejected') THEN now()
      ELSE completed_at
    END,
    updated_at = now()
  WHERE id = current_workflow.id
    AND organization_id = current_workflow.organization_id;

  IF current_workflow.task_id IS NOT NULL THEN
    UPDATE tasks
    SET
      status = p_to_state,
      updated_at = now(),
      version = version + 1
    WHERE id = current_workflow.task_id
      AND organization_id = current_workflow.organization_id;
  END IF;

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

CREATE OR REPLACE FUNCTION resolve_approval_workflow(
  p_resolution_id uuid,
  p_approval_id uuid,
  p_organization_id uuid,
  p_decision text,
  p_reason text,
  p_command_id text,
  p_trace_id text,
  p_request_id text,
  p_input_hash text,
  p_output_hash text
)
RETURNS TABLE (
  resolution_id uuid,
  approval_id uuid,
  workflow_id uuid,
  task_id uuid,
  decision text,
  resulting_workflow_state text,
  policy_version_id uuid,
  policy_content_hash text,
  resolved_by_user_id uuid,
  workflow_version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = operating_layer, public
AS $$
DECLARE
  v_approval approvals%ROWTYPE;
  v_workflow workflows%ROWTYPE;
  v_next_version integer;
  v_resulting_state text;
BEGIN
  IF NOT current_request_user_has_permission(
    p_organization_id,
    'approvals.decide'
  ) THEN
    RAISE EXCEPTION 'approval decision permission denied'
      USING ERRCODE = '42501';
  END IF;

  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'approval decision must be approved or rejected'
      USING ERRCODE = '22023';
  END IF;

  IF length(btrim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'approval reason must contain at least 3 characters'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO v_approval
  FROM approvals
  WHERE id = p_approval_id
    AND organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_approval.status <> 'pending' THEN
    RAISE EXCEPTION 'approval is not pending'
      USING ERRCODE = '23514';
  END IF;

  IF v_approval.policy_version_id IS NULL
     OR v_approval.policy_content_hash IS NULL THEN
    RAISE EXCEPTION 'approval is missing an immutable policy version'
      USING ERRCODE = '23514';
  END IF;

  SELECT *
  INTO v_workflow
  FROM workflows
  WHERE id = v_approval.workflow_id
    AND organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND OR v_workflow.current_state <> 'awaiting_approval' THEN
    RAISE EXCEPTION 'workflow is not awaiting approval'
      USING ERRCODE = '23514';
  END IF;

  PERFORM set_config(
    'app.approval_resolution_guard',
    'resolve_approval_workflow:v1',
    true
  );

  UPDATE approvals
  SET
    status = p_decision,
    decided_at = now(),
    decided_by_user_id = current_request_user_id(),
    decision_reason = p_reason,
    decision_trace_id = p_trace_id,
    comments = p_reason,
    version = version + 1
  WHERE id = p_approval_id
    AND organization_id = p_organization_id;

  PERFORM set_config('app.approval_resolution_guard', '', true);

  IF p_decision = 'approved' THEN
    SELECT transition.workflow_version
    INTO v_next_version
    FROM transition_workflow(
      v_workflow.id,
      p_organization_id,
      p_command_id || ':approved',
      v_workflow.version,
      'approved',
      'user',
      current_request_user_id()::text,
      p_input_hash,
      p_output_hash,
      p_trace_id,
      jsonb_build_object(
        'approvalId', p_approval_id,
        'resolutionId', p_resolution_id,
        'decision', p_decision
      )
    ) transition;

    SELECT transition.workflow_version
    INTO v_next_version
    FROM transition_workflow(
      v_workflow.id,
      p_organization_id,
      p_command_id || ':completed',
      v_next_version,
      'completed',
      'user',
      current_request_user_id()::text,
      p_input_hash,
      p_output_hash,
      p_trace_id,
      jsonb_build_object(
        'approvalId', p_approval_id,
        'resolutionId', p_resolution_id,
        'decision', p_decision,
        'internalOnly', true
      )
    ) transition;
    v_resulting_state := 'completed';
  ELSE
    SELECT transition.workflow_version
    INTO v_next_version
    FROM transition_workflow(
      v_workflow.id,
      p_organization_id,
      p_command_id || ':rejected',
      v_workflow.version,
      'rejected',
      'user',
      current_request_user_id()::text,
      p_input_hash,
      p_output_hash,
      p_trace_id,
      jsonb_build_object(
        'approvalId', p_approval_id,
        'resolutionId', p_resolution_id,
        'decision', p_decision
      )
    ) transition;
    v_resulting_state := 'rejected';
  END IF;

  INSERT INTO approval_resolutions (
    id,
    organization_id,
    approval_id,
    workflow_id,
    task_id,
    decision,
    reason,
    resolved_by_user_id,
    policy_version_id,
    policy_content_hash,
    resulting_workflow_state,
    command_id,
    trace_id,
    request_id
  )
  VALUES (
    p_resolution_id,
    p_organization_id,
    p_approval_id,
    v_workflow.id,
    v_workflow.task_id,
    p_decision,
    p_reason,
    current_request_user_id(),
    v_approval.policy_version_id,
    v_approval.policy_content_hash,
    v_resulting_state,
    p_command_id,
    p_trace_id,
    p_request_id
  );

  RETURN QUERY
  SELECT
    p_resolution_id,
    p_approval_id,
    v_workflow.id,
    v_workflow.task_id,
    p_decision,
    v_resulting_state,
    v_approval.policy_version_id,
    v_approval.policy_content_hash,
    current_request_user_id(),
    v_next_version;
END;
$$;

CREATE OR REPLACE FUNCTION verify_policy_activation_audited()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.activation_mode <> 'bootstrap'
     AND NOT EXISTS (
       SELECT 1
       FROM audit_events event
       WHERE event.organization_id = NEW.organization_id
         AND event.event_type = 'approval_policy.activated'
         AND event.metadata ->> 'activationId' = NEW.id::text
     ) THEN
    RAISE EXCEPTION 'policy activation % has no audit event', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER approval_policy_activation_requires_audit
  AFTER INSERT ON approval_policy_activations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION verify_policy_activation_audited();

CREATE OR REPLACE FUNCTION verify_approval_resolution_audited()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM audit_events event
    WHERE event.organization_id = NEW.organization_id
      AND event.event_type = 'approval.' || NEW.decision
      AND event.metadata ->> 'resolutionId' = NEW.id::text
  ) THEN
    RAISE EXCEPTION 'approval resolution % has no audit event', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER approval_resolution_requires_audit
  AFTER INSERT ON approval_resolutions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION verify_approval_resolution_audited();

-- New organization-scoped tables receive forced RLS.
DO $$
DECLARE
  table_name text;
  isolated_tables text[] := ARRAY[
    'idempotency_retention_policy_versions',
    'idempotency_retention_policy_bindings',
    'approval_policy_versions',
    'approval_policy_rules',
    'approval_policy_bindings',
    'approval_policy_activation_requests',
    'approval_policy_activations',
    'approval_resolutions'
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

GRANT SELECT
  ON idempotency_retention_policy_versions,
     idempotency_retention_policy_bindings,
     approval_policy_versions,
     approval_policy_rules,
     approval_policy_bindings,
     approval_policy_activation_requests,
     approval_policy_activations,
     approval_resolutions,
     idempotency_reaper_runs
  TO operating_layer_app;

GRANT EXECUTE ON FUNCTION create_approval_policy_version(
  uuid,
  uuid,
  text,
  integer,
  text,
  text,
  text,
  text,
  uuid,
  jsonb
) TO operating_layer_app;

GRANT EXECUTE ON FUNCTION request_approval_policy_activation(
  uuid,
  uuid,
  text,
  uuid,
  text,
  text,
  text
) TO operating_layer_app;

GRANT EXECUTE ON FUNCTION activate_approval_policy(
  uuid,
  uuid,
  text,
  uuid,
  uuid,
  text,
  text,
  text
) TO operating_layer_app;

GRANT EXECUTE ON FUNCTION resolve_approval_workflow(
  uuid,
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) TO operating_layer_app;

REVOKE INSERT, UPDATE, DELETE
  ON idempotency_retention_policy_versions,
     idempotency_retention_policy_bindings,
     approval_policy_versions,
     approval_policy_rules,
     approval_policy_bindings,
     approval_policy_activation_requests,
     approval_policy_activations,
     approval_resolutions,
     idempotency_reaper_runs
  FROM operating_layer_app;

REVOKE UPDATE ON approvals FROM operating_layer_app;

COMMIT;
