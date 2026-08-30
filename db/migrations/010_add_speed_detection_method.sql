-- =============================================================================
-- Gates Police Department -- RMS & Court Clerk Ledger Platform
-- Migration: 010_add_speed_detection_method.sql
-- Depends on: 001_init_schema.sql .. 009_fix_audit_log_delete_cascade.sql
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- The redesigned printed citation (Tennessee uniform-citation-style ticket,
-- 2026-08-30) needs to record how a speeding violation's speed was measured
-- -- radar, lidar, paced by a following officer, VASCAR, visual estimation,
-- or not applicable (non-speed offenses). This was never previously
-- collected -- there is no prior column or data to migrate.
--
-- Nullable, no DEFAULT: unlike the T.C.A. 55-10-207(i) mandatory fields
-- (CMV/hazmat/16+ passenger), speed-detection method is not itself one of
-- the 13 statutorily mandated data points, so it stays optional at the DB
-- layer and is only meaningful for speed-related offenses.
-- =============================================================================

BEGIN;

DO $$ BEGIN
    CREATE TYPE speed_detection_method AS ENUM (
        'Radar',
        'Lidar',
        'Paced',
        'VASCAR',
        'Visual_Estimation',
        'Not_Applicable'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE e_citations ADD COLUMN IF NOT EXISTS speed_detection_method speed_detection_method;

-- Table-level grants already cover the new column; no new GRANT needed.

COMMIT;
