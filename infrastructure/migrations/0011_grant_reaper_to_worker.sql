-- 0011: grant the idempotency reaper to the worker runtime role.
--
-- The idempotency reaper loop runs in the worker process
-- (apps/worker/src/main.ts), which connects as operating_layer_worker_runtime.
-- Migration 0004 granted EXECUTE on reap_expired_idempotency_keys only to
-- operating_layer_runtime (the API's role), so the worker's reaper fails every
-- tick with "permission denied for function reap_expired_idempotency_keys".
-- The test suite never exercised the worker's timer loop against the
-- role-enforced database, so the gap only surfaced on a real production boot.
--
-- Grant EXECUTE to the worker role so the reaper can prune expired idempotency
-- keys. This is the only worker-called function missing its grant; the other
-- seven are reachable through the worker's group-role membership.
BEGIN;
SET search_path TO operating_layer, public;

GRANT EXECUTE ON FUNCTION reap_expired_idempotency_keys(integer, text)
  TO operating_layer_worker_runtime;

COMMIT;
