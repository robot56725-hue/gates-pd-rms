-- =============================================================================
-- Run this in Neon's own web SQL Editor (console.neon.tech -> Gates_PD_RMS ->
-- SQL Editor), AFTER running 001_init_schema.sql, 002_add_tca_citation_fields.sql,
-- and 003_add_login_success_audit_type.sql in that same editor, in that order.
--
-- This is a plain-SQL version of provision_app_role.sql + a first admin seed,
-- rewritten because Neon's web SQL editor executes plain SQL only -- it does
-- not understand psql's own scripting syntax (\gexec, \if, :variables), which
-- the command-line version of this step relies on.
--
-- Password already generated for you: ly0vCFICyy5GF09W5UOAdWzy
-- (already written into your local .env's DATABASE_URL -- you don't need to
-- type it anywhere else)
-- =============================================================================

-- 1. Restricted application role (NOT the neondb_owner you're connected as).
--    Required for the users/court_ledger FORCE ROW LEVEL SECURITY policies
--    from 001_init_schema.sql to actually do anything -- they have no effect
--    on a table's owner (neondb_owner), only on a non-owner role like this one.
CREATE ROLE gates_app_user LOGIN PASSWORD 'ly0vCFICyy5GF09W5UOAdWzy';

GRANT CONNECT ON DATABASE neondb TO gates_app_user;
GRANT USAGE ON SCHEMA public TO gates_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gates_app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gates_app_user;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gates_app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO gates_app_user;

-- 2. Seed the first System_Admin account. Bootstraps the same way
--    scripts/seed-admin.js does: FORCE ROW LEVEL SECURITY on `users` checks
--    the session GUC app.actor_role, not who is connected, so setting it to
--    'System_Admin' for this one transaction is enough to insert the first
--    row -- no superuser needed.
--
--    Login: username "demo_admin", password "DemoAdmin_Neon2026!"
--    (password_hash below is that password's real bcrypt hash, generated
--    just now -- not a placeholder.)
BEGIN;
SELECT set_config('app.actor_role', 'System_Admin', true);
INSERT INTO users (username, password_hash, role, badge_number, full_name, agency, is_active)
VALUES (
  'demo_admin',
  '$2b$12$zFOiYNGixaOQTKECJlCOm.vV4Drm7Z3LBPRgVkboUZzGg7LfHuDmq',
  'System_Admin',
  'A-100',
  'Demo Admin',
  'Gates Police Department',
  true
)
RETURNING id, username, role;
COMMIT;
