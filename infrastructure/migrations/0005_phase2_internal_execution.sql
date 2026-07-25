BEGIN;

SET search_path TO operating_layer, public;

-- Approval is no longer completion. Approved work must pass through the
-- guarded internal execution lifecycle before reaching a real terminal state.
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
      'executing',
      'completed',
      'execution_failed',
      'rejected',
      'action_queued',
      'blocked',
      'failed',
      'cancelled'
    )
  );

DELETE FROM workflow_allowed_transitions
WHERE workflow_type = 'issue_intake'
  AND from_state = 'approved'
  AND to_state = 'completed';

INSERT INTO workflow_allowed_transitions (
  workflow_type,
  from_state,
  to_state
)
VALUES
  ('issue_intake', 'approved', 'executing'),
  ('issue_intake', 'executing', 'completed'),
  ('issue_intake', 'executing', 'execution_failed')
ON CONFLICT DO NOTHING;

ALTER TABLE approval_resolutions
  DROP CONSTRAINT approval_resolutions_resulting_workflow_state_check;

ALTER TABLE approval_resolutions
  ADD CONSTRAINT approval_resolutions_resulting_workflow_state_check
  CHECK (
    resulting_workflow_state IN ('approved', 'completed', 'rejected')
  );

CREATE TABLE execution_commands (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  workflow_id uuid NOT NULL,
  task_id uuid NOT NULL,
  approval_id uuid NOT NULL,
  recommendation_id uuid NOT NULL,
  action_type text NOT NULL,
  action_summary text NOT NULL,
  action_payload_reference text NOT NULL,
  action_payload_hash text NOT NULL CHECK (length(action_payload_hash) = 64),
  provider_name text NOT NULL
    CHECK (provider_name = 'deterministic_internal'),
  requested_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  trace_id text NOT NULL,
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  UNIQUE (organization_id, approval_id),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (workflow_id, organization_id)
    REFERENCES workflows(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (task_id, organization_id)
    REFERENCES tasks(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (approval_id, organization_id)
    REFERENCES approvals(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (recommendation_id, organization_id)
    REFERENCES recommendations(id, organization_id) ON DELETE RESTRICT
);

CREATE TABLE execution_results (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  execution_command_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  task_id uuid NOT NULL,
  approval_id uuid NOT NULL,
  recommendation_id uuid NOT NULL,
  executor_provider text NOT NULL,
  executor_id text NOT NULL,
  action_type text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  outcome_summary text NOT NULL,
  output_payload jsonb NOT NULL,
  output_hash text NOT NULL CHECK (length(output_hash) = 64),
  error_code text,
  safe_error_message text,
  resulting_workflow_state text NOT NULL
    CHECK (
      resulting_workflow_state IN ('completed', 'execution_failed')
    ),
  trace_id text NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  UNIQUE (organization_id, execution_command_id),
  FOREIGN KEY (execution_command_id, organization_id)
    REFERENCES execution_commands(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (workflow_id, organization_id)
    REFERENCES workflows(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (task_id, organization_id)
    REFERENCES tasks(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (approval_id, organization_id)
    REFERENCES approvals(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (recommendation_id, organization_id)
    REFERENCES recommendations(id, organization_id) ON DELETE RESTRICT,
  CHECK (completed_at >= started_at),
  CHECK (
    (outcome = 'succeeded'
      AND resulting_workflow_state = 'completed'
      AND error_code IS NULL
      AND safe_error_message IS NULL)
    OR
    (outcome = 'failed'
      AND resulting_workflow_state = 'execution_failed'
      AND error_code IS NOT NULL
      AND safe_error_message IS NOT NULL)
  )
);

CREATE INDEX execution_commands_org_created_idx
  ON execution_commands (organization_id, created_at DESC);

CREATE INDEX execution_results_org_completed_idx
  ON execution_results (organization_id, completed_at DESC);

CREATE TRIGGER execution_commands_are_immutable
  BEFORE UPDATE OR DELETE ON execution_commands
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE TRIGGER execution_results_are_immutable
  BEFORE UPDATE OR DELETE ON execution_results
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

-- The sole workflow writer now recognizes execution states and requires an
-- immutable authorized command/result before entering or leaving execution.
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
  v_execution_command_id uuid;
  v_execution_result_id uuid;
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

  IF current_workflow.current_state = 'approved'
     AND p_to_state = 'executing' THEN
    BEGIN
      v_execution_command_id :=
        NULLIF(p_metadata ->> 'executionCommandId', '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_execution_command_id := NULL;
    END;

    IF v_execution_command_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM execution_commands command
      JOIN approvals approval
        ON approval.id = command.approval_id
       AND approval.organization_id = command.organization_id
      WHERE command.id = v_execution_command_id
        AND command.workflow_id = current_workflow.id
        AND command.organization_id = current_workflow.organization_id
        AND approval.status = 'approved'
    ) THEN
      RAISE EXCEPTION
        'approved -> executing requires an authorized execution command'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF current_workflow.current_state = 'executing'
     AND p_to_state IN ('completed', 'execution_failed') THEN
    BEGIN
      v_execution_result_id :=
        NULLIF(p_metadata ->> 'executionResultId', '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_execution_result_id := NULL;
    END;

    IF v_execution_result_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM execution_results result
      WHERE result.id = v_execution_result_id
        AND result.workflow_id = current_workflow.id
        AND result.organization_id = current_workflow.organization_id
        AND result.resulting_workflow_state = p_to_state
    ) THEN
      RAISE EXCEPTION
        'execution terminal transition requires an immutable execution result'
        USING ERRCODE = '42501';
    END IF;
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
      WHEN p_to_state IN ('completed', 'execution_failed', 'rejected') THEN now()
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

-- Approving now records authorization and stops at approved. Completion is
-- reserved for the executor's immutable successful result.
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

  v_resulting_state := p_decision;

  SELECT transition.workflow_version
  INTO v_next_version
  FROM transition_workflow(
    v_workflow.id,
    p_organization_id,
    p_command_id || ':' || p_decision,
    v_workflow.version,
    v_resulting_state,
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

CREATE OR REPLACE FUNCTION enqueue_internal_execution(
  p_execution_command_id uuid,
  p_approval_id uuid,
  p_organization_id uuid,
  p_provider_name text,
  p_idempotency_key text,
  p_trace_id text,
  p_request_id text
)
RETURNS TABLE (
  execution_command_id uuid,
  outbox_event_id uuid,
  workflow_id uuid,
  task_id uuid,
  approval_id uuid,
  recommendation_id uuid,
  action_type text,
  action_summary text,
  action_payload_hash text,
  policy_version_id uuid,
  policy_content_hash text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = operating_layer, public
AS $$
DECLARE
  v_approval approvals%ROWTYPE;
  v_workflow workflows%ROWTYPE;
  v_recommendation recommendations%ROWTYPE;
  v_outbox_event_id uuid := gen_random_uuid();
BEGIN
  IF NOT current_request_user_has_permission(
    p_organization_id,
    'executions.trigger'
  ) THEN
    RAISE EXCEPTION 'execution trigger permission denied'
      USING ERRCODE = '42501';
  END IF;

  IF p_provider_name <> 'deterministic_internal' THEN
    RAISE EXCEPTION 'only deterministic internal execution is enabled'
      USING ERRCODE = '42501';
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

  SELECT *
  INTO v_workflow
  FROM workflows
  WHERE id = v_approval.workflow_id
    AND organization_id = p_organization_id
  FOR UPDATE;

  IF v_approval.status <> 'approved'
     OR v_workflow.current_state <> 'approved' THEN
    RAISE EXCEPTION 'only an approved workflow can be executed'
      USING ERRCODE = '23514';
  END IF;

  SELECT *
  INTO v_recommendation
  FROM recommendations recommendation
  WHERE recommendation.task_id = v_workflow.task_id
    AND recommendation.organization_id = p_organization_id
    AND v_approval.payload_reference =
      'recommendation:' || recommendation.id::text
  ORDER BY recommendation.created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval recommendation was not found'
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO execution_commands (
    id,
    organization_id,
    workflow_id,
    task_id,
    approval_id,
    recommendation_id,
    action_type,
    action_summary,
    action_payload_reference,
    action_payload_hash,
    provider_name,
    requested_by_user_id,
    idempotency_key,
    trace_id,
    request_id
  )
  VALUES (
    p_execution_command_id,
    p_organization_id,
    v_workflow.id,
    v_workflow.task_id,
    v_approval.id,
    v_recommendation.id,
    v_approval.action_type,
    v_recommendation.summary,
    v_approval.payload_reference,
    v_approval.payload_hash,
    p_provider_name,
    current_request_user_id(),
    p_idempotency_key,
    p_trace_id,
    p_request_id
  );

  INSERT INTO outbox_events (
    id,
    organization_id,
    topic,
    aggregate_type,
    aggregate_id,
    payload_reference,
    payload_hash,
    idempotency_key,
    trace_id,
    requested_by_user_id,
    request_id,
    max_attempts
  )
  VALUES (
    v_outbox_event_id,
    p_organization_id,
    'issue.execute',
    'execution_command',
    p_execution_command_id,
    'postgresql://operating_layer/execution_commands/'
      || p_execution_command_id::text,
    encode(
      digest(
        jsonb_build_object(
          'executionCommandId', p_execution_command_id,
          'approvalId', p_approval_id,
          'payloadHash', v_approval.payload_hash
        )::text,
        'sha256'
      ),
      'hex'
    ),
    p_execution_command_id::text || ':execute',
    p_trace_id,
    current_request_user_id(),
    p_request_id,
    3
  );

  RETURN QUERY
  SELECT
    p_execution_command_id,
    v_outbox_event_id,
    v_workflow.id,
    v_workflow.task_id,
    v_approval.id,
    v_recommendation.id,
    v_approval.action_type,
    v_recommendation.summary,
    v_approval.payload_hash,
    v_approval.policy_version_id,
    v_approval.policy_content_hash;
END;
$$;

CREATE OR REPLACE FUNCTION begin_internal_execution(
  p_execution_command_id uuid,
  p_organization_id uuid,
  p_input_hash text,
  p_trace_id text
)
RETURNS TABLE (
  workflow_id uuid,
  task_id uuid,
  workflow_state text,
  workflow_version integer,
  did_transition boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = operating_layer, public
AS $$
DECLARE
  v_command execution_commands%ROWTYPE;
  v_workflow workflows%ROWTYPE;
  v_next_version integer;
BEGIN
  IF NOT current_user_can_access_organization(p_organization_id) THEN
    RAISE EXCEPTION 'organization access denied'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
  INTO v_command
  FROM execution_commands
  WHERE id = p_execution_command_id
    AND organization_id = p_organization_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'execution command not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM execution_results result
    WHERE result.execution_command_id = v_command.id
      AND result.organization_id = v_command.organization_id
  ) THEN
    RAISE EXCEPTION 'execution command already has a terminal result'
      USING ERRCODE = '23514';
  END IF;

  SELECT *
  INTO v_workflow
  FROM workflows
  WHERE id = v_command.workflow_id
    AND organization_id = v_command.organization_id
  FOR UPDATE;

  IF v_workflow.current_state = 'approved' THEN
    SELECT transition.workflow_version
    INTO v_next_version
    FROM transition_workflow(
      v_workflow.id,
      v_workflow.organization_id,
      v_command.id::text || ':executing',
      v_workflow.version,
      'executing',
      'service',
      'internal-execution-worker',
      p_input_hash,
      NULL,
      p_trace_id,
      jsonb_build_object(
        'taskId', v_command.task_id,
        'approvalId', v_command.approval_id,
        'executionCommandId', v_command.id
      )
    ) transition;

    RETURN QUERY
    SELECT
      v_workflow.id,
      v_workflow.task_id,
      'executing'::text,
      v_next_version,
      true;
    RETURN;
  END IF;

  IF v_workflow.current_state <> 'executing' THEN
    RAISE EXCEPTION 'only an approved workflow can begin execution'
      USING ERRCODE = '23514';
  END IF;

  RETURN QUERY
  SELECT
    v_workflow.id,
    v_workflow.task_id,
    v_workflow.current_state,
    v_workflow.version,
    false;
END;
$$;

CREATE OR REPLACE FUNCTION finalize_internal_execution(
  p_execution_result_id uuid,
  p_execution_command_id uuid,
  p_organization_id uuid,
  p_executor_provider text,
  p_executor_id text,
  p_outcome text,
  p_outcome_summary text,
  p_output_payload jsonb,
  p_output_hash text,
  p_error_code text,
  p_safe_error_message text,
  p_started_at timestamptz,
  p_completed_at timestamptz,
  p_trace_id text
)
RETURNS TABLE (
  execution_result_id uuid,
  workflow_id uuid,
  task_id uuid,
  approval_id uuid,
  recommendation_id uuid,
  resulting_workflow_state text,
  workflow_version integer,
  policy_version_id uuid,
  policy_content_hash text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = operating_layer, public
AS $$
DECLARE
  v_command execution_commands%ROWTYPE;
  v_workflow workflows%ROWTYPE;
  v_approval approvals%ROWTYPE;
  v_resulting_state text;
  v_next_version integer;
BEGIN
  IF NOT current_user_can_access_organization(p_organization_id) THEN
    RAISE EXCEPTION 'organization access denied'
      USING ERRCODE = '42501';
  END IF;

  IF p_outcome NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'execution outcome must be succeeded or failed'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO v_command
  FROM execution_commands
  WHERE id = p_execution_command_id
    AND organization_id = p_organization_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'execution command not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF p_executor_provider <> v_command.provider_name THEN
    RAISE EXCEPTION 'executor provider does not match the authorized command'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
  INTO v_approval
  FROM approvals
  WHERE id = v_command.approval_id
    AND organization_id = v_command.organization_id;

  IF v_approval.status <> 'approved' THEN
    RAISE EXCEPTION 'execution approval is no longer approved'
      USING ERRCODE = '23514';
  END IF;

  SELECT *
  INTO v_workflow
  FROM workflows
  WHERE id = v_command.workflow_id
    AND organization_id = v_command.organization_id
  FOR UPDATE;

  IF v_workflow.current_state <> 'executing' THEN
    RAISE EXCEPTION 'workflow is not executing'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM execution_results result
    WHERE result.execution_command_id = v_command.id
      AND result.organization_id = v_command.organization_id
  ) THEN
    RAISE EXCEPTION 'execution command already has a terminal result'
      USING ERRCODE = '23514';
  END IF;

  v_resulting_state := CASE
    WHEN p_outcome = 'succeeded' THEN 'completed'
    ELSE 'execution_failed'
  END;

  INSERT INTO execution_results (
    id,
    organization_id,
    execution_command_id,
    workflow_id,
    task_id,
    approval_id,
    recommendation_id,
    executor_provider,
    executor_id,
    action_type,
    outcome,
    outcome_summary,
    output_payload,
    output_hash,
    error_code,
    safe_error_message,
    resulting_workflow_state,
    trace_id,
    started_at,
    completed_at
  )
  VALUES (
    p_execution_result_id,
    p_organization_id,
    v_command.id,
    v_command.workflow_id,
    v_command.task_id,
    v_command.approval_id,
    v_command.recommendation_id,
    p_executor_provider,
    p_executor_id,
    v_command.action_type,
    p_outcome,
    p_outcome_summary,
    p_output_payload,
    p_output_hash,
    p_error_code,
    p_safe_error_message,
    v_resulting_state,
    p_trace_id,
    p_started_at,
    p_completed_at
  );

  SELECT transition.workflow_version
  INTO v_next_version
  FROM transition_workflow(
    v_workflow.id,
    v_workflow.organization_id,
    v_command.id::text || ':' || v_resulting_state,
    v_workflow.version,
    v_resulting_state,
    'service',
    p_executor_id,
    v_command.action_payload_hash,
    p_output_hash,
    p_trace_id,
    jsonb_build_object(
      'taskId', v_command.task_id,
      'approvalId', v_command.approval_id,
      'executionCommandId', v_command.id,
      'executionResultId', p_execution_result_id,
      'outcome', p_outcome
    )
  ) transition;

  RETURN QUERY
  SELECT
    p_execution_result_id,
    v_workflow.id,
    v_command.task_id,
    v_command.approval_id,
    v_command.recommendation_id,
    v_resulting_state,
    v_next_version,
    v_approval.policy_version_id,
    v_approval.policy_content_hash;
END;
$$;

CREATE OR REPLACE FUNCTION verify_execution_command_audited()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM audit_events event
    WHERE event.organization_id = NEW.organization_id
      AND event.event_type = 'execution.requested'
      AND event.metadata ->> 'executionCommandId' = NEW.id::text
  ) THEN
    RAISE EXCEPTION 'execution command % has no audit event', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER execution_command_requires_audit
  AFTER INSERT ON execution_commands
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION verify_execution_command_audited();

CREATE OR REPLACE FUNCTION verify_execution_result_audited()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM audit_events event
    WHERE event.organization_id = NEW.organization_id
      AND event.event_type = 'execution.' || NEW.outcome
      AND event.metadata ->> 'executionResultId' = NEW.id::text
  ) THEN
    RAISE EXCEPTION 'execution result % has no audit event', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER execution_result_requires_audit
  AFTER INSERT ON execution_results
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION verify_execution_result_audited();

ALTER TABLE execution_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON execution_commands
  FOR ALL
  USING (current_user_can_access_organization(organization_id))
  WITH CHECK (current_user_can_access_organization(organization_id));

ALTER TABLE execution_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_results FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON execution_results
  FOR ALL
  USING (current_user_can_access_organization(organization_id))
  WITH CHECK (current_user_can_access_organization(organization_id));

GRANT SELECT ON execution_commands, execution_results TO operating_layer_app;
REVOKE INSERT, UPDATE, DELETE
  ON execution_commands, execution_results
  FROM operating_layer_app;

GRANT EXECUTE ON FUNCTION enqueue_internal_execution(
  uuid,
  uuid,
  uuid,
  text,
  text,
  text,
  text
) TO operating_layer_app;

GRANT EXECUTE ON FUNCTION begin_internal_execution(
  uuid,
  uuid,
  text,
  text
) TO operating_layer_app;

GRANT EXECUTE ON FUNCTION finalize_internal_execution(
  uuid,
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  jsonb,
  text,
  text,
  text,
  timestamptz,
  timestamptz,
  text
) TO operating_layer_app;

COMMIT;
