'use strict';

/**
 * Authoritative field mapping for the 13 data points a Tennessee traffic
 * citation must contain under T.C.A. § 55-10-207(i), plus the § 55-10-207(g)
 * 3-day electronic-transmission deadline.
 *
 * Statutory reference (subsection (i)) -- confirm against the current
 * published Tennessee Code / AOC citation form before relying on this list
 * in production; codified statutes are periodically amended:
 *
 *   1.  Citation number
 *   2.  Violator's first, middle (or initial), and last name, and DOB
 *   3.  Violator's driver license number, state of issuance, and class
 *   4.  Whether the driver license is a commercial driver license (CDL)
 *   5.  Vehicle make, model, year, color, and owner
 *   6.  License plate number, year, and state of issuance
 *   7.  Whether the vehicle is a commercial motor vehicle
 *   8.  Whether the vehicle was transporting hazardous materials
 *   9.  Whether the vehicle is designed to transport 16+ passengers
 *   10. The offense committed, including date and time (if applicable)
 *   11. The location of the offense
 *   12. The issuing officer's name, rank, badge/ID number, and agency
 *   13. The time, date, location, and court where the offense will be heard
 *
 * This is enforced TWICE in this codebase, independently: once declaratively
 * via the Joi schema (src/validation/citationSchema.js), which is what
 * actually rejects a malformed request, and again here via explicit
 * path-presence checks against the parsed payload. The Joi schema is the
 * primary gate; this module is defense-in-depth so a future relaxation of
 * the schema (e.g. to accommodate some legacy client) can never silently
 * drop a legally mandated field without a second, independent check also
 * having to be relaxed.
 */

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function isPresent(obj, path) {
  const value = getPath(obj, path);
  if (value === undefined || value === null) return false;
  if (typeof value === 'string' && value.trim() === '') return false;
  return true;
}

function isBooleanPresent(obj, path) {
  return typeof getPath(obj, path) === 'boolean';
}

const MANDATORY_FIELDS = [
  {
    key: 1,
    description: 'Citation number',
    check: (p) => isPresent(p, 'citation_number'),
  },
  {
    key: 2,
    description: "Violator's name and date of birth",
    check: (p) =>
      isPresent(p, 'violator.first_name') &&
      isPresent(p, 'violator.last_name') &&
      isPresent(p, 'violator.dob'),
  },
  {
    key: 3,
    description: "Violator's driver license number, state of issuance, and class",
    check: (p) =>
      isPresent(p, 'violator.drivers_license_num') &&
      isPresent(p, 'violator.dl_state') &&
      isPresent(p, 'violator.dl_class'),
  },
  {
    key: 4,
    description: 'Commercial driver license (CDL) status',
    check: (p) => isBooleanPresent(p, 'violator.is_cdl'),
  },
  {
    key: 5,
    description: 'Vehicle make, model, year, color, and owner',
    check: (p) =>
      isPresent(p, 'vehicle.make') &&
      isPresent(p, 'vehicle.model') &&
      isPresent(p, 'vehicle.year') &&
      isPresent(p, 'vehicle.color') &&
      isPresent(p, 'vehicle.owner_name'),
  },
  {
    key: 6,
    description: 'License plate number, year, and state of issuance',
    check: (p) =>
      isPresent(p, 'vehicle.plate_number') &&
      isPresent(p, 'vehicle.plate_year') &&
      isPresent(p, 'vehicle.plate_state'),
  },
  {
    key: 7,
    description: 'Commercial motor vehicle status',
    check: (p) => isBooleanPresent(p, 'offense.is_cmv'),
  },
  {
    key: 8,
    description: 'Hazardous materials transport status',
    check: (p) => isBooleanPresent(p, 'offense.is_hazmat'),
  },
  {
    key: 9,
    description: '16+ passenger capacity status',
    check: (p) => isBooleanPresent(p, 'offense.passenger_capacity_16plus'),
  },
  {
    key: 10,
    description: 'Offense committed, including date and time',
    check: (p) =>
      isPresent(p, 'offense.offense_description') && isPresent(p, 'offense.offense_date'),
  },
  {
    key: 11,
    description: 'Location of the offense',
    check: (p) => isPresent(p, 'offense.location'),
  },
  {
    key: 12,
    description: "Issuing officer's name, rank, badge/ID number, and employing agency",
    // officer_name/officer_rank/officer_badge_number/officer_agency are
    // resolved server-side from the authenticated officer's user row (see
    // citations.controller.js), not supplied by the client -- checked here
    // against the resolved officer object the controller attaches before
    // calling validateMandatoryFields.
    check: (p) =>
      isPresent(p, 'officer.full_name') &&
      isPresent(p, 'officer.officer_rank') &&
      isPresent(p, 'officer.badge_number') &&
      isPresent(p, 'officer.agency'),
  },
  {
    key: 13,
    description: 'Court date, time, location, and court where offense will be heard',
    check: (p) =>
      isPresent(p, 'court.court_date') &&
      isPresent(p, 'court.court_time') &&
      isPresent(p, 'court.court_location') &&
      isPresent(p, 'court.court_name'),
  },
];

if (MANDATORY_FIELDS.length !== 13) {
  throw new Error('T.C.A. 55-10-207(i) defines exactly 13 mandatory data points');
}

const COURT_FILING_DEADLINE_DAYS = 3;

/**
 * Returns an array of human-readable error strings, one per missing/invalid
 * mandatory data point. An empty array means the payload satisfies all 13
 * T.C.A. 55-10-207(i) requirements.
 */
function validateMandatoryFields(payload) {
  const errors = [];
  for (const field of MANDATORY_FIELDS) {
    if (!field.check(payload)) {
      errors.push(`[TCA 55-10-207(i)(${field.key})] Missing required field: ${field.description}`);
    }
  }
  return errors;
}

module.exports = { MANDATORY_FIELDS, COURT_FILING_DEADLINE_DAYS, validateMandatoryFields };
