'use strict';

const Joi = require('joi');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mirrors db/migrations/011_add_court_case_management.sql's enum types.
// Kept as plain string lists here (rather than querying the DB at startup)
// so validation fails fast with a clear message before a bad value ever
// reaches Postgres -- same convention as citationSchema.js.
const CASE_TYPES = ['Traffic_Citation', 'Ordinance_Violation', 'Other'];
const CASE_STATUSES = ['Open', 'Closed'];
const CHARGE_CATEGORIES = ['TCA_Traffic', 'Municipal_Ordinance', 'Other'];
const PLEA_TYPES = ['Not_Entered', 'Guilty', 'Not_Guilty', 'No_Contest'];
// court_disposition_status -- shared with e_citations/court_ledger, extended
// by migration 011 with 'Continued' for a case-level continuance.
const DISPOSITION_STATUSES = ['Pending', 'Guilty', 'Not_Guilty', 'Dismissed', 'FTA_Failure_To_Appear', 'Continued'];

const idParamSchema = Joi.object({
  id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').required(),
});

const caseChargeParamSchema = Joi.object({
  id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').required(),
  chargeId: Joi.string().pattern(UUID_RE).message('must be a valid UUID').required(),
});

// A defendant with no existing master_persons record yet. Deliberately
// lighter than citationSchema.js's violatorSchema -- an ordinance-violation
// intake (someone cited for, say, a noise or animal-control violation) may
// never have had a full physical-description workup the way a traffic
// citation's mandatory T.C.A. 55-10-207(i) fields require, so only name is
// required here; personService.findOrCreatePerson treats everything else
// as optional.
const defendantSchema = Joi.object({
  first_name: Joi.string().trim().min(1).max(80).required(),
  middle_name: Joi.string().trim().max(80).allow('', null).optional(),
  last_name: Joi.string().trim().min(1).max(80).required(),
  dob: Joi.string()
    .trim()
    .pattern(/^\d{4}-\d{2}-\d{2}$/)
    .message('must be in YYYY-MM-DD format')
    .optional(),
  drivers_license_num: Joi.string().trim().max(40).optional(),
  dl_state: Joi.string().trim().uppercase().pattern(/^[A-Z]{2}$/).optional(),
  dl_class: Joi.string().trim().max(10).optional(),
  is_cdl: Joi.boolean().optional(),
  ssn: Joi.string()
    .trim()
    .pattern(/^\d{3}-?\d{2}-?\d{4}$/)
    .message('must be a 9-digit SSN, with or without dashes')
    .optional(),
  phone: Joi.string().trim().max(20).allow('', null).optional(),
  address: Joi.string().trim().max(255).allow('', null).optional(),
}).required();

const chargeInputSchema = Joi.object({
  charge_category: Joi.string()
    .valid(...CHARGE_CATEGORIES)
    .required(),
  charge_code: Joi.string().trim().min(1).max(30).required(),
  charge_description: Joi.string().trim().min(1).max(1000).required(),
  fine_amount: Joi.number().precision(2).min(0).max(999999.99).optional(),
  court_costs: Joi.number().precision(2).min(0).max(999999.99).optional(),
});

// POST /api/cases -- create a case either from an existing citation
// (case_type Traffic_Citation, citation_id required) or from scratch for an
// ordinance violation or other matter with no citation at all.
//
// For a Traffic_Citation case the defendant is NEVER supplied by the
// caller -- it's taken directly from the citation's own violator_id
// (e_citations.violator_id is NOT NULL), exactly like migration 011's own
// backfill (`c.violator_id` -> court_cases.defendant_id). Allowing the
// clerk to independently pick a defendant here would let a case be opened
// against someone other than the person the citation actually names, so
// defendant_id/defendant are forbidden on this branch, not just optional.
//
// For every other case_type there is no citation to derive a defendant
// from, so exactly one of defendant_id (an existing master_persons row,
// e.g. selected from a prior search) or defendant (find-or-create) must be
// supplied -- never both, never neither -- and citation_id itself is
// forbidden.
const caseCreateSchema = Joi.object({
  id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').optional(),
  case_type: Joi.string()
    .valid(...CASE_TYPES)
    .required(),
  citation_id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').optional(),
  defendant_id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').optional(),
  defendant: defendantSchema.optional(),
  intake_summary: Joi.string().trim().max(4000).allow('', null).optional(),
  charges: Joi.array().items(chargeInputSchema).min(1).required(),
})
  .when(Joi.object({ case_type: Joi.valid('Traffic_Citation') }).unknown(), {
    then: Joi.object({
      citation_id: Joi.required(),
      defendant_id: Joi.forbidden().messages({
        'any.unknown': 'defendant_id may not be supplied for a Traffic_Citation case -- the defendant is taken from the citation.',
      }),
      defendant: Joi.forbidden().messages({
        'any.unknown': 'defendant details may not be supplied for a Traffic_Citation case -- the defendant is taken from the citation.',
      }),
    }),
    otherwise: Joi.object({
      citation_id: Joi.forbidden().messages({
        'any.unknown': 'citation_id may only be supplied when case_type is Traffic_Citation.',
      }),
    }).xor('defendant_id', 'defendant'),
  })
  .messages({
    'object.xor': 'Provide either an existing defendant_id or new defendant details, not both.',
    'object.missing': 'Either defendant_id or defendant details are required.',
  })
  .options({ abortEarly: false });

const chargeAddSchema = chargeInputSchema.keys().required().options({ abortEarly: false });

// PATCH .../charges/:chargeId -- clerk records a plea and/or disposition,
// adjusts the assessed fine/costs. Every field optional (partial update),
// at least one required. disposed_at is set server-side (now()) the moment
// disposition moves off 'Pending', never client-supplied.
const chargeUpdateSchema = Joi.object({
  plea: Joi.string()
    .valid(...PLEA_TYPES)
    .optional(),
  disposition: Joi.string()
    .valid(...DISPOSITION_STATUSES)
    .optional(),
  fine_amount: Joi.number().precision(2).min(0).max(999999.99).optional(),
  court_costs: Joi.number().precision(2).min(0).max(999999.99).optional(),
})
  .min(1)
  .message('At least one field must be provided to update a charge.')
  .options({ abortEarly: false });

const noteCreateSchema = Joi.object({
  note_text: Joi.string().trim().min(1).max(4000).required(),
}).options({ abortEarly: false });

// PATCH /api/cases/:id/status -- open/close. Reopening a closed case is
// allowed (a clerk correcting a premature closure); closed_at is cleared
// server-side when reopened, set server-side when closed.
const caseStatusUpdateSchema = Joi.object({
  case_status: Joi.string()
    .valid(...CASE_STATUSES)
    .required(),
}).options({ abortEarly: false });

const caseListQuerySchema = Joi.object({
  q: Joi.string().trim().max(120).allow('', null).optional(),
  case_status: Joi.string()
    .valid(...CASE_STATUSES)
    .optional(),
  case_type: Joi.string()
    .valid(...CASE_TYPES)
    .optional(),
  limit: Joi.number().integer().min(1).max(100).default(25),
  offset: Joi.number().integer().min(0).default(0),
}).options({ abortEarly: false, presence: 'optional' });

module.exports = {
  CASE_TYPES,
  CASE_STATUSES,
  CHARGE_CATEGORIES,
  PLEA_TYPES,
  DISPOSITION_STATUSES,
  idParamSchema,
  caseChargeParamSchema,
  caseCreateSchema,
  chargeAddSchema,
  chargeUpdateSchema,
  noteCreateSchema,
  caseStatusUpdateSchema,
  caseListQuerySchema,
};
