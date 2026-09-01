-- =============================================================================
-- Gates Police Department -- RMS & Court Clerk Ledger Platform
-- Migration: 012_add_matters_of_record.sql
-- Depends on: 001_init_schema.sql .. 011_add_court_case_management.sql
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- The TIBRS Incident module (005) requires at least one TIBRS Group A
-- offense code on every incident (incidentCreateSchema's `offenses` array is
-- `.min(1).required()`) -- correct for actual crime reporting, but it means
-- there was no way to document an event that never involved a crime or an
-- arrest at all: a welfare check, a mediated civil dispute, a verbal
-- warning, an animal complaint. Forcing one of those through the Incident
-- screen would mean inventing a fake offense code, which would corrupt this
-- department's real TIBRS submission data.
--
-- This adds a separate, deliberately lighter-weight "Matters of Record"
-- (MOR) module for exactly that: non-arrest documentation of an officer
-- response, standing alone rather than as a stripped-down Incident. It
-- reuses master_persons (for involved parties/witnesses) and the shared
-- approval_status/sync_state enums and set_updated_at() trigger already
-- established in 001/005/008, the same way every module since has.
-- =============================================================================

BEGIN;

-- Matches the categories described when this module was requested, plus the
-- 'Other' catch-all every enum in this schema carries for exactly this
-- reason (see e.g. property_loss_type, evidence_category).
DO $$ BEGIN
    CREATE TYPE mor_category AS ENUM (
        'Property_Loss',
        'Neighborhood_Disturbance',
        'Civil_Dispute',
        'Vandalism',
        'Welfare_Check',
        'Verbal_Warning',
        'Medical_Call',
        'Animal_Complaint',
        'Other'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Deliberately just two roles -- MORs are non-arrest by definition, so
-- there's no Victim/Offender distinction the way incident_person_role has
-- (db/migrations/005_add_tibrs_incident_module.sql).
DO $$ BEGIN
    CREATE TYPE mor_person_role AS ENUM ('Involved_Party', 'Witness');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS matters_of_record (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_number           TEXT NOT NULL,
    category                mor_category NOT NULL,
    reporting_officer_id    UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    occurrence_date         TIMESTAMPTZ NOT NULL,
    location_address        TEXT NOT NULL,
    latitude                NUMERIC(9, 6),
    longitude               NUMERIC(9, 6),
    narrative                TEXT NOT NULL,

    -- Same Supervisor/System_Admin approval workflow every other report
    -- type carries (approval_status enum from 008_..._approval.sql).
    approval_status         approval_status NOT NULL DEFAULT 'Pending',
    approved_by_id          UUID REFERENCES users (id),
    approved_at             TIMESTAMPTZ,
    approval_notes          TEXT,

    -- Offline-sync bookkeeping, same fields every submission-type table in
    -- this schema carries (sync_state enum from 001_init_schema.sql).
    device_created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    synced_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    sync_status              sync_state NOT NULL DEFAULT 'synced',

    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_mor_report_number UNIQUE (report_number),
    CONSTRAINT ck_mor_report_number_not_blank CHECK (length(btrim(report_number)) > 0),
    CONSTRAINT ck_mor_location_not_blank CHECK (length(btrim(location_address)) > 0),
    CONSTRAINT ck_mor_narrative_not_blank CHECK (length(btrim(narrative)) > 0)
);

CREATE INDEX IF NOT EXISTS ix_mor_reporting_officer ON matters_of_record (reporting_officer_id);
CREATE INDEX IF NOT EXISTS ix_mor_category ON matters_of_record (category);
CREATE INDEX IF NOT EXISTS ix_mor_occurrence_date ON matters_of_record (occurrence_date);
CREATE INDEX IF NOT EXISTS ix_mor_approval_status ON matters_of_record (approval_status);

DROP TRIGGER IF EXISTS trg_mor_updated_at ON matters_of_record;
CREATE TRIGGER trg_mor_updated_at
    BEFORE UPDATE ON matters_of_record
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------------------------
-- mor_persons -- every involved party or witness named on a matter of
-- record, and in what capacity. Mirrors incident_persons' shape
-- (005_add_tibrs_incident_module.sql) but without a role that implies guilt
-- or victimhood, and without injury_type -- not meaningful for a non-arrest
-- record.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mor_persons (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mor_id              UUID NOT NULL REFERENCES matters_of_record (id) ON DELETE CASCADE,
    person_id           UUID NOT NULL REFERENCES master_persons (id) ON DELETE RESTRICT,
    role                mor_person_role NOT NULL,
    sequence_number     SMALLINT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_mor_persons_role_sequence UNIQUE (mor_id, role, sequence_number)
);

CREATE INDEX IF NOT EXISTS ix_mor_persons_mor ON mor_persons (mor_id);
CREATE INDEX IF NOT EXISTS ix_mor_persons_person ON mor_persons (person_id);

-- Read access open to every authenticated role (matches incidents/crash
-- reports -- no RLS restricting SELECT). Writes enforced at the application
-- layer via requireRoles(), same pattern as every other module.
--
-- The app connects as gates_app_user, a low-privilege role that does not
-- own the public schema -- explicit grants here so the new tables work
-- immediately regardless of whether provisioning's ALTER DEFAULT
-- PRIVILEGES already covers it.
GRANT SELECT, INSERT, UPDATE, DELETE ON matters_of_record, mor_persons TO gates_app_user;

COMMIT;

-- =============================================================================
-- End of 012_add_matters_of_record.sql
-- =============================================================================
