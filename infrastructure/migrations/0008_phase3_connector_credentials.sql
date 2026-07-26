BEGIN;

SET search_path TO operating_layer, public;

-- API and worker logins are intentionally distinct. Only the worker role is
-- allowed to load encrypted credential envelopes for execution-time decrypt.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'operating_layer_worker') THEN
    CREATE ROLE operating_layer_worker NOLOGIN NOSUPERUSER NOCREATEDB
      NOCREATEROLE INHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'operating_layer_worker_runtime'
  ) THEN
    CREATE ROLE operating_layer_worker_runtime NOLOGIN NOSUPERUSER NOCREATEDB
      NOCREATEROLE INHERIT NOBYPASSRLS;
  END IF;
END;
$$;

GRANT operating_layer_app TO operating_layer_worker;
GRANT operating_layer_worker TO operating_layer_worker_runtime;
GRANT EXECUTE ON FUNCTION claim_outbox_job(text)
  TO operating_layer_worker_runtime;

CREATE TABLE gmail_draft_credential_versions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  version_number integer NOT NULL CHECK (version_number > 0),
  algorithm text NOT NULL
    CHECK (algorithm = 'rsa-oaep-sha256+aes-256-gcm-v1'),
  ciphertext text NOT NULL CHECK (length(ciphertext) > 0),
  nonce text NOT NULL CHECK (length(nonce) > 0),
  authentication_tag text NOT NULL CHECK (length(authentication_tag) > 0),
  wrapped_data_key text NOT NULL CHECK (length(wrapped_data_key) > 0),
  token_fingerprint text NOT NULL CHECK (length(token_fingerprint) = 64),
  granted_scopes text[] NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 3),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  UNIQUE (organization_id, version_number),
  CHECK (
    granted_scopes =
      ARRAY['https://www.googleapis.com/auth/gmail.compose']::text[]
  )
);

CREATE TABLE gmail_draft_credential_lifecycle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  credential_version_id uuid NOT NULL,
  event_type text NOT NULL CHECK (
    event_type IN (
      'stored', 'activated', 'invalidated', 'revocation_requested',
      'revoked', 'revocation_failed', 'loaded', 'used'
    )
  ),
  actor_type text NOT NULL CHECK (
    actor_type IN ('user', 'service', 'system')
  ),
  actor_id text NOT NULL,
  purpose text NOT NULL CHECK (length(btrim(purpose)) > 0),
  trace_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (credential_version_id, organization_id)
    REFERENCES gmail_draft_credential_versions(id, organization_id)
      ON DELETE RESTRICT
);

CREATE TABLE gmail_draft_credential_bindings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE RESTRICT,
  active_credential_version_id uuid,
  binding_version integer NOT NULL DEFAULT 1 CHECK (binding_version > 0),
  updated_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (active_credential_version_id, organization_id)
    REFERENCES gmail_draft_credential_versions(id, organization_id)
      ON DELETE RESTRICT
);

