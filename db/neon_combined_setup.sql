-- =============================================================================
-- Gates PD RMS — combined Neon setup script
-- Paste this ENTIRE file into Neon's SQL Editor (console.neon.tech -> Gates_PD_RMS
-- -> SQL Editor) and run it once. It merges, in order:
--   001_init_schema.sql, 002_add_tca_citation_fields.sql,
--   003_add_login_success_audit_type.sql, neon_web_editor_setup.sql
-- Safe to run only once against a fresh database (it creates tables/roles that
-- must not already exist).
-- =============================================================================

-- ================= 001_init_schema.sql =================
-- =============================================================================
-- Gates Police Department -- RMS & Court Clerk Ledger Platform
-- Migration: 001_init_schema.sql
-- Target:    PostgreSQL 14+ (developed/verified against PostgreSQL 16)
--
-- Purpose:   Initializes the full relational schema: identity/master data,
--            incident & narrative records, e-citations, the internal court
--            ledger, and an immutable audit trail.
--
-- Design notes (read before modifying):
--  * Every table uses a UUID primary key so an offline mobile/MDT client can
--    generate the row's identity locally (client-side) before it ever has
--    connectivity, then sync it up later without an id collision or a
--    server round-trip just to get a key. gen_random_uuid() (pgcrypto) is
--    used as the column DEFAULT for online/server-side inserts; an offline
--    client simply supplies its own pre-generated UUID in the INSERT and the
--    default is never invoked.
--  * Legal-record tables (incident_narratives, audit_logs) are append-only:
--    UPDATE/DELETE are blocked by trigger, not just by convention. Business
--    corrections happen by inserting a new version/row, never by rewriting
--    history.
--  * This script is idempotent (safe to re-run against a database that
--    already has it applied) via IF NOT EXISTS / DO-block guards, since
--    CREATE TYPE and CREATE TRIGGER don't natively support IF NOT EXISTS in
--    PostgreSQL. It is NOT a rollback/down-migration -- pair it with your
--    migration tool's convention (Flyway/sqitch/Alembic-raw-SQL) as V1/001.
--  * All statements execute inside a single transaction: partial application
--    of a schema migration is worse than an outright failure.
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 1: EXTENSIONS
-- =============================================================================

-- uuid-ossp: enabled per requirement; provides uuid_generate_v4() etc. for
-- any tooling/reports that expect the classic ossp functions.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- pgcrypto: provides gen_random_uuid() (used as our PK default -- no external
-- library dependency, faster than uuid-ossp) AND the pgp_sym_encrypt/decrypt
-- functions used to protect SSNs at rest (see master_persons.ssn_encrypted).
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- citext: case-insensitive text type. Used for identifiers/codes that are
-- functionally case-insensitive in the field (a badge scanner, a records
-- clerk, and a mobile keyboard will not agree on case for a DL number or a
-- citation number) so lookups and uniqueness constraints don't silently miss
-- matches over a casing difference.
CREATE EXTENSION IF NOT EXISTS "citext";

-- =============================================================================
-- SECTION 2: ENUM TYPES & DOMAINS
-- =============================================================================
-- CREATE TYPE has no IF NOT EXISTS; wrap in DO blocks that swallow
-- duplicate_object so this migration can be safely re-run.

