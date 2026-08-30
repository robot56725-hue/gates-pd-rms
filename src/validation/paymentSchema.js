'use strict';

const Joi = require('joi');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mirrors db/migrations/011_add_court_case_management.sql's enum types.
const PAYMENT_METHODS = ['Cash', 'Check', 'Money_Order', 'Card_In_Person', 'Card_Online', 'Other'];
const PAYMENT_TYPES = ['Fine', 'Court_Cost', 'Bond', 'Other_Fee'];

const idParamSchema = Joi.object({
  id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').required(),
});

// POST /api/payments -- court_payments is append-only (migration 011: a
// correction is a new offsetting row, never an edit to history), so this is
// the only way money ever gets recorded. receipt_number is NEVER accepted
// from the client -- it's always minted server-side from the same
// generate_receipt_number()/receipt_number_seq the migration defines, so
// numbering can never collide or be spoofed.
//
// amount's sign is tied to voids_payment_id: a normal payment is positive;
// a void/reversal (voids_payment_id supplied) must be negative, mirroring
// the migration's own comment ("amount allows negative specifically so a
// void/reversal can be recorded... rather than an UPDATE") -- a client
// can't post a negative amount without saying what it's voiding, and can't
// reference voids_payment_id without actually reducing the ledger.
const paymentCreateSchema = Joi.object({
  case_id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').required(),
  charge_id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').optional(),
  amount: Joi.number().precision(2).min(-99999999.99).max(99999999.99).invalid(0).required(),
  payment_method: Joi.string()
    .valid(...PAYMENT_METHODS)
    .required(),
  payment_type: Joi.string()
    .valid(...PAYMENT_TYPES)
    .required(),
  fund_category_id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').optional(),
  voids_payment_id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').optional(),
  notes: Joi.string().trim().max(2000).allow('', null).optional(),
  // paid_at defaults to now() at the DB layer (migration 011) when omitted --
  // only supplied here to backdate/log a payment actually received earlier
  // (e.g. entering a mailed-in check the day after it arrived).
  paid_at: Joi.string().isoDate().message('must be an ISO-8601 date-time').optional(),
})
  .custom((value, helpers) => {
    if (value.voids_payment_id && value.amount >= 0) {
      return helpers.message(
        'amount must be negative when voids_payment_id is supplied -- a void/reversal reduces the ledger.'
      );
    }
    if (!value.voids_payment_id && value.amount <= 0) {
      return helpers.message('amount must be positive unless voids_payment_id is supplied.');
    }
    return value;
  })
  .options({ abortEarly: false });

const paymentListQuerySchema = Joi.object({
  case_id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').optional(),
  payment_type: Joi.string()
    .valid(...PAYMENT_TYPES)
    .optional(),
  payment_method: Joi.string()
    .valid(...PAYMENT_METHODS)
    .optional(),
  fund_category_id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').optional(),
  paid_from: Joi.string().isoDate().message('must be an ISO-8601 date-time').optional(),
  paid_to: Joi.string().isoDate().message('must be an ISO-8601 date-time').optional(),
  limit: Joi.number().integer().min(1).max(100).default(25),
  offset: Joi.number().integer().min(0).default(0),
}).options({ abortEarly: false, presence: 'optional' });

// GET /api/payments/fund-distribution-report -- an omitted bound is
// unbounded on that side (all-time to date, or everything through a given
// date), matching how a finance office would ask "how much has come in for
// fund X" absent a specific reporting period.
const fundDistributionQuerySchema = Joi.object({
  date_from: Joi.string().isoDate().message('must be an ISO-8601 date-time').optional(),
  date_to: Joi.string().isoDate().message('must be an ISO-8601 date-time').optional(),
}).options({ abortEarly: false, presence: 'optional' });

module.exports = {
  PAYMENT_METHODS,
  PAYMENT_TYPES,
  idParamSchema,
  paymentCreateSchema,
  paymentListQuerySchema,
  fundDistributionQuerySchema,
};
