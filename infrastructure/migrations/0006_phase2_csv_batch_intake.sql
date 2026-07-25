BEGIN;

SET search_path TO operating_layer, public;

-- CSV is an internal upload source, not a connector. The raw file, parsed
-- rows, and row outcomes are immutable facts. Mutable delivery state remains
-- exclusively in outbox_events.
CREATE TABLE csv_batches (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  source_system_id uuid NOT NULL,
  source_record_id uuid NOT NULL,
  source_record_version_id uuid NOT NULL,
  original_filename text NOT NULL
    CHECK (
      length(btrim(original_filename)) BETWEEN 1 AND 200
      AND lower(original_filename) LIKE '%.csv'
    ),
  media_type text NOT NULL DEFAULT 'text/csv'
    CHECK (media_type = 'text/csv'),
  raw_content bytea NOT NULL CHECK (octet_length(raw_content) > 0),
  content_hash text NOT NULL CHECK (length(content_hash) = 64),
  checksum_algorithm text NOT NULL DEFAULT 'sha256'
    CHECK (checksum_algorithm = 'sha256'),
  source_timestamp timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL,
  source_identity jsonb NOT NULL
    CHECK (jsonb_typeof(source_identity) = 'object'),
  schema_version text NOT NULL CHECK (schema_version = 'csv-issue.v1'),
  retention_classification text NOT NULL
    CHECK (
      retention_classification IN (
        'transient',
        'operational',
        'financial_support',
        'legal_hold'
      )
    ),
  imported_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  trace_id text NOT NULL,
  request_id text NOT NULL,
  total_rows integer NOT NULL CHECK (total_rows >= 0),
  valid_rows integer NOT NULL CHECK (valid_rows >= 0),
  rejected_rows integer NOT NULL CHECK (rejected_rows >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (source_record_id, organization_id),
  UNIQUE (source_record_version_id, organization_id),
  FOREIGN KEY (source_system_id, organization_id)
    REFERENCES source_systems(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_record_id, organization_id)
    REFERENCES source_records(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_record_version_id, organization_id)
    REFERENCES source_record_versions(id, organization_id) ON DELETE RESTRICT,
  CHECK (total_rows = valid_rows + rejected_rows)
);

CREATE TABLE csv_batch_rows (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  batch_id uuid NOT NULL,
  row_number integer NOT NULL CHECK (row_number >= 2),
  row_idempotency_key text NOT NULL,
  raw_values jsonb NOT NULL CHECK (jsonb_typeof(raw_values) = 'object'),
  normalized_input jsonb,
  input_hash text NOT NULL CHECK (length(input_hash) = 64),
  validation_status text NOT NULL
    CHECK (validation_status IN ('valid', 'rejected')),
  rejection_reasons jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(rejection_reasons) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  UNIQUE (batch_id, row_number),
  UNIQUE (organization_id, row_idempotency_key),
  FOREIGN KEY (batch_id, organization_id)
    REFERENCES csv_batches(id, organization_id) ON DELETE RESTRICT,
  CHECK (
    (
      validation_status = 'valid'
      AND normalized_input IS NOT NULL
      AND jsonb_typeof(normalized_input) = 'object'
      AND jsonb_array_length(rejection_reasons) = 0
    )
    OR
    (
      validation_status = 'rejected'
      AND normalized_input IS NULL
      AND jsonb_array_length(rejection_reasons) > 0
    )
  )
);

CREATE TABLE csv_batch_row_results (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  batch_id uuid NOT NULL,
  row_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('accepted', 'failed')),
  task_id uuid,
  workflow_id uuid,
  error_code text,
  safe_error_message text,
  attempts integer NOT NULL CHECK (attempts > 0),
  trace_id text NOT NULL,
  completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  UNIQUE (row_id, status),
  FOREIGN KEY (batch_id, organization_id)
    REFERENCES csv_batches(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (row_id, organization_id)
    REFERENCES csv_batch_rows(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (task_id, organization_id)
    REFERENCES tasks(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (workflow_id, organization_id)
    REFERENCES workflows(id, organization_id) ON DELETE RESTRICT,
  CHECK (
    (
      status = 'accepted'
      AND task_id IS NOT NULL
      AND workflow_id IS NOT NULL
      AND error_code IS NULL
      AND safe_error_message IS NULL
    )
    OR
    (
      status = 'failed'
      AND error_code IS NOT NULL
      AND safe_error_message IS NOT NULL
    )
  )
);

CREATE INDEX csv_batches_org_created_idx
  ON csv_batches (organization_id, created_at DESC);

CREATE INDEX csv_batch_rows_batch_row_idx
  ON csv_batch_rows (batch_id, row_number);

CREATE INDEX csv_batch_row_results_batch_status_idx
  ON csv_batch_row_results (batch_id, status);

CREATE TRIGGER csv_batches_are_immutable
  BEFORE UPDATE OR DELETE ON csv_batches
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE TRIGGER csv_batch_rows_are_immutable
  BEFORE UPDATE OR DELETE ON csv_batch_rows
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE TRIGGER csv_batch_row_results_are_immutable
  BEFORE UPDATE OR DELETE ON csv_batch_row_results
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE OR REPLACE FUNCTION verify_csv_batch_audited()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM audit_events event
    WHERE event.organization_id = NEW.organization_id
      AND event.event_type = 'csv.batch.imported'
      AND event.metadata ->> 'batchId' = NEW.id::text
      AND NEW.source_record_id = ANY(event.source_record_ids)
  ) THEN
    RAISE EXCEPTION 'CSV batch % has no import audit event', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER csv_batch_requires_audit
  AFTER INSERT ON csv_batches
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION verify_csv_batch_audited();

CREATE OR REPLACE FUNCTION verify_csv_row_result_audited()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM audit_events event
    WHERE event.organization_id = NEW.organization_id
      AND event.event_type = 'csv.row.' || NEW.status
      AND event.metadata ->> 'batchId' = NEW.batch_id::text
      AND event.metadata ->> 'rowId' = NEW.row_id::text
  ) THEN
    RAISE EXCEPTION 'CSV row result % has no matching audit event', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER csv_row_result_requires_audit
  AFTER INSERT ON csv_batch_row_results
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION verify_csv_row_result_audited();

ALTER TABLE csv_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE csv_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON csv_batches
  FOR ALL
  USING (current_user_can_access_organization(organization_id))
  WITH CHECK (current_user_can_access_organization(organization_id));

ALTER TABLE csv_batch_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE csv_batch_rows FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON csv_batch_rows
  FOR ALL
  USING (current_user_can_access_organization(organization_id))
  WITH CHECK (current_user_can_access_organization(organization_id));

ALTER TABLE csv_batch_row_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE csv_batch_row_results FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON csv_batch_row_results
  FOR ALL
  USING (current_user_can_access_organization(organization_id))
  WITH CHECK (current_user_can_access_organization(organization_id));

GRANT SELECT, INSERT
  ON csv_batches, csv_batch_rows, csv_batch_row_results
  TO operating_layer_app;
REVOKE UPDATE, DELETE
  ON csv_batches, csv_batch_rows, csv_batch_row_results
  FROM operating_layer_app;

COMMIT;
