-- =============================================================================
-- Gates Police Department -- RMS & Court Clerk Ledger Platform
-- Migration: 008_add_signature_multirole_delete_approval.sql
-- Depends on: 001_init_schema.sql .. 007_add_evidence_module.sql
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- Four separate gaps identified by the Chief:
--   1. E-citations had no violator signature capture (T.C.A. 55-10-207
--      practice requires a signature block acknowledging receipt/promise to
--      appear, or a recorded refusal to sign -- refusal is itself a valid,
--      legally meaningful outcome, not an error state).
--   2. Personnel accounts were locked to exactly one role, with no way to
--      grant a person capabilities beyond their primary employment
--      classification (e.g. a Supervisor who is also cross-trained to issue
--      citations as a Patrol Officer).
--   3. There was no way to ever remove a personnel account outright -- only
--      deactivate. System_Admin now gets that ability, but it stays
--      structurally safe: every table that references a user
--      (e_citations.officer_id, incidents.reporting_officer_id,
--      evidence_items.collected_by_id, etc.) uses ON DELETE RESTRICT/NO
--      ACTION by default, so deleting an account with any real history
--      still fails loudly at the database layer instead of silently
--      orphaning or cascading away historical records. Deactivation remains
--      the right tool for an account with a history; DELETE is for
--      never-used or mistakenly-created accounts.
--   4. Supervisors/System_Admin had no way to formally approve or reject an
--      incident, crash, citation, or evidence submission -- there was no
--      concept of supervisory review at all, only the reporting officer's
--      own record.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Citation signature capture
-- ---------------------------------------------------------------------------
-- violator_signature stores a data: URL (image/png) of the captured
-- signature. No CHECK constraint requiring one-or-the-other against
-- existing rows (pre-dates this migration and would fail validation) --
-- enforced at the application/Joi layer for citations issued from now on.
ALTER TABLE e_citations ADD COLUMN IF NOT EXISTS violator_signature TEXT;
ALTER TABLE e_citations ADD COLUMN IF NOT EXISTS violator_refused_to_sign BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 2. Multi-role personnel
-- ---------------------------------------------------------------------------
-- `role` remains the account's single PRIMARY role and is still what gates
-- the two RLS-protected tables (users, court_ledger -- see 001's
-- current_app_role() policies): those stay keyed to a person's primary
-- employment classification, not to any operational role they've been
-- additionally granted. `additional_roles` is purely additive operational
-- capability (which screens/actions the app lets them use), enforced at the
-- application layer (requireRoles()).
ALTER TABLE users ADD COLUMN IF NOT EXISTS additional_roles user_role[] NOT NULL DEFAULT '{}';

-- ---------------------------------------------------------------------------
-- 3. System_Admin may delete a personnel account
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS users_delete_admin_only ON users;
CREATE POLICY users_delete_admin_only ON users
    FOR DELETE USING (current_app_role() = 'System_Admin');

-- ---------------------------------------------------------------------------
-- 4. Supervisor/System_Admin approval workflow
-- ---------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE approval_status AS ENUM ('Pending', 'Approved', 'Rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE incidents ADD COLUMN IF NOT EXISTS approval_status approval_status NOT NULL DEFAULT 'Pending';
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS approved_by_id UUID REFERENCES users(id);
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS approval_notes TEXT;

ALTER TABLE crash_reports ADD COLUMN IF NOT EXISTS approval_status approval_status NOT NULL DEFAULT 'Pending';
ALTER TABLE crash_reports ADD COLUMN IF NOT EXISTS approved_by_id UUID REFERENCES users(id);
ALTER TABLE crash_reports ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE crash_reports ADD COLUMN IF NOT EXISTS approval_notes TEXT;

ALTER TABLE e_citations ADD COLUMN IF NOT EXISTS approval_status approval_status NOT NULL DEFAULT 'Pending';
ALTER TABLE e_citations ADD COLUMN IF NOT EXISTS approved_by_id UUID REFERENCES users(id);
ALTER TABLE e_citations ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE e_citations ADD COLUMN IF NOT EXISTS approval_notes TEXT;

ALTER TABLE evidence_items ADD COLUMN IF NOT EXISTS approval_status approval_status NOT NULL DEFAULT 'Pending';
ALTER TABLE evidence_items ADD COLUMN IF NOT EXISTS approved_by_id UUID REFERENCES users(id);
ALTER TABLE evidence_items ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE evidence_items ADD COLUMN IF NOT EXISTS approval_notes TEXT;

CREATE INDEX IF NOT EXISTS ix_incidents_approval_status ON incidents(approval_status);
CREATE INDEX IF NOT EXISTS ix_crash_reports_approval_status ON crash_reports(approval_status);
CREATE INDEX IF NOT EXISTS ix_e_citations_approval_status ON e_citations(approval_status);
CREATE INDEX IF NOT EXISTS ix_evidence_items_approval_status ON evidence_items(approval_status);

-- Table-level grants already cover new columns; no new GRANT needed.

COMMIT;
