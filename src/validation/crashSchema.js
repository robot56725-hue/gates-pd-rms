'use strict';

const Joi = require('joi');
const { PERSON_SEX_VALUES, PERSON_RACE_VALUES } = require('./citationSchema');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE_RE = /^[A-Z]{2}$/;
const YEAR_RE = /^(19|20)\d{2}$/;
const usState = () =>
  Joi.string().trim().uppercase().pattern(STATE_RE).message('must be a 2-letter USPS state code');
const plausibleYear = () =>
  Joi.string().trim().pattern(YEAR_RE).message('must be a 4-digit year between 1900-2099');

// Mirrors the ENUMs in db/migrations/006_add_ecrash_module.sql.
const WEATHER_CONDITIONS = [
  'Clear',
  'Cloudy',
  'Rain',
  'Sleet_Hail',
  'Snow',
  'Fog_Smog_Smoke',
  'Severe_Crosswinds',
  'Blowing_Sand_Soil_Dirt',
  'Other',
  'Unknown',
];

const ROAD_SURFACE_CONDITIONS = [
  'Dry',
  'Wet',
  'Snow',
  'Ice',
  'Sand_Mud_Dirt_Gravel',
  'Water_Standing_Moving',
  'Slush',
  'Other',
  'Unknown',
];

const LIGHT_CONDITIONS = [
  'Daylight',
  'Dusk',
  'Dawn',
  'Dark_Lighted',
  'Dark_Not_Lighted',
  'Dark_Unknown_Lighting',
  'Other',
  'Unknown',
];

const CRASH_SEVERITIES = ['Property_Damage_Only', 'Injury', 'Fatality'];
const CRASH_PERSON_ROLES = ['Driver', 'Passenger', 'Pedestrian', 'Cyclist', 'Other'];
const CRASH_INJURY_SEVERITIES = [
  'No_Apparent_Injury',
  'Possible_Injury',
  'Suspected_Minor_Injury',
  'Suspected_Serious_Injury',
  'Fatal_Injury',
];

// A vehicle involved in the crash. Same find-or-create-by-VIN semantics as
// citations (see src/services/vehicleService.js) -- provide `vehicle_id` to
// reference an already-known master_vehicles row instead.
const crashVehicleSchema = Joi.object({
  vehicle_id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').optional(),

  vin: Joi.string().trim().length(17).uppercase().optional(),
  make: Joi.string().trim().min(1).max(40).when('vehicle_id', { is: Joi.exist(), then: Joi.optional(), otherwise: Joi.required() }),
  model: Joi.string().trim().min(1).max(40).when('vehicle_id', { is: Joi.exist(), then: Joi.optional(), otherwise: Joi.required() }),
  year: plausibleYear().when('vehicle_id', { is: Joi.exist(), then: Joi.optional(), otherwise: Joi.required() }),
  color: Joi.string().trim().min(1).max(30).when('vehicle_id', { is: Joi.exist(), then: Joi.optional(), otherwise: Joi.required() }),
  owner_name: Joi.string().trim().min(1).max(120).when('vehicle_id', { is: Joi.exist(), then: Joi.optional(), otherwise: Joi.required() }),
  plate_number: Joi.string().trim().min(1).max(20).when('vehicle_id', { is: Joi.exist(), then: Joi.optional(), otherwise: Joi.required() }),
  plate_year: plausibleYear().when('vehicle_id', { is: Joi.exist(), then: Joi.optional(), otherwise: Joi.required() }),
  plate_state: usState().when('vehicle_id', { is: Joi.exist(), then: Joi.optional(), otherwise: Joi.required() }),

  damage_description: Joi.string().trim().max(1000).allow('', null).optional(),
  damage_estimate: Joi.number().precision(2).min(0).max(99999999.99).optional(),
}).options({ abortEarly: false });

// A person involved in the crash (driver, passenger, pedestrian, cyclist).
// `vehicle_index` is a 0-based position into this same request's `vehicles`
// array -- which vehicle they were driving/riding in/struck by, or omitted
// entirely for e.g. an uninvolved witness.
const crashPersonSchema = Joi.object({
  person_id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').optional(),

  first_name: Joi.string().trim().min(1).max(80).optional(),
  last_name: Joi.string().trim().min(1).max(80).optional(),
  dob: Joi.date().iso().optional(),
  sex: Joi.string()
    .valid(...PERSON_SEX_VALUES)
    .optional(),
  race: Joi.string()
    .valid(...PERSON_RACE_VALUES)
    .optional(),
  height_inches: Joi.number().integer().min(20).max(96).optional(),
  weight_lbs: Joi.number().integer().min(30).max(700).optional(),
  eye_color: Joi.string().trim().max(30).allow('', null).optional(),
  hair_color: Joi.string().trim().max(30).allow('', null).optional(),
  drivers_license_num: Joi.string().trim().max(40).allow('', null).optional(),
  dl_state: usState().allow('', null).optional(),
  dl_class: Joi.string().trim().max(10).allow('', null).optional(),
  is_cdl: Joi.boolean().optional(),
  phone: Joi.string().trim().max(20).allow('', null).optional(),
  address: Joi.string().trim().max(255).allow('', null).optional(),

  role: Joi.string()
    .valid(...CRASH_PERSON_ROLES)
    .required(),
  injury_severity: Joi.string()
    .valid(...CRASH_INJURY_SEVERITIES)
    .default('No_Apparent_Injury'),
  vehicle_index: Joi.number().integer().min(0).optional(),
}).options({ abortEarly: false });

const crashCreateSchema = Joi.object({
  id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').optional(),
  report_number: Joi.string().trim().min(1).max(30).required(),
  crash_date: Joi.date().iso().required(),
  location: Joi.string().trim().min(1).max(255).required(),
  latitude: Joi.number().min(-90).max(90).optional(),
  longitude: Joi.number().min(-180).max(180).optional(),

  weather_condition: Joi.string()
    .valid(...WEATHER_CONDITIONS)
    .required(),
  road_surface_condition: Joi.string()
    .valid(...ROAD_SURFACE_CONDITIONS)
    .required(),
  light_condition: Joi.string()
    .valid(...LIGHT_CONDITIONS)
    .required(),
  crash_severity: Joi.string()
    .valid(...CRASH_SEVERITIES)
    .required(),
  narrative: Joi.string().trim().max(10000).allow('', null).optional(),
  device_created_at: Joi.date().iso().optional(),

  vehicles: Joi.array().items(crashVehicleSchema).min(1).max(20).required(),
  persons: Joi.array().items(crashPersonSchema).max(50).default([]),
})
  .and('latitude', 'longitude')
  .options({ abortEarly: false, presence: 'optional' });

const crashListQuerySchema = Joi.object({
  q: Joi.string().trim().max(120).allow('', null).optional(),
  severity: Joi.string()
    .valid(...CRASH_SEVERITIES)
    .optional(),
  mine: Joi.boolean().optional(),
  limit: Joi.number().integer().min(1).max(100).default(25),
  offset: Joi.number().integer().min(0).default(0),
}).options({ abortEarly: false, presence: 'optional' });

module.exports = {
  crashCreateSchema,
  crashListQuerySchema,
  WEATHER_CONDITIONS,
  ROAD_SURFACE_CONDITIONS,
  LIGHT_CONDITIONS,
  CRASH_SEVERITIES,
  CRASH_PERSON_ROLES,
  CRASH_INJURY_SEVERITIES,
};
