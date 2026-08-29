'use strict';

const Joi = require('joi');

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const monthlyValidationQuerySchema = Joi.object({
  month: Joi.string()
    .pattern(MONTH_RE)
    .message('must be in YYYY-MM format')
    .required(),
});

module.exports = { monthlyValidationQuerySchema };
