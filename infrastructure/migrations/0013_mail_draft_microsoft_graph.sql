-- Migration 0013: move the draft-mail subsystem from Google to Microsoft 365.
--
-- The group runs on Outlook; the draft output path was built against Gmail,
-- with the Google OAuth scope pinned inside CHECK constraints. This renames the
-- whole subsystem to a provider-neutral mail_draft_* and re-pins the scope to
-- Microsoft Graph.
--
-- Generated from the live schema (176 objects) rather than hand-written: a table
-- rename silently breaks every PL/pgSQL body that references it, so all 21
-- functions are recreated with updated bodies.
--
-- Scope note: Gmail offered gmail.compose, which could create drafts but could
-- neither send nor read. Graph has no compose-only equivalent; Mail.ReadWrite is
-- the minimum that can create a draft, and it also grants mailbox read. That is
-- inherent to Graph. Mail.Send is NEVER granted, and the equality CHECK below
-- makes granting it impossible without a migration.

BEGIN;

SET search_path TO operating_layer, public;

-- 1. Drop triggers so their functions can be replaced.
DROP TRIGGER IF EXISTS gmail_draft_authorization_requires_audit ON gmail_draft_authorizations;
DROP TRIGGER IF EXISTS gmail_draft_authorization_requires_gates ON gmail_draft_authorizations;
DROP TRIGGER IF EXISTS gmail_draft_authorizations_are_immutable ON gmail_draft_authorizations;
DROP TRIGGER IF EXISTS gmail_draft_binding_requires_function ON gmail_draft_connector_bindings;
DROP TRIGGER IF EXISTS gmail_draft_live_pilot_limits_enabled_organization ON gmail_draft_connector_bindings;
DROP TRIGGER IF EXISTS gmail_draft_config_requires_audit ON gmail_draft_connector_config_versions;
DROP TRIGGER IF EXISTS gmail_draft_config_versions_are_immutable ON gmail_draft_connector_config_versions;
DROP TRIGGER IF EXISTS gmail_credential_binding_requires_function ON gmail_draft_credential_bindings;
DROP TRIGGER IF EXISTS gmail_credential_lifecycle_is_immutable ON gmail_draft_credential_lifecycle_events;
DROP TRIGGER IF EXISTS gmail_credential_versions_are_immutable ON gmail_draft_credential_versions;
DROP TRIGGER IF EXISTS gmail_draft_abandonment_requires_audit ON gmail_draft_execution_abandonments;
DROP TRIGGER IF EXISTS gmail_draft_abandonments_are_immutable ON gmail_draft_execution_abandonments;
DROP TRIGGER IF EXISTS gmail_global_kill_requires_function ON gmail_draft_global_kill_switch;
DROP TRIGGER IF EXISTS gmail_draft_live_pilot_control_requires_function ON gmail_draft_live_pilot_control;
DROP TRIGGER IF EXISTS gmail_draft_live_pilot_events_are_immutable ON gmail_draft_live_pilot_events;
DROP TRIGGER IF EXISTS gmail_draft_preview_requires_audit ON gmail_draft_previews;
DROP TRIGGER IF EXISTS gmail_draft_preview_requires_gates ON gmail_draft_previews;
DROP TRIGGER IF EXISTS gmail_draft_previews_are_immutable ON gmail_draft_previews;

-- 2. Drop the functions that are being RENAMED. Functions whose own name
--    does not change are re-emitted with CREATE OR REPLACE further down
--    instead: dropping one would fail or cascade away a trigger that
--    depends on it. They still need new bodies, because they reference the
--    renamed tables and would break silently otherwise.
DROP FUNCTION IF EXISTS abandon_gmail_draft_execution(p_abandonment_id uuid, p_execution_command_id uuid, p_organization_id uuid, p_reason_code text, p_trace_id text);
DROP FUNCTION IF EXISTS assert_gmail_credential_storage_invariants();
DROP FUNCTION IF EXISTS claim_gmail_draft_live_pilot(p_organization_id uuid, p_reason text, p_trace_id text, p_request_id text);
DROP FUNCTION IF EXISTS enqueue_gmail_draft_execution(p_execution_command_id uuid, p_outbox_event_id uuid, p_authorization_id uuid, p_organization_id uuid, p_idempotency_key text, p_trace_id text, p_request_id text);
DROP FUNCTION IF EXISTS guard_gmail_credential_binding();
DROP FUNCTION IF EXISTS guard_gmail_draft_binding_update();
DROP FUNCTION IF EXISTS guard_gmail_draft_live_pilot_binding();
DROP FUNCTION IF EXISTS guard_gmail_draft_live_pilot_control();
DROP FUNCTION IF EXISTS guard_gmail_global_kill_switch();
DROP FUNCTION IF EXISTS inspect_gmail_draft_live_pilot(p_organization_id uuid, p_expected_recipient text, p_expected_credential_fingerprint text);
DROP FUNCTION IF EXISTS invalidate_gmail_draft_credential(p_organization_id uuid, p_reason text, p_trace_id text, p_request_id text);
DROP FUNCTION IF EXISTS load_gmail_draft_credential(p_credential_version_id uuid, p_organization_id uuid, p_purpose text, p_trace_id text);
DROP FUNCTION IF EXISTS queue_gmail_credential_revocation(p_organization_id uuid, p_credential_version_id uuid, p_trace_id text, p_request_id text, p_reason text);
DROP FUNCTION IF EXISTS record_gmail_credential_use(p_credential_version_id uuid, p_organization_id uuid, p_event_type text, p_purpose text, p_trace_id text, p_metadata jsonb);
DROP FUNCTION IF EXISTS release_gmail_draft_live_pilot(p_organization_id uuid, p_reason text, p_trace_id text, p_request_id text);
DROP FUNCTION IF EXISTS set_gmail_draft_connector_config(p_config_version_id uuid, p_organization_id uuid, p_enabled boolean, p_allowed_recipient_addresses text[], p_allowed_recipient_domains text[], p_credential_secret_reference text, p_content_hash text, p_reason text);
DROP FUNCTION IF EXISTS set_gmail_draft_global_kill(p_killed boolean, p_trace_id text, p_request_id text, p_reason text);
DROP FUNCTION IF EXISTS store_gmail_draft_credential(p_credential_version_id uuid, p_organization_id uuid, p_algorithm text, p_ciphertext text, p_nonce text, p_authentication_tag text, p_wrapped_data_key text, p_token_fingerprint text, p_granted_scopes text[], p_reason text, p_trace_id text, p_request_id text);
DROP FUNCTION IF EXISTS validate_gmail_draft_authorization();
DROP FUNCTION IF EXISTS validate_gmail_draft_preview();
DROP FUNCTION IF EXISTS verify_gmail_draft_fact_audited();

-- 3. Rename tables.
ALTER TABLE gmail_draft_authorizations RENAME TO mail_draft_authorizations;
ALTER TABLE gmail_draft_connector_bindings RENAME TO mail_draft_connector_bindings;
ALTER TABLE gmail_draft_connector_config_versions RENAME TO mail_draft_connector_config_versions;
ALTER TABLE gmail_draft_credential_bindings RENAME TO mail_draft_credential_bindings;
ALTER TABLE gmail_draft_credential_lifecycle_events RENAME TO mail_draft_credential_lifecycle_events;
ALTER TABLE gmail_draft_credential_versions RENAME TO mail_draft_credential_versions;
ALTER TABLE gmail_draft_execution_abandonments RENAME TO mail_draft_execution_abandonments;
ALTER TABLE gmail_draft_global_kill_switch RENAME TO mail_draft_global_kill_switch;
ALTER TABLE gmail_draft_live_pilot_control RENAME TO mail_draft_live_pilot_control;
ALTER TABLE gmail_draft_live_pilot_events RENAME TO mail_draft_live_pilot_events;
ALTER TABLE gmail_draft_previews RENAME TO mail_draft_previews;

