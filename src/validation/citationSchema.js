'use strict';

const Joi = require('joi');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const STATE_RE = /^[A-Z]{2}$/;
const YEAR_RE = /^(19|20)\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isoDate = () => Joi.string().trim().pattern(DATE_RE).message('must be in YYYY-MM-DD format');
const isoTime = () =>
  Joi.string().trim().pattern(TIME_RE).message('must be HH:MM or HH:MM:SS 24-hour format');
const usState = () =>
  Joi.string().trim().uppercase().pattern(STATE_RE).message('must be a 2-letter USPS state code');
const plausibleYear = () =>
  Joi.string().trim().pattern(YEAR_RE).message('must be a 4-digit year between 1900-2099');

// Mirrors db/migrations/004_add_citation_physical_description_and_gps.sql --
// person_sex / person_race ENUM values, kept as plain string lists here
// (rather than querying the DB at startup) so validation fails fast with a
// clear message before a bad value ever reaches Postgres.
const PERSON_SEX_VALUES = ['Male', 'Female', 'Unknown'];
const PERSON_RACE_VALUES = [
  'White',
  'Black',
  'American_Indian_Alaska_Native',
  'Asian',
  'Native_Hawaiian_Pacific_Islander',
  'Unknown',
];

// (2) violator name + DOB + physical description, (3) DL number/state/class,
// (4) CDL status. Physical description (sex, race, height, weight, eye/hair
// color) is itself one of the mandated T.C.A. 55-10-207(i) data points, not
// an optional extra -- see db/migrations/004_add_citation_physical_description_and_gps.sql.
const violatorSchema = Joi.object({
  first_name: Joi.string().trim().min(1).max(80).required(),
  middle_name: Joi.string().trim().max(80).allow('', null).optional(),
  last_name: Joi.string().trim().min(1).max(80).required(),
  dob: isoDate().required(),

  sex: Joi.string()
    .valid(...PERSON_SEX_VALUES)
    .required(),
  race: Joi.string()
    .valid(...PERSON_RACE_VALUES)
    .required(),
  height_inches: Joi.number().integer().min(20).max(96).required(),
  weight_lbs: Joi.number().integer().min(30).max(700).required(),
  eye_color: Joi.string().trim().min(1).max(30).required(),
  hair_color: Joi.string().trim().min(1).max(30).required(),

  drivers_license_num: Joi.string().trim().min(1).max(40).required(),
  dl_state: usState().required(),
  dl_class: Joi.string().trim().min(1).max(10).required(),
  is_cdl: Joi.boolean().required(),

  ssn: Joi.string()
    .trim()
    .pattern(/^\d{3}-?\d{2}-?\d{4}$/)
    .message('must be a 9-digit SSN, with or without dashes')
    .optional(),
  phone: Joi.string().trim().max(20).allow('', null).optional(),
  address: Joi.string().trim().max(255).allow('', null).optional(),
}).required();

// (5) vehicle make/model/year/color/owner, (6) plate number/year/state
const vehicleSchema = Joi.object({
  vin: Joi.string().trim().length(17).uppercase().optional(),
  make: Joi.string().trim().min(1).max(40).required(),
  model: Joi.string().trim().min(1).max(40).required(),
  year: plausibleYear().required(),
  color: Joi.string().trim().min(1).max(30).required(),
  owner_name: Joi.string().trim().min(1).max(120).required(),

  plate_number: Joi.string().trim().min(1).max(20).required(),
  plate_year: plausibleYear().required(),
  plate_state: usState().required(),
}).required();

// (7) CMV, (8) hazmat, (9) 16+ passengers, (10) offense + date/time +
// precise GPS location (captured the same way TraCS Geolocation would),
// (11) human-readable location.
const offenseSchema = Joi.object({
  offense_date: isoDate().required(),
  offense_time: isoTime().required(),
  location: Joi.string().trim().min(1).max(255).required(),
  latitude: Joi.number().min(-90).max(90).required(),
  longitude: Joi.number().min(-180).max(180).required(),
  offense_description: Joi.string().trim().min(1).max(1000).required(),
  tca_code: Joi.string().trim().min(1).max(30).required(),

  is_cmv: Joi.boolean().required(),
  is_hazmat: Joi.boolean().required(),
  passenger_capacity_16plus: Joi.boolean().required(),
}).required();

// (13) court date/time/location/name, as assigned at citation issuance.
const courtSchema = Joi.object({
  court_date: isoDate().required(),
  court_time: isoTime().required(),
  court_location: Joi.string().trim().min(1).max(255).required(),
  court_name: Joi.string().trim().min(1).max(120).required(),
}).required();

