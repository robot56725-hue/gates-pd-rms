-- =============================================================================
-- Gates Police Department -- RMS & Court Clerk Ledger Platform
-- Migration: 013_add_incident_tca_charges.sql
-- Depends on: 001_init_schema.sql, 005_add_tibrs_incident_module.sql
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- incident_offenses (005_add_tibrs_incident_module.sql) records the TIBRS/
-- NIBRS crime-classification code for an incident -- what a real state
-- submission needs, not what a defendant is actually charged with in court.
-- Those are two different things a real incident report has to carry side
-- by side: a citation already has exactly this pair (e_citations.tca_code +
-- .offense_description, see 002_add_tca_citation_fields.sql), but incidents
-- had nowhere to record the actual Tennessee Code Annotated statute
-- charge(s) an officer is bringing -- only the TIBRS code.
--
-- Modeled as its own table, not a column on incidents, because an incident
-- can have multiple charges (against one or more offenders), the same
-- shape citations chose not to need since a citation is always exactly one
-- charge. charge_sequence mirrors incident_offenses' own sequencing
-- pattern. offender_incident_person_id is nullable and, when supplied, must
-- reference an incident_persons row with role Offender belonging to the
-- SAME incident -- enforced by trigger, not a plain FK, for the identical
-- reason incident_victim_offender_relationships already needs one (a CHECK
-- constraint cannot look up another table's role/incident_id).
--
-- Additive and idempotent; safe to run against a database with existing
-- incident rows.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS incident_tca_charges (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id                     UUID NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
    charge_sequence                 SMALLINT NOT NULL,
    tca_code                        TEXT NOT NULL,
    charge_description               TEXT NOT NULL,
    -- Free text (e.g. "Class E Felony", "Class A Misdemeanor") -- Tennessee
    -- charge classifications vary by statute and are routinely amended, so
    -- this is deliberately not an enum (same reasoning as tca_code itself).
    charge_classification           TEXT,
    offender_incident_person_id     UUID REFERENCES incident_persons (id) ON DELETE SET NULL,
    created_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_tca_charges_code_not_blank CHECK (length(btrim(tca_code)) > 0),
    CONSTRAINT ck_tca_charges_desc_not_blank CHECK (length(btrim(charge_description)) > 0),
    CONSTRAINT ck_tca_charges_sequence_range CHECK (charge_sequence BETWEEN 1 AND 20),
    CONSTRAINT uq_tca_charges_incident_sequence UNIQUE (incident_id, charge_sequence)
);

CREATE INDEX IF NOT EXISTS ix_tca_charges_incident ON incident_tca_charges (incident_id);
CREATE INDEX IF NOT EXISTS ix_tca_charges_offender ON incident_tca_charges (offender_incident_person_id);

-- Same integrity check incident_victim_offender_relationships already needs
-- (005_add_tibrs_incident_module.sql's trg_validate_victim_offender_roles):
-- a plain FK can confirm offender_incident_person_id exists, but not that
-- it has role Offender or belongs to this same incident.
CREATE OR REPLACE FUNCTION trg_validate_tca_charge_offender_role() RETURNS TRIGGER AS $$
DECLARE
    offender_role   incident_person_role;
    offender_incident UUID;
BEGIN
    IF NEW.offender_incident_person_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT role, incident_id INTO offender_role, offender_incident
      FROM incident_persons WHERE id = NEW.offender_incident_person_id;

    IF offender_role IS DISTINCT FROM 'Offender' THEN
        RAISE EXCEPTION 'offender_incident_person_id % does not have role Offender', NEW.offender_incident_person_id;
    END IF;
    IF offender_incident IS DISTINCT FROM NEW.incident_id THEN
        RAISE EXCEPTION 'offender_incident_person_id % does not belong to incident_id %', NEW.offender_incident_person_id, NEW.incident_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tca_charges_validate ON incident_tca_charges;
CREATE TRIGGER trg_tca_charges_validate
    BEFORE INSERT OR UPDATE ON incident_tca_charges
    FOR EACH ROW EXECUTE FUNCTION trg_validate_tca_charge_offender_role();

-- Read access open to every authenticated role (matches every other
-- incident sub-table -- no RLS restriction). Writes enforced at the
-- application layer via requireRoles(), same pattern as the rest of the
-- incident module.
--
-- The app connects as gates_app_user, a low-privilege role that does not
-- own the public schema -- explicit grant here so the new table works
-- immediately regardless of whether provisioning's ALTER DEFAULT
-- PRIVILEGES already covers it.
GRANT SELECT, INSERT, UPDATE, DELETE ON incident_tca_charges TO gates_app_user;

COMMIT;

-- =============================================================================
-- End of 013_add_incident_tca_charges.sql
-- =============================================================================