-- 4. Rename constraints (a table rename does not rename them, and their
--    names surface in operator-facing error messages).
ALTER TABLE mail_draft_authorizations RENAME CONSTRAINT gmail_draft_authorizations_approval_id_organization_id_fkey TO mail_draft_authorizations_approval_id_organization_id_fkey;
ALTER TABLE mail_draft_authorizations RENAME CONSTRAINT gmail_draft_authorizations_authorized_by_user_id_fkey TO mail_draft_authorizations_authorized_by_user_id_fkey;
ALTER TABLE mail_draft_authorizations RENAME CONSTRAINT gmail_draft_authorizations_connector_config_version_id_org_fkey TO mail_draft_authorizations_connector_config_version_id_org_fkey;
ALTER TABLE mail_draft_authorizations RENAME CONSTRAINT gmail_draft_authorizations_id_organization_id_key TO mail_draft_authorizations_id_organization_id_key;
ALTER TABLE mail_draft_authorizations RENAME CONSTRAINT gmail_draft_authorizations_organization_id_fkey TO mail_draft_authorizations_organization_id_fkey;
ALTER TABLE mail_draft_authorizations RENAME CONSTRAINT gmail_draft_authorizations_organization_id_idempotency_key_key TO mail_draft_authorizations_organization_id_idempotency_key_key;
ALTER TABLE mail_draft_authorizations RENAME CONSTRAINT gmail_draft_authorizations_organization_id_preview_id_key TO mail_draft_authorizations_organization_id_preview_id_key;
ALTER TABLE mail_draft_authorizations RENAME CONSTRAINT gmail_draft_authorizations_pkey TO mail_draft_authorizations_pkey;
ALTER TABLE mail_draft_authorizations RENAME CONSTRAINT gmail_draft_authorizations_preview_id_organization_id_fkey TO mail_draft_authorizations_preview_id_organization_id_fkey;
ALTER TABLE mail_draft_authorizations RENAME CONSTRAINT gmail_draft_authorizations_reason_check TO mail_draft_authorizations_reason_check;
ALTER TABLE mail_draft_authorizations RENAME CONSTRAINT gmail_draft_authorizations_rendered_payload_hash_check TO mail_draft_authorizations_rendered_payload_hash_check;
ALTER TABLE mail_draft_authorizations RENAME CONSTRAINT gmail_draft_authorizations_task_id_organization_id_fkey TO mail_draft_authorizations_task_id_organization_id_fkey;
ALTER TABLE mail_draft_authorizations RENAME CONSTRAINT gmail_draft_authorizations_workflow_id_organization_id_fkey TO mail_draft_authorizations_workflow_id_organization_id_fkey;
ALTER TABLE mail_draft_connector_bindings RENAME CONSTRAINT gmail_draft_connector_binding_active_config_version_id_org_fkey TO mail_draft_connector_binding_active_config_version_id_org_fkey;
ALTER TABLE mail_draft_connector_bindings RENAME CONSTRAINT gmail_draft_connector_bindings_binding_version_check TO mail_draft_connector_bindings_binding_version_check;
ALTER TABLE mail_draft_connector_bindings RENAME CONSTRAINT gmail_draft_connector_bindings_organization_id_fkey TO mail_draft_connector_bindings_organization_id_fkey;
ALTER TABLE mail_draft_connector_bindings RENAME CONSTRAINT gmail_draft_connector_bindings_pkey TO mail_draft_connector_bindings_pkey;
ALTER TABLE mail_draft_connector_bindings RENAME CONSTRAINT gmail_draft_connector_bindings_updated_by_user_id_fkey TO mail_draft_connector_bindings_updated_by_user_id_fkey;
ALTER TABLE mail_draft_connector_config_versions RENAME CONSTRAINT gmail_draft_connector_config__allowed_recipient_addresses_check TO mail_draft_connector_config__allowed_recipient_addresses_check;
ALTER TABLE mail_draft_connector_config_versions RENAME CONSTRAINT gmail_draft_connector_config__organization_id_version_numbe_key TO mail_draft_connector_config__organization_id_version_numbe_key;
ALTER TABLE mail_draft_connector_config_versions RENAME CONSTRAINT gmail_draft_connector_config_ve_allowed_recipient_domains_check TO mail_draft_connector_config_ve_allowed_recipient_domains_check;
ALTER TABLE mail_draft_connector_config_versions RENAME CONSTRAINT gmail_draft_connector_config_versions_check TO mail_draft_connector_config_versions_check;
ALTER TABLE mail_draft_connector_config_versions RENAME CONSTRAINT gmail_draft_connector_config_versions_content_hash_check TO mail_draft_connector_config_versions_content_hash_check;
ALTER TABLE mail_draft_connector_config_versions RENAME CONSTRAINT gmail_draft_connector_config_versions_created_by_user_id_fkey TO mail_draft_connector_config_versions_created_by_user_id_fkey;
ALTER TABLE mail_draft_connector_config_versions RENAME CONSTRAINT gmail_draft_connector_config_versions_id_organization_id_key TO mail_draft_connector_config_versions_id_organization_id_key;
ALTER TABLE mail_draft_connector_config_versions RENAME CONSTRAINT gmail_draft_connector_config_versions_oauth_scopes_check TO mail_draft_connector_config_versions_oauth_scopes_check;
ALTER TABLE mail_draft_connector_config_versions RENAME CONSTRAINT gmail_draft_connector_config_versions_organization_id_fkey TO mail_draft_connector_config_versions_organization_id_fkey;
ALTER TABLE mail_draft_connector_config_versions RENAME CONSTRAINT gmail_draft_connector_config_versions_pkey TO mail_draft_connector_config_versions_pkey;
ALTER TABLE mail_draft_connector_config_versions RENAME CONSTRAINT gmail_draft_connector_config_versions_reason_check TO mail_draft_connector_config_versions_reason_check;
ALTER TABLE mail_draft_connector_config_versions RENAME CONSTRAINT gmail_draft_connector_config_versions_version_number_check TO mail_draft_connector_config_versions_version_number_check;
ALTER TABLE mail_draft_credential_bindings RENAME CONSTRAINT gmail_draft_credential_bindin_active_credential_version_id_fkey TO mail_draft_credential_bindin_active_credential_version_id_fkey;
ALTER TABLE mail_draft_credential_bindings RENAME CONSTRAINT gmail_draft_credential_bindings_binding_version_check TO mail_draft_credential_bindings_binding_version_check;
ALTER TABLE mail_draft_credential_bindings RENAME CONSTRAINT gmail_draft_credential_bindings_organization_id_fkey TO mail_draft_credential_bindings_organization_id_fkey;
ALTER TABLE mail_draft_credential_bindings RENAME CONSTRAINT gmail_draft_credential_bindings_pkey TO mail_draft_credential_bindings_pkey;
ALTER TABLE mail_draft_credential_bindings RENAME CONSTRAINT gmail_draft_credential_bindings_updated_by_user_id_fkey TO mail_draft_credential_bindings_updated_by_user_id_fkey;
ALTER TABLE mail_draft_credential_lifecycle_events RENAME CONSTRAINT gmail_draft_credential_lifecy_credential_version_id_organi_fkey TO mail_draft_credential_lifecy_credential_version_id_organi_fkey;
ALTER TABLE mail_draft_credential_lifecycle_events RENAME CONSTRAINT gmail_draft_credential_lifecycle_events_actor_type_check TO mail_draft_credential_lifecycle_events_actor_type_check;
ALTER TABLE mail_draft_credential_lifecycle_events RENAME CONSTRAINT gmail_draft_credential_lifecycle_events_event_type_check TO mail_draft_credential_lifecycle_events_event_type_check;
ALTER TABLE mail_draft_credential_lifecycle_events RENAME CONSTRAINT gmail_draft_credential_lifecycle_events_organization_id_fkey TO mail_draft_credential_lifecycle_events_organization_id_fkey;
ALTER TABLE mail_draft_credential_lifecycle_events RENAME CONSTRAINT gmail_draft_credential_lifecycle_events_pkey TO mail_draft_credential_lifecycle_events_pkey;
ALTER TABLE mail_draft_credential_lifecycle_events RENAME CONSTRAINT gmail_draft_credential_lifecycle_events_purpose_check TO mail_draft_credential_lifecycle_events_purpose_check;
ALTER TABLE mail_draft_credential_versions RENAME CONSTRAINT gmail_draft_credential_versio_organization_id_version_numbe_key TO mail_draft_credential_versio_organization_id_version_numbe_key;
ALTER TABLE mail_draft_credential_versions RENAME CONSTRAINT gmail_draft_credential_versions_algorithm_check TO mail_draft_credential_versions_algorithm_check;
ALTER TABLE mail_draft_credential_versions RENAME CONSTRAINT gmail_draft_credential_versions_authentication_tag_check TO mail_draft_credential_versions_authentication_tag_check;
ALTER TABLE mail_draft_credential_versions RENAME CONSTRAINT gmail_draft_credential_versions_ciphertext_check TO mail_draft_credential_versions_ciphertext_check;
ALTER TABLE mail_draft_credential_versions RENAME CONSTRAINT gmail_draft_credential_versions_created_by_user_id_fkey TO mail_draft_credential_versions_created_by_user_id_fkey;
ALTER TABLE mail_draft_credential_versions RENAME CONSTRAINT gmail_draft_credential_versions_granted_scopes_check TO mail_draft_credential_versions_granted_scopes_check;
ALTER TABLE mail_draft_credential_versions RENAME CONSTRAINT gmail_draft_credential_versions_id_organization_id_key TO mail_draft_credential_versions_id_organization_id_key;
ALTER TABLE mail_draft_credential_versions RENAME CONSTRAINT gmail_draft_credential_versions_nonce_check TO mail_draft_credential_versions_nonce_check;
ALTER TABLE mail_draft_credential_versions RENAME CONSTRAINT gmail_draft_credential_versions_organization_id_fkey TO mail_draft_credential_versions_organization_id_fkey;
ALTER TABLE mail_draft_credential_versions RENAME CONSTRAINT gmail_draft_credential_versions_pkey TO mail_draft_credential_versions_pkey;
ALTER TABLE mail_draft_credential_versions RENAME CONSTRAINT gmail_draft_credential_versions_reason_check TO mail_draft_credential_versions_reason_check;
ALTER TABLE mail_draft_credential_versions RENAME CONSTRAINT gmail_draft_credential_versions_token_fingerprint_check TO mail_draft_credential_versions_token_fingerprint_check;
ALTER TABLE mail_draft_credential_versions RENAME CONSTRAINT gmail_draft_credential_versions_version_number_check TO mail_draft_credential_versions_version_number_check;
ALTER TABLE mail_draft_credential_versions RENAME CONSTRAINT gmail_draft_credential_versions_wrapped_data_key_check TO mail_draft_credential_versions_wrapped_data_key_check;
ALTER TABLE mail_draft_execution_abandonments RENAME CONSTRAINT gmail_draft_execution_abandon_authorization_id_organizatio_fkey TO mail_draft_execution_abandon_authorization_id_organizatio_fkey;
ALTER TABLE mail_draft_execution_abandonments RENAME CONSTRAINT gmail_draft_execution_abandon_connector_config_version_id__fkey TO mail_draft_execution_abandon_connector_config_version_id__fkey;
ALTER TABLE mail_draft_execution_abandonments RENAME CONSTRAINT gmail_draft_execution_abandon_execution_command_id_organiz_fkey TO mail_draft_execution_abandon_execution_command_id_organiz_fkey;
ALTER TABLE mail_draft_execution_abandonments RENAME CONSTRAINT gmail_draft_execution_abandon_organization_id_execution_com_key TO mail_draft_execution_abandon_organization_id_execution_com_key;
ALTER TABLE mail_draft_execution_abandonments RENAME CONSTRAINT gmail_draft_execution_abandonm_workflow_id_organization_id_fkey TO mail_draft_execution_abandonm_workflow_id_organization_id_fkey;
ALTER TABLE mail_draft_execution_abandonments RENAME CONSTRAINT gmail_draft_execution_abandonme_preview_id_organization_id_fkey TO mail_draft_execution_abandonme_preview_id_organization_id_fkey;
ALTER TABLE mail_draft_execution_abandonments RENAME CONSTRAINT gmail_draft_execution_abandonments_id_organization_id_key TO mail_draft_execution_abandonments_id_organization_id_key;
ALTER TABLE mail_draft_execution_abandonments RENAME CONSTRAINT gmail_draft_execution_abandonments_organization_id_fkey TO mail_draft_execution_abandonments_organization_id_fkey;
ALTER TABLE mail_draft_execution_abandonments RENAME CONSTRAINT gmail_draft_execution_abandonments_pkey TO mail_draft_execution_abandonments_pkey;
ALTER TABLE mail_draft_execution_abandonments RENAME CONSTRAINT gmail_draft_execution_abandonments_reason_code_check TO mail_draft_execution_abandonments_reason_code_check;
ALTER TABLE mail_draft_execution_abandonments RENAME CONSTRAINT gmail_draft_execution_abandonments_task_id_organization_id_fkey TO mail_draft_execution_abandonments_task_id_organization_id_fkey;
ALTER TABLE mail_draft_global_kill_switch RENAME CONSTRAINT gmail_draft_global_kill_switch_pkey TO mail_draft_global_kill_switch_pkey;
ALTER TABLE mail_draft_global_kill_switch RENAME CONSTRAINT gmail_draft_global_kill_switch_singleton_check TO mail_draft_global_kill_switch_singleton_check;
ALTER TABLE mail_draft_global_kill_switch RENAME CONSTRAINT gmail_draft_global_kill_switch_switch_version_check TO mail_draft_global_kill_switch_switch_version_check;
ALTER TABLE mail_draft_global_kill_switch RENAME CONSTRAINT gmail_draft_global_kill_switch_updated_by_user_id_fkey TO mail_draft_global_kill_switch_updated_by_user_id_fkey;
ALTER TABLE mail_draft_live_pilot_control RENAME CONSTRAINT gmail_draft_live_pilot_control_check TO mail_draft_live_pilot_control_check;
ALTER TABLE mail_draft_live_pilot_control RENAME CONSTRAINT gmail_draft_live_pilot_control_claim_version_check TO mail_draft_live_pilot_control_claim_version_check;
ALTER TABLE mail_draft_live_pilot_control RENAME CONSTRAINT gmail_draft_live_pilot_control_pkey TO mail_draft_live_pilot_control_pkey;
ALTER TABLE mail_draft_live_pilot_control RENAME CONSTRAINT gmail_draft_live_pilot_control_singleton_check TO mail_draft_live_pilot_control_singleton_check;
ALTER TABLE mail_draft_live_pilot_control RENAME CONSTRAINT gmail_draft_live_pilot_control_target_organization_id_fkey TO mail_draft_live_pilot_control_target_organization_id_fkey;
ALTER TABLE mail_draft_live_pilot_control RENAME CONSTRAINT gmail_draft_live_pilot_control_updated_by_user_id_fkey TO mail_draft_live_pilot_control_updated_by_user_id_fkey;
ALTER TABLE mail_draft_live_pilot_events RENAME CONSTRAINT gmail_draft_live_pilot_events_actor_id_fkey TO mail_draft_live_pilot_events_actor_id_fkey;
ALTER TABLE mail_draft_live_pilot_events RENAME CONSTRAINT gmail_draft_live_pilot_events_claim_version_check TO mail_draft_live_pilot_events_claim_version_check;
ALTER TABLE mail_draft_live_pilot_events RENAME CONSTRAINT gmail_draft_live_pilot_events_event_type_check TO mail_draft_live_pilot_events_event_type_check;
ALTER TABLE mail_draft_live_pilot_events RENAME CONSTRAINT gmail_draft_live_pilot_events_organization_id_fkey TO mail_draft_live_pilot_events_organization_id_fkey;
ALTER TABLE mail_draft_live_pilot_events RENAME CONSTRAINT gmail_draft_live_pilot_events_pkey TO mail_draft_live_pilot_events_pkey;
ALTER TABLE mail_draft_live_pilot_events RENAME CONSTRAINT gmail_draft_live_pilot_events_reason_check TO mail_draft_live_pilot_events_reason_check;
ALTER TABLE mail_draft_previews RENAME CONSTRAINT gmail_draft_previews_approval_id_organization_id_fkey TO mail_draft_previews_approval_id_organization_id_fkey;
ALTER TABLE mail_draft_previews RENAME CONSTRAINT gmail_draft_previews_body_check TO mail_draft_previews_body_check;
ALTER TABLE mail_draft_previews RENAME CONSTRAINT gmail_draft_previews_connector_config_version_id_organizat_fkey TO mail_draft_previews_connector_config_version_id_organizat_fkey;
ALTER TABLE mail_draft_previews RENAME CONSTRAINT gmail_draft_previews_id_organization_id_key TO mail_draft_previews_id_organization_id_key;
ALTER TABLE mail_draft_previews RENAME CONSTRAINT gmail_draft_previews_organization_id_approval_id_key TO mail_draft_previews_organization_id_approval_id_key;
ALTER TABLE mail_draft_previews RENAME CONSTRAINT gmail_draft_previews_organization_id_fkey TO mail_draft_previews_organization_id_fkey;
ALTER TABLE mail_draft_previews RENAME CONSTRAINT gmail_draft_previews_organization_id_idempotency_key_key TO mail_draft_previews_organization_id_idempotency_key_key;
ALTER TABLE mail_draft_previews RENAME CONSTRAINT gmail_draft_previews_pkey TO mail_draft_previews_pkey;
ALTER TABLE mail_draft_previews RENAME CONSTRAINT gmail_draft_previews_policy_content_hash_check TO mail_draft_previews_policy_content_hash_check;
ALTER TABLE mail_draft_previews RENAME CONSTRAINT gmail_draft_previews_policy_version_id_organization_id_fkey TO mail_draft_previews_policy_version_id_organization_id_fkey;
ALTER TABLE mail_draft_previews RENAME CONSTRAINT gmail_draft_previews_recipient_check TO mail_draft_previews_recipient_check;
ALTER TABLE mail_draft_previews RENAME CONSTRAINT gmail_draft_previews_recommendation_id_organization_id_fkey TO mail_draft_previews_recommendation_id_organization_id_fkey;
ALTER TABLE mail_draft_previews RENAME CONSTRAINT gmail_draft_previews_rendered_payload_hash_check TO mail_draft_previews_rendered_payload_hash_check;
ALTER TABLE mail_draft_previews RENAME CONSTRAINT gmail_draft_previews_requested_by_user_id_fkey TO mail_draft_previews_requested_by_user_id_fkey;
ALTER TABLE mail_draft_previews RENAME CONSTRAINT gmail_draft_previews_subject_check TO mail_draft_previews_subject_check;
ALTER TABLE mail_draft_previews RENAME CONSTRAINT gmail_draft_previews_task_id_organization_id_fkey TO mail_draft_previews_task_id_organization_id_fkey;
ALTER TABLE mail_draft_previews RENAME CONSTRAINT gmail_draft_previews_workflow_id_organization_id_fkey TO mail_draft_previews_workflow_id_organization_id_fkey;