CREATE TABLE gmail_draft_global_kill_switch (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  killed boolean NOT NULL DEFAULT false,
  switch_version integer NOT NULL DEFAULT 1 CHECK (switch_version > 0),
  updated_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO gmail_draft_global_kill_switch (singleton, killed)
VALUES (true, false);

CREATE TRIGGER gmail_credential_versions_are_immutable
  BEFORE UPDATE OR DELETE ON gmail_draft_credential_versions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER gmail_credential_lifecycle_is_immutable
  BEFORE UPDATE OR DELETE ON gmail_draft_credential_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE OR REPLACE FUNCTION guard_gmail_credential_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.gmail_credential_binding_guard', true)
     IS DISTINCT FROM 'gmail_credential_binding:v1' THEN
    RAISE EXCEPTION 'Gmail credential binding requires guarded function'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER gmail_credential_binding_requires_function
  BEFORE INSERT OR UPDATE OR DELETE ON gmail_draft_credential_bindings
  FOR EACH ROW EXECUTE FUNCTION guard_gmail_credential_binding();

CREATE OR REPLACE FUNCTION guard_gmail_global_kill_switch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.gmail_global_kill_guard', true)
     IS DISTINCT FROM 'gmail_global_kill:v1' THEN
    RAISE EXCEPTION 'Gmail global kill switch requires guarded function'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER gmail_global_kill_requires_function
  BEFORE UPDATE OR DELETE ON gmail_draft_global_kill_switch
  FOR EACH ROW EXECUTE FUNCTION guard_gmail_global_kill_switch();

CREATE OR REPLACE FUNCTION queue_gmail_credential_revocation(
  p_organization_id uuid,
  p_credential_version_id uuid,
  p_trace_id text,
  p_request_id text,
  p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = operating_layer, public
AS $$
DECLARE
  v_outbox_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO gmail_draft_credential_lifecycle_events (
    organization_id, credential_version_id, event_type, actor_type, actor_id,
    purpose, trace_id, metadata
  ) VALUES (
    p_organization_id, p_credential_version_id, 'revocation_requested',
    'user', current_request_user_id()::text, p_reason, p_trace_id,
    jsonb_build_object('requestId', p_request_id)
  );
  INSERT INTO outbox_events (
    id, organization_id, topic, aggregate_type, aggregate_id,
    payload_reference, payload_hash, idempotency_key, trace_id,
    requested_by_user_id, request_id, max_attempts
  ) VALUES (
    v_outbox_id, p_organization_id, 'gmail.credential.revoke',
    'gmail_draft_credential', p_credential_version_id,
    'postgresql://operating_layer/gmail_draft_credential_versions/'
      || p_credential_version_id::text,
    encode(digest(p_credential_version_id::text || ':' || p_reason, 'sha256'), 'hex'),
    p_credential_version_id::text || ':revoke', p_trace_id,
    current_request_user_id(), p_request_id, 3
  ) ON CONFLICT (organization_id, topic, idempotency_key) DO NOTHING;
  RETURN v_outbox_id;
END;
$$;

CREATE OR REPLACE FUNCTION store_gmail_draft_credential(
  p_credential_version_id uuid,
  p_organization_id uuid,
  p_algorithm text,
  p_ciphertext text,
  p_nonce text,
  p_authentication_tag text,
  p_wrapped_data_key text,
  p_token_fingerprint text,
  p_granted_scopes text[],
  p_reason text,
  p_trace_id text,
  p_request_id text
)
RETURNS TABLE (
  credential_version_id uuid,
  version_number integer,
  replaced_credential_version_id uuid,
  revocation_outbox_event_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = operating_layer, public
AS $$
DECLARE
  v_version integer;
  v_old uuid;
  v_outbox uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('gmail-draft-global-kill'));
  IF NOT current_request_user_has_permission(p_organization_id, 'connectors.admin') THEN
    RAISE EXCEPTION 'connector administration permission denied'
      USING ERRCODE = '42501';
  END IF;
  IF p_granted_scopes IS DISTINCT FROM
       ARRAY['https://www.googleapis.com/auth/gmail.compose']::text[] THEN
    RAISE EXCEPTION 'Gmail credential scopes exceed the exact allowlist'
      USING ERRCODE = '23514';
  END IF;
  SELECT active_credential_version_id INTO v_old
  FROM gmail_draft_credential_bindings
  WHERE organization_id = p_organization_id
  FOR UPDATE;
  SELECT COALESCE(max(credential.version_number), 0) + 1 INTO v_version
  FROM gmail_draft_credential_versions credential
  WHERE credential.organization_id = p_organization_id;
  INSERT INTO gmail_draft_credential_versions (
    id, organization_id, version_number, algorithm, ciphertext, nonce,
    authentication_tag, wrapped_data_key, token_fingerprint, granted_scopes,
    created_by_user_id, reason
  ) VALUES (
    p_credential_version_id, p_organization_id, v_version, p_algorithm,
    p_ciphertext, p_nonce, p_authentication_tag, p_wrapped_data_key,
    p_token_fingerprint, p_granted_scopes, current_request_user_id(), p_reason
  );
  INSERT INTO gmail_draft_credential_lifecycle_events (
    organization_id, credential_version_id, event_type, actor_type, actor_id,
    purpose, trace_id
  ) VALUES
    (p_organization_id, p_credential_version_id, 'stored', 'user',
     current_request_user_id()::text, p_reason, p_trace_id),
    (p_organization_id, p_credential_version_id, 'activated', 'user',
     current_request_user_id()::text, p_reason, p_trace_id);
  PERFORM set_config(
    'app.gmail_credential_binding_guard', 'gmail_credential_binding:v1', true
  );
  INSERT INTO gmail_draft_credential_bindings (
    organization_id, active_credential_version_id, binding_version,
    updated_by_user_id
  ) VALUES (
    p_organization_id, p_credential_version_id, 1, current_request_user_id()
  ) ON CONFLICT (organization_id) DO UPDATE SET
    active_credential_version_id = EXCLUDED.active_credential_version_id,
    binding_version = gmail_draft_credential_bindings.binding_version + 1,
    updated_by_user_id = EXCLUDED.updated_by_user_id,
    updated_at = now();
  PERFORM set_config('app.gmail_credential_binding_guard', '', true);
  IF v_old IS NOT NULL AND v_old <> p_credential_version_id THEN
    INSERT INTO gmail_draft_credential_lifecycle_events (
      organization_id, credential_version_id, event_type, actor_type, actor_id,
      purpose, trace_id
    ) VALUES (
      p_organization_id, v_old, 'invalidated', 'user',
      current_request_user_id()::text, 'credential_rotation', p_trace_id
    );
    v_outbox := queue_gmail_credential_revocation(
      p_organization_id, v_old, p_trace_id, p_request_id, 'credential_rotation'
    );
  END IF;
  RETURN QUERY SELECT p_credential_version_id, v_version, v_old, v_outbox;
END;
$$;

CREATE OR REPLACE FUNCTION invalidate_gmail_draft_credential(
  p_organization_id uuid,
  p_reason text,
  p_trace_id text,
  p_request_id text
)
RETURNS TABLE (
  invalidated_credential_version_id uuid,
  revocation_outbox_event_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = operating_layer, public
AS $$
DECLARE
  v_old uuid;
  v_outbox uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('gmail-draft-global-kill'));
  IF NOT current_request_user_has_permission(p_organization_id, 'connectors.admin') THEN
    RAISE EXCEPTION 'connector administration permission denied'
      USING ERRCODE = '42501';
  END IF;
  SELECT active_credential_version_id INTO v_old
  FROM gmail_draft_credential_bindings
  WHERE organization_id = p_organization_id
  FOR UPDATE;
  IF v_old IS NOT NULL THEN
    PERFORM set_config(
      'app.gmail_credential_binding_guard', 'gmail_credential_binding:v1', true
    );
    UPDATE gmail_draft_credential_bindings SET
      active_credential_version_id = NULL,
      binding_version = binding_version + 1,
      updated_by_user_id = current_request_user_id(),
      updated_at = now()
    WHERE organization_id = p_organization_id;
    PERFORM set_config('app.gmail_credential_binding_guard', '', true);
    INSERT INTO gmail_draft_credential_lifecycle_events (
      organization_id, credential_version_id, event_type, actor_type, actor_id,
      purpose, trace_id
    ) VALUES (
      p_organization_id, v_old, 'invalidated', 'user',
      current_request_user_id()::text, p_reason, p_trace_id
    );
    v_outbox := queue_gmail_credential_revocation(
      p_organization_id, v_old, p_trace_id, p_request_id, p_reason
    );
  END IF;
  RETURN QUERY SELECT v_old, v_outbox;
END;
$$;

CREATE OR REPLACE FUNCTION load_gmail_draft_credential(
  p_credential_version_id uuid,
  p_organization_id uuid,
  p_purpose text,
  p_trace_id text
)
RETURNS TABLE (
  credential_version_id uuid,
  algorithm text,
  ciphertext text,
  nonce text,
  authentication_tag text,
  wrapped_data_key text,
  token_fingerprint text,
  granted_scopes text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = operating_layer, public
AS $$
DECLARE
  v_is_revocation boolean;
BEGIN
  IF NOT pg_has_role(current_user, 'operating_layer_worker', 'member') THEN
    RAISE EXCEPTION 'credential load is restricted to the worker role'
      USING ERRCODE = '42501';
  END IF;
  IF NOT current_user_can_access_organization(p_organization_id) THEN
    RAISE EXCEPTION 'organization access denied' USING ERRCODE = '42501';
  END IF;
  v_is_revocation := p_purpose = 'oauth_revocation';
  IF NOT v_is_revocation AND NOT EXISTS (
    SELECT 1 FROM gmail_draft_credential_bindings binding
    JOIN gmail_draft_global_kill_switch kill ON kill.singleton
    WHERE binding.organization_id = p_organization_id
      AND binding.active_credential_version_id = p_credential_version_id
      AND NOT kill.killed
  ) THEN
    RAISE EXCEPTION 'credential is not active' USING ERRCODE = '42501';
  END IF;
  IF v_is_revocation AND NOT EXISTS (
    SELECT 1 FROM gmail_draft_credential_lifecycle_events event
    WHERE event.organization_id = p_organization_id
      AND event.credential_version_id = p_credential_version_id
      AND event.event_type = 'revocation_requested'
  ) THEN
    RAISE EXCEPTION 'credential is not pending revocation'
      USING ERRCODE = '42501';
  END IF;
  INSERT INTO gmail_draft_credential_lifecycle_events (
    organization_id, credential_version_id, event_type, actor_type, actor_id,
    purpose, trace_id
  ) VALUES (
    p_organization_id, p_credential_version_id, 'loaded', 'service',
    current_user::text, p_purpose, p_trace_id
  );
  RETURN QUERY
  SELECT credential.id, credential.algorithm, credential.ciphertext,
         credential.nonce, credential.authentication_tag,
         credential.wrapped_data_key, credential.token_fingerprint,
         credential.granted_scopes
  FROM gmail_draft_credential_versions credential
  WHERE credential.id = p_credential_version_id
    AND credential.organization_id = p_organization_id;
END;
$$;

CREATE OR REPLACE FUNCTION record_gmail_credential_use(
  p_credential_version_id uuid,
  p_organization_id uuid,
  p_event_type text,
  p_purpose text,
  p_trace_id text,
  p_metadata jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = operating_layer, public
AS $$
BEGIN
  IF NOT pg_has_role(current_user, 'operating_layer_worker', 'member') THEN
    RAISE EXCEPTION 'credential use is restricted to the worker role'
      USING ERRCODE = '42501';
  END IF;
  IF p_event_type NOT IN ('used', 'revoked', 'revocation_failed') THEN
    RAISE EXCEPTION 'invalid credential use event' USING ERRCODE = '22023';
  END IF;
  INSERT INTO gmail_draft_credential_lifecycle_events (
    organization_id, credential_version_id, event_type, actor_type, actor_id,
    purpose, trace_id, metadata
  ) VALUES (
    p_organization_id, p_credential_version_id, p_event_type, 'service',
    current_user::text, p_purpose, p_trace_id, p_metadata
  );
END;
$$;

CREATE OR REPLACE FUNCTION assert_gmail_credential_storage_invariants()
RETURNS TABLE (
  unsafe_legacy_references bigint,
  enabled_without_active_credential bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = operating_layer, public
AS $$
  SELECT
    (
      SELECT count(*)
      FROM gmail_draft_connector_config_versions config
      WHERE config.credential_secret_reference IS NOT NULL
        AND config.credential_secret_reference <>
          'credential://gmail-draft/active'
    ),
    (
      SELECT count(*)
      FROM gmail_draft_connector_bindings binding
      JOIN gmail_draft_connector_config_versions config
        ON config.id = binding.active_config_version_id
       AND config.organization_id = binding.organization_id
      LEFT JOIN gmail_draft_credential_bindings credential
        ON credential.organization_id = binding.organization_id
      WHERE config.enabled
        AND credential.active_credential_version_id IS NULL
    );
$$;

CREATE OR REPLACE FUNCTION set_gmail_draft_global_kill(
  p_killed boolean,
  p_trace_id text,
  p_request_id text,
  p_reason text
)
RETURNS TABLE (
  organization_id uuid,
  invalidated_credential_version_id uuid,
  revocation_outbox_event_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = operating_layer, public
AS $$
DECLARE
  v_org record;
  v_outbox uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('gmail-draft-global-kill'));
  IF NOT EXISTS (
    SELECT 1 FROM organization_memberships membership
    JOIN permission_set_grants grant_row
      ON grant_row.permission_set_id = membership.permission_set_id
    WHERE membership.user_id = current_request_user_id()
      AND membership.status = 'active'
      AND grant_row.permission = 'admin.manage'
  ) THEN
    RAISE EXCEPTION 'global connector kill permission denied'
      USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('app.gmail_global_kill_guard', 'gmail_global_kill:v1', true);
  UPDATE gmail_draft_global_kill_switch SET
    killed = p_killed,
    switch_version = switch_version + 1,
    updated_by_user_id = current_request_user_id(),
    updated_at = now()
  WHERE singleton;
  PERFORM set_config('app.gmail_global_kill_guard', '', true);
  IF p_killed THEN
    FOR v_org IN
      SELECT binding.organization_id, binding.active_credential_version_id
      FROM gmail_draft_credential_bindings binding
      WHERE binding.active_credential_version_id IS NOT NULL
      FOR UPDATE
    LOOP
      PERFORM set_config(
        'app.gmail_credential_binding_guard', 'gmail_credential_binding:v1', true
      );
      UPDATE gmail_draft_credential_bindings SET
        active_credential_version_id = NULL,
        binding_version = binding_version + 1,
        updated_by_user_id = current_request_user_id(),
        updated_at = now()
      WHERE gmail_draft_credential_bindings.organization_id =
        v_org.organization_id;
      PERFORM set_config('app.gmail_credential_binding_guard', '', true);
      INSERT INTO gmail_draft_credential_lifecycle_events (
        organization_id, credential_version_id, event_type, actor_type,
        actor_id, purpose, trace_id
      ) VALUES (
        v_org.organization_id, v_org.active_credential_version_id,
        'invalidated', 'user', current_request_user_id()::text,
        p_reason, p_trace_id
      );
      v_outbox := queue_gmail_credential_revocation(
        v_org.organization_id, v_org.active_credential_version_id,
        p_trace_id, p_request_id, p_reason
      );
      organization_id := v_org.organization_id;
      invalidated_credential_version_id := v_org.active_credential_version_id;
      revocation_outbox_event_id := v_outbox;
      RETURN NEXT;
    END LOOP;
  END IF;
END;
$$;

ALTER TABLE gmail_draft_credential_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmail_draft_credential_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON gmail_draft_credential_versions
  FOR ALL USING (current_user_can_access_organization(organization_id))
  WITH CHECK (current_user_can_access_organization(organization_id));
ALTER TABLE gmail_draft_credential_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmail_draft_credential_lifecycle_events FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON gmail_draft_credential_lifecycle_events
  FOR ALL USING (current_user_can_access_organization(organization_id))
  WITH CHECK (current_user_can_access_organization(organization_id));
ALTER TABLE gmail_draft_credential_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmail_draft_credential_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON gmail_draft_credential_bindings
  FOR ALL USING (current_user_can_access_organization(organization_id))
  WITH CHECK (current_user_can_access_organization(organization_id));

REVOKE ALL ON gmail_draft_credential_versions,
  gmail_draft_credential_lifecycle_events,
  gmail_draft_credential_bindings FROM PUBLIC, operating_layer_app;
GRANT SELECT ON gmail_draft_credential_versions,
  gmail_draft_credential_lifecycle_events,
  gmail_draft_credential_bindings TO operating_layer_worker;
GRANT INSERT ON gmail_draft_credential_lifecycle_events TO operating_layer_worker;
GRANT SELECT ON gmail_draft_credential_bindings,
  gmail_draft_credential_lifecycle_events TO operating_layer_app;
GRANT SELECT ON gmail_draft_global_kill_switch TO operating_layer_app;

REVOKE ALL ON FUNCTION load_gmail_draft_credential(uuid, uuid, text, text)
  FROM PUBLIC, operating_layer_app;
REVOKE ALL ON FUNCTION record_gmail_credential_use(
  uuid, uuid, text, text, text, jsonb
) FROM PUBLIC, operating_layer_app;
GRANT EXECUTE ON FUNCTION load_gmail_draft_credential(uuid, uuid, text, text)
  TO operating_layer_worker;
GRANT EXECUTE ON FUNCTION record_gmail_credential_use(
  uuid, uuid, text, text, text, jsonb
) TO operating_layer_worker;
REVOKE ALL ON FUNCTION assert_gmail_credential_storage_invariants()
  FROM PUBLIC, operating_layer_app;
GRANT EXECUTE ON FUNCTION assert_gmail_credential_storage_invariants()
  TO operating_layer_worker;
REVOKE ALL ON FUNCTION queue_gmail_credential_revocation(
  uuid, uuid, text, text, text
) FROM PUBLIC, operating_layer_app, operating_layer_worker;
REVOKE ALL ON FUNCTION store_gmail_draft_credential(
  uuid, uuid, text, text, text, text, text, text, text[], text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION invalidate_gmail_draft_credential(
  uuid, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_gmail_draft_global_kill(
  boolean, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION store_gmail_draft_credential(
  uuid, uuid, text, text, text, text, text, text, text[], text, text, text
) TO operating_layer_app;
GRANT EXECUTE ON FUNCTION invalidate_gmail_draft_credential(
  uuid, text, text, text
) TO operating_layer_app;
GRANT EXECUTE ON FUNCTION set_gmail_draft_global_kill(
  boolean, text, text, text
) TO operating_layer_app;

COMMIT;
