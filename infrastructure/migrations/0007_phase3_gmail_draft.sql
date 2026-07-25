BEGIN;

SET search_path TO operating_layer, public;

-- Gmail draft creation is the only external capability in this migration.
-- Configuration, previews, authorizations, and abandonments are immutable
-- facts. The active configuration binding is a guarded projection.
ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
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
      'awaiting_external_authorization',
      'external_authorized',
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

INSERT INTO workflow_allowed_transitions (
  workflow_type,
  from_state,
  to_state
)
VALUES
  ('issue_intake', 'approved', 'awaiting_external_authorization'),
  ('issue_intake', 'awaiting_external_authorization', 'external_authorized'),
  ('issue_intake', 'awaiting_external_authorization', 'approved'),
  ('issue_intake', 'external_authorized', 'executing'),
  ('issue_intake', 'external_authorized', 'approved'),
  ('issue_intake', 'executing', 'approved')
ON CONFLICT DO NOTHING;

CREATE TABLE gmail_draft_connector_config_versions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  version_number integer NOT NULL CHECK (version_number > 0),
  enabled boolean NOT NULL DEFAULT false,
  allowed_recipient_addresses text[] NOT NULL DEFAULT '{}',
  allowed_recipient_domains text[] NOT NULL DEFAULT '{}',
  credential_secret_reference text,
  oauth_scopes text[] NOT NULL DEFAULT
    ARRAY['https://www.googleapis.com/auth/gmail.compose']::text[],
  content_hash text NOT NULL CHECK (length(content_hash) = 64),
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 3),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  UNIQUE (organization_id, version_number),
  CHECK (
    oauth_scopes =
      ARRAY['https://www.googleapis.com/auth/gmail.compose']::text[]
  ),
  CHECK (
    NOT enabled
    OR (
      credential_secret_reference IS NOT NULL
      AND length(btrim(credential_secret_reference)) > 0
      AND (
        cardinality(allowed_recipient_addresses) > 0
        OR cardinality(allowed_recipient_domains) > 0
      )
    )
  ),
  CHECK (array_position(allowed_recipient_addresses, NULL) IS NULL),
  CHECK (array_position(allowed_recipient_domains, NULL) IS NULL)
);

CREATE TABLE gmail_draft_connector_bindings (
  organization_id uuid PRIMARY KEY
    REFERENCES organizations(id) ON DELETE RESTRICT,
  active_config_version_id uuid NOT NULL,
  binding_version integer NOT NULL DEFAULT 1 CHECK (binding_version > 0),
  updated_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (active_config_version_id, organization_id)
    REFERENCES gmail_draft_connector_config_versions(id, organization_id)
      ON DELETE RESTRICT
);

CREATE TABLE gmail_draft_previews (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  workflow_id uuid NOT NULL,
  task_id uuid NOT NULL,
  approval_id uuid NOT NULL,
  recommendation_id uuid NOT NULL,
  connector_config_version_id uuid NOT NULL,
  recipient text NOT NULL CHECK (
    recipient = lower(recipient)
    AND recipient ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    AND recipient !~ E'[\r\n]'
  ),
  subject text NOT NULL CHECK (
    length(btrim(subject)) BETWEEN 1 AND 998
    AND subject !~ E'[\r\n]'
  ),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 100000),
  rendered_payload_hash text NOT NULL CHECK (
    length(rendered_payload_hash) = 64
  ),
  requested_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  policy_version_id uuid NOT NULL,
  policy_content_hash text NOT NULL CHECK (
    length(policy_content_hash) = 64
  ),
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
    REFERENCES recommendations(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (connector_config_version_id, organization_id)
    REFERENCES gmail_draft_connector_config_versions(id, organization_id)
      ON DELETE RESTRICT,
  FOREIGN KEY (policy_version_id, organization_id)
    REFERENCES approval_policy_versions(id, organization_id)
      ON DELETE RESTRICT
);