-- 5. Rename standalone indexes (constraint-backed ones moved with their
--    constraint above).

-- 6. Recreate every function under its new name, with bodies pointing at the
--    renamed tables and the Graph scope.

CREATE OR REPLACE FUNCTION operating_layer.abandon_mail_draft_execution(p_abandonment_id uuid, p_execution_command_id uuid, p_organization_id uuid, p_reason_code text, p_trace_id text)
 RETURNS TABLE(abandonment_id uuid, workflow_id uuid, task_id uuid, workflow_state text, workflow_version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'operating_layer', 'public'
AS $function$
DECLARE
  v_command execution_commands%ROWTYPE;
  v_workflow workflows%ROWTYPE;
  v_preview mail_draft_previews%ROWTYPE;
  v_authorization mail_draft_authorizations%ROWTYPE;
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
    AND provider_name = 'mail_draft';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mail draft execution command not found'
      USING ERRCODE = 'P0002';
  END IF;
  IF p_reason_code NOT IN (
    'connector_disabled',
    'connector_config_changed'
  ) THEN
    RAISE EXCEPTION 'invalid mail draft abandonment reason'
      USING ERRCODE = '22023';
  END IF;
  SELECT *
  INTO v_authorization
  FROM mail_draft_authorizations
  WHERE id = v_command.external_authorization_id
    AND organization_id = p_organization_id;
  SELECT *
  INTO v_preview
  FROM mail_draft_previews
  WHERE id = v_authorization.preview_id
    AND organization_id = p_organization_id;
  SELECT *
  INTO v_workflow
  FROM workflows
  WHERE id = v_command.workflow_id
    AND organization_id = p_organization_id
  FOR UPDATE;
  IF v_workflow.current_state NOT IN ('external_authorized', 'executing') THEN
    RAISE EXCEPTION 'mail draft workflow is not active'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM execution_results result
    WHERE result.execution_command_id = v_command.id
      AND result.organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'materialized mail draft cannot be abandoned'
      USING ERRCODE = '23514';
  END IF;
  INSERT INTO mail_draft_execution_abandonments (
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
    'mail-draft-kill-switch',
    v_preview.rendered_payload_hash,
    NULL,
    p_trace_id,
    jsonb_build_object(
      'executionCommandId', v_command.id,
      'mailDraftAbandonmentId', p_abandonment_id,
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
$function$;

CREATE OR REPLACE FUNCTION operating_layer.assert_mail_credential_storage_invariants()
 RETURNS TABLE(unsafe_legacy_references bigint, enabled_without_active_credential bigint)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'operating_layer', 'public'
AS $function$
  SELECT
    (
      SELECT count(*)
      FROM mail_draft_connector_config_versions config
      WHERE config.credential_secret_reference IS NOT NULL
        AND config.credential_secret_reference <>
          'credential://mail-draft/active'
    ),
    (
      SELECT count(*)
      FROM mail_draft_connector_bindings binding
      JOIN mail_draft_connector_config_versions config
        ON config.id = binding.active_config_version_id
       AND config.organization_id = binding.organization_id
      LEFT JOIN mail_draft_credential_bindings credential
        ON credential.organization_id = binding.organization_id
      WHERE config.enabled
        AND credential.active_credential_version_id IS NULL
    );
$function$;

CREATE OR REPLACE FUNCTION operating_layer.begin_execution(p_execution_command_id uuid, p_organization_id uuid, p_input_hash text, p_trace_id text)
 RETURNS TABLE(workflow_id uuid, task_id uuid, workflow_state text, workflow_version integer, did_transition boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'operating_layer', 'public'
AS $function$
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
    FROM mail_draft_execution_abandonments abandonment
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
    v_command.provider_name = 'mail_draft'
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
        WHEN v_command.provider_name = 'mail_draft'
          THEN 'mail-draft-execution-worker'
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
$function$;

CREATE OR REPLACE FUNCTION operating_layer.claim_mail_draft_live_pilot(p_organization_id uuid, p_reason text, p_trace_id text, p_request_id text)
 RETURNS TABLE(organization_id uuid, organization_code text, claim_version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'operating_layer', 'public'
AS $function$
DECLARE
  v_control mail_draft_live_pilot_control%ROWTYPE;
  v_claim_version integer;
  v_organization_code text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('mail-draft-global-kill'));
  IF NOT current_user_can_administer_all_active_organizations() THEN
    RAISE EXCEPTION
      'live mail pilot requires admin.manage for every active organization'
      USING ERRCODE = '42501';
  END IF;
  SELECT code INTO v_organization_code
  FROM organizations
  WHERE id = p_organization_id
    AND status = 'active';
  IF v_organization_code IS NULL THEN
    RAISE EXCEPTION 'live mail pilot target organization is not active'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM mail_draft_global_kill_switch
    WHERE singleton
      AND killed
  ) THEN
    RAISE EXCEPTION 'global mail kill switch is active'
      USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_control
  FROM mail_draft_live_pilot_control
  WHERE singleton
  FOR UPDATE;
  IF v_control.target_organization_id IS NOT NULL
     AND v_control.target_organization_id <> p_organization_id THEN
    RAISE EXCEPTION 'another organization already owns the live mail pilot'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM mail_draft_connector_bindings binding
    JOIN mail_draft_connector_config_versions config
      ON config.id = binding.active_config_version_id
     AND config.organization_id = binding.organization_id
    WHERE config.enabled
      AND binding.organization_id <> p_organization_id
  ) THEN
    RAISE EXCEPTION
      'another organization has an enabled mail draft configuration'
      USING ERRCODE = '55000';
  END IF;
  PERFORM set_config(
    'app.mail_draft_live_pilot_guard',
    'mail_draft_live_pilot:v1',
    true
  );
  UPDATE mail_draft_live_pilot_control AS control
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
  PERFORM set_config('app.mail_draft_live_pilot_guard', '', true);
  INSERT INTO mail_draft_live_pilot_events (
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
$function$;

CREATE OR REPLACE FUNCTION operating_layer.enqueue_mail_draft_execution(p_execution_command_id uuid, p_outbox_event_id uuid, p_authorization_id uuid, p_organization_id uuid, p_idempotency_key text, p_trace_id text, p_request_id text)
 RETURNS TABLE(execution_command_id uuid, outbox_event_id uuid, workflow_id uuid, task_id uuid, approval_id uuid, recommendation_id uuid, preview_id uuid, action_payload_hash text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'operating_layer', 'public'
AS $function$
DECLARE
  v_authorization mail_draft_authorizations%ROWTYPE;
  v_preview mail_draft_previews%ROWTYPE;
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
  FROM mail_draft_authorizations
  WHERE id = p_authorization_id
    AND organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mail draft authorization not found'
      USING ERRCODE = 'P0002';
  END IF;
  SELECT *
  INTO v_preview
  FROM mail_draft_previews
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
    'mail_draft_create',
    'Create the explicitly authorized mail draft without sending it.',
    'mail_draft_preview:' || v_preview.id::text,
    v_preview.rendered_payload_hash,
    'mail_draft',
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
$function$;

CREATE OR REPLACE FUNCTION operating_layer.guard_execution_command_insert()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM execution_commands existing
    LEFT JOIN mail_draft_execution_abandonments abandonment
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
$function$;

CREATE OR REPLACE FUNCTION operating_layer.guard_mail_credential_binding()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_setting('app.mail_credential_binding_guard', true)
     IS DISTINCT FROM 'mail_credential_binding:v1' THEN
    RAISE EXCEPTION 'mail credential binding requires guarded function'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION operating_layer.guard_mail_draft_binding_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_setting('app.mail_draft_config_guard', true)
     IS DISTINCT FROM 'set_mail_draft_connector_config:v1' THEN
    RAISE EXCEPTION
      'mail draft connector binding must use the guarded config function'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION operating_layer.guard_mail_draft_live_pilot_binding()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'operating_layer', 'public'
AS $function$
DECLARE
  v_target_organization_id uuid;
  v_enabled boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('mail-draft-global-kill'));
  SELECT target_organization_id INTO v_target_organization_id
  FROM mail_draft_live_pilot_control
  WHERE singleton;
  IF v_target_organization_id IS NULL
     OR v_target_organization_id = NEW.organization_id THEN
    RETURN NEW;
  END IF;
  SELECT enabled INTO v_enabled
  FROM mail_draft_connector_config_versions
  WHERE id = NEW.active_config_version_id
    AND organization_id = NEW.organization_id;
  IF v_enabled THEN
    RAISE EXCEPTION
      'mail live pilot permits exactly one enabled organization'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION operating_layer.guard_mail_draft_live_pilot_control()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_setting('app.mail_draft_live_pilot_guard', true)
     IS DISTINCT FROM 'mail_draft_live_pilot:v1' THEN
    RAISE EXCEPTION 'mail live-pilot control requires guarded function'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION operating_layer.guard_mail_global_kill_switch()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_setting('app.mail_global_kill_guard', true)
     IS DISTINCT FROM 'mail_global_kill:v1' THEN
    RAISE EXCEPTION 'mail global kill switch requires guarded function'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION operating_layer.inspect_mail_draft_live_pilot(p_organization_id uuid, p_expected_recipient text, p_expected_credential_fingerprint text)
 RETURNS TABLE(organization_id uuid, organization_code text, organization_name text, pilot_claim_active boolean, pilot_claimed_for_target boolean, target_connector_enabled boolean, active_credential_present boolean, credential_envelope_valid boolean, credential_fingerprint_matches boolean, exact_compose_scope boolean, exact_single_recipient_allowlist boolean, expected_recipient_allowed boolean, other_enabled_organization_count bigint, all_other_organizations_disabled boolean, global_kill_cleared boolean, kill_switch_reachable boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'operating_layer', 'public'
AS $function$
BEGIN
  IF NOT current_user_can_administer_all_active_organizations() THEN
    RAISE EXCEPTION
      'live mail preflight requires admin.manage for every active organization'
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
    LEFT JOIN mail_draft_connector_bindings config_binding
      ON config_binding.organization_id = organization.id
    LEFT JOIN mail_draft_connector_config_versions config
      ON config.id = config_binding.active_config_version_id
     AND config.organization_id = config_binding.organization_id
    LEFT JOIN mail_draft_credential_bindings credential_binding
      ON credential_binding.organization_id = organization.id
    LEFT JOIN mail_draft_credential_versions credential
      ON credential.id = credential_binding.active_credential_version_id
     AND credential.organization_id = credential_binding.organization_id
    WHERE organization.id = p_organization_id
      AND organization.status = 'active'
  ),
  other_enabled AS (
    SELECT count(*)::bigint AS enabled_count
    FROM mail_draft_connector_bindings binding
    JOIN mail_draft_connector_config_versions config
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
        ARRAY['https://graph.microsoft.com/Mail.ReadWrite']::text[]
        AND target.granted_scopes =
          ARRAY['https://graph.microsoft.com/Mail.ReadWrite']::text[],
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
      'operating_layer.set_mail_draft_global_kill(boolean,text,text,text)',
      'EXECUTE'
    )
  FROM target
  CROSS JOIN mail_draft_live_pilot_control control
  CROSS JOIN mail_draft_global_kill_switch kill
  CROSS JOIN other_enabled
  WHERE control.singleton
    AND kill.singleton;
END;
$function$;

CREATE OR REPLACE FUNCTION operating_layer.invalidate_mail_draft_credential(p_organization_id uuid, p_reason text, p_trace_id text, p_request_id text)
 RETURNS TABLE(invalidated_credential_version_id uuid, revocation_outbox_event_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'operating_layer', 'public'
AS $function$
DECLARE
  v_old uuid;
  v_outbox uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('mail-draft-global-kill'));
  IF NOT current_request_user_has_permission(p_organization_id, 'connectors.admin') THEN
    RAISE EXCEPTION 'connector administration permission denied'
      USING ERRCODE = '42501';
  END IF;
  SELECT active_credential_version_id INTO v_old
  FROM mail_draft_credential_bindings
  WHERE organization_id = p_organization_id
  FOR UPDATE;
  IF v_old IS NOT NULL THEN
    PERFORM set_config(
      'app.mail_credential_binding_guard', 'mail_credential_binding:v1', true
    );
    UPDATE mail_draft_credential_bindings SET
      active_credential_version_id = NULL,
      binding_version = binding_version + 1,
      updated_by_user_id = current_request_user_id(),
      updated_at = now()
    WHERE organization_id = p_organization_id;
    PERFORM set_config('app.mail_credential_binding_guard', '', true);
    INSERT INTO mail_draft_credential_lifecycle_events (
      organization_id, credential_version_id, event_type, actor_type, actor_id,
      purpose, trace_id
    ) VALUES (
      p_organization_id, v_old, 'invalidated', 'user',
      current_request_user_id()::text, p_reason, p_trace_id
    );
    v_outbox := queue_mail_credential_revocation(
      p_organization_id, v_old, p_trace_id, p_request_id, p_reason
    );
  END IF;
  RETURN QUERY SELECT v_old, v_outbox;
END;
$function$;

CREATE OR REPLACE FUNCTION operating_layer.load_mail_draft_credential(p_credential_version_id uuid, p_organization_id uuid, p_purpose text, p_trace_id text)
 RETURNS TABLE(credential_version_id uuid, algorithm text, ciphertext text, nonce text, authentication_tag text, wrapped_data_key text, token_fingerprint text, granted_scopes text[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'operating_layer', 'public'
AS $function$
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
    SELECT 1 FROM mail_draft_credential_bindings binding
    JOIN mail_draft_global_kill_switch kill ON kill.singleton
    WHERE binding.organization_id = p_organization_id
      AND binding.active_credential_version_id = p_credential_version_id
      AND NOT kill.killed
  ) THEN
    RAISE EXCEPTION 'credential is not active' USING ERRCODE = '42501';
  END IF;
  IF v_is_revocation AND NOT EXISTS (
    SELECT 1 FROM mail_draft_credential_lifecycle_events event
    WHERE event.organization_id = p_organization_id
      AND event.credential_version_id = p_credential_version_id
      AND event.event_type = 'revocation_requested'
  ) THEN
    RAISE EXCEPTION 'credential is not pending revocation'
      USING ERRCODE = '42501';
  END IF;
  INSERT INTO mail_draft_credential_lifecycle_events (
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
  FROM mail_draft_credential_versions credential
  WHERE credential.id = p_credential_version_id
    AND credential.organization_id = p_organization_id;
END;
$function$;

CREATE OR REPLACE FUNCTION operating_layer.queue_mail_credential_revocation(p_organization_id uuid, p_credential_version_id uuid, p_trace_id text, p_request_id text, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'operating_layer', 'public'
AS $function$
DECLARE
  v_outbox_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO mail_draft_credential_lifecycle_events (
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
    v_outbox_id, p_organization_id, 'mail.credential.revoke',
    'mail_draft_credential', p_credential_version_id,
    'postgresql://operating_layer/mail_draft_credential_versions/'
      || p_credential_version_id::text,
    encode(digest(p_credential_version_id::text || ':' || p_reason, 'sha256'), 'hex'),
    p_credential_version_id::text || ':revoke', p_trace_id,
    current_request_user_id(), p_request_id, 3
  ) ON CONFLICT (organization_id, topic, idempotency_key) DO NOTHING;
  RETURN v_outbox_id;
END;
$function$;

CREATE OR REPLACE FUNCTION operating_layer.record_mail_credential_use(p_credential_version_id uuid, p_organization_id uuid, p_event_type text, p_purpose text, p_trace_id text, p_metadata jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'operating_layer', 'public'
AS $function$
BEGIN
  IF NOT pg_has_role(current_user, 'operating_layer_worker', 'member') THEN
    RAISE EXCEPTION 'credential use is restricted to the worker role'
      USING ERRCODE = '42501';
  END IF;
  IF p_event_type NOT IN ('used', 'revoked', 'revocation_failed') THEN
    RAISE EXCEPTION 'invalid credential use event' USING ERRCODE = '22023';
  END IF;
  INSERT INTO mail_draft_credential_lifecycle_events (
    organization_id, credential_version_id, event_type, actor_type, actor_id,
    purpose, trace_id, metadata
  ) VALUES (
    p_organization_id, p_credential_version_id, p_event_type, 'service',
    current_user::text, p_purpose, p_trace_id, p_metadata
  );
END;
$function$;

CREATE OR REPLACE FUNCTION operating_layer.release_mail_draft_live_pilot(p_organization_id uuid, p_reason text, p_trace_id text, p_request_id text)
 RETURNS TABLE(organization_id uuid, organization_code text, claim_version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'operating_layer', 'public'
AS $function$
DECLARE
  v_control mail_draft_live_pilot_control%ROWTYPE;
  v_claim_version integer;
  v_organization_code text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('mail-draft-global-kill'));
  IF NOT current_user_can_administer_all_active_organizations() THEN
    RAISE EXCEPTION
      'live mail pilot requires admin.manage for every active organization'
      USING ERRCODE = '42501';
  END IF;
  SELECT code INTO v_organization_code
  FROM organizations
  WHERE id = p_organization_id;
  IF v_organization_code IS NULL THEN
    RAISE EXCEPTION 'live mail pilot target organization does not exist'
      USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_control
  FROM mail_draft_live_pilot_control
  WHERE singleton
  FOR UPDATE;
  IF v_control.target_organization_id IS NULL THEN
    RETURN QUERY
    SELECT p_organization_id, v_organization_code, v_control.claim_version;
    RETURN;
  END IF;
  IF v_control.target_organization_id <> p_organization_id THEN
    RAISE EXCEPTION 'live mail pilot is owned by another organization'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM mail_draft_connector_bindings binding
    JOIN mail_draft_connector_config_versions config
      ON config.id = binding.active_config_version_id
     AND config.organization_id = binding.organization_id
    WHERE binding.organization_id = p_organization_id
      AND config.enabled
  ) OR EXISTS (
    SELECT 1
    FROM mail_draft_credential_bindings binding
    WHERE binding.organization_id = p_organization_id
      AND binding.active_credential_version_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'disable connector and invalidate credential before releasing pilot'
      USING ERRCODE = '55000';
  END IF;
  PERFORM set_config(
    'app.mail_draft_live_pilot_guard',
    'mail_draft_live_pilot:v1',
    true
  );
  UPDATE mail_draft_live_pilot_control AS control
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
  PERFORM set_config('app.mail_draft_live_pilot_guard', '', true);
  INSERT INTO mail_draft_live_pilot_events (
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
$function$;

CREATE OR REPLACE FUNCTION operating_layer.set_mail_draft_connector_config(p_config_version_id uuid, p_organization_id uuid, p_enabled boolean, p_allowed_recipient_addresses text[], p_allowed_recipient_domains text[], p_credential_secret_reference text, p_content_hash text, p_reason text)
 RETURNS TABLE(config_version_id uuid, version_number integer, binding_version integer, enabled boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'operating_layer', 'public'
AS $function$
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
      'enabled mail draft connector requires a secret reference and allowlist'
      USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(max(config.version_number), 0) + 1
  INTO v_version_number
  FROM mail_draft_connector_config_versions config
  WHERE config.organization_id = p_organization_id;
  INSERT INTO mail_draft_connector_config_versions (
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
    'app.mail_draft_config_guard',
    'set_mail_draft_connector_config:v1',
    true
  );
  INSERT INTO mail_draft_connector_bindings (
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
    binding_version = mail_draft_connector_bindings.binding_version + 1,
    updated_by_user_id = EXCLUDED.updated_by_user_id,
    updated_at = now()
  RETURNING mail_draft_connector_bindings.binding_version
  INTO v_binding_version;
  PERFORM set_config('app.mail_draft_config_guard', '', true);
  RETURN QUERY
  SELECT
    p_config_version_id,
    v_version_number,
    v_binding_version,
    p_enabled;
END;
$function$;

CREATE OR REPLACE FUNCTION operating_layer.set_mail_draft_global_kill(p_killed boolean, p_trace_id text, p_request_id text, p_reason text)
 RETURNS TABLE(organization_id uuid, invalidated_credential_version_id uuid, revocation_outbox_event_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'operating_layer', 'public'
AS $function$
DECLARE
  v_org record;
  v_outbox uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('mail-draft-global-kill'));
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
  PERFORM set_config('app.mail_global_kill_guard', 'mail_global_kill:v1', true);
  UPDATE mail_draft_global_kill_switch SET
    killed = p_killed,
    switch_version = switch_version + 1,
    updated_by_user_id = current_request_user_id(),
    updated_at = now()
  WHERE singleton;
  PERFORM set_config('app.mail_global_kill_guard', '', true);
  IF p_killed THEN
    FOR v_org IN
      SELECT binding.organization_id, binding.active_credential_version_id
      FROM mail_draft_credential_bindings binding
      WHERE binding.active_credential_version_id IS NOT NULL
      FOR UPDATE
    LOOP
      PERFORM set_config(
        'app.mail_credential_binding_guard', 'mail_credential_binding:v1', true
      );
      UPDATE mail_draft_credential_bindings SET
        active_credential_version_id = NULL,
        binding_version = binding_version + 1,
        updated_by_user_id = current_request_user_id(),
        updated_at = now()
      WHERE mail_draft_credential_bindings.organization_id =
        v_org.organization_id;
      PERFORM set_config('app.mail_credential_binding_guard', '', true);
      INSERT INTO mail_draft_credential_lifecycle_events (
        organization_id, credential_version_id, event_type, actor_type,
        actor_id, purpose, trace_id
      ) VALUES (
        v_org.organization_id, v_org.active_credential_version_id,
        'invalidated', 'user', current_request_user_id()::text,
        p_reason, p_trace_id
      );
      v_outbox := queue_mail_credential_revocation(
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
$function$;

CREATE OR REPLACE FUNCTION operating_layer.store_mail_draft_credential(p_credential_version_id uuid, p_organization_id uuid, p_algorithm text, p_ciphertext text, p_nonce text, p_authentication_tag text, p_wrapped_data_key text, p_token_fingerprint text, p_granted_scopes text[], p_reason text, p_trace_id text, p_request_id text)
 RETURNS TABLE(credential_version_id uuid, version_number integer, replaced_credential_version_id uuid, revocation_outbox_event_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'operating_layer', 'public'
AS $function$
DECLARE
  v_version integer;
  v_old uuid;
  v_outbox uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('mail-draft-global-kill'));
  IF NOT current_request_user_has_permission(p_organization_id, 'connectors.admin') THEN
    RAISE EXCEPTION 'connector administration permission denied'
      USING ERRCODE = '42501';
  END IF;
  IF p_granted_scopes IS DISTINCT FROM
       ARRAY['https://graph.microsoft.com/Mail.ReadWrite']::text[] THEN
    RAISE EXCEPTION 'mail credential scopes exceed the exact allowlist'
      USING ERRCODE = '23514';
  END IF;
  SELECT active_credential_version_id INTO v_old
  FROM mail_draft_credential_bindings
  WHERE organization_id = p_organization_id
  FOR UPDATE;
  SELECT COALESCE(max(credential.version_number), 0) + 1 INTO v_version
  FROM mail_draft_credential_versions credential
  WHERE credential.organization_id = p_organization_id;
  INSERT INTO mail_draft_credential_versions (
    id, organization_id, version_number, algorithm, ciphertext, nonce,
    authentication_tag, wrapped_data_key, token_fingerprint, granted_scopes,
    created_by_user_id, reason
  ) VALUES (
    p_credential_version_id, p_organization_id, v_version, p_algorithm,
    p_ciphertext, p_nonce, p_authentication_tag, p_wrapped_data_key,
    p_token_fingerprint, p_granted_scopes, current_request_user_id(), p_reason
  );
  INSERT INTO mail_draft_credential_lifecycle_events (
    organization_id, credential_version_id, event_type, actor_type, actor_id,
    purpose, trace_id
  ) VALUES
    (p_organization_id, p_credential_version_id, 'stored', 'user',
     current_request_user_id()::text, p_reason, p_trace_id),
    (p_organization_id, p_credential_version_id, 'activated', 'user',
     current_request_user_id()::text, p_reason, p_trace_id);
  PERFORM set_config(
    'app.mail_credential_binding_guard', 'mail_credential_binding:v1', true
  );
  INSERT INTO mail_draft_credential_bindings (
    organization_id, active_credential_version_id, binding_version,
    updated_by_user_id
  ) VALUES (
    p_organization_id, p_credential_version_id, 1, current_request_user_id()
  ) ON CONFLICT (organization_id) DO UPDATE SET
    active_credential_version_id = EXCLUDED.active_credential_version_id,
    binding_version = mail_draft_credential_bindings.binding_version + 1,
    updated_by_user_id = EXCLUDED.updated_by_user_id,
    updated_at = now();
  PERFORM set_config('app.mail_credential_binding_guard', '', true);
  IF v_old IS NOT NULL AND v_old <> p_credential_version_id THEN
    INSERT INTO mail_draft_credential_lifecycle_events (
      organization_id, credential_version_id, event_type, actor_type, actor_id,
      purpose, trace_id
    ) VALUES (
      p_organization_id, v_old, 'invalidated', 'user',
      current_request_user_id()::text, 'credential_rotation', p_trace_id
    );
    v_outbox := queue_mail_credential_revocation(
      p_organization_id, v_old, p_trace_id, p_request_id, 'credential_rotation'
    );
  END IF;
  RETURN QUERY SELECT p_credential_version_id, v_version, v_old, v_outbox;
END;
$function$;

CREATE OR REPLACE FUNCTION operating_layer.transition_workflow(p_workflow_id uuid, p_organization_id uuid, p_command_id text, p_expected_version integer, p_to_state text, p_actor_type text, p_actor_id text, p_input_hash text, p_output_hash text, p_trace_id text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(workflow_id uuid, current_state text, workflow_version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'operating_layer', 'public'
AS $function$
DECLARE
  current_workflow workflows%ROWTYPE;
  v_execution_command_id uuid;
  v_execution_result_id uuid;
  v_abandonment_id uuid;
  v_mail_preview_id uuid;
  v_mail_authorization_id uuid;
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
      v_mail_preview_id := NULLIF(p_metadata ->> 'previewId', '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_mail_preview_id := NULL;
    END;
    IF v_mail_preview_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM mail_draft_previews preview
      WHERE preview.id = v_mail_preview_id
        AND preview.workflow_id = current_workflow.id
        AND preview.organization_id = current_workflow.organization_id
    ) THEN
      RAISE EXCEPTION
        'external authorization wait requires an immutable mail draft preview'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  IF p_to_state = 'external_authorized' THEN
    BEGIN
      v_mail_authorization_id :=
        NULLIF(p_metadata ->> 'authorizationId', '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_mail_authorization_id := NULL;
    END;
    IF v_mail_authorization_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM mail_draft_authorizations draft_authorization
      WHERE draft_authorization.id = v_mail_authorization_id
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
            AND command.provider_name = 'mail_draft'
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
        NULLIF(p_metadata ->> 'mailDraftAbandonmentId', '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_abandonment_id := NULL;
    END;
    IF v_abandonment_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM mail_draft_execution_abandonments abandonment
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
$function$;

CREATE OR REPLACE FUNCTION operating_layer.validate_mail_draft_authorization()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_preview mail_draft_previews%ROWTYPE;
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
  FROM mail_draft_previews
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
  FROM mail_draft_connector_bindings binding
  JOIN mail_draft_connector_config_versions config
    ON config.id = binding.active_config_version_id
   AND config.organization_id = binding.organization_id
  WHERE binding.organization_id = NEW.organization_id;
  IF v_active_config_id IS DISTINCT FROM
       NEW.connector_config_version_id
     OR NOT COALESCE(v_enabled, false) THEN
    RAISE EXCEPTION 'mail draft connector preview is stale or disabled'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION operating_layer.validate_mail_draft_preview()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_approval approvals%ROWTYPE;
  v_workflow workflows%ROWTYPE;
  v_config mail_draft_connector_config_versions%ROWTYPE;
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
      'mail draft preview requires the approved draft recommendation'
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
  FROM mail_draft_connector_bindings binding
  WHERE binding.organization_id = NEW.organization_id;
  IF v_active_config_id IS NULL
     OR v_active_config_id <> NEW.connector_config_version_id THEN
    RAISE EXCEPTION 'mail draft connector configuration is not active'
      USING ERRCODE = '23514';
  END IF;
  SELECT *
  INTO v_config
  FROM mail_draft_connector_config_versions
  WHERE id = v_active_config_id
    AND organization_id = NEW.organization_id;
  v_recipient_domain := split_part(NEW.recipient, '@', 2);
  IF NOT v_config.enabled
     OR NOT (
       NEW.recipient = ANY(v_config.allowed_recipient_addresses)
       OR v_recipient_domain = ANY(v_config.allowed_recipient_domains)
     ) THEN
    RAISE EXCEPTION
      'mail draft connector is disabled or recipient is not allowlisted'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION operating_layer.verify_mail_draft_fact_audited()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_event_type text;
  v_id_key text;
BEGIN
  v_event_type := CASE TG_TABLE_NAME
    WHEN 'mail_draft_connector_config_versions'
      THEN 'mail_draft.connector_configured'
    WHEN 'mail_draft_previews' THEN 'mail_draft.previewed'
    WHEN 'mail_draft_authorizations' THEN 'mail_draft.authorized'
    WHEN 'mail_draft_execution_abandonments'
      THEN 'mail_draft.materialization_abandoned'
  END;
  v_id_key := CASE TG_TABLE_NAME
    WHEN 'mail_draft_connector_config_versions' THEN 'configVersionId'
    WHEN 'mail_draft_previews' THEN 'previewId'
    WHEN 'mail_draft_authorizations' THEN 'authorizationId'
    WHEN 'mail_draft_execution_abandonments' THEN 'abandonmentId'
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
$function$;

-- 7. Recreate triggers against the renamed functions.
CREATE CONSTRAINT TRIGGER mail_draft_authorization_requires_audit AFTER INSERT ON operating_layer.mail_draft_authorizations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION operating_layer.verify_mail_draft_fact_audited();
CREATE TRIGGER mail_draft_authorization_requires_gates BEFORE INSERT ON operating_layer.mail_draft_authorizations FOR EACH ROW EXECUTE FUNCTION operating_layer.validate_mail_draft_authorization();
CREATE TRIGGER mail_draft_authorizations_are_immutable BEFORE DELETE OR UPDATE ON operating_layer.mail_draft_authorizations FOR EACH ROW EXECUTE FUNCTION operating_layer.reject_immutable_mutation();
CREATE TRIGGER mail_draft_binding_requires_function BEFORE INSERT OR DELETE OR UPDATE ON operating_layer.mail_draft_connector_bindings FOR EACH ROW EXECUTE FUNCTION operating_layer.guard_mail_draft_binding_update();
CREATE TRIGGER mail_draft_live_pilot_limits_enabled_organization BEFORE INSERT OR UPDATE ON operating_layer.mail_draft_connector_bindings FOR EACH ROW EXECUTE FUNCTION operating_layer.guard_mail_draft_live_pilot_binding();
CREATE CONSTRAINT TRIGGER mail_draft_config_requires_audit AFTER INSERT ON operating_layer.mail_draft_connector_config_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION operating_layer.verify_mail_draft_fact_audited();
CREATE TRIGGER mail_draft_config_versions_are_immutable BEFORE DELETE OR UPDATE ON operating_layer.mail_draft_connector_config_versions FOR EACH ROW EXECUTE FUNCTION operating_layer.reject_immutable_mutation();
CREATE TRIGGER mail_credential_binding_requires_function BEFORE INSERT OR DELETE OR UPDATE ON operating_layer.mail_draft_credential_bindings FOR EACH ROW EXECUTE FUNCTION operating_layer.guard_mail_credential_binding();
CREATE TRIGGER mail_credential_lifecycle_is_immutable BEFORE DELETE OR UPDATE ON operating_layer.mail_draft_credential_lifecycle_events FOR EACH ROW EXECUTE FUNCTION operating_layer.reject_immutable_mutation();
CREATE TRIGGER mail_credential_versions_are_immutable BEFORE DELETE OR UPDATE ON operating_layer.mail_draft_credential_versions FOR EACH ROW EXECUTE FUNCTION operating_layer.reject_immutable_mutation();
CREATE CONSTRAINT TRIGGER mail_draft_abandonment_requires_audit AFTER INSERT ON operating_layer.mail_draft_execution_abandonments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION operating_layer.verify_mail_draft_fact_audited();
CREATE TRIGGER mail_draft_abandonments_are_immutable BEFORE DELETE OR UPDATE ON operating_layer.mail_draft_execution_abandonments FOR EACH ROW EXECUTE FUNCTION operating_layer.reject_immutable_mutation();
CREATE TRIGGER mail_global_kill_requires_function BEFORE DELETE OR UPDATE ON operating_layer.mail_draft_global_kill_switch FOR EACH ROW EXECUTE FUNCTION operating_layer.guard_mail_global_kill_switch();
CREATE TRIGGER mail_draft_live_pilot_control_requires_function BEFORE DELETE OR UPDATE ON operating_layer.mail_draft_live_pilot_control FOR EACH ROW EXECUTE FUNCTION operating_layer.guard_mail_draft_live_pilot_control();
CREATE TRIGGER mail_draft_live_pilot_events_are_immutable BEFORE DELETE OR UPDATE ON operating_layer.mail_draft_live_pilot_events FOR EACH ROW EXECUTE FUNCTION operating_layer.reject_immutable_mutation();
CREATE CONSTRAINT TRIGGER mail_draft_preview_requires_audit AFTER INSERT ON operating_layer.mail_draft_previews DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION operating_layer.verify_mail_draft_fact_audited();
CREATE TRIGGER mail_draft_preview_requires_gates BEFORE INSERT ON operating_layer.mail_draft_previews FOR EACH ROW EXECUTE FUNCTION operating_layer.validate_mail_draft_preview();
CREATE TRIGGER mail_draft_previews_are_immutable BEFORE DELETE OR UPDATE ON operating_layer.mail_draft_previews FOR EACH ROW EXECUTE FUNCTION operating_layer.reject_immutable_mutation();

-- 8. Re-pin the OAuth scope to Microsoft Graph.
--
-- Renaming a constraint does not change its definition, so these two must be
-- dropped and re-added. Equality (not "contains") is deliberate and is the
-- whole safety property: it pins the grant to exactly one scope, which makes it
-- impossible to add Mail.Send without a migration and a review.
ALTER TABLE mail_draft_connector_config_versions
  DROP CONSTRAINT mail_draft_connector_config_versions_oauth_scopes_check;
ALTER TABLE mail_draft_connector_config_versions
  ADD CONSTRAINT mail_draft_connector_config_versions_oauth_scopes_check
  CHECK (oauth_scopes = ARRAY['https://graph.microsoft.com/Mail.ReadWrite'::text]);

ALTER TABLE mail_draft_credential_versions
  DROP CONSTRAINT mail_draft_credential_versions_granted_scopes_check;
ALTER TABLE mail_draft_credential_versions
  ADD CONSTRAINT mail_draft_credential_versions_granted_scopes_check
  CHECK (granted_scopes = ARRAY['https://graph.microsoft.com/Mail.ReadWrite'::text]);

-- 9. The execution provider name is a data value the application matches on,
--    so it has to move in lockstep with the code.
UPDATE execution_commands SET provider_name = 'mail_draft'
  WHERE provider_name = 'gmail_draft';
UPDATE execution_commands SET action_type = 'mail_draft_create'
  WHERE action_type = 'gmail_draft_create';

ALTER TABLE execution_commands
  DROP CONSTRAINT execution_commands_provider_name_check;
ALTER TABLE execution_commands
  ADD CONSTRAINT execution_commands_provider_name_check
  CHECK (provider_name = ANY (ARRAY['deterministic_internal'::text, 'mail_draft'::text]));

ALTER TABLE execution_commands DROP CONSTRAINT execution_commands_check;
ALTER TABLE execution_commands
  ADD CONSTRAINT execution_commands_check CHECK (
    (provider_name = 'deterministic_internal' AND external_authorization_id IS NULL)
    OR (provider_name = 'mail_draft' AND external_authorization_id IS NOT NULL)
  );

-- 10. Which mailbox a draft is created in.
--
-- Gmail addressed "users/me" — the mailbox was implied by the token. Graph
-- requires an explicit mailbox, which suits this group better: each entity has
-- its own AR mailbox, so the address belongs in that entity's connector config
-- rather than being implicit in a credential.
ALTER TABLE mail_draft_connector_config_versions
  ADD COLUMN mailbox_address text
  CHECK (
    mailbox_address IS NULL
    OR (
      mailbox_address = lower(mailbox_address)
      AND mailbox_address ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      AND mailbox_address !~ E'[\r\n]'
    )
  );

-- Enabling the connector without naming a mailbox would leave the destination
-- undefined at execution time; require it at the point of enablement.
ALTER TABLE mail_draft_connector_config_versions
  ADD CONSTRAINT mail_draft_config_enabled_requires_mailbox
  CHECK (enabled = false OR mailbox_address IS NOT NULL);

COMMIT;
