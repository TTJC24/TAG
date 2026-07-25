BEGIN;

SET search_path TO operating_layer, public;

-- tasks.status is the transactionally maintained projection of the task's
-- authoritative workflow state.
ALTER TABLE tasks
  DROP CONSTRAINT tasks_status_check;

ALTER TABLE tasks
  ALTER COLUMN status SET DEFAULT 'received';

UPDATE tasks task
SET status = workflow.current_state
FROM workflows workflow
WHERE workflow.task_id = task.id
  AND workflow.organization_id = task.organization_id
  AND task.status IS DISTINCT FROM workflow.current_state;

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
      'blocked',
      'failed',
      'cancelled'
    )
  );

CREATE OR REPLACE FUNCTION guard_task_status_projection()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'received' THEN
      RAISE EXCEPTION 'new task status must start at received'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status
    AND current_setting('app.workflow_transition_guard', true)
      IS DISTINCT FROM 'transition_workflow:v1' THEN
    RAISE EXCEPTION 'task status must be changed through transition_workflow'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER tasks_status_requires_transition_function
  BEFORE INSERT OR UPDATE OF status ON tasks
  FOR EACH ROW EXECUTE FUNCTION guard_task_status_projection();

CREATE OR REPLACE FUNCTION verify_task_workflow_projection()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  projected_task_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'tasks' THEN
    projected_task_id := NEW.id;

    IF NOT EXISTS (
      SELECT 1
      FROM workflows workflow
      WHERE workflow.task_id = projected_task_id
        AND workflow.organization_id = NEW.organization_id
    ) THEN
      RAISE EXCEPTION 'task % has no authoritative workflow', projected_task_id
        USING ERRCODE = '23514';
    END IF;
  ELSE
    projected_task_id := NEW.task_id;
  END IF;

  IF projected_task_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM workflows workflow
    JOIN tasks task
      ON task.id = workflow.task_id
     AND task.organization_id = workflow.organization_id
    WHERE workflow.task_id = projected_task_id
      AND task.status IS DISTINCT FROM workflow.current_state
  ) THEN
    RAISE EXCEPTION 'task status projection drift detected for task %',
      projected_task_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER tasks_status_projection_matches_workflow
  AFTER INSERT OR UPDATE ON tasks
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION verify_task_workflow_projection();

CREATE CONSTRAINT TRIGGER workflows_state_matches_task_projection
  AFTER INSERT OR UPDATE ON workflows
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION verify_task_workflow_projection();

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

-- The application role may update task attributes, but never the workflow
-- projection column. transition_workflow is SECURITY DEFINER and is the sole
-- post-insert writer of tasks.status.
REVOKE UPDATE ON tasks FROM operating_layer_app;
GRANT UPDATE (
  title,
  description,
  task_type,
  priority,
  priority_score,
  owner_user_id,
  due_date,
  financial_exposure,
  financial_exposure_currency,
  confidence,
  updated_at,
  version
) ON tasks TO operating_layer_app;

-- A non-owner, non-bypass login role is provisioned without credentials.
-- Environment-specific provisioning enables LOGIN and supplies the secret.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'operating_layer_runtime'
  ) THEN
    CREATE ROLE operating_layer_runtime NOLOGIN NOSUPERUSER NOCREATEDB
      NOCREATEROLE INHERIT NOBYPASSRLS;
  END IF;
END;
$$;

GRANT operating_layer_app TO operating_layer_runtime;

-- Workers claim globally available commands through this narrow dispatcher
-- function, then reload and process the job inside an explicit organization
-- scope. The runtime login never receives unrestricted table ownership.
CREATE OR REPLACE FUNCTION claim_outbox_job(p_worker_id text)
RETURNS TABLE (
  id uuid,
  organization_id uuid,
  topic text,
  aggregate_id uuid,
  idempotency_key text,
  trace_id text,
  requested_by_user_id uuid,
  request_id text,
  attempts integer,
  max_attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = operating_layer, public
AS $$
BEGIN
  UPDATE outbox_events event
  SET
    status = 'failed',
    locked_at = NULL,
    locked_by = NULL,
    safe_error_message = 'Worker lease expired before completion',
    last_error_code = 'lease_expired',
    available_at = now()
  WHERE event.status = 'processing'
    AND event.locked_at < now() - interval '5 minutes';

  RETURN QUERY
  WITH candidate AS (
    SELECT event.id
    FROM outbox_events event
    WHERE event.status IN ('pending', 'failed')
      AND event.available_at <= now()
      AND event.attempts < event.max_attempts
      AND event.requested_by_user_id IS NOT NULL
      AND event.request_id IS NOT NULL
    ORDER BY event.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE outbox_events event
  SET
    status = 'processing',
    attempts = event.attempts + 1,
    locked_at = now(),
    locked_by = p_worker_id,
    last_attempt_at = now()
  FROM candidate
  WHERE event.id = candidate.id
  RETURNING
    event.id,
    event.organization_id,
    event.topic,
    event.aggregate_id,
    event.idempotency_key,
    event.trace_id,
    event.requested_by_user_id,
    event.request_id,
    event.attempts,
    event.max_attempts;
END;
$$;

REVOKE ALL ON FUNCTION claim_outbox_job(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_outbox_job(text)
  TO operating_layer_runtime;

COMMIT;
