-- =============================================================================
-- Gates Police Department -- RMS & Court Clerk Ledger Platform
-- Migration: 007_add_evidence_module.sql
-- Depends on: 001_init_schema.sql .. 006_add_ecrash_module.sql
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- Nothing in the schema tracked physical/digital evidence at all. This adds
-- an evidence_items table (one row per collected item, optionally linked to
-- the incident or crash report it was collected under) plus an
-- evidence_custody_log table recording every chain-of-custody event
-- (collected, transferred, released, returned, destroyed) so an item's full
-- custody history is auditable -- standard practice for anything that may
-- end up in court.
-- =============================================================================

BEGIN;

DO $$ BEGIN
    CREATE TYPE evidence_category AS ENUM (
        'Weapon',
        'Firearm',
        'Ammunition',
        'Drug_Narcotic',
        'Drug_Paraphernalia',
        'Document',
        'Electronic_Device',
        'Biological',
        'Currency',
        'Vehicle',
        'Photograph',
        'Video_Audio_Recording',
        'Clothing',
        'Tool',
        'Fingerprint_Impression',
        'Other'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE evidence_status AS ENUM (
        'In_Storage',
        'Checked_Out',
        'Transferred',
        'Released_To_Owner',
        'Submitted_To_Lab',
        'Court_Evidence',
        'Destroyed'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE evidence_custody_action AS ENUM (
        'Collected',
        'Transferred',
        'Checked_Out',
        'Checked_In',
        'Submitted_To_Lab',
        'Returned_From_Lab',
        'Released',
        'Destroyed'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS evidence_items (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_number         TEXT NOT NULL,
    incident_id         UUID REFERENCES incidents(id),
    crash_report_id     UUID REFERENCES crash_reports(id),
    category            evidence_category NOT NULL,
    description         TEXT NOT NULL,
    quantity            INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
    location_collected  TEXT,
    date_collected      DATE NOT NULL,
    collected_by_id     UUID NOT NULL REFERENCES users(id),
    storage_location    TEXT,
    status              evidence_status NOT NULL DEFAULT 'In_Storage',
    disposition_notes   TEXT,
    device_created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_evidence_item_number UNIQUE (item_number),
    CONSTRAINT chk_evidence_linked_to_case CHECK (incident_id IS NOT NULL OR crash_report_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_evidence_items_incident ON evidence_items(incident_id);
CREATE INDEX IF NOT EXISTS idx_evidence_items_crash ON evidence_items(crash_report_id);
CREATE INDEX IF NOT EXISTS idx_evidence_items_collected_by ON evidence_items(collected_by_id);

CREATE TABLE IF NOT EXISTS evidence_custody_log (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evidence_item_id    UUID NOT NULL REFERENCES evidence_items(id),
    action              evidence_custody_action NOT NULL,
    from_custodian      TEXT,
    to_custodian        TEXT,
    notes               TEXT,
    performed_by_id     UUID NOT NULL REFERENCES users(id),
    performed_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evidence_custody_item ON evidence_custody_log(evidence_item_id);

-- updated_at bookkeeping, reusing the shared set_updated_at() trigger
-- function already defined in 001_init_schema.sql.
DROP TRIGGER IF EXISTS trg_evidence_items_updated_at ON evidence_items;
CREATE TRIGGER trg_evidence_items_updated_at
    BEFORE UPDATE ON evidence_items
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Read access is open to every authenticated role (matches incidents/crash
-- reports -- no RLS restricting SELECT). Writes are enforced at the
-- application layer via requireRoles(), same pattern as every other module.

COMMIT;
