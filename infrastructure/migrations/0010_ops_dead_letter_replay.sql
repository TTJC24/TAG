-- 0010: operator dead-letter replay for internal executions.
--
-- Adds a permitted, audited path to replay a deterministic-internal execution
-- that exhausted its retries and landed in a dead-lettered outbox job with the
-- workflow terminal in `execution_failed`. Replay mints a NEW immutable
-- execution command against the still-approved approval (the original command
-- keeps its immutable execution_failed result), re-opens the terminal state via
-- a DB-enforced `execution_failed -> executing` transition, and enqueues a
-- fresh job. No immutable row is mutated; the original dead-letter stays as
-- history.

BEGIN;

SET search_path TO operating_layer, public;

-- 1. Allow the re-open transition for the issue_intake workflow type.
INSERT INTO workflow_allowed_transitions (workflow_type, from_state, to_state)
VALUES ('issue_intake', 'execution_failed', 'executing')
ON CONFLICT (workflow_type, from_state, to_state) DO NOTHING;

-- 2. Immutable replay-linkage record, org-scoped and audit-required.
CREATE TABLE execution_replays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  workflow_id uuid NOT NULL,
  task_id uuid NOT NULL,
  approval_id uuid NOT NULL,
  original_execution_command_id uuid NOT NULL,
  replay_execution_command_id uuid NOT NULL,
  dead_letter_event_id uuid NOT NULL,
  replayed_by_user_id text NOT NULL,
  trace_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, replay_execution_command_id),
  UNIQUE (organization_id, dead_letter_event_id),
  FOREIGN KEY (replay_execution_command_id, organization_id)
    REFERENCES execution_commands(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (original_execution_command_id, organization_id)
    REFERENCES execution_commands(id, organization_id) ON DELETE RESTRICT
);

CREATE INDEX execution_replays_org_created_idx
  ON execution_replays (organization_id, created_at DESC);

CREATE OR REPLACE FUNCTION execution_replays_are_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'execution_replays rows are immutable'
    USING ERRCODE = '23514';
  RETURN NULL;
END;
$$;

CREATE TRIGGER execution_replays_are_immutable
  BEFORE UPDATE OR DELETE ON execution_replays
  FOR EACH ROW EXECUTE FUNCTION execution_replays_are_immutable();

CREATE OR REPLACE FUNCTION verify_execution_replay_audited()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM audit_events event
    WHERE event.organization_id = NEW.organization_id
      AND event.event_type = 'execution.replay_requested'
      AND event.metadata ->> 'executionReplayId' = NEW.id::text
  ) THEN
    RAISE EXCEPTION 'execution_replay % has no matching audit event', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER execution_replay_requires_audit
  AFTER INSERT ON execution_replays
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION verify_execution_replay_audited();

ALTER TABLE execution_replays ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_replays FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON execution_replays
  FOR ALL
  USING (current_user_can_access_organization(organization_id))
  WITH CHECK (current_user_can_access_organization(organization_id));

GRANT SELECT ON execution_replays TO operating_layer_app;
REVOKE INSERT, UPDATE, DELETE ON execution_replays FROM operating_layer_app;