CREATE TABLE gmail_draft_authorizations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  preview_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  task_id uuid NOT NULL,
  approval_id uuid NOT NULL,
  connector_config_version_id uuid NOT NULL,
  rendered_payload_hash text NOT NULL CHECK (
    length(rendered_payload_hash) = 64
  ),
  authorized_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 3),
  idempotency_key text NOT NULL,
  trace_id text NOT NULL,
  request_id text NOT NULL,
  authorized_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  UNIQUE (organization_id, preview_id),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (preview_id, organization_id)
    REFERENCES gmail_draft_previews(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (workflow_id, organization_id)
    REFERENCES workflows(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (task_id, organization_id)
    REFERENCES tasks(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (approval_id, organization_id)
    REFERENCES approvals(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (connector_config_version_id, organization_id)
    REFERENCES gmail_draft_connector_config_versions(id, organization_id)
      ON DELETE RESTRICT
);

ALTER TABLE execution_commands
  DROP CONSTRAINT execution_commands_provider_name_check,
  DROP CONSTRAINT execution_commands_organization_id_approval_id_key;

ALTER TABLE execution_commands
  ADD CONSTRAINT execution_commands_provider_name_check
  CHECK (provider_name IN ('deterministic_internal', 'gmail_draft')),
  ADD COLUMN external_authorization_id uuid,
  ADD FOREIGN KEY (external_authorization_id, organization_id)
    REFERENCES gmail_draft_authorizations(id, organization_id)
      ON DELETE RESTRICT,
  ADD CHECK (
    (provider_name = 'deterministic_internal'
      AND external_authorization_id IS NULL)
    OR
    (provider_name = 'gmail_draft'
      AND external_authorization_id IS NOT NULL)
  );

CREATE UNIQUE INDEX execution_commands_approval_provider_unique
  ON execution_commands (organization_id, approval_id, provider_name);

CREATE TABLE gmail_draft_execution_abandonments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  execution_command_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  task_id uuid NOT NULL,
  preview_id uuid NOT NULL,
  authorization_id uuid NOT NULL,
  connector_config_version_id uuid NOT NULL,
  reason_code text NOT NULL CHECK (
    reason_code IN ('connector_disabled', 'connector_config_changed')
  ),
  trace_id text NOT NULL,
  abandoned_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  UNIQUE (organization_id, execution_command_id),
  FOREIGN KEY (execution_command_id, organization_id)
    REFERENCES execution_commands(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (workflow_id, organization_id)
    REFERENCES workflows(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (task_id, organization_id)
    REFERENCES tasks(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (preview_id, organization_id)
    REFERENCES gmail_draft_previews(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (authorization_id, organization_id)
    REFERENCES gmail_draft_authorizations(id, organization_id)
      ON DELETE RESTRICT,
  FOREIGN KEY (connector_config_version_id, organization_id)
    REFERENCES gmail_draft_connector_config_versions(id, organization_id)
      ON DELETE RESTRICT
);

CREATE TRIGGER gmail_draft_config_versions_are_immutable
  BEFORE UPDATE OR DELETE ON gmail_draft_connector_config_versions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE TRIGGER gmail_draft_previews_are_immutable
  BEFORE UPDATE OR DELETE ON gmail_draft_previews
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE TRIGGER gmail_draft_authorizations_are_immutable
  BEFORE UPDATE OR DELETE ON gmail_draft_authorizations
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE TRIGGER gmail_draft_abandonments_are_immutable
  BEFORE UPDATE OR DELETE ON gmail_draft_execution_abandonments
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE OR REPLACE FUNCTION guard_gmail_draft_binding_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('app.gmail_draft_config_guard', true)
     IS DISTINCT FROM 'set_gmail_draft_connector_config:v1' THEN
    RAISE EXCEPTION
      'Gmail draft connector binding must use the guarded config function'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER gmail_draft_binding_requires_function
  BEFORE INSERT OR UPDATE OR DELETE ON gmail_draft_connector_bindings
  FOR EACH ROW EXECUTE FUNCTION guard_gmail_draft_binding_update();

CREATE OR REPLACE FUNCTION set_gmail_draft_connector_config(
  p_config_version_id uuid,
  p_organization_id uuid,
  p_enabled boolean,
  p_allowed_recipient_addresses text[],
  p_allowed_recipient_domains text[],
  p_credential_secret_reference text,
  p_content_hash text,
  p_reason text
)
RETURNS TABLE (
  config_version_id uuid,
  version_number integer,
  binding_version integer,
  enabled boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = operating_layer, public
AS $$
DECLARE
  v_version_number integer;
  v_binding_version integer;
BEGIN
  IF NOT current_request_user_has_permission(
    p_organization_id,
    'connectors.admin'
  ) THEN
    RAISE EXCEPTION 'connector administration permission denied'
      USING ERRCODE = '42501';
  END IF;

  IF p_enabled AND (
    p_credential_secret_reference IS NULL
    OR length(btrim(p_credential_secret_reference)) = 0
    OR (
      cardinality(p_allowed_recipient_addresses) = 0
      AND cardinality(p_allowed_recipient_domains) = 0
    )
  ) THEN
    RAISE EXCEPTION
      'enabled Gmail draft connector requires a secret reference and allowlist'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(max(config.version_number), 0) + 1
  INTO v_version_number
  FROM gmail_draft_connector_config_versions config
  WHERE config.organization_id = p_organization_id;

  INSERT INTO gmail_draft_connector_config_versions (
    id,
    organization_id,
    version_number,
    enabled,
    allowed_recipient_addresses,
    allowed_recipient_domains,
    credential_secret_reference,
    content_hash,
    created_by_user_id,
    reason
  )
  VALUES (
    p_config_version_id,
    p_organization_id,
    v_version_number,
    p_enabled,
    ARRAY(
      SELECT lower(btrim(value))
      FROM unnest(p_allowed_recipient_addresses) value
      ORDER BY lower(btrim(value))
    ),
    ARRAY(
      SELECT lower(btrim(value))
      FROM unnest(p_allowed_recipient_domains) value
      ORDER BY lower(btrim(value))
    ),
    p_credential_secret_reference,
    p_content_hash,
    current_request_user_id(),
    p_reason
  );

  PERFORM set_config(
    'app.gmail_draft_config_guard',
    'set_gmail_draft_connector_config:v1',
    true
  );

  INSERT INTO gmail_draft_connector_bindings (
    organization_id,
    active_config_version_id,
    binding_version,
    updated_by_user_id
  )
  VALUES (
    p_organization_id,
    p_config_version_id,
    1,
    current_request_user_id()
  )
  ON CONFLICT (organization_id) DO UPDATE
  SET
    active_config_version_id = EXCLUDED.active_config_version_id,
    binding_version = gmail_draft_connector_bindings.binding_version + 1,
    updated_by_user_id = EXCLUDED.updated_by_user_id,
    updated_at = now()
  RETURNING gmail_draft_connector_bindings.binding_version
  INTO v_binding_version;

  PERFORM set_config('app.gmail_draft_config_guard', '', true);

  RETURN QUERY
  SELECT
    p_config_version_id,
    v_version_number,
    v_binding_version,
    p_enabled;
END;
$$;

CREATE OR REPLACE FUNCTION validate_gmail_draft_preview()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_approval approvals%ROWTYPE;
  v_workflow workflows%ROWTYPE;
  v_config gmail_draft_connector_config_versions%ROWTYPE;
  v_active_config_id uuid;
  v_recommendation_id uuid;
  v_recipient_domain text;
BEGIN
  IF NOT current_request_user_has_permission(
    NEW.organization_id,
    'external_actions.preview'
  ) THEN
    RAISE EXCEPTION 'external action preview permission denied'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.requested_by_user_id <> current_request_user_id() THEN
    RAISE EXCEPTION 'preview requester must match request identity'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
  INTO v_approval
  FROM approvals
  WHERE id = NEW.approval_id
    AND organization_id = NEW.organization_id;

  SELECT recommendation.id
  INTO v_recommendation_id
  FROM recommendations recommendation
  WHERE recommendation.organization_id = NEW.organization_id
    AND v_approval.payload_reference =
      'recommendation:' || recommendation.id::text;

  IF NOT FOUND
     OR v_approval.status <> 'approved'
     OR v_approval.action_type <> 'draft_external_follow_up'
     OR v_approval.policy_version_id <> NEW.policy_version_id
     OR v_approval.policy_content_hash <> NEW.policy_content_hash
     OR v_recommendation_id <> NEW.recommendation_id THEN
    RAISE EXCEPTION
      'Gmail draft preview requires the approved draft recommendation'
      USING ERRCODE = '23514';
  END IF;

  SELECT *
  INTO v_workflow
  FROM workflows
  WHERE id = NEW.workflow_id
    AND organization_id = NEW.organization_id;

  IF NOT FOUND
     OR v_workflow.id <> v_approval.workflow_id
     OR v_workflow.task_id <> NEW.task_id
     OR v_workflow.current_state <> 'approved' THEN
    RAISE EXCEPTION 'workflow is not approved for preview'
      USING ERRCODE = '23514';
  END IF;

  SELECT binding.active_config_version_id
  INTO v_active_config_id
  FROM gmail_draft_connector_bindings binding
  WHERE binding.organization_id = NEW.organization_id;

  IF v_active_config_id IS NULL
     OR v_active_config_id <> NEW.connector_config_version_id THEN
    RAISE EXCEPTION 'Gmail draft connector configuration is not active'
      USING ERRCODE = '23514';
  END IF;

  SELECT *
  INTO v_config
  FROM gmail_draft_connector_config_versions
  WHERE id = v_active_config_id
    AND organization_id = NEW.organization_id;

  v_recipient_domain := split_part(NEW.recipient, '@', 2);
  IF NOT v_config.enabled
     OR NOT (
       NEW.recipient = ANY(v_config.allowed_recipient_addresses)
       OR v_recipient_domain = ANY(v_config.allowed_recipient_domains)
     ) THEN
    RAISE EXCEPTION
      'Gmail draft connector is disabled or recipient is not allowlisted'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER gmail_draft_preview_requires_gates
  BEFORE INSERT ON gmail_draft_previews
  FOR EACH ROW EXECUTE FUNCTION validate_gmail_draft_preview();

CREATE OR REPLACE FUNCTION validate_gmail_draft_authorization()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_preview gmail_draft_previews%ROWTYPE;
  v_workflow workflows%ROWTYPE;
  v_active_config_id uuid;
  v_enabled boolean;
BEGIN
  IF NOT current_request_user_has_permission(
    NEW.organization_id,
    'external_actions.authorize'
  ) THEN
    RAISE EXCEPTION 'external action authorization permission denied'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.authorized_by_user_id <> current_request_user_id() THEN
    RAISE EXCEPTION 'external authorizer must match request identity'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
  INTO v_preview
  FROM gmail_draft_previews
  WHERE id = NEW.preview_id
    AND organization_id = NEW.organization_id;

  IF NOT FOUND
     OR v_preview.workflow_id <> NEW.workflow_id
     OR v_preview.task_id <> NEW.task_id
     OR v_preview.approval_id <> NEW.approval_id
     OR v_preview.connector_config_version_id <>
       NEW.connector_config_version_id
     OR v_preview.rendered_payload_hash <> NEW.rendered_payload_hash THEN
    RAISE EXCEPTION 'authorization does not match the immutable preview'
      USING ERRCODE = '23514';
  END IF;

  SELECT *
  INTO v_workflow
  FROM workflows
  WHERE id = NEW.workflow_id
    AND organization_id = NEW.organization_id;

  IF NOT FOUND
     OR v_workflow.current_state <> 'awaiting_external_authorization' THEN
    RAISE EXCEPTION 'workflow is not awaiting external authorization'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    binding.active_config_version_id,
    config.enabled
  INTO v_active_config_id, v_enabled
  FROM gmail_draft_connector_bindings binding
  JOIN gmail_draft_connector_config_versions config
    ON config.id = binding.active_config_version_id
   AND config.organization_id = binding.organization_id
  WHERE binding.organization_id = NEW.organization_id;

  IF v_active_config_id IS DISTINCT FROM
       NEW.connector_config_version_id
     OR NOT COALESCE(v_enabled, false) THEN
    RAISE EXCEPTION 'Gmail draft connector preview is stale or disabled'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER gmail_draft_authorization_requires_gates
  BEFORE INSERT ON gmail_draft_authorizations
  FOR EACH ROW EXECUTE FUNCTION validate_gmail_draft_authorization();

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
  ) THEN
    RAISE EXCEPTION 'approval already has a non-abandoned execution command'
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER execution_command_exclusivity_guard
  BEFORE INSERT ON execution_commands
  FOR EACH ROW EXECUTE FUNCTION guard_execution_command_insert();

CREATE OR REPLACE FUNCTION enqueue_gmail_draft_execution(
  p_execution_command_id uuid,
  p_outbox_event_id uuid,
  p_authorization_id uuid,
  p_organization_id uuid,
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
  preview_id uuid,
  action_payload_hash text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = operating_layer, public
AS $$
DECLARE
  v_authorization gmail_draft_authorizations%ROWTYPE;
  v_preview gmail_draft_previews%ROWTYPE;
  v_workflow workflows%ROWTYPE;
BEGIN
  IF NOT current_request_user_has_permission(
    p_organization_id,
    'external_actions.authorize'
  ) THEN
    RAISE EXCEPTION 'external action authorization permission denied'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
  INTO v_authorization
  FROM gmail_draft_authorizations
  WHERE id = p_authorization_id
    AND organization_id = p_organization_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Gmail draft authorization not found'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT *
  INTO v_preview
  FROM gmail_draft_previews
  WHERE id = v_authorization.preview_id
    AND organization_id = p_organization_id;

  SELECT *
  INTO v_workflow
  FROM workflows
  WHERE id = v_authorization.workflow_id
    AND organization_id = p_organization_id;

  IF v_workflow.current_state <> 'external_authorized' THEN
    RAISE EXCEPTION 'workflow is not externally authorized'
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
    request_id,
    external_authorization_id
  )
  VALUES (
    p_execution_command_id,
    p_organization_id,
    v_preview.workflow_id,
    v_preview.task_id,
    v_preview.approval_id,
    v_preview.recommendation_id,
    'gmail_draft_create',
    'Create the explicitly authorized Gmail draft without sending it.',
    'gmail_draft_preview:' || v_preview.id::text,
    v_preview.rendered_payload_hash,
    'gmail_draft',
    current_request_user_id(),
    p_idempotency_key,
    p_trace_id,
    p_request_id,
    v_authorization.id
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
    p_outbox_event_id,
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
          'authorizationId', p_authorization_id,
          'payloadHash', v_preview.rendered_payload_hash
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
    p_outbox_event_id,
    v_preview.workflow_id,
    v_preview.task_id,
    v_preview.approval_id,
    v_preview.recommendation_id,
    v_preview.id,
    v_preview.rendered_payload_hash;
END;
$$;

-- Every transition to executing now requires an immutable execution command.
-- Returning an external command to approved additionally requires an immutable
-- abandonment fact created by the kill-switch path.
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

CREATE OR REPLACE FUNCTION abandon_gmail_draft_execution(
  p_abandonment_id uuid,
  p_execution_command_id uuid,
  p_organization_id uuid,
  p_reason_code text,
  p_trace_id text
)
RETURNS TABLE (
  abandonment_id uuid,
  workflow_id uuid,
  task_id uuid,
  workflow_state text,
  workflow_version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = operating_layer, public
AS $$
DECLARE
  v_command execution_commands%ROWTYPE;
  v_workflow workflows%ROWTYPE;
  v_preview gmail_draft_previews%ROWTYPE;
  v_authorization gmail_draft_authorizations%ROWTYPE;
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
    AND organization_id = p_organization_id
    AND provider_name = 'gmail_draft';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Gmail draft execution command not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF p_reason_code NOT IN (
    'connector_disabled',
    'connector_config_changed'
  ) THEN
    RAISE EXCEPTION 'invalid Gmail draft abandonment reason'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO v_authorization
  FROM gmail_draft_authorizations
  WHERE id = v_command.external_authorization_id
    AND organization_id = p_organization_id;

  SELECT *
  INTO v_preview
  FROM gmail_draft_previews
  WHERE id = v_authorization.preview_id
    AND organization_id = p_organization_id;

  SELECT *
  INTO v_workflow
  FROM workflows
  WHERE id = v_command.workflow_id
    AND organization_id = p_organization_id
  FOR UPDATE;

  IF v_workflow.current_state NOT IN ('external_authorized', 'executing') THEN
    RAISE EXCEPTION 'Gmail draft workflow is not active'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM execution_results result
    WHERE result.execution_command_id = v_command.id
      AND result.organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'materialized Gmail draft cannot be abandoned'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO gmail_draft_execution_abandonments (
    id,
    organization_id,
    execution_command_id,
    workflow_id,
    task_id,
    preview_id,
    authorization_id,
    connector_config_version_id,
    reason_code,
    trace_id
  )
  VALUES (
    p_abandonment_id,
    p_organization_id,
    v_command.id,
    v_command.workflow_id,
    v_command.task_id,
    v_preview.id,
    v_authorization.id,
    v_authorization.connector_config_version_id,
    p_reason_code,
    p_trace_id
  );

  SELECT transition.workflow_version
  INTO v_next_version
  FROM transition_workflow(
    v_workflow.id,
    p_organization_id,
    v_command.id::text || ':abandoned',
    v_workflow.version,
    'approved',
    'service',
    'gmail-draft-kill-switch',
    v_preview.rendered_payload_hash,
    NULL,
    p_trace_id,
    jsonb_build_object(
      'executionCommandId', v_command.id,
      'gmailDraftAbandonmentId', p_abandonment_id,
      'reasonCode', p_reason_code
    )
  ) transition;

  RETURN QUERY
  SELECT
    p_abandonment_id,
    v_workflow.id,
    v_workflow.task_id,
    'approved'::text,
    v_next_version;
END;
$$;

CREATE OR REPLACE FUNCTION verify_gmail_draft_fact_audited()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_event_type text;
  v_id_key text;
BEGIN
  v_event_type := CASE TG_TABLE_NAME
    WHEN 'gmail_draft_connector_config_versions'
      THEN 'gmail_draft.connector_configured'
    WHEN 'gmail_draft_previews' THEN 'gmail_draft.previewed'
    WHEN 'gmail_draft_authorizations' THEN 'gmail_draft.authorized'
    WHEN 'gmail_draft_execution_abandonments'
      THEN 'gmail_draft.materialization_abandoned'
  END;
  v_id_key := CASE TG_TABLE_NAME
    WHEN 'gmail_draft_connector_config_versions' THEN 'configVersionId'
    WHEN 'gmail_draft_previews' THEN 'previewId'
    WHEN 'gmail_draft_authorizations' THEN 'authorizationId'
    WHEN 'gmail_draft_execution_abandonments' THEN 'abandonmentId'
  END;

  IF NOT EXISTS (
    SELECT 1
    FROM audit_events event
    WHERE event.organization_id = NEW.organization_id
      AND event.event_type = v_event_type
      AND event.metadata ->> v_id_key = NEW.id::text
  ) THEN
    RAISE EXCEPTION '% % has no matching audit event',
      TG_TABLE_NAME,
      NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER gmail_draft_config_requires_audit
  AFTER INSERT ON gmail_draft_connector_config_versions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION verify_gmail_draft_fact_audited();

CREATE CONSTRAINT TRIGGER gmail_draft_preview_requires_audit
  AFTER INSERT ON gmail_draft_previews
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION verify_gmail_draft_fact_audited();

CREATE CONSTRAINT TRIGGER gmail_draft_authorization_requires_audit
  AFTER INSERT ON gmail_draft_authorizations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION verify_gmail_draft_fact_audited();

CREATE CONSTRAINT TRIGGER gmail_draft_abandonment_requires_audit
  AFTER INSERT ON gmail_draft_execution_abandonments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION verify_gmail_draft_fact_audited();

ALTER TABLE gmail_draft_connector_config_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmail_draft_connector_config_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation
  ON gmail_draft_connector_config_versions
  FOR ALL
  USING (current_user_can_access_organization(organization_id))
  WITH CHECK (current_user_can_access_organization(organization_id));

ALTER TABLE gmail_draft_connector_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmail_draft_connector_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation
  ON gmail_draft_connector_bindings
  FOR ALL
  USING (current_user_can_access_organization(organization_id))
  WITH CHECK (current_user_can_access_organization(organization_id));

ALTER TABLE gmail_draft_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmail_draft_previews FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON gmail_draft_previews
  FOR ALL
  USING (current_user_can_access_organization(organization_id))
  WITH CHECK (current_user_can_access_organization(organization_id));

ALTER TABLE gmail_draft_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmail_draft_authorizations FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON gmail_draft_authorizations
  FOR ALL
  USING (current_user_can_access_organization(organization_id))
  WITH CHECK (current_user_can_access_organization(organization_id));

ALTER TABLE gmail_draft_execution_abandonments ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmail_draft_execution_abandonments FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation
  ON gmail_draft_execution_abandonments
  FOR ALL
  USING (current_user_can_access_organization(organization_id))
  WITH CHECK (current_user_can_access_organization(organization_id));

GRANT SELECT
  ON gmail_draft_connector_config_versions,
     gmail_draft_connector_bindings,
     gmail_draft_previews,
     gmail_draft_authorizations,
     gmail_draft_execution_abandonments
  TO operating_layer_app;

GRANT INSERT ON gmail_draft_previews, gmail_draft_authorizations
  TO operating_layer_app;

REVOKE UPDATE, DELETE
  ON gmail_draft_connector_config_versions,
     gmail_draft_previews,
     gmail_draft_authorizations,
     gmail_draft_execution_abandonments
  FROM operating_layer_app;

REVOKE INSERT, UPDATE, DELETE
  ON gmail_draft_connector_bindings,
     gmail_draft_execution_abandonments
  FROM operating_layer_app;

GRANT EXECUTE ON FUNCTION set_gmail_draft_connector_config(
  uuid,
  uuid,
  boolean,
  text[],
  text[],
  text,
  text,
  text
) TO operating_layer_app;

GRANT EXECUTE ON FUNCTION enqueue_gmail_draft_execution(
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  text,
  text
) TO operating_layer_app;

GRANT EXECUTE ON FUNCTION begin_execution(
  uuid,
  uuid,
  text,
  text
) TO operating_layer_app;

GRANT EXECUTE ON FUNCTION abandon_gmail_draft_execution(
  uuid,
  uuid,
  uuid,
  text,
  text
) TO operating_layer_app;

COMMIT;
