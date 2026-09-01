'use strict';

const Joi = require('joi');
const { UUID_RE } = require('./common');

// Mirrors db/migrations/012_add_matters_of_record.sql's enum types exactly
// -- kept in sync by hand, same convention as every other module's
// validation file (see e.g. incidentSchema.js's own comment on this).
const MOR_CATEGORIES = [
  'Property_Loss',
  'Neighborhood_Disturbance',
  'Civil_Dispute',
  'Vandalism',
  'Welfare_Check',
  'Verbal_Warning',
  'Medical_Call',
  'Animal_Complaint',
  'Other',
];

const MOR_PERSON_ROLES = ['Involved_Party', 'Witness'];

// Deliberately minimal compared to incidentPersonSchema (incidentSchema.js)
// -- a matter of record just needs to name who was involved or who
// witnessed it, not the full physical-description intake a criminal
// incident's persons carry. person_id links to an existing master_persons
// row (e.g. selected from a prior search); otherwise first_name/last_name
// are required and personService.findOrCreatePerson dedupes/creates one,
// same pattern incidents.controller.js already uses.
const morPersonSchema = Joi.object({
  person_id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').optional(),

  first_name: Joi.string().trim().min(1).max(80).optional(),
  last_name: Joi.string().trim().min(1).max(80).optional(),
  phone: Joi.string().trim().max(20).allow('', null).optional(),
  address: Joi.string().trim().max(255).allow('', null).optional(),

  role: Joi.string()
    .valid(...MOR_PERSON_ROLES)
    .required(),
}).options({ abortEarly: false });

const morCreateSchema = Joi.object({
  id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').optional(),
  report_number: Joi.string().trim().min(1).max(40).required(),
  category: Joi.string()
    .valid(...MOR_CATEGORIES)
    .required(),
  occurrence_date: Joi.date().iso().required(),
  location_address: Joi.string().trim().min(1).max(255).required(),
  latitude: Joi.number().min(-90).max(90).optional(),
  longitude: Joi.number().min(-180).max(180).optional(),
  narrative: Joi.string().trim().min(1).max(10000).required(),
  persons: Joi.array().items(morPersonSchema).max(50).default([]),
  device_created_at: Joi.date().iso().optional(),
}).options({ abortEarly: false });

// Top-level-field correction only, same split as incidentUpdateSchema --
// re-working the persons list is a rarer, separate concern (see
// addMorPerson below) rather than something this endpoint touches.
const morUpdateSchema = Joi.object({
  report_number: Joi.string().trim().min(1).max(40).optional(),
  category: Joi.string()
    .valid(...MOR_CATEGORIES)
    .optional(),
  occurrence_date: Joi.date().iso().optional(),
  location_address: Joi.string().trim().min(1).max(255).optional(),
  latitude: Joi.number().min(-90).max(90).optional(),
  longitude: Joi.number().min(-180).max(180).optional(),
  narrative: Joi.string().trim().min(1).max(10000).optional(),
})
  .min(1)
  .options({ abortEarly: false });

const morAddPersonSchema = morPersonSchema;

const morListQuerySchema = Joi.object({
  q: Joi.string().trim().max(120).allow('', null).optional(),
  category: Joi.string()
    .valid(...MOR_CATEGORIES)
    .optional(),
  approval_status: Joi.string().valid('Pending', 'Approved', 'Rejected').optional(),
  limit: Joi.number().integer().min(1).max(100).default(25),
  offset: Joi.number().integer().min(0).default(0),
}).options({ abortEarly: false, presence: 'optional' });

module.exports = {
  MOR_CATEGORIES,
  MOR_PERSON_ROLES,
  morCreateSchema,
  morUpdateSchema,
  morAddPersonSchema,
  morListQuerySchema,
};