-- 3. Permission-gated replay: mint a fresh internal execution command for a
--    dead-lettered, execution_failed workflow.
CREATE OR REPLACE FUNCTION replay_internal_execution(
  p_replay_id uuid,
  p_replay_execution_command_id uuid,
  p_original_execution_command_id uuid,
  p_dead_letter_event_id uuid,
  p_organization_id uuid,
  p_provider_name text,
  p_idempotency_key text,
  p_trace_id text,
  p_request_id text
)
RETURNS TABLE (
  execution_replay_id uuid,
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
  v_original execution_commands%ROWTYPE;
  v_approval approvals%ROWTYPE;
  v_workflow workflows%ROWTYPE;
  v_outbox_event_id uuid := gen_random_uuid();
BEGIN
  IF NOT current_request_user_has_permission(
    p_organization_id,
    'executions.replay'
  ) THEN
    RAISE EXCEPTION 'execution replay permission denied'
      USING ERRCODE = '42501';
  END IF;

  IF p_provider_name <> 'deterministic_internal' THEN
    RAISE EXCEPTION 'only deterministic internal execution can be replayed'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
  INTO v_original
  FROM execution_commands
  WHERE id = p_original_execution_command_id
    AND organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'original execution command not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_original.provider_name <> 'deterministic_internal' THEN
    RAISE EXCEPTION 'only deterministic internal execution can be replayed'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
  INTO v_workflow
  FROM workflows
  WHERE id = v_original.workflow_id
    AND organization_id = p_organization_id
  FOR UPDATE;

  IF v_workflow.current_state <> 'execution_failed' THEN
    RAISE EXCEPTION 'only a failed execution can be replayed'
      USING ERRCODE = '23514';
  END IF;

  SELECT *
  INTO v_approval
  FROM approvals
  WHERE id = v_original.approval_id
    AND organization_id = p_organization_id;

  IF NOT FOUND OR v_approval.status <> 'approved' THEN
    RAISE EXCEPTION 'replay requires the original approval to remain approved'
      USING ERRCODE = '23514';
  END IF;

  -- The replayed job must correspond to a genuine dead letter for this command.
  IF NOT EXISTS (
    SELECT 1
    FROM outbox_events event
    WHERE event.id = p_dead_letter_event_id
      AND event.organization_id = p_organization_id
      AND event.topic = 'issue.execute'
      AND event.aggregate_id = p_original_execution_command_id
      AND event.status = 'dead_letter'
  ) THEN
    RAISE EXCEPTION 'no dead-lettered execution job for this command'
      USING ERRCODE = '23514';
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
    p_replay_execution_command_id,
    p_organization_id,
    v_original.workflow_id,
    v_original.task_id,
    v_original.approval_id,
    v_original.recommendation_id,
    v_original.action_type,
    v_original.action_summary,
    v_original.action_payload_reference,
    v_original.action_payload_hash,
    'deterministic_internal',
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
    p_replay_execution_command_id,
    'postgresql://operating_layer/execution_commands/'
      || p_replay_execution_command_id::text,
    encode(
      digest(
        jsonb_build_object(
          'executionCommandId', p_replay_execution_command_id,
          'approvalId', v_original.approval_id,
          'payloadHash', v_original.action_payload_hash
        )::text,
        'sha256'
      ),
      'hex'
    ),
    p_replay_execution_command_id::text || ':execute',
    p_trace_id,
    current_request_user_id(),
    p_request_id,
    3
  );

  INSERT INTO execution_replays (
    id,
    organization_id,
    workflow_id,
    task_id,
    approval_id,
    original_execution_command_id,
    replay_execution_command_id,
    dead_letter_event_id,
    replayed_by_user_id,
    trace_id
  )
  VALUES (
    p_replay_id,
    p_organization_id,
    v_original.workflow_id,
    v_original.task_id,
    v_original.approval_id,
    p_original_execution_command_id,
    p_replay_execution_command_id,
    p_dead_letter_event_id,
    current_request_user_id(),
    p_trace_id
  );

  RETURN QUERY
  SELECT
    p_replay_id,
    p_replay_execution_command_id,
    v_outbox_event_id,
    v_workflow.id,
    v_workflow.task_id,
    v_approval.id,
    v_original.recommendation_id,
    v_original.action_type,
    v_original.action_summary,
    v_original.action_payload_hash,
    v_approval.policy_version_id,
    v_approval.policy_content_hash;
END;
$$;

REVOKE ALL ON FUNCTION replay_internal_execution(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION replay_internal_execution(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text
) TO operating_layer_app;

-- 4. Extend the guarded transition + begin_execution to permit the
--    execution_failed -> executing re-open with a fresh internal command.

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
  v_abandonment_id uuid;
  v_gmail_preview_id uuid;
  v_gmail_authorization_id uuid;
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

  IF p_to_state = 'awaiting_external_authorization' THEN
    BEGIN
      v_gmail_preview_id := NULLIF(p_metadata ->> 'previewId', '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_gmail_preview_id := NULL;
    END;

    IF v_gmail_preview_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM gmail_draft_previews preview
      WHERE preview.id = v_gmail_preview_id
        AND preview.workflow_id = current_workflow.id
        AND preview.organization_id = current_workflow.organization_id
    ) THEN
      RAISE EXCEPTION
        'external authorization wait requires an immutable Gmail draft preview'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF p_to_state = 'external_authorized' THEN
    BEGIN
      v_gmail_authorization_id :=
        NULLIF(p_metadata ->> 'authorizationId', '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_gmail_authorization_id := NULL;
    END;

    IF v_gmail_authorization_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM gmail_draft_authorizations draft_authorization
      WHERE draft_authorization.id = v_gmail_authorization_id
        AND draft_authorization.workflow_id = current_workflow.id
        AND draft_authorization.organization_id =
          current_workflow.organization_id
    ) THEN
      RAISE EXCEPTION
        'external authorization transition requires an immutable authorization'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF p_to_state = 'executing' THEN
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
        AND (
          (current_workflow.current_state = 'approved'
            AND command.provider_name = 'deterministic_internal')
          OR
          (current_workflow.current_state = 'external_authorized'
            AND command.provider_name = 'gmail_draft'
            AND command.external_authorization_id IS NOT NULL)
          OR
          (current_workflow.current_state = 'execution_failed'
            AND command.provider_name = 'deterministic_internal')
        )
    ) THEN
      RAISE EXCEPTION
        'execution requires an authorized command for the current workflow state'
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

  IF current_workflow.current_state IN (
       'external_authorized',
       'executing'
     )
     AND p_to_state = 'approved' THEN
    BEGIN
      v_abandonment_id :=
        NULLIF(p_metadata ->> 'gmailDraftAbandonmentId', '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_abandonment_id := NULL;
    END;

    IF v_abandonment_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM gmail_draft_execution_abandonments abandonment
      WHERE abandonment.id = v_abandonment_id
        AND abandonment.workflow_id = current_workflow.id
        AND abandonment.organization_id = current_workflow.organization_id
    ) THEN
      RAISE EXCEPTION
        'external execution may return to approved only through kill-switch abandonment'
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
      WHEN p_to_state IN ('completed', 'execution_failed', 'rejected')
        THEN now()
      ELSE NULL
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

