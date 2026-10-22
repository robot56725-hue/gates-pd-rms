-- =============================================================================
-- Gates Police Department -- RMS & Court Clerk Ledger Platform
-- Migration: 014_add_case_photos.sql
-- Depends on: 001_init_schema.sql .. 013_add_incident_tca_charges.sql
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- Nothing in the schema could hold a photo attached to a report. This adds a
-- single, polymorphic case_photos table shared by Incidents, Matters of
-- Record, and Crash Reports (the three modules this was requested for)
-- rather than three near-identical tables -- the shape (who uploaded what
-- image, with what caption, on what date) is identical across all three,
-- and a shared table means one API surface and one frontend component.
--
-- STORAGE CHOICE: images are stored directly in Postgres as BYTEA, not in
-- external object storage (S3 etc.). This was a deliberate, explicit choice
-- made with the department (not a default) -- Render's free web-service
-- plan has no persistent disk, so local-filesystem storage would be lost on
-- every deploy/restart, and standing up external cloud storage would mean
-- a new paid account and credentials before any of this could be built.
-- Storing in Neon/Postgres works immediately with the infrastructure
-- already in place. The size cap below (8 MB/photo) and client-side
-- downscaling (done in the frontend before upload, not enforced here) exist
-- specifically to keep this from bloating the database -- if photo volume
-- ever grows large enough to matter, migrating case_photos.file_data out to
-- object storage later is a contained change (this table's shape doesn't
-- need to move, just where file_data's bytes physically live).
--
-- Exactly one of incident_id / mor_id / crash_report_id is set per row,
-- enforced below the same way evidence_items enforces "incident OR crash,
-- never neither" (007_add_evidence_module.sql) -- except here it's exactly
-- one of three, not an either/or of two, so a plain CHECK counting non-null
-- columns is clearer than a set of xor-pair constraints.
-- =============================================================================

BEGIN;

DO $$ BEGIN
    CREATE TYPE photo_record_type AS ENUM ('Incident', 'MOR', 'Crash');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS case_photos (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    record_type         photo_record_type NOT NULL,
    incident_id         UUID REFERENCES incidents (id) ON DELETE CASCADE,
    mor_id              UUID REFERENCES matters_of_record (id) ON DELETE CASCADE,
    crash_report_id     UUID REFERENCES crash_reports (id) ON DELETE CASCADE,

    mime_type           TEXT NOT NULL,
    file_data           BYTEA NOT NULL,
    file_size_bytes     INTEGER NOT NULL,
    caption             TEXT,

    uploaded_by_id      UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Only the three formats the frontend will ever produce (it downscales
    -- to JPEG/WebP client-side before upload; PNG is allowed too for a
    -- scanned-document-style attachment). Anything else is rejected before
    -- it ever reaches the database.
    CONSTRAINT chk_case_photos_mime CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),

    -- 8 MB/photo -- generous for a phone-camera JPEG even unscaled, but
    -- still bounds how fast this table can grow from a single bad upload.
    CONSTRAINT chk_case_photos_size CHECK (file_size_bytes > 0 AND file_size_bytes <= 8388608),

    -- Exactly one of the three link columns must be set.
    CONSTRAINT chk_case_photos_exactly_one_link CHECK (
        (CASE WHEN incident_id IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN mor_id IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN crash_report_id IS NOT NULL THEN 1 ELSE 0 END) = 1
    ),

    -- record_type must agree with which link column is actually set --
    -- without this, record_type could drift from the FK that's really
    -- populated and every query filtering by record_type would silently
    -- miss rows.
    CONSTRAINT chk_case_photos_type_matches_link CHECK (
        (record_type = 'Incident' AND incident_id IS NOT NULL AND mor_id IS NULL AND crash_report_id IS NULL) OR
        (record_type = 'MOR' AND mor_id IS NOT NULL AND incident_id IS NULL AND crash_report_id IS NULL) OR
        (record_type = 'Crash' AND crash_report_id IS NOT NULL AND incident_id IS NULL AND mor_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS ix_case_photos_incident ON case_photos (incident_id);
CREATE INDEX IF NOT EXISTS ix_case_photos_mor ON case_photos (mor_id);
CREATE INDEX IF NOT EXISTS ix_case_photos_crash ON case_photos (crash_report_id);
CREATE INDEX IF NOT EXISTS ix_case_photos_uploaded_by ON case_photos (uploaded_by_id);

-- updated_at bookkeeping, reusing the shared set_updated_at() trigger
-- function already defined in 001_init_schema.sql -- only ever touched by
-- a caption edit (the image bytes themselves are never replaced; a bad
-- upload is deleted and re-uploaded, same pattern as everything else
-- append-only-ish in this schema).
DROP TRIGGER IF EXISTS trg_case_photos_updated_at ON case_photos;
CREATE TRIGGER trg_case_photos_updated_at
    BEFORE UPDATE ON case_photos
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Read access open to every authenticated role (matches every other module
-- -- no RLS restricting SELECT). Writes enforced at the application layer
-- via requireRoles(), same pattern as every other module.
--
-- The app connects as gates_app_user, a low-privilege role that does not
-- own the public schema -- explicit grants here so the new table works
-- immediately regardless of whether provisioning's ALTER DEFAULT
-- PRIVILEGES already covers it.
GRANT SELECT, INSERT, UPDATE, DELETE ON case_photos TO gates_app_user;

COMMIT;

-- =============================================================================
-- End of 014_add_case_photos.sql
-- =============================================================================
