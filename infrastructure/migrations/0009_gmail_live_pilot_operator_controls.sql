BEGIN;

SET search_path TO operating_layer, public;

CREATE TABLE gmail_draft_live_pilot_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  target_organization_id uuid REFERENCES organizations(id) ON DELETE RESTRICT,
  claim_version integer NOT NULL DEFAULT 1 CHECK (claim_version > 0),
  updated_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  trace_id text,
  reason text,
  claimed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (target_organization_id IS NULL AND claimed_at IS NULL)
    OR (target_organization_id IS NOT NULL AND claimed_at IS NOT NULL)
  )
);

INSERT INTO gmail_draft_live_pilot_control (singleton)
VALUES (true);

CREATE TABLE gmail_draft_live_pilot_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('claimed', 'released')),
  claim_version integer NOT NULL CHECK (claim_version > 0),
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  trace_id text NOT NULL,
  request_id text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 3),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER gmail_draft_live_pilot_events_are_immutable
  BEFORE UPDATE OR DELETE ON gmail_draft_live_pilot_events
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE OR REPLACE FUNCTION guard_gmail_draft_live_pilot_control()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('app.gmail_draft_live_pilot_guard', true)
     IS DISTINCT FROM 'gmail_draft_live_pilot:v1' THEN
    RAISE EXCEPTION 'Gmail live-pilot control requires guarded function'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER gmail_draft_live_pilot_control_requires_function
  BEFORE UPDATE OR DELETE ON gmail_draft_live_pilot_control
  FOR EACH ROW EXECUTE FUNCTION guard_gmail_draft_live_pilot_control();

CREATE OR REPLACE FUNCTION current_user_can_administer_all_active_organizations()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = operating_layer, public
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM organizations organization
    WHERE organization.status = 'active'
      AND NOT current_request_user_has_permission(
        organization.id,
        'admin.manage'
      )
  );
$$;

CREATE OR REPLACE FUNCTION claim_gmail_draft_live_pilot(
  p_organization_id uuid,
  p_reason text,
  p_trace_id text,
  p_request_id text
)
RETURNS TABLE (
  organization_id uuid,
  organization_code text,
  claim_version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = operating_layer, public
AS $$
DECLARE
  v_control gmail_draft_live_pilot_control%ROWTYPE;
  v_claim_version integer;
  v_organization_code text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('gmail-draft-global-kill'));

  IF NOT current_user_can_administer_all_active_organizations() THEN
    RAISE EXCEPTION
      'live Gmail pilot requires admin.manage for every active organization'
      USING ERRCODE = '42501';
  END IF;

  SELECT code INTO v_organization_code
  FROM organizations
  WHERE id = p_organization_id
    AND status = 'active';
  IF v_organization_code IS NULL THEN
    RAISE EXCEPTION 'live Gmail pilot target organization is not active'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM gmail_draft_global_kill_switch
    WHERE singleton
      AND killed
  ) THEN
    RAISE EXCEPTION 'global Gmail kill switch is active'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_control
  FROM gmail_draft_live_pilot_control
  WHERE singleton
  FOR UPDATE;
  IF v_control.target_organization_id IS NOT NULL
     AND v_control.target_organization_id <> p_organization_id THEN
    RAISE EXCEPTION 'another organization already owns the live Gmail pilot'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM gmail_draft_connector_bindings binding
    JOIN gmail_draft_connector_config_versions config
      ON config.id = binding.active_config_version_id
     AND config.organization_id = binding.organization_id
    WHERE config.enabled
      AND binding.organization_id <> p_organization_id
  ) THEN
    RAISE EXCEPTION
      'another organization has an enabled Gmail draft configuration'
      USING ERRCODE = '55000';
  END IF;

  PERFORM set_config(
    'app.gmail_draft_live_pilot_guard',
    'gmail_draft_live_pilot:v1',
    true
  );
  UPDATE gmail_draft_live_pilot_control AS control
  SET
    target_organization_id = p_organization_id,
    claim_version = control.claim_version + 1,
    updated_by_user_id = current_request_user_id(),
    trace_id = p_trace_id,
    reason = p_reason,
    claimed_at = COALESCE(control.claimed_at, now()),
    updated_at = now()
  WHERE singleton
  RETURNING control.claim_version
  INTO v_claim_version;
  PERFORM set_config('app.gmail_draft_live_pilot_guard', '', true);

  INSERT INTO gmail_draft_live_pilot_events (
    organization_id,
    event_type,
    claim_version,
    actor_id,
    trace_id,
    request_id,
    reason
  )
  VALUES (
    p_organization_id,
    'claimed',
    v_claim_version,
    current_request_user_id(),
    p_trace_id,
    p_request_id,
    p_reason
  );

  RETURN QUERY
  SELECT p_organization_id, v_organization_code, v_claim_version;
END;
$$;