// A signature is a data: URL (image/png) captured from an on-screen
// signature pad. TN practice for a citation is a signature block
// acknowledging receipt/promise to appear -- a violator refusing to sign is
// itself a legally meaningful, valid outcome (not an error), so exactly one
// of violator_signature / violator_refused_to_sign is required, never both
// and never neither -- see db/migrations/008_..._multirole_...sql.
// No .default() on violator_refused_to_sign here, deliberately: .xor()
// checks presence in the RESOLVED value, which includes defaults -- a
// default of false would make the key "present" on every request (even one
// that only sent violator_signature), so .xor() would always see both
// peers and reject every legitimately-signed citation. The controller
// coalesces the omitted case to false before it hits the NOT NULL column.
const signatureSchema = Joi.object({
  violator_signature: Joi.string().trim().max(200000).optional(),
  violator_refused_to_sign: Joi.boolean().optional(),
})
  .xor('violator_signature', 'violator_refused_to_sign')
  .messages({
    'object.xor': 'Provide either a captured signature or mark that the violator refused to sign, not both.',
    'object.missing': 'A signature or a recorded refusal to sign is required.',
  });

const citationRequestSchema = Joi.object({
  // Optional client-generated id: lets an offline mobile client pre-assign
  // the citation's UUID primary key so a retried sync is idempotent (see
  // controllers/citations.controller.js). Server generates one if omitted.
  id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').optional(),

  // (1) Citation number -- pre-assigned from the officer's citation book;
  // never server-generated (see the 002 migration's numbering-generator note).
  citation_number: Joi.string().trim().min(1).max(30).required(),

  // When the citation was actually authored on the officer's device
  // (possibly offline); defaults to server receipt time if omitted. The
  // statutory 3-day filing clock is computed from this value at the DB
  // layer (db/migrations/001_init_schema.sql trigger).
  device_created_at: Joi.date().iso().optional(),

  violator: violatorSchema,
  vehicle: vehicleSchema,
  offense: offenseSchema,
  court: courtSchema,
})
  .concat(signatureSchema)
  .required()
  .options({ abortEarly: false, stripUnknown: false, presence: 'required' });

// PATCH /api/citations/:id -- correcting a mistake on an already-issued
// citation (wrong TCA code, court date, description, etc). Deliberately
// scoped to columns that live directly on e_citations: re-pointing a
// citation at a different violator/vehicle person record is a rarer,
// higher-stakes correction handled separately, not through this endpoint.
const citationUpdateSchema = Joi.object({
  location: Joi.string().trim().min(1).max(255).optional(),
  latitude: Joi.number().min(-90).max(90).optional(),
  longitude: Joi.number().min(-180).max(180).optional(),
  offense_description: Joi.string().trim().min(1).max(1000).optional(),
  tca_code: Joi.string().trim().min(1).max(30).optional(),
  is_cmv: Joi.boolean().optional(),
  is_hazmat: Joi.boolean().optional(),
  passenger_capacity_16plus: Joi.boolean().optional(),
  court_date: isoDate().optional(),
  court_time: isoTime().optional(),
  court_location: Joi.string().trim().min(1).max(255).optional(),
  court_name: Joi.string().trim().min(1).max(120).optional(),
})
  .and('latitude', 'longitude')
  .and('court_date', 'court_time')
  .min(1)
  .options({ abortEarly: false });

// GET /api/citations query params. status re-uses the same
// court_disposition_status values as courtLedgerSchema.js -- kept as a
// plain string list here (rather than importing that module) to avoid a
// circular require, since courtLedgerSchema.js has no reason to depend on
// this file.
const CITATION_LIST_STATUSES = ['Pending', 'Guilty', 'Not_Guilty', 'Dismissed', 'FTA_Failure_To_Appear'];

const citationListQuerySchema = Joi.object({
  q: Joi.string().trim().max(120).allow('', null).optional(),
  status: Joi.string()
    .valid(...CITATION_LIST_STATUSES)
    .optional(),
  // Restricts the list to citations issued by the requesting officer. Any
  // role may pass this; it's a convenience filter, not an access control --
  // reads are already open to every authenticated role at the DB layer.
  mine: Joi.boolean().optional(),
  limit: Joi.number().integer().min(1).max(100).default(25),
  offset: Joi.number().integer().min(0).default(0),
}).options({ abortEarly: false, presence: 'optional' });

module.exports = {
  citationRequestSchema,
  citationUpdateSchema,
  citationListQuerySchema,
  PERSON_SEX_VALUES,
  PERSON_RACE_VALUES,
};
