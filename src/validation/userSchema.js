'use strict';

const Joi = require('joi');
const { VALID_ROLES } = require('../middleware/auth');

const ROLE_VALUES = Array.from(VALID_ROLES);

// A department-managed account, not a public signup -- the Chief/admin sets
// the initial password directly (see users.controller.js), so this only
// needs to keep someone from typing in something trivially guessable, not
// enforce a public-facing password policy with confirmation flows etc.
const passwordRule = () =>
  Joi.string().min(10).max(200).message('must be at least 10 characters');

// additional_roles: operational capabilities beyond the account's primary
// `role` (see db/migrations/008_..._multirole_...sql for why this is
// additive-only and does not affect the users/court_ledger RLS gates).
// Deduplicated against `role` itself in the controller, not here, since
// role/additional_roles arrive as two separate fields on this schema.
const rolesArray = () => Joi.array().items(Joi.string().valid(...ROLE_VALUES)).max(ROLE_VALUES.length);

const createUserSchema = Joi.object({
  username: Joi.string().trim().lowercase().min(3).max(50).pattern(/^[a-z0-9._-]+$/).message(
    'must be 3-50 characters: letters, numbers, dot, underscore, or hyphen only'
  ).required(),
  password: passwordRule().required(),
  role: Joi.string().valid(...ROLE_VALUES).required(),
  // Defaults to [] here (create) only -- on update, an omitted
  // additional_roles must leave the existing value alone, not default to [].
  additional_roles: rolesArray().default([]),
  badge_number: Joi.string().trim().min(1).max(20).required(),
  full_name: Joi.string().trim().min(1).max(120).required(),
  officer_rank: Joi.string().trim().max(40).allow('', null).optional(),
  agency: Joi.string().trim().min(1).max(120).default('Gates Police Department'),
}).options({ abortEarly: false });

// Every field optional, but at least one must be present -- a PATCH with an
// empty body is a client bug, not a no-op to silently accept. No default()
// on additional_roles here: an omitted field must mean "leave unchanged",
// which the controller implements via COALESCE -- a default would silently
// wipe existing additional_roles on every PATCH that doesn't mention them.
const updateUserSchema = Joi.object({
  role: Joi.string().valid(...ROLE_VALUES).optional(),
  additional_roles: rolesArray().optional(),
  badge_number: Joi.string().trim().min(1).max(20).optional(),
  full_name: Joi.string().trim().min(1).max(120).optional(),
  officer_rank: Joi.string().trim().max(40).allow('', null).optional(),
  agency: Joi.string().trim().min(1).max(120).optional(),
  is_active: Joi.boolean().optional(),
  new_password: passwordRule().optional(),
})
  .min(1)
  .options({ abortEarly: false });

module.exports = { createUserSchema, updateUserSchema, ROLE_VALUES };
