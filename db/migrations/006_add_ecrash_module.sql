-- =============================================================================
-- Gates Police Department -- RMS & Court Clerk Ledger Platform
-- Migration: 006_add_ecrash_module.sql
-- Depends on: 001_init_schema.sql .. 005_add_tibrs_incident_module.sql
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- Alongside e-Citations, Tennessee's e-Crash system generates the other
-- half of state-level driver history: electronic traffic crash/accident
-- reports. Nothing in the original schema modeled a crash at all. This adds
-- a crash_reports table plus its involved-vehicles and involved-persons
-- child tables, using the same MMUCC/KABCO-standard condition and injury
-- vocabularies real crash report forms use (weather, road surface, light
-- condition, injury severity), and the same offline-sync bookkeeping
-- pattern already used by incidents/e_citations.
-- =============================================================================

BEGIN;

DO $$ BEGIN
    CREATE TYPE crash_severity AS ENUM (
        'Property_Damage_Only',
        'Injury',
        'Fatality'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE crash_person_role AS ENUM (
        'Driver',
        'Passenger',
        'Pedestrian',
        'Cyclist',
        'Other'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Standard KABCO injury scale (K/A/B/C/O), as used on MMUCC-aligned state
-- crash report forms, including Tennessee's.
DO $$ BEGIN
    CREATE TYPE crash_injury_severity AS ENUM (
        'No_Apparent_Injury',
        'Possible_Injury',
        'Suspected_Minor_Injury',
        'Suspected_Serious_Injury',
        'Fatal_Injury'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE weather_condition AS ENUM (
        'Clear',
        'Cloudy',
        'Rain',
        'Sleet_Hail',
        'Snow',
        'Fog_Smog_Smoke',
        'Severe_Crosswinds',
        'Blowing_Sand_Soil_Dirt',
        'Other',
        'Unknown'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE road_surface_condition AS ENUM (
        'Dry',
        'Wet',
        'Snow',
        'Ice',
        'Sand_Mud_Dirt_Gravel',
        'Water_Standing_Moving',
        'Slush',
        'Other',
        'Unknown'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE light_condition AS ENUM (
        'Daylight',
        'Dusk',
        'Dawn',
        'Dark_Lighted',
        'Dark_Not_Lighted',
        'Dark_Unknown_Lighting',
        'Other',
        'Unknown'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- --------------------------------------------------------------------------
-- crash_reports
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crash_reports (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_number               CITEXT NOT NULL,
    reporting_officer_id        UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,

    crash_date                  TIMESTAMPTZ NOT NULL,
    location                    TEXT NOT NULL,
    latitude                    NUMERIC(10,7),
    longitude                   NUMERIC(10,7),

    weather_condition            weather_condition,
    road_surface_condition       road_surface_condition,
    light_condition               light_condition,
    crash_severity                 crash_severity NOT NULL,
    narrative                       TEXT,

    -- Offline-sync bookkeeping, matching incidents/e_citations.
    device_created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    synced_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
    sync_status                 sync_state NOT NULL DEFAULT 'synced',

    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_crash_report_number_not_blank CHECK (length(btrim(report_number)) > 0),
    CONSTRAINT ck_crash_location_not_blank CHECK (length(btrim(location)) > 0),
    CONSTRAINT ck_crash_not_future CHECK (crash_date <= now() + INTERVAL '15 minutes'),
    CONSTRAINT ck_crash_latitude_plausible CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
    CONSTRAINT ck_crash_longitude_plausible CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
    CONSTRAINT ck_crash_gps_both_or_neither CHECK ((latitude IS NULL) = (longitude IS NULL))
);

CREATE INDEX IF NOT EXISTS ix_crash_reports_date ON crash_reports (crash_date);
CREATE INDEX IF NOT EXISTS ix_crash_reports_officer ON crash_reports (reporting_officer_id);

-- --------------------------------------------------------------------------
-- crash_involved_vehicles
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crash_involved_vehicles (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    crash_report_id     UUID NOT NULL REFERENCES crash_reports (id) ON DELETE CASCADE,
    vehicle_id          UUID NOT NULL REFERENCES master_vehicles (id) ON DELETE RESTRICT,
    sequence_number     SMALLINT NOT NULL,
    -- Nullable: a hit-and-run or unattended vehicle may have no identified driver yet.
    driver_person_id    UUID REFERENCES master_persons (id) ON DELETE RESTRICT,
    damage_description  TEXT,
    damage_estimate     currency_amount,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_crash_vehicles_sequence UNIQUE (crash_report_id, sequence_number),
    CONSTRAINT ck_crash_vehicles_damage_nonnegative CHECK (damage_estimate IS NULL OR damage_estimate >= 0)
);

CREATE INDEX IF NOT EXISTS ix_crash_involved_vehicles_report ON crash_involved_vehicles (crash_report_id);

-- --------------------------------------------------------------------------
-- crash_involved_persons
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crash_involved_persons (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    crash_report_id     UUID NOT NULL REFERENCES crash_reports (id) ON DELETE CASCADE,
    person_id           UUID NOT NULL REFERENCES master_persons (id) ON DELETE RESTRICT,
    role                crash_person_role NOT NULL,
    injury_severity     crash_injury_severity NOT NULL DEFAULT 'No_Apparent_Injury',
    -- Which vehicle they were in/struck by, if relevant (NULL for e.g. a
    -- pedestrian witness not actually struck).
    vehicle_id          UUID REFERENCES crash_involved_vehicles (id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_crash_involved_persons_report ON crash_involved_persons (crash_report_id);
CREATE INDEX IF NOT EXISTS ix_crash_involved_persons_person ON crash_involved_persons (person_id);

COMMIT;

-- =============================================================================
-- End of 006_add_ecrash_module.sql
-- =============================================================================
