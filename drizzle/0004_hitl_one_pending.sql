-- HITL hardening: at most ONE pending request per project for each of the three
-- request tables (atomic "one open modal" invariant). Dedupe any existing extra
-- pending rows (keep the newest per project) BEFORE creating the partial unique
-- index, or the CREATE would fail.

-- oauth_provider_requests — the index covers the ACTIVE set (pending + the
-- in-flight 'completing' claim) so a new request can't coexist with an in-flight
-- apply. Dedupe over the FULL active set (handles any stuck 'completing'), and
-- DROP+recreate the index so a re-run upgrades an earlier pending-only predicate.
UPDATE oauth_provider_requests SET status = 'dismissed', updated_at = now()
WHERE status IN ('pending', 'completing') AND id NOT IN (
  SELECT DISTINCT ON (project_id) id FROM oauth_provider_requests
  WHERE status IN ('pending', 'completing') ORDER BY project_id, created_at DESC
);
DROP INDEX IF EXISTS oauth_provider_requests_one_pending;
CREATE UNIQUE INDEX oauth_provider_requests_one_pending
  ON oauth_provider_requests (project_id) WHERE status IN ('pending', 'completing');

-- env_var_requests
UPDATE env_var_requests SET status = 'dismissed', updated_at = now()
WHERE status IN ('pending', 'completing') AND id NOT IN (
  SELECT DISTINCT ON (project_id) id FROM env_var_requests
  WHERE status IN ('pending', 'completing') ORDER BY project_id, created_at DESC
);
DROP INDEX IF EXISTS env_var_requests_one_pending;
CREATE UNIQUE INDEX env_var_requests_one_pending
  ON env_var_requests (project_id) WHERE status IN ('pending', 'completing');

-- stripe_connect_requests
UPDATE stripe_connect_requests SET status = 'dismissed', updated_at = now()
WHERE status = 'pending' AND id NOT IN (
  SELECT DISTINCT ON (project_id) id FROM stripe_connect_requests
  WHERE status = 'pending' ORDER BY project_id, created_at DESC
);
CREATE UNIQUE INDEX IF NOT EXISTS stripe_connect_requests_one_pending
  ON stripe_connect_requests (project_id) WHERE status = 'pending';
