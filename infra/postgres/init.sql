-- Company Brain v3 Postgres bootstrap.
-- This script runs ONCE when the company-brain-postgres container is first
-- created (Postgres /docker-entrypoint-initdb.d/ convention). On subsequent
-- starts the data directory already exists and this is ignored.
--
-- ISOLATION CONTRACT
--   - Database: company_brain (not `postgres`, not `app`, not `data`)
--   - Admin role: company_brain_admin (owner; runs migrations + this script)
--   - Ingest role: company_brain_ingest (write — used by connectors)
--   - Reader role: company_brain_reader (SELECT only — used by /query endpoint)
--
-- These three roles are scoped to the company_brain database. They do not
-- exist in any other DB on this Postgres instance, and they cannot reach
-- jerry-* or hermes-* databases if those are ever co-hosted here.
--
-- Passwords come from the container's env vars (INGEST_PASSWORD,
-- READER_PASSWORD) which the docker-compose.yml passes through from
-- /opt/company-brain/infra/.env.

\set INGEST_PASSWORD `echo "$INGEST_PASSWORD"`
\set READER_PASSWORD `echo "$READER_PASSWORD"`

-- Note: company_brain database and company_brain_admin role are created
-- by the postgres:16-alpine image's entrypoint from POSTGRES_DB +
-- POSTGRES_USER + POSTGRES_PASSWORD env vars. This script runs AGAINST
-- that database as company_brain_admin.

-- =========================================================================
-- Role 1: company_brain_ingest (WRITE for connectors)
-- =========================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'company_brain_ingest') THEN
    CREATE ROLE company_brain_ingest LOGIN PASSWORD :'INGEST_PASSWORD';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE company_brain TO company_brain_ingest;
GRANT USAGE, CREATE ON SCHEMA public TO company_brain_ingest;
-- INSERT/UPDATE/DELETE/SELECT on every current and future table in public.
-- This is the role the gbrain ingestion path uses.
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO company_brain_ingest;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO company_brain_ingest;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO company_brain_ingest;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL PRIVILEGES ON TABLES TO company_brain_ingest;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL PRIVILEGES ON SEQUENCES TO company_brain_ingest;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO company_brain_ingest;

-- =========================================================================
-- Role 2: company_brain_reader (READ-ONLY for the /query endpoint)
-- =========================================================================
-- THIS IS THE SECURITY-CRITICAL ROLE. The SQL query service connects as
-- this user. It must NEVER be granted INSERT/UPDATE/DELETE on any table,
-- including future tables created later by ingest.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'company_brain_reader') THEN
    CREATE ROLE company_brain_reader LOGIN PASSWORD :'READER_PASSWORD';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE company_brain TO company_brain_reader;
GRANT USAGE ON SCHEMA public TO company_brain_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO company_brain_reader;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO company_brain_reader;
-- Forward-compatible: any table the ingest role creates later is also
-- auto-granted SELECT to the reader. This is what makes the read user
-- robust against gbrain schema migrations.
ALTER DEFAULT PRIVILEGES FOR ROLE company_brain_ingest IN SCHEMA public
  GRANT SELECT ON TABLES TO company_brain_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE company_brain_ingest IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO company_brain_reader;

-- Belt + suspenders: explicitly REVOKE write privileges. If anything in
-- public has been granted to PUBLIC (which the reader inherits), strip it.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public FROM company_brain_reader;
REVOKE CREATE ON SCHEMA public FROM company_brain_reader;

-- =========================================================================
-- Verification (visible in `docker logs company-brain-postgres`)
-- =========================================================================
DO $$
DECLARE
  ingest_can_write boolean;
  reader_can_write boolean;
BEGIN
  -- These don't actually run as the role; they verify the grants exist.
  SELECT has_database_privilege('company_brain_ingest', 'company_brain', 'CONNECT')
    INTO ingest_can_write;
  SELECT has_database_privilege('company_brain_reader', 'company_brain', 'CONNECT')
    INTO reader_can_write;

  RAISE NOTICE 'company_brain_ingest CONNECT: %', ingest_can_write;
  RAISE NOTICE 'company_brain_reader CONNECT: %', reader_can_write;
  RAISE NOTICE 'company_brain bootstrap complete; v3 SQL endpoint will use company_brain_reader';
END
$$;
