'use strict';

const Joi = require('joi');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

const isoDate = () => Joi.string().trim().pattern(DATE_RE).message('must be in YYYY-MM-DD format');
const isoTime = () =>
  Joi.string().trim().pattern(TIME_RE).message('must be HH:MM or HH:MM:SS 24-hour format');

// Mirrors db/migrations/011_add_court_case_management.sql's enum types.
const DOCKET_TYPES = ['Traffic', 'Ordinance', 'General_Sessions', 'Other'];
const DOCKET_STATUSES = ['Scheduled', 'In_Session', 'Completed', 'Cancelled'];
const APPEARANCE_STATUSES = ['Scheduled', 'Appeared', 'FTA', 'Continued', 'Removed'];

const idParamSchema = Joi.object({
  id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').required(),
});

const docketEntryParamSchema = Joi.object({
  id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').required(),
  entryId: Joi.string().pattern(UUID_RE).message('must be a valid UUID').required(),
});

// POST /api/dockets -- schedules a court session. judge_id is optional (a
// docket can be created before a judge is assigned) but when supplied, the
// controller checks it against judge_unavailability for docket_date -- see
// the note above that check in dockets.controller.js.
const docketCreateSchema = Joi.object({
  id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').optional(),
  docket_date: isoDate().required(),
  docket_time: isoTime().optional(),
  judge_id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').optional(),
  docket_type: Joi.string()
    .valid(...DOCKET_TYPES)
    .optional(),
  location: Joi.string().trim().max(255).allow('', null).optional(),
  notes: Joi.string().trim().max(2000).allow('', null).optional(),
}).options({ abortEarly: false });

// PATCH /api/dockets/:id -- partial update. judge_id may be explicitly set
// to null to unassign (court_dockets.judge_id is nullable, ON DELETE SET
// NULL), so it's allow(null) here rather than merely optional.
const docketUpdateSchema = Joi.object({
  docket_date: isoDate().optional(),
  docket_time: isoTime().allow(null).optional(),
  judge_id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').allow(null).optional(),
  docket_type: Joi.string()
    .valid(...DOCKET_TYPES)
    .optional(),
  location: Joi.string().trim().max(255).allow('', null).optional(),
  docket_status: Joi.string()
    .valid(...DOCKET_STATUSES)
    .optional(),
  notes: Joi.string().trim().max(2000).allow('', null).optional(),
})
  .min(1)
  .message('At least one field must be provided to update a docket.')
  .options({ abortEarly: false });

const docketListQuerySchema = Joi.object({
  docket_date_from: isoDate().optional(),
  docket_date_to: isoDate().optional(),
  judge_id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').optional(),
  docket_status: Joi.string()
    .valid(...DOCKET_STATUSES)
    .optional(),
  limit: Joi.number().integer().min(1).max(100).default(25),
  offset: Joi.number().integer().min(0).default(0),
}).options({ abortEarly: false, presence: 'optional' });

// POST /api/dockets/:id/entries -- puts one case onto this docket.
// sequence_number is optional (a clerk building out a docket may not have
// call-order settled yet); when omitted the controller assigns the next
// integer, same convention as case_charges.count_number in
// cases.controller.js.
const docketEntryCreateSchema = Joi.object({
  case_id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').required(),
  sequence_number: Joi.number().integer().min(1).optional(),
  notes: Joi.string().trim().max(2000).allow('', null).optional(),
}).options({ abortEarly: false });

const docketEntryUpdateSchema = Joi.object({
  appearance_status: Joi.string()
    .valid(...APPEARANCE_STATUSES)
    .optional(),
  sequence_number: Joi.number().integer().min(1).optional(),
  notes: Joi.string().trim().max(2000).allow('', null).optional(),
})
  .min(1)
  .message('At least one field must be provided to update a docket entry.')
  .options({ abortEarly: false });

module.exports = {
  DOCKET_TYPES,
  DOCKET_STATUSES,
  APPEARANCE_STATUSES,
  idParamSchema,
  docketEntryParamSchema,
  docketCreateSchema,
  docketUpdateSchema,
  docketListQuerySchema,
  docketEntryCreateSchema,
  docketEntryUpdateSchema,
};
