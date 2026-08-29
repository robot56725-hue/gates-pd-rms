-- =============================================================================
-- Gates Police Department -- provisions the restricted PostgreSQL role the
-- Express API connects as.
--
-- Run this ONCE per environment, as a superuser (e.g. the `postgres` role),
-- AFTER 001_init_schema.sql and 002_add_tca_citation_fields.sql have already
-- been applied to the target database.
--
-- IMPORTANT: this role must NOT be the owner of these tables and must NOT be
-- a superuser. The court_ledger/users FORCE ROW LEVEL SECURITY policies in
-- 001_init_schema.sql have no effect on a table's owner or on a superuser --
-- if the API connects as either, the RLS backstop from that migration is
-- silently inert.
--
-- Usage (first time -- role does not exist yet):
--   psql -U postgres -d gates_pd_dev -v app_password="'CHANGE_ME_STRONG_PASSWORD'" -f db/provision_app_role.sql
--
-- To rotate the password later instead of re-running this whole script:
--   psql -U postgres -d gates_pd_dev -c "ALTER ROLE gates_app_user PASSWORD 'NEW_PASSWORD';"
--
-- Note on psql variable substitution: :app_password is only interpolated in
-- a plain top-level statement, NOT inside a dollar-quoted DO $$ ... $$ block
-- -- that's why CREATE ROLE below is a bare statement rather than wrapped in
-- one.
-- =============================================================================

\if :{?app_password}
\else
  \echo 'ERROR: pass -v app_password="''your-password-here''" (with the extra quotes) on the psql command line.'
  \quit
\endif

CREATE ROLE gates_app_user LOGIN PASSWORD :app_password;

-- GRANT CONNECT needs the current database's name, which we don't want the
-- caller to have to also pass in separately -- \gexec builds and runs it
-- from the query result instead.
SELECT format('GRANT CONNECT ON DATABASE %I TO gates_app_user', current_database()) \gexec

GRANT USAGE ON SCHEMA public TO gates_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gates_app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gates_app_user;

-- Ensure any table created by a FUTURE migration is also covered without
-- having to remember to re-grant by hand.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gates_app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO gates_app_user;

\echo 'gates_app_user provisioned. Put its password in DATABASE_URL in your .env -- never in this file.'