CREATE OR REPLACE FUNCTION release_gmail_draft_live_pilot(
  p_organization_id uuid,
  p_reason text,
  p_trace_id text,
  p_request_id text
)
RETURNS TABLE (
  organization_id uuid,
  organization_code text,
  claim_version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = operating_layer, public
AS $$
DECLARE
  v_control gmail_draft_live_pilot_control%ROWTYPE;
  v_claim_version integer;
  v_organization_code text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('gmail-draft-global-kill'));

  IF NOT current_user_can_administer_all_active_organizations() THEN
    RAISE EXCEPTION
      'live Gmail pilot requires admin.manage for every active organization'
      USING ERRCODE = '42501';
  END IF;

  SELECT code INTO v_organization_code
  FROM organizations
  WHERE id = p_organization_id;
  IF v_organization_code IS NULL THEN
    RAISE EXCEPTION 'live Gmail pilot target organization does not exist'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_control
  FROM gmail_draft_live_pilot_control
  WHERE singleton
  FOR UPDATE;
  IF v_control.target_organization_id IS NULL THEN
    RETURN QUERY
    SELECT p_organization_id, v_organization_code, v_control.claim_version;
    RETURN;
  END IF;
  IF v_control.target_organization_id <> p_organization_id THEN
    RAISE EXCEPTION 'live Gmail pilot is owned by another organization'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM gmail_draft_connector_bindings binding
    JOIN gmail_draft_connector_config_versions config
      ON config.id = binding.active_config_version_id
     AND config.organization_id = binding.organization_id
    WHERE binding.organization_id = p_organization_id
      AND config.enabled
  ) OR EXISTS (
    SELECT 1
    FROM gmail_draft_credential_bindings binding
    WHERE binding.organization_id = p_organization_id
      AND binding.active_credential_version_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'disable connector and invalidate credential before releasing pilot'
      USING ERRCODE = '55000';
  END IF;

  PERFORM set_config(
    'app.gmail_draft_live_pilot_guard',
    'gmail_draft_live_pilot:v1',
    true
  );
  UPDATE gmail_draft_live_pilot_control AS control
  SET
    target_organization_id = NULL,
    claim_version = control.claim_version + 1,
    updated_by_user_id = current_request_user_id(),
    trace_id = p_trace_id,
    reason = p_reason,
    claimed_at = NULL,
    updated_at = now()
  WHERE singleton
  RETURNING control.claim_version
  INTO v_claim_version;
  PERFORM set_config('app.gmail_draft_live_pilot_guard', '', true);

  INSERT INTO gmail_draft_live_pilot_events (
    organization_id,
    event_type,
    claim_version,
    actor_id,
    trace_id,
    request_id,
    reason
  )
  VALUES (
    p_organization_id,
    'released',
    v_claim_version,
    current_request_user_id(),
    p_trace_id,
    p_request_id,
    p_reason
  );

  RETURN QUERY
  SELECT p_organization_id, v_organization_code, v_claim_version;
END;
$$;

CREATE OR REPLACE FUNCTION guard_gmail_draft_live_pilot_binding()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = operating_layer, public
AS $$
DECLARE
  v_target_organization_id uuid;
  v_enabled boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('gmail-draft-global-kill'));
  SELECT target_organization_id INTO v_target_organization_id
  FROM gmail_draft_live_pilot_control
  WHERE singleton;
  IF v_target_organization_id IS NULL
     OR v_target_organization_id = NEW.organization_id THEN
    RETURN NEW;
  END IF;
  SELECT enabled INTO v_enabled
  FROM gmail_draft_connector_config_versions
  WHERE id = NEW.active_config_version_id
    AND organization_id = NEW.organization_id;
  IF v_enabled THEN
    RAISE EXCEPTION
      'Gmail live pilot permits exactly one enabled organization'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER gmail_draft_live_pilot_limits_enabled_organization
  BEFORE INSERT OR UPDATE ON gmail_draft_connector_bindings
  FOR EACH ROW EXECUTE FUNCTION guard_gmail_draft_live_pilot_binding();

