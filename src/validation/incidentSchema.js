'use strict';

const Joi = require('joi');
const { PERSON_SEX_VALUES, PERSON_RACE_VALUES } = require('./citationSchema');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE_RE = /^[A-Z]{2}$/;
const usState = () =>
  Joi.string().trim().uppercase().pattern(STATE_RE).message('must be a 2-letter USPS state code');

// Every one of these lists mirrors an ENUM created in
// db/migrations/005_add_tibrs_incident_module.sql exactly -- kept in sync by
// hand (there are only two places: the migration and here), so a mismatch
// surfaces immediately as a rejected INSERT in testing rather than silently
// accepting a value the database will never agree matches.
const LOCATION_TYPES = [
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
  'Unknown',
];

const INCIDENT_PERSON_ROLES = ['Victim', 'Offender', 'Witness', 'Reporting_Party'];

const INJURY_TYPES = [
  'None',
  'Apparent_Broken_Bones',
  'Possible_Internal_Injury',
  'Severe_Laceration',
  'Apparent_Minor_Injury',
  'Loss_of_Teeth',
  'Unconsciousness',
  'Other_Major_Injury',
];

const VOR_RELATIONSHIPS = [
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
  'Relationship_Unknown',
];

const PROPERTY_LOSS_TYPES = [
  'None',
  'Stolen',
  'Burned',
  'Counterfeited_Forged',
  'Damaged_Destroyed_Vandalized',
  'Recovered',
  'Seized',
  'Other',
];

const PROPERTY_CATEGORIES = [
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
  'Not_Applicable',
];

const INCIDENT_STATUSES = ['Open', 'Under_Review', 'Closed'];

const EXCEPTIONAL_CLEARANCE_VALUES = [
  'Not_Applicable',
  'Death_of_Offender',
  'Prosecution_Declined',
  'In_Custody_of_Other_Jurisdiction',
  'Victim_Refused_to_Cooperate',
  'Juvenile_No_Custody',
];

const isoDate = () => Joi.date().iso();

// A person involved in the incident. Provide `person_id` to reference an
// already-known master_persons row (e.g. selected from a search result)
// -- otherwise first_name/last_name are required and a new-or-deduped
// row is created the same way citations.controller.js has always done
// (see src/services/personService.js). Enforced in the controller rather
// than as a Joi conditional -- simpler to read and to test than a nested
// .when() chain, and the controller has to load/validate person_id either
// way.
const incidentPersonSchema = Joi.object({
  person_id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').optional(),

  first_name: Joi.string().trim().min(1).max(80).optional(),
  last_name: Joi.string().trim().min(1).max(80).optional(),
  dob: isoDate().optional(),
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
    .valid(...INCIDENT_PERSON_ROLES)
    .required(),
  injury_type: Joi.string()
    .valid(...INJURY_TYPES)
    .optional(),
}).options({ abortEarly: false });

const offenseInputSchema = Joi.object({
  tibrs_offense_code: Joi.string().trim().max(10).required(),
  attempted_completed: Joi.string().valid('Attempted', 'Completed').default('Completed'),
});

// victim_index / offender_index are 0-based positions into the `persons`
// array of THIS SAME request -- resolved to actual incident_persons rows by
// the controller after it inserts each person, so the client never needs
// to know a not-yet-created person's future database id.
const relationshipInputSchema = Joi.object({
  victim_index: Joi.number().integer().min(0).required(),
  offender_index: Joi.number().integer().min(0).required(),
  relationship: Joi.string()
    .valid(...VOR_RELATIONSHIPS)
    .required(),
});

const propertyInputSchema = Joi.object({
  property_loss_type: Joi.string()
    .valid(...PROPERTY_LOSS_TYPES)
    .required(),
  property_category: Joi.string()
    .valid(...PROPERTY_CATEGORIES)
    .required(),
  property_description: Joi.string().trim().min(1).max(500).required(),
  value_amount: Joi.number().precision(2).min(0).max(99999999.99).optional(),
  date_recovered: Joi.date().iso().optional(),
});

const incidentCreateSchema = Joi.object({
  id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').optional(),
  case_number: Joi.string().trim().min(1).max(40).required(),
  occurrence_date: Joi.date().iso().required(),
  location_address: Joi.string().trim().min(1).max(255).required(),
  location_type: Joi.string()
    .valid(...LOCATION_TYPES)
    .required(),
  latitude: Joi.number().min(-90).max(90).optional(),
  longitude: Joi.number().min(-180).max(180).optional(),
  device_created_at: Joi.date().iso().optional(),

  // Up to 10 -- matches the structural cap enforced by
  // db/migrations/005_add_tibrs_incident_module.sql (offense_sequence
  // CHECK + UNIQUE), so a request that would violate the DB constraint is
  // rejected here first with a clear message instead of a raw SQL error.
  offenses: Joi.array().items(offenseInputSchema).min(1).max(10).required(),
  persons: Joi.array().items(incidentPersonSchema).max(50).default([]),
  relationships: Joi.array().items(relationshipInputSchema).default([]),
  property: Joi.array().items(propertyInputSchema).default([]),

  narrative: Joi.string().trim().max(10000).allow('', null).optional(),
})
  .and('latitude', 'longitude')
  .options({ abortEarly: false, presence: 'optional' });

// Deliberately scoped to fields that live directly on `incidents` --
// re-working the nested offenses/persons/relationships/property collections
// is a rarer, higher-stakes correction handled separately, not through this
// endpoint (mirrors citationUpdateSchema's same scoping decision).
const incidentUpdateSchema = Joi.object({
  status: Joi.string()
    .valid(...INCIDENT_STATUSES)
    .optional(),
  exceptional_clearance: Joi.string()
    .valid(...EXCEPTIONAL_CLEARANCE_VALUES)
    .optional(),
  cleared_date: Joi.date().iso().optional(),

  occurrence_date: Joi.date().iso().optional(),
  location_address: Joi.string().trim().min(1).max(255).optional(),
  location_type: Joi.string()
    .valid(...LOCATION_TYPES)
    .optional(),
  latitude: Joi.number().min(-90).max(90).optional(),
  longitude: Joi.number().min(-180).max(180).optional(),
})
  .and('latitude', 'longitude')
  .min(1)
  .message('At least one field must be provided to update the incident.')
  .options({ abortEarly: false, presence: 'optional' });

const narrativeCreateSchema = Joi.object({
  narrative_text: Joi.string().trim().min(1).max(10000).required(),
});

const incidentListQuerySchema = Joi.object({
  q: Joi.string().trim().max(120).allow('', null).optional(),
  status: Joi.string()
    .valid(...INCIDENT_STATUSES)
    .optional(),
  mine: Joi.boolean().optional(),
  limit: Joi.number().integer().min(1).max(100).default(25),
  offset: Joi.number().integer().min(0).default(0),
}).options({ abortEarly: false, presence: 'optional' });

module.exports = {
  incidentCreateSchema,
  incidentUpdateSchema,
  narrativeCreateSchema,
  incidentListQuerySchema,
  LOCATION_TYPES,
  INCIDENT_PERSON_ROLES,
  INJURY_TYPES,
  VOR_RELATIONSHIPS,
  PROPERTY_LOSS_TYPES,
  PROPERTY_CATEGORIES,
  INCIDENT_STATUSES,
  EXCEPTIONAL_CLEARANCE_VALUES,
};
