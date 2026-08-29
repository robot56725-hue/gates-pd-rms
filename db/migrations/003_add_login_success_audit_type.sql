-- =============================================================================
-- Adds LOGIN_SUCCESS to audit_action_type.
--
-- Gap found during a live end-to-end test run: audit_logs.action_type only
-- had READ / WRITE / DELETE / LOGIN_FAIL (exactly the four values originally
-- specified), so a *successful* login wrote no audit row at all -- the audit
-- trail could show every failed login attempt but not a single successful
-- one, which is backwards for a security-relevant log on a system handling
-- active court/citation data. src/controllers/auth.controller.js now writes
-- a LOGIN_SUCCESS row (user_id, ip, user_agent) immediately before issuing
-- the JWT, using the same fail-open-but-loudly-logged pattern as the
-- existing writeLoginFailAudit().
--
-- ALTER TYPE ... ADD VALUE cannot run inside the same transaction as a
-- statement that uses the new value, but is safe as its own top-level
-- statement (Postgres 12+), which is how this migration is written and how
-- every other migration in this project is applied (one file, run alone).
-- =============================================================================

ALTER TYPE audit_action_type ADD VALUE IF NOT EXISTS 'LOGIN_SUCCESS';
