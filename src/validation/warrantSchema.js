'use strict';

const Joi = require('joi');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mirrors db/migrations/011_add_court_case_management.sql's enum types.
const WARRANT_TYPES = ['Capias', 'Bench_Warrant'];
const WARRANT_STATUSES = ['Issued', 'Recalled', 'Served'];

const idParamSchema = Joi.object({
  id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').required(),
});

// POST /api/warrants -- tracks that a warrant application was prepared for
// a case (migration 011's own comment: the actual legal instrument still
// requires a real judge's signature obtained outside this system). Always
// inserted as 'Issued' -- the table default -- never client-supplied, so
// creating a warrant record can't simultaneously claim it's already been
// Recalled or Served.
const warrantCreateSchema = Joi.object({
  case_id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').required(),
  judge_id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').optional(),
  warrant_type: Joi.string()
    .valid(...WARRANT_TYPES)
    .required(),
  notes: Joi.string().trim().max(2000).allow('', null).optional(),
}).options({ abortEarly: false });

// PATCH /api/warrants/:id/status -- Recalled or Served only; the
// controller separately refuses this once a warrant is already in either
// state (see the note above updateWarrantStatus in warrants.controller.js).
// There's no route back to 'Issued' -- a warrant that needs reissuing is a
// fresh POST, not a resurrection of an old one.
const warrantStatusUpdateSchema = Joi.object({
  warrant_status: Joi.string()
    .valid('Recalled', 'Served')
    .required(),
  notes: Joi.string().trim().max(2000).allow('', null).optional(),
}).options({ abortEarly: false });

const warrantListQuerySchema = Joi.object({
  case_id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').optional(),
  warrant_status: Joi.string()
    .valid(...WARRANT_STATUSES)
    .optional(),
  limit: Joi.number().integer().min(1).max(100).default(25),
  offset: Joi.number().integer().min(0).default(0),
}).options({ abortEarly: false, presence: 'optional' });

module.exports = {
  WARRANT_TYPES,
  WARRANT_STATUSES,
  idParamSchema,
  warrantCreateSchema,
  warrantStatusUpdateSchema,
  warrantListQuerySchema,
};