CREATE OR REPLACE FUNCTION inspect_gmail_draft_live_pilot(
  p_organization_id uuid,
  p_expected_recipient text,
  p_expected_credential_fingerprint text
)
RETURNS TABLE (
  organization_id uuid,
  organization_code text,
  organization_name text,
  pilot_claim_active boolean,
  pilot_claimed_for_target boolean,
  target_connector_enabled boolean,
  active_credential_present boolean,
  credential_envelope_valid boolean,
  credential_fingerprint_matches boolean,
  exact_compose_scope boolean,
  exact_single_recipient_allowlist boolean,
  expected_recipient_allowed boolean,
  other_enabled_organization_count bigint,
  all_other_organizations_disabled boolean,
  global_kill_cleared boolean,
  kill_switch_reachable boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = operating_layer, public
AS $$
BEGIN
  IF NOT current_user_can_administer_all_active_organizations() THEN
    RAISE EXCEPTION
      'live Gmail preflight requires admin.manage for every active organization'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH target AS (
    SELECT
      organization.id,
      organization.code,
      organization.name,
      config.enabled,
      config.allowed_recipient_addresses,
      config.allowed_recipient_domains,
      config.oauth_scopes,
      credential_binding.active_credential_version_id,
      credential.algorithm,
      credential.ciphertext,
      credential.nonce,
      credential.authentication_tag,
      credential.wrapped_data_key,
      credential.token_fingerprint,
      credential.granted_scopes
    FROM organizations organization
    LEFT JOIN gmail_draft_connector_bindings config_binding
      ON config_binding.organization_id = organization.id
    LEFT JOIN gmail_draft_connector_config_versions config
      ON config.id = config_binding.active_config_version_id
     AND config.organization_id = config_binding.organization_id
    LEFT JOIN gmail_draft_credential_bindings credential_binding
      ON credential_binding.organization_id = organization.id
    LEFT JOIN gmail_draft_credential_versions credential
      ON credential.id = credential_binding.active_credential_version_id
     AND credential.organization_id = credential_binding.organization_id
    WHERE organization.id = p_organization_id
      AND organization.status = 'active'
  ),
  other_enabled AS (
    SELECT count(*)::bigint AS enabled_count
    FROM gmail_draft_connector_bindings binding
    JOIN gmail_draft_connector_config_versions config
      ON config.id = binding.active_config_version_id
     AND config.organization_id = binding.organization_id
    WHERE binding.organization_id <> p_organization_id
      AND config.enabled
  )
  SELECT
    target.id,
    target.code,
    target.name,
    control.target_organization_id IS NOT NULL,
    COALESCE(control.target_organization_id = target.id, false),
    COALESCE(target.enabled, false),
    target.active_credential_version_id IS NOT NULL,
    target.active_credential_version_id IS NOT NULL
      AND target.algorithm = 'rsa-oaep-sha256+aes-256-gcm-v1'
      AND length(target.ciphertext) > 0
      AND length(target.nonce) > 0
      AND length(target.authentication_tag) > 0
      AND length(target.wrapped_data_key) > 0
      AND length(target.token_fingerprint) = 64
      AND target.ciphertext <> target.token_fingerprint,
    CASE
      WHEN p_expected_credential_fingerprint IS NULL THEN NULL
      ELSE COALESCE(
        target.token_fingerprint = p_expected_credential_fingerprint,
        false
      )
    END,
    COALESCE(
      target.oauth_scopes =
        ARRAY['https://www.googleapis.com/auth/gmail.compose']::text[]
        AND target.granted_scopes =
          ARRAY['https://www.googleapis.com/auth/gmail.compose']::text[],
      false
    ),
    COALESCE(
      cardinality(target.allowed_recipient_addresses) = 1
        AND cardinality(target.allowed_recipient_domains) = 0,
      false
    ),
    CASE
      WHEN p_expected_recipient IS NULL THEN NULL
      ELSE COALESCE(
        lower(p_expected_recipient) = ANY(
          target.allowed_recipient_addresses
        ),
        false
      )
    END,
    other_enabled.enabled_count,
    other_enabled.enabled_count = 0,
    NOT kill.killed,
    has_function_privilege(
      'operating_layer_app',
      'operating_layer.set_gmail_draft_global_kill(boolean,text,text,text)',
      'EXECUTE'
    )
  FROM target
  CROSS JOIN gmail_draft_live_pilot_control control
  CROSS JOIN gmail_draft_global_kill_switch kill
  CROSS JOIN other_enabled
  WHERE control.singleton
    AND kill.singleton;
END;
$$;

ALTER TABLE gmail_draft_live_pilot_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmail_draft_live_pilot_events FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON gmail_draft_live_pilot_events
  FOR ALL
  USING (current_user_can_access_organization(organization_id))
  WITH CHECK (current_user_can_access_organization(organization_id));

REVOKE ALL ON gmail_draft_live_pilot_control,
  gmail_draft_live_pilot_events FROM PUBLIC, operating_layer_app;
GRANT SELECT ON gmail_draft_live_pilot_control,
  gmail_draft_live_pilot_events TO operating_layer_app;

REVOKE ALL ON FUNCTION current_user_can_administer_all_active_organizations()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_gmail_draft_live_pilot(
  uuid, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_gmail_draft_live_pilot(
  uuid, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION inspect_gmail_draft_live_pilot(
  uuid, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_gmail_draft_live_pilot(
  uuid, text, text, text
) TO operating_layer_app;
GRANT EXECUTE ON FUNCTION release_gmail_draft_live_pilot(
  uuid, text, text, text
) TO operating_layer_app;
GRANT EXECUTE ON FUNCTION inspect_gmail_draft_live_pilot(
  uuid, text, text
) TO operating_layer_app;

COMMIT;
