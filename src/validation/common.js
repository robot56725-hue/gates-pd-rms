'use strict';

const Joi = require('joi');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const idParamSchema = Joi.object({
  id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').required(),
});

// Shared shape for every search/list endpoint: a free-text query plus
// bounded pagination. limit is capped at 100 so a client can never force an
// unbounded full-table scan/response -- a mobile client on a slow connection
// benefits from the same cap a malicious client would be blocked by.
const listQuerySchema = Joi.object({
  q: Joi.string().trim().max(120).allow('', null).optional(),
  limit: Joi.number().integer().min(1).max(100).default(25),
  offset: Joi.number().integer().min(0).default(0),
}).options({ abortEarly: false, presence: 'optional' });

module.exports = { UUID_RE, idParamSchema, listQuerySchema };
