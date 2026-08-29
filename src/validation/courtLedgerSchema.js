'use strict';

const Joi = require('joi');

const COURT_STATUSES = ['Pending', 'Guilty', 'Not_Guilty', 'Dismissed', 'FTA_Failure_To_Appear'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const citationIdParamSchema = Joi.object({
  id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').required(),
});

// Every field optional (partial update -- a clerk patches only what
// changed), but at least one must be supplied. money fields capped at two
// decimal places to match the currency_amount DOMAIN in the database.
const courtLedgerUpdateSchema = Joi.object({
  court_status: Joi.string()
    .valid(...COURT_STATUSES)
    .optional(),
  fine_amount_due: Joi.number().precision(2).min(0).max(999999.99).optional(),
  amount_paid: Joi.number().precision(2).min(0).max(999999.99).optional(),
  payment_date: Joi.date().iso().optional(),
  disposition_notes: Joi.string().trim().max(2000).allow('', null).optional(),
})
  .min(1)
  .message('At least one field must be provided to update the court ledger.')
  .options({ abortEarly: false, presence: 'optional' });

module.exports = { COURT_STATUSES, citationIdParamSchema, courtLedgerUpdateSchema };
