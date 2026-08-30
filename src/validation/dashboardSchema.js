'use strict';

const Joi = require('joi');

// GET /api/dashboard/upcoming-appearances -- bounded lookahead window so a
// client can never force an unbounded scan of every future docket entry;
// same rationale as the pagination caps elsewhere (caseListQuerySchema,
// etc.) even though this endpoint isn't paginated itself.
const upcomingAppearancesQuerySchema = Joi.object({
  days_ahead: Joi.number().integer().min(1).max(90).default(14),
}).options({ abortEarly: false, presence: 'optional' });

module.exports = { upcomingAppearancesQuerySchema };
