-- =============================================================================
-- Gates Police Department -- RMS & Court Clerk Ledger Platform
-- Migration: 011_add_court_case_management.sql
-- Depends on: 001_init_schema.sql .. 010_add_speed_detection_method.sql
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- The Court Clerk section of this platform was, until now, just court_ledger
-- (one disposition/fine/paid row per citation). The Chief asked for a real
-- municipal court case-management layer covering five things:
--   1. Citation/case management: defendants, charges, case notes, and final
--      dispositions, intake to closure -- and NOT traffic-only: Gates
--      Municipal Court also hears city ordinance violations, which have no
--      e_citations row at all (no T.C.A. code, no vehicle, often no
--      officer-issued citation). That means the case record has to be a
--      layer ABOVE e_citations, not just more columns bolted onto it.
--   2. Scheduling/calendaring: dockets, judges, judge availability.
--   3. Financial processing: an itemized, append-only payment ledger (fines/
--      fees/bonds) with fund-category allocation for end-of-month
--      distribution reporting.
--   4. Document automation: FTA notices and warrant tracking (the actual
--      documents are printable views built from this data, same pattern as
--      the citation ticket -- a judge/clerk still has to sign a real warrant
--      in person; this system prepares the paperwork, it does not
--      autonomously issue legal process).
--   5. State/local reporting: a monthly summary is built as a general,
--      exportable report (case counts, dispositions, fines assessed/
--      collected) since no specific state file format was supplied -- adapt
--      the query/export to a specific schema later if the state requires one.
--
-- SCOPE DELIBERATELY NOT INCLUDED HERE (flag to the user, don't fabricate):
--   * No live online payment gateway (Stripe/Square/etc.) -- court_payments
--     records a payment however it actually came in (cash/check/card/etc.);
--     wiring a real "pay your citation online" flow is a separate piece of
--     work once a processor is chosen and its API keys are available.
--   * No live email/SMS sending for reminders -- court_reminders is a
--     scheduling/queue table only. Its rows start life as 'Not_Configured'
--     specifically so nobody mistakes an unset provider for reminders that
--     were actually delivered.
--   * court_ledger (per-citation disposition/fine/paid) is UNCHANGED and
--     still works exactly as before -- it is not migrated into
--     court_payments/case_charges in this pass. Every citation gets a
--     linked court_cases row (backfilled below) so it also shows up in the
--     new Cases screens, but reconciling court_ledger.amount_paid against
--     the new court_payments ledger is a follow-up, not attempted here.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. New ENUM types
-- ---------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE case_type AS ENUM ('Traffic_Citation', 'Ordinance_Violation', 'Other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE case_status AS ENUM ('Open', 'Closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE charge_category AS ENUM ('TCA_Traffic', 'Municipal_Ordinance', 'Other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE plea_type AS ENUM ('Not_Entered', 'Guilty', 'Not_Guilty', 'No_Contest');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE docket_type AS ENUM ('Traffic', 'Ordinance', 'General_Sessions', 'Other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE docket_status AS ENUM ('Scheduled', 'In_Session', 'Completed', 'Cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE appearance_status AS ENUM ('Scheduled', 'Appeared', 'FTA', 'Continued', 'Removed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE court_payment_method AS ENUM ('Cash', 'Check', 'Money_Order', 'Card_In_Person', 'Card_Online', 'Other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE court_payment_type AS ENUM ('Fine', 'Court_Cost', 'Bond', 'Other_Fee');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE reminder_type AS ENUM ('Court_Date', 'FTA_Warning');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE reminder_channel AS ENUM ('Email', 'SMS', 'None');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    -- 'Not_Configured' (not 'Pending') is the default further down -- see the
    -- scope note above on why that default matters.
    CREATE TYPE reminder_status AS ENUM ('Pending', 'Sent', 'Cancelled', 'Failed', 'Not_Configured');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE warrant_type AS ENUM ('Capias', 'Bench_Warrant');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE warrant_status AS ENUM ('Issued', 'Recalled', 'Served');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A charge/case can be continued to a later docket without that being a
-- final disposition -- extends the existing court_disposition_status enum
-- (used both by court_ledger.court_status and case_charges.disposition
-- below) rather than inventing a parallel type. IF NOT EXISTS already makes
-- this idempotent on its own -- deliberately NOT wrapped in a DO block:
-- ALTER TYPE ... ADD VALUE cannot run inside a PL/pgSQL block (it executes
-- via an implicit subtransaction there, which this command disallows even
-- on PostgreSQL 12+); it only works as a bare statement in the enclosing
-- transaction, which is what this migration already is. Safe here because
-- nothing in THIS migration inserts a row using the new value (PostgreSQL
-- forbids using a brand-new enum value in the same transaction that added
-- it, but declaring columns of the enum's TYPE, as case_charges does below,
-- is not "using the value" and is unaffected).
ALTER TYPE court_disposition_status ADD VALUE IF NOT EXISTS 'Continued';

-- ---------------------------------------------------------------------------
-- 2. Case numbering for cases NOT derived from an existing citation
--    (ordinance violations, "other"). A traffic-citation-origin case simply
--    reuses e_citations.citation_number as its case_number (see backfill
--    below) -- one fewer number for a clerk to reconcile.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS court_case_number_seq AS BIGINT START WITH 1 INCREMENT BY 1;

CREATE OR REPLACE FUNCTION generate_court_case_number() RETURNS TEXT AS $$
    SELECT 'GMC-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('court_case_number_seq')::text, 7, '0');
$$ LANGUAGE sql VOLATILE;

CREATE SEQUENCE IF NOT EXISTS receipt_number_seq AS BIGINT START WITH 1 INCREMENT BY 1;

CREATE OR REPLACE FUNCTION generate_receipt_number() RETURNS TEXT AS $$
    SELECT 'RCT-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('receipt_number_seq')::text, 7, '0');
$$ LANGUAGE sql VOLATILE;

-- ---------------------------------------------------------------------------
-- 3. court_cases -- the case record itself. citation_id is populated when
--    (and only when) the case originated from an officer-issued e-citation;
--    an ordinance-violation or "other" case has no citation at all.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS court_cases (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_number     CITEXT NOT NULL,
    case_type       case_type NOT NULL,
    citation_id     UUID REFERENCES e_citations (id) ON DELETE RESTRICT,
    defendant_id    UUID NOT NULL REFERENCES master_persons (id) ON DELETE RESTRICT,
    filed_by_id     UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    case_status     case_status NOT NULL DEFAULT 'Open',
    opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at       TIMESTAMPTZ,
    -- Short intake summary (e.g. "junk vehicle complaint, 3rd notice"), NOT
    -- the legal record -- case_notes below is the append-only log for that.
    intake_summary  TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_cases_case_number_not_blank CHECK (length(btrim(case_number)) > 0),
    CONSTRAINT ck_cases_citation_requires_traffic_type
        CHECK (citation_id IS NULL OR case_type = 'Traffic_Citation'),
    CONSTRAINT ck_cases_closed_at_matches_status
        CHECK ((case_status = 'Closed') = (closed_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cases_case_number ON court_cases (case_number);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cases_citation_id ON court_cases (citation_id) WHERE citation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_cases_defendant_id ON court_cases (defendant_id);
CREATE INDEX IF NOT EXISTS ix_cases_status ON court_cases (case_status);
CREATE INDEX IF NOT EXISTS ix_cases_case_type ON court_cases (case_type);
CREATE INDEX IF NOT EXISTS ix_cases_opened_at ON court_cases (opened_at);

DROP TRIGGER IF EXISTS trg_cases_updated_at ON court_cases;
CREATE TRIGGER trg_cases_updated_at
    BEFORE UPDATE ON court_cases
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. case_charges -- one or more chargeable counts per case. A traffic case
--    gets exactly one charge row backfilled/auto-created from the citation's
--    tca_code/offense_description; additional charges (or every charge, for
--    an ordinance case) are added directly against this table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS case_charges (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id             UUID NOT NULL REFERENCES court_cases (id) ON DELETE CASCADE,
    count_number        SMALLINT NOT NULL DEFAULT 1,
    charge_category     charge_category NOT NULL,
    charge_code         TEXT NOT NULL,
    charge_description  TEXT NOT NULL,
    plea                plea_type NOT NULL DEFAULT 'Not_Entered',
    disposition         court_disposition_status NOT NULL DEFAULT 'Pending',
    fine_amount         currency_amount,
    court_costs         currency_amount,
    disposed_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_charges_code_not_blank CHECK (length(btrim(charge_code)) > 0),
    CONSTRAINT ck_charges_desc_not_blank CHECK (length(btrim(charge_description)) > 0),
    CONSTRAINT ck_charges_count_positive CHECK (count_number > 0),
    CONSTRAINT uq_charges_case_count UNIQUE (case_id, count_number)
);

CREATE INDEX IF NOT EXISTS ix_charges_case_id ON case_charges (case_id);
CREATE INDEX IF NOT EXISTS ix_charges_disposition ON case_charges (disposition);

DROP TRIGGER IF EXISTS trg_charges_updated_at ON case_charges;
CREATE TRIGGER trg_charges_updated_at
    BEFORE UPDATE ON case_charges
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 5. case_notes -- append-only clerk log, same legal-record pattern as
--    incident_narratives (INSERT-only; UPDATE/DELETE blocked at the DB level).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS case_notes (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id     UUID NOT NULL REFERENCES court_cases (id) ON DELETE CASCADE,
    author_id   UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    note_text   TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_case_notes_text_not_blank CHECK (length(btrim(note_text)) > 0)
);

CREATE INDEX IF NOT EXISTS ix_case_notes_case_id ON case_notes (case_id);

DROP TRIGGER IF EXISTS trg_case_notes_immutable_update ON case_notes;
CREATE TRIGGER trg_case_notes_immutable_update
    BEFORE UPDATE ON case_notes
    FOR EACH ROW EXECUTE FUNCTION prevent_modification();

DROP TRIGGER IF EXISTS trg_case_notes_immutable_delete ON case_notes;
CREATE TRIGGER trg_case_notes_immutable_delete
    BEFORE DELETE ON case_notes
    FOR EACH ROW EXECUTE FUNCTION prevent_modification();

-- ---------------------------------------------------------------------------
-- 6. court_judges -- a lightweight reference list, NOT user accounts. Judges
--    do not log into this system; dockets/warrants just need to name one.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS court_judges (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name   TEXT NOT NULL,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_judges_name_not_blank CHECK (length(btrim(full_name)) > 0)
);

DROP TRIGGER IF EXISTS trg_judges_updated_at ON court_judges;
CREATE TRIGGER trg_judges_updated_at
    BEFORE UPDATE ON court_judges
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 7. court_dockets -- a scheduled court session; docket_entries below links
--    cases onto it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS court_dockets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    docket_date     DATE NOT NULL,
    docket_time     TIME,
    judge_id        UUID REFERENCES court_judges (id) ON DELETE SET NULL,
    docket_type     docket_type NOT NULL DEFAULT 'Traffic',
    location        TEXT,
    docket_status   docket_status NOT NULL DEFAULT 'Scheduled',
    notes           TEXT,
    created_by_id   UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_dockets_date ON court_dockets (docket_date);
CREATE INDEX IF NOT EXISTS ix_dockets_judge ON court_dockets (judge_id);
CREATE INDEX IF NOT EXISTS ix_dockets_status ON court_dockets (docket_status);

DROP TRIGGER IF EXISTS trg_dockets_updated_at ON court_dockets;
CREATE TRIGGER trg_dockets_updated_at
    BEFORE UPDATE ON court_dockets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 8. docket_entries -- one case's appearance on one docket. A case can gain
--    a new entry on a later docket when continued (appearance_status on the
--    earlier entry becomes 'Continued', a fresh entry is added for the new
--    date) -- the history of every scheduled appearance stays intact rather
--    than being overwritten.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS docket_entries (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    docket_id           UUID NOT NULL REFERENCES court_dockets (id) ON DELETE CASCADE,
    case_id             UUID NOT NULL REFERENCES court_cases (id) ON DELETE CASCADE,
    sequence_number     INTEGER,
    appearance_status   appearance_status NOT NULL DEFAULT 'Scheduled',
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_docket_entries_docket_case UNIQUE (docket_id, case_id)
);

CREATE INDEX IF NOT EXISTS ix_docket_entries_docket ON docket_entries (docket_id);
CREATE INDEX IF NOT EXISTS ix_docket_entries_case ON docket_entries (case_id);
CREATE INDEX IF NOT EXISTS ix_docket_entries_status ON docket_entries (appearance_status);

DROP TRIGGER IF EXISTS trg_docket_entries_updated_at ON docket_entries;
CREATE TRIGGER trg_docket_entries_updated_at
    BEFORE UPDATE ON docket_entries
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 9. judge_unavailability -- exception-based, not a full slot calendar: a
--    judge is assumed available unless a date range here says otherwise.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS judge_unavailability (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    judge_id    UUID NOT NULL REFERENCES court_judges (id) ON DELETE CASCADE,
    start_date  DATE NOT NULL,
    end_date    DATE NOT NULL,
    reason      TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_unavailability_date_order CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS ix_judge_unavail_judge ON judge_unavailability (judge_id);
CREATE INDEX IF NOT EXISTS ix_judge_unavail_dates ON judge_unavailability (start_date, end_date);

-- ---------------------------------------------------------------------------
-- 10. fund_categories -- seeded starting set. Names/descriptions here are
--     illustrative starting points, NOT verified against Tennessee's actual
--     statutory litigation-tax/fee schedule -- confirm exact fund names and
--     required allocations with the department's finance office / the state
--     before relying on this for real remittance.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fund_categories (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    description TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_fund_categories_name ON fund_categories (name);

INSERT INTO fund_categories (name, description) VALUES
    ('City General Fund', 'Base municipal fine revenue.'),
    ('State Litigation Tax', 'State-mandated litigation tax collected on qualifying citations. Confirm the exact statutory rate and remittance categories with the department finance office before using this for state remittance.'),
    ('Court Technology Fund', 'Local court technology and administration fee.'),
    ('Victims Assistance Fund', 'Victims assistance surcharge, where applicable.')
ON CONFLICT (name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 11. court_payments -- itemized, append-only payment/receipt ledger. A
--     correction is a new offsetting row (voids_payment_id), never an edit
--     to history -- same legal-record principle as incident_narratives/
--     audit_logs. amount allows negative specifically so a void/reversal can
--     be recorded as a real, auditable entry rather than an UPDATE.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS court_payments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id             UUID NOT NULL REFERENCES court_cases (id) ON DELETE RESTRICT,
    charge_id           UUID REFERENCES case_charges (id) ON DELETE RESTRICT,
    amount              NUMERIC(10, 2) NOT NULL CHECK (amount <> 0),
    payment_method      court_payment_method NOT NULL,
    payment_type        court_payment_type NOT NULL,
    fund_category_id    UUID REFERENCES fund_categories (id) ON DELETE RESTRICT,
    received_by_id      UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    receipt_number      TEXT NOT NULL,
    voids_payment_id    UUID REFERENCES court_payments (id) ON DELETE RESTRICT,
    notes               TEXT,
    paid_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_receipt_number ON court_payments (receipt_number);
CREATE INDEX IF NOT EXISTS ix_payments_case_id ON court_payments (case_id);
CREATE INDEX IF NOT EXISTS ix_payments_paid_at ON court_payments (paid_at);
CREATE INDEX IF NOT EXISTS ix_payments_fund_category ON court_payments (fund_category_id);

DROP TRIGGER IF EXISTS trg_payments_immutable_update ON court_payments;
CREATE TRIGGER trg_payments_immutable_update
    BEFORE UPDATE ON court_payments
    FOR EACH ROW EXECUTE FUNCTION prevent_modification();

DROP TRIGGER IF EXISTS trg_payments_immutable_delete ON court_payments;
CREATE TRIGGER trg_payments_immutable_delete
    BEFORE DELETE ON court_payments
    FOR EACH ROW EXECUTE FUNCTION prevent_modification();

-- ---------------------------------------------------------------------------
-- 12. court_reminders -- scheduling/queue only (see scope note at top of
--     file). status defaults to 'Not_Configured', not 'Pending', so an
--     unwired provider can never be mistaken for reminders actually sent.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS court_reminders (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id             UUID NOT NULL REFERENCES court_cases (id) ON DELETE CASCADE,
    docket_entry_id     UUID REFERENCES docket_entries (id) ON DELETE CASCADE,
    reminder_type       reminder_type NOT NULL,
    channel             reminder_channel NOT NULL DEFAULT 'None',
    scheduled_send_at   TIMESTAMPTZ NOT NULL,
    status              reminder_status NOT NULL DEFAULT 'Not_Configured',
    sent_at             TIMESTAMPTZ,
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_reminders_case_id ON court_reminders (case_id);
CREATE INDEX IF NOT EXISTS ix_reminders_scheduled ON court_reminders (scheduled_send_at);
CREATE INDEX IF NOT EXISTS ix_reminders_status ON court_reminders (status);

-- ---------------------------------------------------------------------------
-- 13. court_warrants -- tracks that a warrant application was prepared/
--     issued for a case; the actual legal instrument still requires a real
--     judge's signature obtained outside this system.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS court_warrants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id         UUID NOT NULL REFERENCES court_cases (id) ON DELETE RESTRICT,
    judge_id        UUID REFERENCES court_judges (id) ON DELETE SET NULL,
    warrant_type    warrant_type NOT NULL,
    warrant_status  warrant_status NOT NULL DEFAULT 'Issued',
    issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    recalled_at     TIMESTAMPTZ,
    served_at       TIMESTAMPTZ,
    notes           TEXT,
    created_by_id   UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_warrants_case_id ON court_warrants (case_id);

DROP TRIGGER IF EXISTS trg_warrants_updated_at ON court_warrants;
CREATE TRIGGER trg_warrants_updated_at
    BEFORE UPDATE ON court_warrants
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 14. RLS: court_payments gets the same defense-in-depth write restriction
--     as court_ledger (Section 9 of 001_init_schema.sql) -- Court_Clerk or
--     System_Admin only. Everything else in this migration relies on the
--     API layer's requireRoles() guard alone, matching the existing
--     treatment of incidents/crashes/citations/evidence (no per-table RLS).
-- ---------------------------------------------------------------------------
ALTER TABLE court_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE court_payments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payments_select_all ON court_payments;
CREATE POLICY payments_select_all ON court_payments
    FOR SELECT USING (true);

DROP POLICY IF EXISTS payments_write_clerk_admin_only ON court_payments;
CREATE POLICY payments_write_clerk_admin_only ON court_payments
    FOR INSERT WITH CHECK (current_app_role() IN ('Court_Clerk', 'System_Admin'));

-- ---------------------------------------------------------------------------
-- 15. Backfill: every existing e_citations row gets a matching court_cases
--     row (case_number = citation_number, reusing the existing unique
--     number rather than minting a second one) plus its one primary charge,
--     so pre-existing citations show up correctly in the new Cases screens.
--     Idempotent: WHERE NOT EXISTS guards against re-running this migration.
-- ---------------------------------------------------------------------------
INSERT INTO court_cases (case_number, case_type, citation_id, defendant_id, filed_by_id, case_status, opened_at, closed_at)
SELECT
    c.citation_number,
    'Traffic_Citation'::case_type,
    c.id,
    c.violator_id,
    c.officer_id,
    (CASE WHEN cl.court_status IN ('Guilty', 'Not_Guilty', 'Dismissed') THEN 'Closed' ELSE 'Open' END)::case_status,
    c.created_at,
    CASE WHEN cl.court_status IN ('Guilty', 'Not_Guilty', 'Dismissed') THEN cl.updated_at ELSE NULL END
FROM e_citations c
LEFT JOIN court_ledger cl ON cl.citation_id = c.id
WHERE NOT EXISTS (SELECT 1 FROM court_cases cc WHERE cc.citation_id = c.id);

INSERT INTO case_charges (case_id, count_number, charge_category, charge_code, charge_description, disposition, fine_amount, disposed_at)
SELECT
    cc.id,
    1,
    'TCA_Traffic'::charge_category,
    c.tca_code,
    c.offense_description,
    COALESCE(cl.court_status, 'Pending'),
    cl.fine_amount_due,
    CASE WHEN cl.court_status IN ('Guilty', 'Not_Guilty', 'Dismissed') THEN cl.updated_at ELSE NULL END
FROM court_cases cc
JOIN e_citations c ON c.id = cc.citation_id
LEFT JOIN court_ledger cl ON cl.citation_id = c.id
WHERE NOT EXISTS (SELECT 1 FROM case_charges ch WHERE ch.case_id = cc.id);

COMMIT;
