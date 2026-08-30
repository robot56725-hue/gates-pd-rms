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

const createUserSchema = Joi.object({
  username: Joi.string().trim().lowercase().min(3).max(50).pattern(/^[a-z0-9._-]+$/).message(
    'must be 3-50 characters: letters, numbers, dot, underscore, or hyphen only'
  ).required(),
  password: passwordRule().required(),
  role: Joi.string().valid(...ROLE_VALUES).required(),
  badge_number: Joi.string().trim().min(1).max(20).required(),
  full_name: Joi.string().trim().min(1).max(120).required(),
  officer_rank: Joi.string().trim().max(40).allow('', null).optional(),
  agency: Joi.string().trim().min(1).max(120).default('Gates Police Department'),
}).options({ abortEarly: false });

// Every field optional, but at least one must be present -- a PATCH with an
// empty body is a client bug, not a no-op to silently accept.
const updateUserSchema = Joi.object({
  role: Joi.string().valid(...ROLE_VALUES).optional(),
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
