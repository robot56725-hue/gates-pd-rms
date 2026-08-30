-- Fixes a conflict that predates this migration but could only surface once
-- migration 008 made deleting a users row possible: audit_logs.user_id is
-- `REFERENCES users (id) ON DELETE SET NULL` (deliberately -- see
-- 001_init_schema.sql's note that audit history must outlive a deleted
-- account), but audit_logs' own append-only trigger (prevent_modification(),
-- shared with incident_narratives) blocks EVERY UPDATE, including the one
-- Postgres itself issues to carry out that ON DELETE SET NULL action. The
-- result: deleting any users row that has ever generated an audit_logs entry
-- (which is nearly every real account -- logging in alone writes one) raised
-- a raw, uncaught trigger exception instead of either succeeding or the
-- friendly 409 deleteUser's foreign-key handling gives for every other
-- table's history.
--
-- Fix: give audit_logs its own BEFORE UPDATE trigger function that allows
-- exactly the shape of update the FK cascade performs -- user_id moving
-- from some value to NULL, with every other column byte-for-byte unchanged
-- -- and continues to reject anything else (a human trying to edit
-- action_type, ip_address, timestamp, or reassign user_id to a different
-- account). incident_narratives keeps using the original shared
-- prevent_modification() function unchanged; its author_id FK is already
-- ON DELETE RESTRICT, not SET NULL, so it never hits this case.

BEGIN;

CREATE OR REPLACE FUNCTION prevent_audit_log_tampering() RETURNS trigger AS $$
BEGIN
    IF NEW.user_id IS NULL
       AND OLD.user_id IS NOT NULL
       AND NEW.id = OLD.id
       AND NEW.action_type = OLD.action_type
       AND NEW.target_table IS NOT DISTINCT FROM OLD.target_table
       AND NEW.target_record_id IS NOT DISTINCT FROM OLD.target_record_id
       AND NEW.ip_address = OLD.ip_address
       AND NEW.user_agent IS NOT DISTINCT FROM OLD.user_agent
       AND NEW."timestamp" = OLD."timestamp"
    THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'Table "audit_logs" is append-only for legal record-keeping; content changes are not permitted (user_id may only be cleared when the referenced account is deleted).';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_immutable_update ON audit_logs;
CREATE TRIGGER trg_audit_immutable_update
    BEFORE UPDATE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_tampering();

COMMIT;
