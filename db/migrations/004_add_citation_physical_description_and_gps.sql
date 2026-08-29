-- =============================================================================
-- Gates Police Department -- RMS & Court Clerk Ledger Platform
-- Migration: 004_add_citation_physical_description_and_gps.sql
-- Depends on: 001_init_schema.sql, 002_add_tca_citation_fields.sql,
--             003_add_login_success_audit_type.sql
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- Two more T.C.A. 55-10-207(i) / standard e-citation data points had nowhere
-- to be persisted:
--
--   - Violator PHYSICAL DESCRIPTION (sex, race, height, weight, eye color,
--     hair color) -- master_persons only had name/DOB/DL/contact info.
--   - Precise GPS coordinates for the offense location (as captured via
--     TraCS Geolocation or an equivalent device-side GPS reading) --
--     e_citations.location was free-text only.
--
-- Additive and idempotent, safe to run against a database that already has
-- rows (nothing here is set NOT NULL, since backfilling physical
-- descriptions or GPS coordinates for historical citations is not always
-- possible).
-- =============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- Enumerations for physical description. Kept as a small, fixed set of
-- standard values (matching the categories used on TN driver's licenses /
-- standard incident-reporting forms) rather than free text, so downstream
-- reporting/statistics never have to reconcile a hundred spellings of the
-- same value.
-- --------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE person_sex AS ENUM (
        'Male',
        'Female',
        'Unknown'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE person_race AS ENUM (
        'White',
        'Black',
        'American_Indian_Alaska_Native',
        'Asian',
        'Native_Hawaiian_Pacific_Islander',
        'Unknown'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- --------------------------------------------------------------------------
-- master_persons: physical description fields. All nullable -- not every
-- historical record can be backfilled, and a citation submission that omits
-- one (e.g. hair color not visually confirmed) should not be blocked at the
-- database layer; the API's own validation decides what's mandatory for a
-- NEW citation (see src/validation/citationSchema.js).
-- --------------------------------------------------------------------------
ALTER TABLE master_persons
    ADD COLUMN IF NOT EXISTS sex             person_sex,
    ADD COLUMN IF NOT EXISTS race            person_race,
    ADD COLUMN IF NOT EXISTS height_inches    SMALLINT,
    ADD COLUMN IF NOT EXISTS weight_lbs       SMALLINT,
    ADD COLUMN IF NOT EXISTS eye_color        TEXT,
    ADD COLUMN IF NOT EXISTS hair_color       TEXT;

DO $$ BEGIN
    ALTER TABLE master_persons
        ADD CONSTRAINT ck_persons_height_plausible
        CHECK (height_inches IS NULL OR height_inches BETWEEN 20 AND 96);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE master_persons
        ADD CONSTRAINT ck_persons_weight_plausible
        CHECK (weight_lbs IS NULL OR weight_lbs BETWEEN 30 AND 700);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- --------------------------------------------------------------------------
-- e_citations: precise GPS coordinates for the offense location, distinct
-- from the existing free-text `location` column (a human-readable "Main St
-- & 5th Ave" description remains useful alongside, not instead of, a GPS
-- fix -- neither one substitutes for the other on the printed citation).
--
-- NUMERIC(10,7) gives ~1cm precision at these latitudes, matching what a
-- consumer/in-vehicle GPS unit or TraCS Geolocation actually reports.
-- --------------------------------------------------------------------------
ALTER TABLE e_citations
    ADD COLUMN IF NOT EXISTS latitude   NUMERIC(10,7),
    ADD COLUMN IF NOT EXISTS longitude  NUMERIC(10,7);

DO $$ BEGIN
    ALTER TABLE e_citations
        ADD CONSTRAINT ck_citations_latitude_plausible
        CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE e_citations
        ADD CONSTRAINT ck_citations_longitude_plausible
        CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Both coordinates must be supplied together, or neither -- a lone latitude
-- or longitude is not a usable location fix and almost always indicates a
-- partial/corrupted client submission.
DO $$ BEGIN
    ALTER TABLE e_citations
        ADD CONSTRAINT ck_citations_gps_both_or_neither
        CHECK ((latitude IS NULL) = (longitude IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;

-- =============================================================================
-- End of 004_add_citation_physical_description_and_gps.sql
-- =============================================================================
