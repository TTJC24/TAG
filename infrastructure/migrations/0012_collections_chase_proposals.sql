-- Collections chase proposals: the deterministic draft text for a past-due
-- customer, composed at intake time so the approver reviews instead of retypes.
--
-- This table deliberately changes NOTHING about the governed path. A proposal
-- is inert text: it does not authorize, enqueue, or send anything, and the
-- Outlook draft still requires the same two human steps (preview, then
-- authorize) against mail_draft_previews. Its only job is to remove the
-- retyping that made the collections doorway impractical to work daily.
--
-- Append-only for the app role (INSERT + SELECT, no UPDATE/DELETE), matching
-- how previews and authorizations are treated: what was proposed for a given
-- aging run stays auditable.

BEGIN;

SET search_path TO operating_layer, public;

CREATE TABLE collections_chase_proposals (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  task_id uuid NOT NULL,
  -- Acumatica customer id the chase is about (e.g. "ACME01").
  customer_id text NOT NULL CHECK (length(btrim(customer_id)) BETWEEN 1 AND 200),
  customer_name text NOT NULL
    CHECK (length(btrim(customer_name)) BETWEEN 1 AND 500),
  -- Null when Acumatica has no AR contact email on file. Deliberately nullable:
  -- an unaddressable chase must surface as a visible gap for a human, never as
  -- a guessed recipient. Same shape constraints as mail_draft_previews so a
  -- proposal can never prefill a recipient the preview would reject.
  recipient text CHECK (
    recipient IS NULL
    OR (
      recipient = lower(recipient)
      AND recipient ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      AND recipient !~ E'[\r\n]'
    )
  ),
  blocked_reason text CHECK (
    blocked_reason IS NULL OR length(btrim(blocked_reason)) BETWEEN 1 AND 500
  ),
  subject text NOT NULL CHECK (
    length(btrim(subject)) BETWEEN 1 AND 998
    AND subject !~ E'[\r\n]'
  ),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 100000),
  -- Which rung of the collections ladder produced this text (1..4).
  ladder_step integer NOT NULL CHECK (ladder_step BETWEEN 1 AND 4),
  past_due numeric(14, 2) NOT NULL CHECK (past_due > 0),
  -- The aging run this came from, so re-running a day's aging replays rather
  -- than duplicating, and next day's run proposes fresh text.
  aged_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  -- One live proposal per task; intake is already idempotent per customer+date.
  UNIQUE (organization_id, task_id),
  FOREIGN KEY (task_id, organization_id)
    REFERENCES tasks(id, organization_id) ON DELETE RESTRICT,
  -- An addressable proposal must not carry a blocked reason, and an
  -- unaddressable one must explain itself.
  CONSTRAINT chase_proposal_addressability_is_explained CHECK (
    (recipient IS NOT NULL AND blocked_reason IS NULL)
    OR (recipient IS NULL AND blocked_reason IS NOT NULL)
  )
);

CREATE INDEX collections_chase_proposals_task_idx
  ON collections_chase_proposals (organization_id, task_id);

ALTER TABLE collections_chase_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE collections_chase_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON collections_chase_proposals
  FOR ALL
  USING (current_user_can_access_organization(organization_id))
  WITH CHECK (current_user_can_access_organization(organization_id));

GRANT SELECT, INSERT ON collections_chase_proposals TO operating_layer_app;
REVOKE UPDATE, DELETE ON collections_chase_proposals FROM operating_layer_app;

COMMIT;
