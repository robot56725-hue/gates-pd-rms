-- =============================================================================
-- Gates Police Department -- RMS & Court Clerk Ledger Platform
-- Migration: 002_add_tca_citation_fields.sql
-- Depends on: 001_init_schema.sql
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- While wiring the Node.js/Express API's T.C.A. § 55-10-207(i) 13-point
-- citation validation to the schema in 001_init_schema.sql, four of the
-- thirteen legally mandated data points turned out to have nowhere to be
-- persisted:
--
--   (5)  vehicle owner            -- master_vehicles had no owner column
--   (6)  license plate YEAR       -- master_vehicles had a vehicle model
--                                    year, but not a plate/decal year
--   (12) officer name/rank/agency -- users only had badge_number + role;
--                                    no display name, no rank, no agency
--   (13) court date/time/location -- nothing captured the court appearance
--        /court name                info that must appear on the citation
--                                    AT ISSUANCE, distinct from
--                                    court_ledger.court_date (which is the
--                                    Court_Clerk's own, separately-editable
--                                    operational field -- e.g. after a
--                                    continuance reschedules the case, long
--                                    after the original citation was printed)
--
-- This migration adds exactly those columns, additively and idempotently,
-- and is safe to run against the database 001_init_schema.sql already
-- created (including one with no rows yet, which is the expected case for
-- a schema this new).
-- =============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- users: officer identity fields needed for T.C.A. 55-10-207(i)(12).
-- --------------------------------------------------------------------------
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS full_name TEXT,
    ADD COLUMN IF NOT EXISTS officer_rank TEXT,
    ADD COLUMN IF NOT EXISTS agency TEXT NOT NULL DEFAULT 'Gates Police Department';

-- full_name should be required for every account going forward. Added
-- nullable above so this migration never fails against an existing table
-- with rows; tightened to NOT NULL here only if there's nothing to break.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM users WHERE full_name IS NULL) THEN
        ALTER TABLE users ALTER COLUMN full_name SET NOT NULL;
    ELSE
        RAISE NOTICE 'users.full_name left nullable: existing rows have NULL. Backfill, then run: ALTER TABLE users ALTER COLUMN full_name SET NOT NULL;';
    END IF;
END $$;

-- officer_rank is intentionally left nullable at the DB level (a Court_Clerk
-- or System_Admin account has no police rank); the API enforces it as
-- required specifically when the account is issuing citations (role =
-- Patrol_Officer / Supervisor). See src/controllers/citations.controller.js.

-- --------------------------------------------------------------------------
-- master_vehicles: owner + plate (decal) year for T.C.A. 55-10-207(i)(5)/(6).
-- --------------------------------------------------------------------------
ALTER TABLE master_vehicles
    ADD COLUMN IF NOT EXISTS owner_name TEXT,
    ADD COLUMN IF NOT EXISTS plate_year SMALLINT;

DO $$ BEGIN
    ALTER TABLE master_vehicles
        ADD CONSTRAINT ck_vehicles_plate_year_plausible
        CHECK (plate_year IS NULL OR plate_year BETWEEN 1900 AND (EXTRACT(YEAR FROM now())::INT + 1));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- --------------------------------------------------------------------------
-- e_citations: court appearance info as assigned AT ISSUANCE, for
-- T.C.A. 55-10-207(i)(13). Distinct from court_ledger.court_date, which the
-- Court_Clerk may subsequently update (continuances, rescheduling) without
-- rewriting the citation's own historical record of what it originally said.
-- --------------------------------------------------------------------------
-- court_date is TIMESTAMPTZ (date + time together), matching offense_date's
-- own representation directly above it in 001_init_schema.sql -- there is no
-- separate court_time column; the "time" half of T.C.A. 55-10-207(i)(13) is
-- just the time-of-day component of this same timestamp.
ALTER TABLE e_citations
    ADD COLUMN IF NOT EXISTS court_date TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS court_location TEXT,
    ADD COLUMN IF NOT EXISTS court_name TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM e_citations
         WHERE court_date IS NULL
            OR court_location IS NULL OR court_name IS NULL
    ) THEN
        ALTER TABLE e_citations
            ALTER COLUMN court_date SET NOT NULL,
            ALTER COLUMN court_location SET NOT NULL,
            ALTER COLUMN court_name SET NOT NULL;
    ELSE
        RAISE NOTICE 'e_citations court_* columns left nullable: existing rows have NULLs. Backfill, then tighten manually.';
    END IF;
END $$;

DO $$ BEGIN
    ALTER TABLE e_citations
        ADD CONSTRAINT ck_citations_court_not_before_offense
        CHECK (court_date IS NULL OR court_date >= offense_date);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS ix_citations_court_date ON e_citations (court_date);

COMMIT;

-- =============================================================================
-- End of 002_add_tca_citation_fields.sql
-- =============================================================================