DO $$ BEGIN
    CREATE TYPE user_role AS ENUM (
        'Patrol_Officer',
        'Supervisor',
        'Court_Clerk',
        'System_Admin'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE incident_status AS ENUM (
        'Open',
        'Under_Review',
        'Closed'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE court_disposition_status AS ENUM (
        'Pending',
        'Guilty',
        'Not_Guilty',
        'Dismissed',
        'FTA_Failure_To_Appear'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE audit_action_type AS ENUM (
        'READ',
        'WRITE',
        'DELETE',
        'LOGIN_FAIL'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Offline-sync lifecycle for records that can be authored on a disconnected
-- mobile/MDT client: 'pending_sync' rows exist only because a device pushed
-- them before the server could fully process them (rare with UUID PKs, but
-- kept for records ingested via a batch/async sync pipeline); 'synced' is
-- the normal steady state; 'sync_conflict' flags a row whose client-supplied
-- data disagreed with server-side validation and needs human review rather
-- than silent acceptance or silent rejection.
DO $$ BEGIN
    CREATE TYPE sync_state AS ENUM (
        'pending_sync',
        'synced',
        'sync_conflict'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Reusable non-negative monetary domain (fine amounts / payments). Centralizing
-- the CHECK here means every monetary column gets the same guarantee without
-- repeating the constraint at each table.
DO $$ BEGIN
    CREATE DOMAIN currency_amount AS NUMERIC(10, 2) CHECK (VALUE >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================================
-- SECTION 3: SHARED TRIGGER FUNCTIONS
-- =============================================================================

-- Maintains updated_at on any table that has the column.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Generic append-only guard: attach as a BEFORE UPDATE and/or BEFORE DELETE
-- trigger to make a table's history tamper-evident at the database level,
-- not just by application convention. Even a compromised or buggy
-- application credential cannot rewrite these rows.
CREATE OR REPLACE FUNCTION prevent_modification() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'Table "%" is append-only for legal record-keeping; % operations are not permitted.',
        TG_TABLE_NAME, TG_OP;
    RETURN NULL; -- unreachable, satisfies function-must-return contract
END;
$$ LANGUAGE plpgsql;

-- Auto-assigns the next narrative version for an incident when the caller
-- does not supply one, so the application never has to compute
-- max(version_number)+1 itself (and risk a race between two officers editing
-- the same incident at once -- this still runs under the row lock implied by
-- the transaction, see incident_narratives below for the concurrency note).
CREATE OR REPLACE FUNCTION assign_narrative_version() RETURNS trigger AS $$
BEGIN
    IF NEW.version_number IS NULL THEN
        SELECT COALESCE(MAX(version_number), 0) + 1
          INTO NEW.version_number
          FROM incident_narratives
         WHERE incident_id = NEW.incident_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Cross-table sanity check that a citation's court date is never scheduled
-- before the offense actually occurred. This mirrors the same rule enforced
-- in the API layer's request validation (defense in depth: a direct psql
-- session or a future integration that bypasses the API is still protected).
CREATE OR REPLACE FUNCTION validate_court_date() RETURNS trigger AS $$
DECLARE
    v_offense_date DATE;
BEGIN
    IF NEW.court_date IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT offense_date INTO v_offense_date
      FROM e_citations
     WHERE id = NEW.citation_id;

    IF v_offense_date IS NULL THEN
        RAISE EXCEPTION 'court_ledger.citation_id % does not reference an existing citation', NEW.citation_id;
    END IF;

    IF NEW.court_date < v_offense_date THEN
        RAISE EXCEPTION 'court_date (%) cannot be earlier than the citation offense_date (%)',
            NEW.court_date, v_offense_date;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Computes the T.C.A. § 55-10-207(g) 3-day statutory court-filing deadline
-- from the citation's actual device-authored timestamp (not server receipt
-- time), so a citation issued offline gets the correct clock start.
CREATE OR REPLACE FUNCTION set_citation_filing_deadline() RETURNS trigger AS $$
BEGIN
    NEW.court_filing_deadline := NEW.device_created_at + INTERVAL '3 days';
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Convenience wrappers around pgcrypto for symmetric SSN encryption. The
-- encryption key itself is NEVER stored in the database -- it must come from
-- the application's secrets manager / KMS and be passed in at call time,
-- e.g.:
--   INSERT INTO master_persons (..., ssn_encrypted)
--   VALUES (..., encrypt_ssn('123-45-6789', :app_supplied_key));
--
--   SELECT decrypt_ssn(ssn_encrypted, :app_supplied_key) FROM master_persons WHERE id = :id;
--
-- pgp_sym_encrypt output includes a random session key/IV per call, so the
-- same plaintext SSN encrypts to different ciphertext every time. This is a
-- deliberate security property (ciphertext doesn't leak equality/frequency
-- information) but means ssn_encrypted CANNOT be used in an equality lookup
-- or a uniqueness constraint -- deduplicate people via drivers_license_num,
-- not SSN.
CREATE OR REPLACE FUNCTION encrypt_ssn(plain_ssn TEXT, encryption_key TEXT) RETURNS BYTEA AS $$
    SELECT pgp_sym_encrypt(plain_ssn, encryption_key, 'cipher-algo=aes256, compress-algo=1');
$$ LANGUAGE sql STRICT;

CREATE OR REPLACE FUNCTION decrypt_ssn(cipher_ssn BYTEA, encryption_key TEXT) RETURNS TEXT AS $$
    SELECT pgp_sym_decrypt(cipher_ssn, encryption_key);
$$ LANGUAGE sql STRICT;

-- =============================================================================
-- SECTION 4: SEQUENTIAL NUMBER GENERATORS (case_number / citation_number)
-- =============================================================================
-- Deliberately NOT wired in as column DEFAULTs. In the field, both case
-- numbers and citation numbers are frequently pre-assigned to an officer's
-- device/citation book *before* the device ever has connectivity (this is
-- the whole point of a paper-carbonless or pre-loaded electronic citation
-- book: the number exists independent of the server). Forcing a DEFAULT
-- nextval() would require a live DB round-trip at authoring time, defeating
-- offline support. Instead these sequences/functions are available for the
-- application to call explicitly when it IS online and needs the platform
-- to mint a number (e.g. a desk-reported incident with no pre-assigned
-- number), while an offline-originated record simply supplies its own
-- pre-assigned number, and the table's UNIQUE constraint is the real
-- integrity guarantee either way.

CREATE SEQUENCE IF NOT EXISTS case_number_seq AS BIGINT START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS citation_number_seq AS BIGINT START WITH 1 INCREMENT BY 1;

CREATE OR REPLACE FUNCTION generate_case_number() RETURNS TEXT AS $$
    SELECT 'GPD-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('case_number_seq')::text, 7, '0');
$$ LANGUAGE sql VOLATILE;

CREATE OR REPLACE FUNCTION generate_citation_number() RETURNS TEXT AS $$
    SELECT 'GPD-C-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('citation_number_seq')::text, 7, '0');
$$ LANGUAGE sql VOLATILE;

-- =============================================================================
-- SECTION 5: MASTER TABLES
-- =============================================================================

-- --------------------------------------------------------------------------
-- users -- sworn officers, supervisors, court clerks, and system admins.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username        CITEXT NOT NULL,
    password_hash   TEXT NOT NULL,
    role            user_role NOT NULL,
    badge_number    TEXT NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_users_username CHECK (length(username) > 0),
    CONSTRAINT uq_users_badge_number_not_blank CHECK (length(badge_number) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_username ON users (username);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_badge_number ON users (badge_number);
CREATE INDEX IF NOT EXISTS ix_users_role ON users (role);
-- Partial index: the overwhelming majority of lookups are "find an active
-- user by role" (e.g. assigning an on-duty supervisor); indexing only
-- is_active = TRUE keeps this index small even as deactivated accounts pile up.
CREATE INDEX IF NOT EXISTS ix_users_active_role ON users (role) WHERE is_active;

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------------------------
-- master_persons -- deduplicated person records (violators, victims,
-- witnesses, etc.) shared across incidents and citations.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS master_persons (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    first_name              TEXT NOT NULL,
    last_name               TEXT NOT NULL,
    dob                     DATE,
    -- Encrypted at rest via pgcrypto (see encrypt_ssn/decrypt_ssn above).
    -- Nullable: SSN is not collected for every stop/contact.
    ssn_encrypted           BYTEA,
    drivers_license_num     CITEXT,
    dl_state                CHAR(2),
    dl_class                TEXT,
    is_cdl                  BOOLEAN NOT NULL DEFAULT FALSE,
    phone                   TEXT,
    address                 TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_persons_first_name_not_blank CHECK (length(btrim(first_name)) > 0),
    CONSTRAINT ck_persons_last_name_not_blank CHECK (length(btrim(last_name)) > 0),
    CONSTRAINT ck_persons_dob_plausible CHECK (dob IS NULL OR (dob <= CURRENT_DATE AND dob >= DATE '1900-01-01')),
    CONSTRAINT ck_persons_dl_state_format CHECK (dl_state IS NULL OR dl_state ~ '^[A-Z]{2}$')
);

-- last_name (paired with first_name) is the single most common person-search
-- pattern in an RMS ("Doe, John" style lookup at the front desk / in the field).
CREATE INDEX IF NOT EXISTS ix_persons_last_first_name ON master_persons (last_name, first_name);

-- A driver's license number is only unique within its issuing state, so the
-- uniqueness constraint (and the fast-lookup index the app actually queries
-- against) must be composite. Partial (WHERE ... IS NOT NULL) because not
-- every person contact captures a DL (pedestrians, minors, witnesses).
CREATE UNIQUE INDEX IF NOT EXISTS uq_persons_dl_number_state
    ON master_persons (drivers_license_num, dl_state)
    WHERE drivers_license_num IS NOT NULL AND dl_state IS NOT NULL;

DROP TRIGGER IF EXISTS trg_persons_updated_at ON master_persons;
CREATE TRIGGER trg_persons_updated_at
    BEFORE UPDATE ON master_persons
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------------------------
-- master_vehicles -- deduplicated vehicle records referenced by citations.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS master_vehicles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vin             CITEXT,
    plate_number    CITEXT NOT NULL,
    plate_state     CHAR(2) NOT NULL,
    make            TEXT NOT NULL,
    model           TEXT NOT NULL,
    year            SMALLINT,
    color           TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_vehicles_vin_format CHECK (vin IS NULL OR length(vin) = 17),
    CONSTRAINT ck_vehicles_plate_state_format CHECK (plate_state ~ '^[A-Z]{2}$'),
    CONSTRAINT ck_vehicles_year_plausible
        CHECK (year IS NULL OR (year BETWEEN 1900 AND (EXTRACT(YEAR FROM now())::INT + 1)))
);

-- VINs are globally unique when present; not every citation captures one
-- (officers frequently record only plate + description roadside), so this
-- is a partial unique index rather than a blanket NOT NULL UNIQUE.
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicles_vin ON master_vehicles (vin) WHERE vin IS NOT NULL;

-- Deliberately NOT unique: plates are reissued to different owners/vehicles
-- over time by the state, so (plate_number, plate_state) can legitimately
-- repeat across master_vehicles rows created years apart. This index exists
-- purely for lookup speed.
CREATE INDEX IF NOT EXISTS ix_vehicles_plate_number_state ON master_vehicles (plate_number, plate_state);

DROP TRIGGER IF EXISTS trg_vehicles_updated_at ON master_vehicles;
CREATE TRIGGER trg_vehicles_updated_at
    BEFORE UPDATE ON master_vehicles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- SECTION 6: OPERATIONS MODULES
-- =============================================================================

-- --------------------------------------------------------------------------
-- incidents
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incidents (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_number             CITEXT NOT NULL,
    reporting_officer_id    UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    occurrence_date         TIMESTAMPTZ NOT NULL,
    location_address        TEXT NOT NULL,
    status                  incident_status NOT NULL DEFAULT 'Open',

    -- Offline-sync bookkeeping (see sync_state type above).
    device_created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    synced_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    sync_status             sync_state NOT NULL DEFAULT 'synced',

    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_incidents_case_number_not_blank CHECK (length(btrim(case_number)) > 0),
    CONSTRAINT ck_incidents_location_not_blank CHECK (length(btrim(location_address)) > 0),
    CONSTRAINT ck_incidents_occurrence_not_future CHECK (occurrence_date <= now() + INTERVAL '15 minutes')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_incidents_case_number ON incidents (case_number);
CREATE INDEX IF NOT EXISTS ix_incidents_reporting_officer ON incidents (reporting_officer_id);
CREATE INDEX IF NOT EXISTS ix_incidents_occurrence_date ON incidents (occurrence_date);
CREATE INDEX IF NOT EXISTS ix_incidents_status ON incidents (status);

DROP TRIGGER IF EXISTS trg_incidents_updated_at ON incidents;
CREATE TRIGGER trg_incidents_updated_at
    BEFORE UPDATE ON incidents
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------------------------
-- incident_narratives -- append-only, versioned narrative history.
-- Corrections/additions are new rows, never edits to an existing one, so the
-- legal record of "what did the officer write, and when" can never be lost.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incident_narratives (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id         UUID NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
    author_id           UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    narrative_text      TEXT NOT NULL,
    version_number      INTEGER,

    -- Offline-sync bookkeeping.
    device_created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    synced_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    sync_status         sync_state NOT NULL DEFAULT 'synced',

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_narratives_text_not_blank CHECK (length(btrim(narrative_text)) > 0),
    CONSTRAINT ck_narratives_version_positive CHECK (version_number IS NULL OR version_number > 0)
);

-- NOTE on concurrency: assign_narrative_version() computes MAX(version_number)+1
-- under the current transaction. Two concurrent authors racing on the same
-- incident_id can still both compute the same next version number under
-- READ COMMITTED unless you also take an explicit lock, e.g. have the
-- application `SELECT ... FOR UPDATE` a sentinel row (or advisory lock keyed
-- on incident_id) before inserting. In practice narrative authorship is
-- almost always single-officer/single-session, so this is flagged as an
-- operational note rather than solved with SERIALIZABLE isolation here.
DROP TRIGGER IF EXISTS trg_narratives_assign_version ON incident_narratives;
CREATE TRIGGER trg_narratives_assign_version
    BEFORE INSERT ON incident_narratives
    FOR EACH ROW EXECUTE FUNCTION assign_narrative_version();

DROP TRIGGER IF EXISTS trg_narratives_immutable_update ON incident_narratives;
CREATE TRIGGER trg_narratives_immutable_update
    BEFORE UPDATE ON incident_narratives
    FOR EACH ROW EXECUTE FUNCTION prevent_modification();

DROP TRIGGER IF EXISTS trg_narratives_immutable_delete ON incident_narratives;
CREATE TRIGGER trg_narratives_immutable_delete
    BEFORE DELETE ON incident_narratives
    FOR EACH ROW EXECUTE FUNCTION prevent_modification();

CREATE UNIQUE INDEX IF NOT EXISTS uq_narratives_incident_version ON incident_narratives (incident_id, version_number);
CREATE INDEX IF NOT EXISTS ix_narratives_incident_id ON incident_narratives (incident_id);
CREATE INDEX IF NOT EXISTS ix_narratives_author_id ON incident_narratives (author_id);

-- --------------------------------------------------------------------------
-- e_citations -- T.C.A. Title 55 traffic citations.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS e_citations (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    citation_number             CITEXT NOT NULL,
    violator_id                 UUID NOT NULL REFERENCES master_persons (id) ON DELETE RESTRICT,
    vehicle_id                  UUID NOT NULL REFERENCES master_vehicles (id) ON DELETE RESTRICT,
    officer_id                  UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    offense_date                TIMESTAMPTZ NOT NULL,
    location                    TEXT NOT NULL,
    offense_description         TEXT NOT NULL,
    tca_code                    TEXT NOT NULL,

    -- T.C.A. § 55-10-207(i) mandated indicator flags. NOT NULL with no
    -- DEFAULT deliberately: the officer must explicitly record true/false for
    -- each -- a silently-defaulted FALSE on a hazmat/CMV/passenger-capacity
    -- flag is a compliance and safety defect, not a convenience.
    is_cmv                      BOOLEAN NOT NULL,
    is_hazmat                   BOOLEAN NOT NULL,
    passenger_capacity_16plus   BOOLEAN NOT NULL,

    -- Offline-sync bookkeeping: device_created_at is the moment the officer
    -- actually authored/issued the citation (possibly offline), which is
    -- what the statutory 3-day court-filing clock must run from.
    device_created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    synced_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
    sync_status                 sync_state NOT NULL DEFAULT 'synced',

    -- T.C.A. § 55-10-207(g): citation data must be transmitted to the court
    -- of jurisdiction within 3 days of issuance. Computed at the data layer
    -- (via trg_citations_set_filing_deadline below) so the deadline can
    -- never drift from device_created_at, regardless of which application
    -- or report touches this row.
    --
    -- NOT a GENERATED ALWAYS column: PostgreSQL requires generated-column
    -- expressions to be IMMUTABLE, but timestamptz + interval is only
    -- STABLE (the real-world length of "3 days" depends on the session
    -- timezone's DST rules), so it is computed by trigger instead.
    court_filing_deadline       TIMESTAMPTZ NOT NULL DEFAULT now(),

    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_citations_number_not_blank CHECK (length(btrim(citation_number)) > 0),
    CONSTRAINT ck_citations_location_not_blank CHECK (length(btrim(location)) > 0),
    CONSTRAINT ck_citations_offense_desc_not_blank CHECK (length(btrim(offense_description)) > 0),
    CONSTRAINT ck_citations_tca_code_not_blank CHECK (length(btrim(tca_code)) > 0),
    CONSTRAINT ck_citations_offense_not_future CHECK (offense_date <= now() + INTERVAL '15 minutes')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_citations_citation_number ON e_citations (citation_number);
CREATE INDEX IF NOT EXISTS ix_citations_violator_id ON e_citations (violator_id);
CREATE INDEX IF NOT EXISTS ix_citations_vehicle_id ON e_citations (vehicle_id);
CREATE INDEX IF NOT EXISTS ix_citations_officer_id ON e_citations (officer_id);
CREATE INDEX IF NOT EXISTS ix_citations_offense_date ON e_citations (offense_date);
CREATE INDEX IF NOT EXISTS ix_citations_tca_code ON e_citations (tca_code);
-- Powers the "citations at risk of missing their statutory filing deadline"
-- operational dashboard.
CREATE INDEX IF NOT EXISTS ix_citations_court_filing_deadline ON e_citations (court_filing_deadline);

DROP TRIGGER IF EXISTS trg_citations_updated_at ON e_citations;
CREATE TRIGGER trg_citations_updated_at
    BEFORE UPDATE ON e_citations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_citations_set_filing_deadline ON e_citations;
CREATE TRIGGER trg_citations_set_filing_deadline
    BEFORE INSERT ON e_citations
    FOR EACH ROW EXECUTE FUNCTION set_citation_filing_deadline();

-- =============================================================================
-- SECTION 7: INTERNAL COURT LEDGER
-- =============================================================================
-- Modeled as its own table (rather than columns bolted onto e_citations) so
-- that:
--   1. Every citation row doesn't carry a wide block of nullable
--      court-only columns before a disposition exists (3NF).
--   2. Write access can be scoped to this table alone (see Section 8's RLS
--      policy) so a Court_Clerk-only write restriction is a table-level
--      concern, matching the same boundary enforced in the API layer.
--   3. disposition history stays cleanly separated from the officer-authored
--      citation facts it is adjudicating.
CREATE TABLE IF NOT EXISTS court_ledger (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    citation_id             UUID NOT NULL UNIQUE REFERENCES e_citations (id) ON DELETE CASCADE,

    court_date              DATE,
    court_status            court_disposition_status NOT NULL DEFAULT 'Pending',
    fine_amount_due         currency_amount,
    amount_paid             currency_amount NOT NULL DEFAULT 0,
    payment_date            DATE,
    disposition_notes       TEXT,

    last_updated_by_user_id UUID REFERENCES users (id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_ledger_paid_not_over_due
        CHECK (fine_amount_due IS NULL OR amount_paid <= fine_amount_due),
    CONSTRAINT ck_ledger_payment_date_requires_payment
        CHECK (payment_date IS NULL OR amount_paid > 0)
);

CREATE INDEX IF NOT EXISTS ix_ledger_court_status ON court_ledger (court_status);
CREATE INDEX IF NOT EXISTS ix_ledger_court_date ON court_ledger (court_date);

DROP TRIGGER IF EXISTS trg_ledger_updated_at ON court_ledger;
CREATE TRIGGER trg_ledger_updated_at
    BEFORE UPDATE ON court_ledger
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_ledger_validate_court_date ON court_ledger;
CREATE TRIGGER trg_ledger_validate_court_date
    BEFORE INSERT OR UPDATE ON court_ledger
    FOR EACH ROW EXECUTE FUNCTION validate_court_date();

-- =============================================================================
-- SECTION 8: ABSOLUTE SECURITY LOGGING -- audit_logs
-- =============================================================================
-- Append-only by trigger (same guarantee as incident_narratives). No FK
-- cascade to users: if a user account is ever removed, its historical audit
-- rows must survive with user_id set to NULL rather than disappearing --
-- losing "who did this" from the audit trail defeats its entire purpose.
CREATE TABLE IF NOT EXISTS audit_logs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID REFERENCES users (id) ON DELETE SET NULL,
    action_type         audit_action_type NOT NULL,
    target_table        TEXT,
    target_record_id    UUID,
    ip_address          INET NOT NULL,
    user_agent          TEXT,
    "timestamp"         TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_audit_immutable_update ON audit_logs;
CREATE TRIGGER trg_audit_immutable_update
    BEFORE UPDATE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION prevent_modification();

DROP TRIGGER IF EXISTS trg_audit_immutable_delete ON audit_logs;
CREATE TRIGGER trg_audit_immutable_delete
    BEFORE DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION prevent_modification();

CREATE INDEX IF NOT EXISTS ix_audit_user_id ON audit_logs (user_id);
CREATE INDEX IF NOT EXISTS ix_audit_target ON audit_logs (target_table, target_record_id);
-- BRIN, not BTREE: audit_logs is an append-only, insertion-ordered table that
-- will grow far faster than any other table in this schema. "timestamp"
-- values are naturally correlated with physical row order, which is exactly
-- what makes a BRIN index effective -- a fraction of the storage cost of a
-- BTREE for the same range-scan queries ("everything in the last 24 hours").
CREATE INDEX IF NOT EXISTS ix_audit_timestamp_brin ON audit_logs USING BRIN ("timestamp");

-- =============================================================================
-- SECTION 9: DEFENSE-IN-DEPTH ACCESS CONTROL (Row-Level Security)
-- =============================================================================
-- The API layer already enforces RBAC via verified JWT claims (see the
-- application's require_roles() dependency). This section adds a SECOND,
-- independent layer directly in the database for the two highest-sensitivity
-- write paths in this schema, so a bug in application code, a compromised
-- application credential, or an ad hoc psql session under the same DB role
-- still cannot bypass them.
--
-- Integration contract: at the start of every request/transaction, the
-- application must run:
--     SET LOCAL app.actor_role = '<Patrol_Officer|Supervisor|Court_Clerk|System_Admin>';
-- using the role verified from the request's JWT. SET LOCAL scopes the
-- setting to the current transaction, which is exactly the boundary a
-- connection pooler running in transaction-pooling mode (e.g. PgBouncer)
-- also uses -- so this pattern is safe under transaction pooling.
--
-- Fails closed by construction: current_setting(..., true) returns NULL if
-- the application never sets it (e.g. a raw psql session), and NULL = 'X'
-- evaluates to NULL/false in a policy check, denying the write rather than
-- defaulting it open.
CREATE OR REPLACE FUNCTION current_app_role() RETURNS TEXT AS $$
    SELECT current_setting('app.actor_role', true);
$$ LANGUAGE sql STABLE;

-- --- users: only System_Admin may create or modify accounts. ---
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_select_all ON users;
CREATE POLICY users_select_all ON users
    FOR SELECT USING (true);

DROP POLICY IF EXISTS users_write_admin_only ON users;
CREATE POLICY users_write_admin_only ON users
    FOR INSERT WITH CHECK (current_app_role() = 'System_Admin');

DROP POLICY IF EXISTS users_update_admin_only ON users;
CREATE POLICY users_update_admin_only ON users
    FOR UPDATE USING (current_app_role() = 'System_Admin')
    WITH CHECK (current_app_role() = 'System_Admin');

-- --- court_ledger: only Court_Clerk may create or modify dispositions. ---
ALTER TABLE court_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE court_ledger FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ledger_select_all ON court_ledger;
CREATE POLICY ledger_select_all ON court_ledger
    FOR SELECT USING (true);

DROP POLICY IF EXISTS ledger_write_clerk_only ON court_ledger;
CREATE POLICY ledger_write_clerk_only ON court_ledger
    FOR INSERT WITH CHECK (current_app_role() = 'Court_Clerk');

DROP POLICY IF EXISTS ledger_update_clerk_only ON court_ledger;
CREATE POLICY ledger_update_clerk_only ON court_ledger
    FOR UPDATE USING (current_app_role() = 'Court_Clerk')
    WITH CHECK (current_app_role() = 'Court_Clerk');

-- NOTE: table owners bypass RLS by default unless FORCE ROW LEVEL SECURITY is
-- set (done above for both tables). Ensure the application's connection role
-- is NOT the table owner/superuser in production, or FORCE has no effect.
--
-- NOTE on observed behavior: an UPDATE blocked by policy does not raise an
-- error -- the policy's USING clause simply filters the target row out of
-- the update, so the statement reports "UPDATE 0" and the row is left
-- unchanged. This is standard PostgreSQL RLS behavior, not a bug. The
-- application should treat an unexpected 0-rows-affected result on a
-- role-gated write as the same authorization failure its own RBAC layer
-- would have raised, and should already be rejecting the request before it
-- ever reaches the database (this layer is a backstop, not the primary
-- signal path).

COMMIT;

-- =============================================================================
-- End of 001_init_schema.sql
-- =============================================================================

-- ================= 002_add_tca_citation_fields.sql =================
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

-- ================= 003_add_login_success_audit_type.sql =================
-- =============================================================================
-- Adds LOGIN_SUCCESS to audit_action_type.
--
-- Gap found during a live end-to-end test run: audit_logs.action_type only
-- had READ / WRITE / DELETE / LOGIN_FAIL (exactly the four values originally
-- specified), so a *successful* login wrote no audit row at all -- the audit
-- trail could show every failed login attempt but not a single successful
-- one, which is backwards for a security-relevant log on a system handling
-- active court/citation data. src/controllers/auth.controller.js now writes
-- a LOGIN_SUCCESS row (user_id, ip, user_agent) immediately before issuing
-- the JWT, using the same fail-open-but-loudly-logged pattern as the
-- existing writeLoginFailAudit().
--
-- ALTER TYPE ... ADD VALUE cannot run inside the same transaction as a
-- statement that uses the new value, but is safe as its own top-level
-- statement (Postgres 12+), which is how this migration is written and how
-- every other migration in this project is applied (one file, run alone).
-- =============================================================================

ALTER TYPE audit_action_type ADD VALUE IF NOT EXISTS 'LOGIN_SUCCESS';

-- ================= neon_web_editor_setup.sql (role + admin seed) =================
-- =============================================================================
-- Run this in Neon's own web SQL Editor (console.neon.tech -> Gates_PD_RMS ->
-- SQL Editor), AFTER running 001_init_schema.sql, 002_add_tca_citation_fields.sql,
-- and 003_add_login_success_audit_type.sql in that same editor, in that order.
--
-- This is a plain-SQL version of provision_app_role.sql + a first admin seed,
-- rewritten because Neon's web SQL editor executes plain SQL only -- it does
-- not understand psql's own scripting syntax (\gexec, \if, :variables), which
-- the command-line version of this step relies on.
--
-- Password already generated for you: ly0vCFICyy5GF09W5UOAdWzy
-- (already written into your local .env's DATABASE_URL -- you don't need to
-- type it anywhere else)
-- =============================================================================

-- 1. Restricted application role (NOT the neondb_owner you're connected as).
--    Required for the users/court_ledger FORCE ROW LEVEL SECURITY policies
--    from 001_init_schema.sql to actually do anything -- they have no effect
--    on a table's owner (neondb_owner), only on a non-owner role like this one.
CREATE ROLE gates_app_user LOGIN PASSWORD 'ly0vCFICyy5GF09W5UOAdWzy';

GRANT CONNECT ON DATABASE neondb TO gates_app_user;
GRANT USAGE ON SCHEMA public TO gates_app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gates_app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gates_app_user;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gates_app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO gates_app_user;

-- 2. Seed the first System_Admin account. Bootstraps the same way
--    scripts/seed-admin.js does: FORCE ROW LEVEL SECURITY on `users` checks
--    the session GUC app.actor_role, not who is connected, so setting it to
--    'System_Admin' for this one transaction is enough to insert the first
--    row -- no superuser needed.
--
--    Login: username "demo_admin", password "DemoAdmin_Neon2026!"
--    (password_hash below is that password's real bcrypt hash, generated
--    just now -- not a placeholder.)
BEGIN;
SELECT set_config('app.actor_role', 'System_Admin', true);
INSERT INTO users (username, password_hash, role, badge_number, full_name, agency, is_active)
VALUES (
  'demo_admin',
  '$2b$12$zFOiYNGixaOQTKECJlCOm.vV4Drm7Z3LBPRgVkboUZzGg7LfHuDmq',
  'System_Admin',
  'A-100',
  'Demo Admin',
  'Gates Police Department',
  true
)
RETURNING id, username, role;
COMMIT;