CREATE OR REPLACE FUNCTION begin_execution(
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
  ) OR EXISTS (
    SELECT 1
    FROM gmail_draft_execution_abandonments abandonment
    WHERE abandonment.execution_command_id = v_command.id
      AND abandonment.organization_id = v_command.organization_id
  ) THEN
    RAISE EXCEPTION 'execution command is already terminal or abandoned'
      USING ERRCODE = '23514';
  END IF;

  SELECT *
  INTO v_workflow
  FROM workflows
  WHERE id = v_command.workflow_id
    AND organization_id = v_command.organization_id
  FOR UPDATE;

  IF (
    v_command.provider_name = 'deterministic_internal'
    AND v_workflow.current_state = 'approved'
  ) OR (
    v_command.provider_name = 'gmail_draft'
    AND v_workflow.current_state = 'external_authorized'
  ) OR (
    v_command.provider_name = 'deterministic_internal'
    AND v_workflow.current_state = 'execution_failed'
  ) THEN
    SELECT transition.workflow_version
    INTO v_next_version
    FROM transition_workflow(
      v_workflow.id,
      v_workflow.organization_id,
      v_command.id::text || ':executing',
      v_workflow.version,
      'executing',
      'service',
      CASE
        WHEN v_command.provider_name = 'gmail_draft'
          THEN 'gmail-draft-execution-worker'
        ELSE 'internal-execution-worker'
      END,
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
    RAISE EXCEPTION 'workflow is not ready to begin execution'
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


-- 5. Permit a replacement execution command only when every prior
--    non-abandoned command for the approval has terminally failed. A duplicate
--    live trigger (prior command still active or succeeded) stays blocked; an
--    operator replay of a failed command is allowed.
--
--    Drop the hard per-approval/provider uniqueness (it forbade any second
--    command); the relaxed trigger below is now the sole enforcer of
--    one-active-command-per-approval, which is what enables replay.
DROP INDEX IF EXISTS execution_commands_approval_provider_unique;

CREATE OR REPLACE FUNCTION guard_execution_command_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM execution_commands existing
    LEFT JOIN gmail_draft_execution_abandonments abandonment
      ON abandonment.execution_command_id = existing.id
     AND abandonment.organization_id = existing.organization_id
    WHERE existing.organization_id = NEW.organization_id
      AND existing.approval_id = NEW.approval_id
      AND abandonment.id IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM execution_results result
        WHERE result.execution_command_id = existing.id
          AND result.organization_id = existing.organization_id
          AND result.resulting_workflow_state = 'execution_failed'
      )
  ) THEN
    RAISE EXCEPTION 'approval already has an active execution command'
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$;

-- 6. A replay is a valid audited origin for a new execution command, so accept
--    execution.replay_requested alongside execution.requested.
CREATE OR REPLACE FUNCTION verify_execution_command_audited()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM audit_events event
    WHERE event.organization_id = NEW.organization_id
      AND event.event_type IN (
        'execution.requested',
        'execution.replay_requested'
      )
      AND event.metadata ->> 'executionCommandId' = NEW.id::text
  ) THEN
    RAISE EXCEPTION 'execution command % has no audit event', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

COMMIT;
