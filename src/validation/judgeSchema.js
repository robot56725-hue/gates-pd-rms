'use strict';

const Joi = require('joi');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isoDate = () => Joi.string().trim().pattern(DATE_RE).message('must be in YYYY-MM-DD format');

const idParamSchema = Joi.object({
  id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').required(),
});

const unavailabilityParamSchema = Joi.object({
  id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').required(),
  unavailabilityId: Joi.string().pattern(UUID_RE).message('must be a valid UUID').required(),
});

// court_judges is a lightweight reference list (migration 011) -- judges do
// not log into this system, so there's no email/password/role here, just
// enough to name one on a docket or warrant.
const judgeCreateSchema = Joi.object({
  full_name: Joi.string().trim().min(1).max(200).required(),
  is_active: Joi.boolean().optional(),
}).options({ abortEarly: false });

const judgeUpdateSchema = Joi.object({
  full_name: Joi.string().trim().min(1).max(200).optional(),
  is_active: Joi.boolean().optional(),
})
  .min(1)
  .message('At least one field must be provided to update a judge.')
  .options({ abortEarly: false });

const judgeListQuerySchema = Joi.object({
  is_active: Joi.boolean().optional(),
  limit: Joi.number().integer().min(1).max(100).default(25),
  offset: Joi.number().integer().min(0).default(0),
}).options({ abortEarly: false, presence: 'optional' });

// judge_unavailability is exception-based (migration 011's own comment): a
// judge is assumed available unless a date range here says otherwise, so
// end_date must be on/after start_date -- mirrors
// ck_unavailability_date_order exactly, so a bad range fails fast here
// rather than surfacing as a raw constraint-violation 500/422 from Postgres.
const unavailabilityCreateSchema = Joi.object({
  start_date: isoDate().required(),
  end_date: isoDate().required(),
  reason: Joi.string().trim().max(500).allow('', null).optional(),
})
  .custom((value, helpers) => {
    if (value.end_date < value.start_date) {
      return helpers.message('end_date must be on or after start_date.');
    }
    return value;
  })
  .options({ abortEarly: false });

module.exports = {
  idParamSchema,
  unavailabilityParamSchema,
  judgeCreateSchema,
  judgeUpdateSchema,
  judgeListQuerySchema,
  unavailabilityCreateSchema,
};
