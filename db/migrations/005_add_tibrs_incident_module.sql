-- =============================================================================
-- Gates Police Department -- RMS & Court Clerk Ledger Platform
-- Migration: 005_add_tibrs_incident_module.sql
-- Depends on: 001_init_schema.sql .. 004_add_citation_physical_description_and_gps.sql
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- The original `incidents` table (001_init_schema.sql) was a bare shell: a
-- case number, occurrence date, location string, and status. None of the
-- data TIBRS (Tennessee's NIBRS-based incident reporting system) actually
-- requires had anywhere to live:
--
--   - Up to 10 offenses per incident, coded against a real UCR/NIBRS
--     offense code list (Data Elements 6/7).
--   - Which persons were involved and in what role (victim / offender /
--     witness / reporting party), and the detailed victim-to-offender
--     relationship TIBRS requires when both exist (Data Element 34).
--   - Property loss/recovery: type of loss, category, description, value
--     (Data Elements 15-19).
--   - A specific, coded location type, not just a free-text address
--     (Data Element 9).
--
-- This migration adds all of it, plus a couple of fields
-- (exceptional_clearance / cleared_date) that TIBRS submissions are
-- routinely rejected for omitting, and lightweight bookkeeping
-- (tibrs_submitted_at / tibrs_submission_batch) so a monthly submission
-- run can mark which incidents it already covered.
--
-- Additive and idempotent; safe to run against a database with existing
-- incident rows.
-- =============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- Enumerations. Each mirrors a real, standard TIBRS/NIBRS code list rather
-- than free text, so nothing here can silently drift into a value that a
-- real TIBRS submission would reject. Lists are trimmed to the most common
-- values in each category (not the full ~50-entry official list in every
-- case) -- extend with an ALTER TYPE ... ADD VALUE migration if a
-- department needs a code that isn't here yet.
-- --------------------------------------------------------------------------

DO $$ BEGIN
    CREATE TYPE location_type AS ENUM (
        'Air_Bus_Train_Terminal',
        'Bank_Savings_Loan',
        'Bar_Nightclub',
        'Church_Synagogue_Temple_Mosque',
        'Commercial_Office_Building',
        'Construction_Site',
        'Convenience_Store',
        'Department_Discount_Store',
        'Drug_Store_Doctors_Office_Hospital',
        'Field_Woods',
        'Government_Public_Building',
        'Grocery_Supermarket',
        'Highway_Road_Alley_Street_Sidewalk',
        'Hotel_Motel',
        'Jail_Prison',
        'Lake_Waterway_Beach',
        'Liquor_Store',
        'Parking_Lot_Garage',
        'Park_Playground',
        'Rental_Storage_Facility',
        'Residence_Home',
        'Restaurant',
        'School_College',
        'Service_Gas_Station',
        'Shopping_Mall',
        'Specialty_Store',
        'Other',
        'Unknown'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE incident_person_role AS ENUM (
        'Victim',
        'Offender',
        'Witness',
        'Reporting_Party'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE injury_type AS ENUM (
        'None',
        'Apparent_Broken_Bones',
        'Possible_Internal_Injury',
        'Severe_Laceration',
        'Apparent_Minor_Injury',
        'Loss_of_Teeth',
        'Unconsciousness',
        'Other_Major_Injury'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- TIBRS Data Element 34. 'Victim_Was_Offender' and 'Relationship_Unknown'
-- are themselves valid TIBRS values, not error states.
DO $$ BEGIN
    CREATE TYPE victim_offender_relationship AS ENUM (
        'Spouse',
        'Common_Law_Spouse',
        'Ex_Spouse',
        'Parent',
        'Sibling',
        'Child',
        'Grandparent',
        'Grandchild',
        'In_Law',
        'Stepparent',
        'Stepchild',
        'Stepsibling',
        'Other_Family',
        'Boyfriend_Girlfriend',
        'Acquaintance',
        'Friend',
        'Neighbor',
        'Employee',
        'Employer',
        'Otherwise_Known',
        'Stranger',
        'Victim_Was_Offender',
        'Relationship_Unknown'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- TIBRS Data Element 14 (Type of Property Loss/Etc.).
DO $$ BEGIN
    CREATE TYPE property_loss_type AS ENUM (
        'None',
        'Stolen',
        'Burned',
        'Counterfeited_Forged',
        'Damaged_Destroyed_Vandalized',
        'Recovered',
        'Seized',
        'Other'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- TIBRS Data Element 15 (Property Description), trimmed to the most common
-- categories a municipal department actually files.
DO $$ BEGIN
    CREATE TYPE property_category AS ENUM (
        'Automobiles',
        'Other_Motor_Vehicles',
        'Bicycles',
        'Watercraft',
        'Firearms',
        'Household_Goods',
        'Jewelry_Precious_Metals',
        'Electronics_Computer_Equipment',
        'Office_Equipment',
        'Tools',
        'Clothes_Furs',
        'Money',
        'Negotiable_Instruments',
        'Credit_Debit_Cards',
        'Identity_Documents',
        'Drugs_Narcotics',
        'Drug_Equipment',
        'Firearm_Accessories',
        'Structures',
        'Merchandise',
        'Purses_Handbags_Wallets',
        'Consumable_Goods',
        'Recreational_Vehicles',
        'Other',
        'Not_Applicable'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- TIBRS Data Element 5 (Exceptional Clearance).
DO $$ BEGIN
    CREATE TYPE exceptional_clearance AS ENUM (
        'Not_Applicable',
        'Death_of_Offender',
        'Prosecution_Declined',
        'In_Custody_of_Other_Jurisdiction',
        'Victim_Refused_to_Cooperate',
        'Juvenile_No_Custody'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- --------------------------------------------------------------------------
-- incidents: location type, GPS, clearance, and monthly-submission
-- bookkeeping. All nullable/optional -- an incident is opened long before
-- everything about it is known (clearance in particular is often set weeks
-- later), so none of this can be required at the database layer.
-- --------------------------------------------------------------------------
ALTER TABLE incidents
    ADD COLUMN IF NOT EXISTS location_type            location_type,
    ADD COLUMN IF NOT EXISTS latitude                 NUMERIC(10,7),
    ADD COLUMN IF NOT EXISTS longitude                NUMERIC(10,7),
    ADD COLUMN IF NOT EXISTS exceptional_clearance     exceptional_clearance NOT NULL DEFAULT 'Not_Applicable',
    ADD COLUMN IF NOT EXISTS cleared_date              DATE,
    ADD COLUMN IF NOT EXISTS tibrs_submitted_at         TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS tibrs_submission_batch     TEXT;

DO $$ BEGIN
    ALTER TABLE incidents
        ADD CONSTRAINT ck_incidents_latitude_plausible
        CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE incidents
        ADD CONSTRAINT ck_incidents_longitude_plausible
        CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE incidents
        ADD CONSTRAINT ck_incidents_gps_both_or_neither
        CHECK ((latitude IS NULL) = (longitude IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- --------------------------------------------------------------------------
-- Reference table: real UCR/NIBRS Group A offense codes. Every
-- incident_offenses row must point at one of these -- this is what lets the
-- monthly validation endpoint (see the Express API) actually catch a typo'd
-- or made-up code before a submission file gets rejected by the state,
-- instead of discovering it the same way the state would.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tibrs_offense_codes (
    code            TEXT PRIMARY KEY,
    description     TEXT NOT NULL,
    crime_against   TEXT NOT NULL CHECK (crime_against IN ('Person', 'Property', 'Society'))
);

INSERT INTO tibrs_offense_codes (code, description, crime_against) VALUES
    ('09A', 'Murder & Nonnegligent Manslaughter', 'Person'),
    ('09B', 'Negligent Manslaughter', 'Person'),
    ('09C', 'Justifiable Homicide', 'Person'),
    ('100', 'Kidnapping/Abduction', 'Person'),
    ('11A', 'Rape', 'Person'),
    ('11B', 'Sodomy', 'Person'),
    ('11C', 'Sexual Assault With An Object', 'Person'),
    ('11D', 'Fondling', 'Person'),
    ('13A', 'Aggravated Assault', 'Person'),
    ('13B', 'Simple Assault', 'Person'),
    ('13C', 'Intimidation', 'Person'),
    ('36A', 'Incest', 'Person'),
    ('36B', 'Statutory Rape', 'Person'),
    ('64A', 'Human Trafficking, Commercial Sex Acts', 'Person'),
    ('64B', 'Human Trafficking, Involuntary Servitude', 'Person'),
    ('200', 'Arson', 'Property'),
    ('210', 'Extortion/Blackmail', 'Property'),
    ('220', 'Burglary/Breaking & Entering', 'Property'),
    ('23A', 'Pocket-picking', 'Property'),
    ('23B', 'Purse-snatching', 'Property'),
    ('23C', 'Shoplifting', 'Property'),
    ('23D', 'Theft From Building', 'Property'),
    ('23E', 'Theft From Coin-Operated Machine', 'Property'),
    ('23F', 'Theft From Motor Vehicle', 'Property'),
    ('23G', 'Theft Of Motor Vehicle Parts/Accessories', 'Property'),
    ('23H', 'All Other Larceny', 'Property'),
    ('240', 'Motor Vehicle Theft', 'Property'),
    ('250', 'Counterfeiting/Forgery', 'Property'),
    ('270', 'Embezzlement', 'Property'),
    ('26A', 'False Pretenses/Swindle/Confidence Game', 'Property'),
    ('26B', 'Credit Card/ATM Fraud', 'Property'),
    ('26C', 'Impersonation', 'Property'),
    ('26D', 'Welfare Fraud', 'Property'),
    ('26E', 'Wire Fraud', 'Property'),
    ('26F', 'Identity Theft', 'Property'),
    ('26G', 'Hacking/Computer Invasion', 'Property'),
    ('280', 'Stolen Property Offenses', 'Property'),
    ('290', 'Destruction/Damage/Vandalism of Property', 'Property'),
    ('510', 'Bribery', 'Property'),
    ('35A', 'Drug/Narcotic Violations', 'Society'),
    ('35B', 'Drug Equipment Violations', 'Society'),
    ('39A', 'Betting/Wagering', 'Society'),
    ('39B', 'Operating/Promoting/Assisting Gambling', 'Society'),
    ('39C', 'Gambling Equipment Violation', 'Society'),
    ('39D', 'Sports Tampering', 'Society'),
    ('370', 'Pornography/Obscene Material', 'Society'),
    ('40A', 'Prostitution', 'Society'),
    ('40B', 'Assisting or Promoting Prostitution', 'Society'),
    ('520', 'Weapon Law Violations', 'Society')
ON CONFLICT (code) DO NOTHING;

-- --------------------------------------------------------------------------
-- incident_offenses: up to 10 offenses per incident (TIBRS caps a single
-- Group A Incident Report at 10 offense segments). The cap is enforced
-- structurally, not just by convention: offense_sequence must be 1-10 AND
-- unique per incident, so an 11th row is impossible to insert.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incident_offenses (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id             UUID NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
    offense_sequence        SMALLINT NOT NULL,
    tibrs_offense_code      TEXT NOT NULL REFERENCES tibrs_offense_codes (code),
    attempted_completed     TEXT NOT NULL DEFAULT 'Completed'
                                CHECK (attempted_completed IN ('Attempted', 'Completed')),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_offenses_sequence_range CHECK (offense_sequence BETWEEN 1 AND 10),
    CONSTRAINT uq_offenses_incident_sequence UNIQUE (incident_id, offense_sequence)
);

CREATE INDEX IF NOT EXISTS ix_incident_offenses_incident ON incident_offenses (incident_id);

-- --------------------------------------------------------------------------
-- incident_persons: every person tied to an incident, and in what role.
-- sequence_number matches TIBRS' own Victim Sequence Number / Offender
-- Sequence Number concept -- it's how the relationship table below cross-
-- references "victim #1 to offender #2" the same way a real TIBRS
-- submission does.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incident_persons (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id         UUID NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
    person_id           UUID NOT NULL REFERENCES master_persons (id) ON DELETE RESTRICT,
    role                incident_person_role NOT NULL,
    sequence_number     SMALLINT NOT NULL,
    injury_type         injury_type,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_incident_persons_role_sequence UNIQUE (incident_id, role, sequence_number)
);

CREATE INDEX IF NOT EXISTS ix_incident_persons_incident ON incident_persons (incident_id);
CREATE INDEX IF NOT EXISTS ix_incident_persons_person ON incident_persons (person_id);

-- --------------------------------------------------------------------------
-- incident_victim_offender_relationships: TIBRS Data Element 34. References
-- incident_persons rows (not master_persons directly) so the relationship
-- is always scoped to a specific victim/offender pairing WITHIN one
-- incident -- the same two people could have a different recorded
-- relationship context across two unrelated incidents.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incident_victim_offender_relationships (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id                     UUID NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
    victim_incident_person_id       UUID NOT NULL REFERENCES incident_persons (id) ON DELETE CASCADE,
    offender_incident_person_id     UUID NOT NULL REFERENCES incident_persons (id) ON DELETE CASCADE,
    relationship                    victim_offender_relationship NOT NULL,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_vor_pair UNIQUE (victim_incident_person_id, offender_incident_person_id)
);

CREATE INDEX IF NOT EXISTS ix_vor_incident ON incident_victim_offender_relationships (incident_id);

-- Integrity check a plain CHECK constraint can't express (it would need to
-- look up other rows): both referenced incident_persons rows must actually
-- have the matching role, and must both belong to the SAME incident this
-- relationship row claims to belong to.
CREATE OR REPLACE FUNCTION trg_validate_victim_offender_roles() RETURNS TRIGGER AS $$
DECLARE
    victim_role incident_person_role;
    victim_incident UUID;
    offender_role incident_person_role;
    offender_incident UUID;
BEGIN
    SELECT role, incident_id INTO victim_role, victim_incident
      FROM incident_persons WHERE id = NEW.victim_incident_person_id;
    SELECT role, incident_id INTO offender_role, offender_incident
      FROM incident_persons WHERE id = NEW.offender_incident_person_id;

    IF victim_role IS DISTINCT FROM 'Victim' THEN
        RAISE EXCEPTION 'victim_incident_person_id % does not have role Victim', NEW.victim_incident_person_id;
    END IF;
    IF offender_role IS DISTINCT FROM 'Offender' THEN
        RAISE EXCEPTION 'offender_incident_person_id % does not have role Offender', NEW.offender_incident_person_id;
    END IF;
    IF victim_incident IS DISTINCT FROM NEW.incident_id OR offender_incident IS DISTINCT FROM NEW.incident_id THEN
        RAISE EXCEPTION 'victim/offender incident_persons rows must belong to the same incident_id as this relationship row';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_vor_validate ON incident_victim_offender_relationships;
CREATE TRIGGER trg_vor_validate
    BEFORE INSERT OR UPDATE ON incident_victim_offender_relationships
    FOR EACH ROW EXECUTE FUNCTION trg_validate_victim_offender_roles();

-- --------------------------------------------------------------------------
-- incident_property: TIBRS Data Elements 15-19 (property loss/recovery).
-- date_recovered only makes sense alongside a 'Recovered' loss type --
-- enforced directly since it doesn't require a cross-row lookup.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incident_property (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id             UUID NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
    property_loss_type      property_loss_type NOT NULL,
    property_category       property_category NOT NULL,
    property_description    TEXT NOT NULL,
    value_amount             currency_amount,
    date_recovered           DATE,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_property_desc_not_blank CHECK (length(btrim(property_description)) > 0),
    CONSTRAINT ck_property_value_nonnegative CHECK (value_amount IS NULL OR value_amount >= 0),
    CONSTRAINT ck_property_recovered_date_requires_recovered
        CHECK (date_recovered IS NULL OR property_loss_type = 'Recovered')
);

CREATE INDEX IF NOT EXISTS ix_incident_property_incident ON incident_property (incident_id);

COMMIT;

-- =============================================================================
-- End of 005_add_tibrs_incident_module.sql
-- =============================================================================
