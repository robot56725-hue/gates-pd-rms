'use strict';

const Joi = require('joi');

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// GET /api/reports/monthly-summary -- month is required (YYYY-MM); there's
// no sensible "everything, all-time" default for a report whose whole
// point is a single reporting period.
const monthlySummaryQuerySchema = Joi.object({
  month: Joi.string().trim().pattern(MONTH_RE).message('must be in YYYY-MM format').required(),
}).options({ abortEarly: false });

module.exports = { monthlySummaryQuerySchema };
