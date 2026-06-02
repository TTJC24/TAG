-- Company Brain v3 Postgres bootstrap.
-- Runs once when /var/lib/postgresql/data is empty.
-- Admin role/database are created by the Postgres entrypoint from
-- POSTGRES_USER/POSTGRES_DB/POSTGRES_PASSWORD.

\set INGEST_PASSWORD `echo "$INGEST_PASSWORD"`
\set READER_PASSWORD `echo "$READER_PASSWORD"`

-- Extensions must be created by the admin/superuser bootstrap path, not by
-- the ingest role. gbrain/search and ingest paths rely on these being present.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create application roles. psql variables are expanded before \gexec, avoiding
-- invalid :'VAR' syntax inside PL/pgSQL DO blocks.
SELECT format('CREATE ROLE company_brain_ingest LOGIN PASSWORD %L', :'INGEST_PASSWORD')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'company_brain_ingest')
\gexec

SELECT format('CREATE ROLE company_brain_reader LOGIN PASSWORD %L', :'READER_PASSWORD')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'company_brain_reader')
\gexec

-- Baseline database/schema access.
GRANT CONNECT ON DATABASE company_brain TO company_brain_ingest;
GRANT CONNECT ON DATABASE company_brain TO company_brain_reader;
GRANT USAGE, CREATE ON SCHEMA public TO company_brain_ingest;
GRANT USAGE ON SCHEMA public TO company_brain_reader;
REVOKE CREATE ON SCHEMA public FROM company_brain_reader;

-- Current-object privileges. These are intentionally repeated after query_log
-- creation below so objects created by this script are also covered.
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO company_brain_ingest;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO company_brain_ingest;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO company_brain_ingest;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO company_brain_reader;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO company_brain_reader;

-- Future objects created by admin migrations.
ALTER DEFAULT PRIVILEGES FOR ROLE company_brain_admin IN SCHEMA public
  GRANT ALL PRIVILEGES ON TABLES TO company_brain_ingest;
ALTER DEFAULT PRIVILEGES FOR ROLE company_brain_admin IN SCHEMA public
  GRANT ALL PRIVILEGES ON SEQUENCES TO company_brain_ingest;
ALTER DEFAULT PRIVILEGES FOR ROLE company_brain_admin IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO company_brain_ingest;
ALTER DEFAULT PRIVILEGES FOR ROLE company_brain_admin IN SCHEMA public
  GRANT SELECT ON TABLES TO company_brain_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE company_brain_admin IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO company_brain_reader;

-- Future objects created by ingest/gbrain.
ALTER DEFAULT PRIVILEGES FOR ROLE company_brain_ingest IN SCHEMA public
  GRANT ALL PRIVILEGES ON TABLES TO company_brain_ingest;
ALTER DEFAULT PRIVILEGES FOR ROLE company_brain_ingest IN SCHEMA public
  GRANT ALL PRIVILEGES ON SEQUENCES TO company_brain_ingest;
ALTER DEFAULT PRIVILEGES FOR ROLE company_brain_ingest IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO company_brain_ingest;
ALTER DEFAULT PRIVILEGES FOR ROLE company_brain_ingest IN SCHEMA public
  GRANT SELECT ON TABLES TO company_brain_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE company_brain_ingest IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO company_brain_reader;

CREATE TABLE IF NOT EXISTS query_log (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  cf_access_user_email TEXT,
  query_text TEXT NOT NULL,
  query_text_truncated BOOLEAN NOT NULL DEFAULT FALSE,
  duration_ms INTEGER,
  row_count INTEGER,
  ok BOOLEAN NOT NULL,
  error_class TEXT,
  error_message TEXT,
  client_addr TEXT
);

CREATE INDEX IF NOT EXISTS query_log_ts_idx ON query_log (ts DESC);
CREATE INDEX IF NOT EXISTS query_log_user_ts_idx ON query_log (cf_access_user_email, ts DESC);

-- Re-apply current-object grants after objects created in this script.
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO company_brain_ingest;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO company_brain_ingest;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO company_brain_ingest;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO company_brain_reader;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO company_brain_reader;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public FROM company_brain_reader;
REVOKE CREATE ON SCHEMA public FROM company_brain_reader;

DO $$
DECLARE
  ingest_connect boolean;
  reader_connect boolean;
BEGIN
  SELECT has_database_privilege('company_brain_ingest', 'company_brain', 'CONNECT') INTO ingest_connect;
  SELECT has_database_privilege('company_brain_reader', 'company_brain', 'CONNECT') INTO reader_connect;
  RAISE NOTICE 'company_brain_ingest CONNECT: %', ingest_connect;
  RAISE NOTICE 'company_brain_reader CONNECT: %', reader_connect;
  RAISE NOTICE 'company_brain bootstrap complete; extensions and roles installed';
END
$$;
