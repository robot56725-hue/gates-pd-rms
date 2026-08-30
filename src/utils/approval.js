'use strict';

const Joi = require('joi');
const AppError = require('./AppError');
const asyncHandler = require('./asyncHandler');
const { idParamSchema } = require('../validation/common');

// Shared by the incidents/crashes/citations/evidence approval endpoints --
// see db/migrations/008_..._multirole_...sql for the approval_status column
// each of those tables carries. 'Pending' is only ever the default a fresh
// submission starts in; a Supervisor/System_Admin explicitly moves it to
// Approved or Rejected, never back to Pending through this endpoint.
const approvalSchema = Joi.object({
  approval_status: Joi.string().valid('Approved', 'Rejected').required(),
  approval_notes: Joi.string().trim().max(2000).allow('', null).optional(),
}).options({ abortEarly: false });

/**
 * Builds a PATCH /:id/approval handler for one of the four
 * approval_status-carrying tables. `tableName` is always a fixed,
 * hardcoded string supplied by the route file that calls this (never
 * request input), so interpolating it into the query is safe.
 */
function makeApprovalHandler(tableName, notFoundMessage) {
  return asyncHandler(async (req, res) => {
    const { error: paramsError, value: params } = idParamSchema.validate(req.params);
    if (paramsError) throw Object.assign(paramsError, { isJoi: true });

    const { error, value } = approvalSchema.validate(req.body);
    if (error) throw Object.assign(error, { isJoi: true });

    const { rows } = await req.db.query(
      `UPDATE ${tableName}
          SET approval_status = $1, approved_by_id = $2, approved_at = now(), approval_notes = $3
        WHERE id = $4
        RETURNING id, approval_status, approved_by_id, approved_at, approval_notes`,
      [value.approval_status, req.user.id, value.approval_notes ? value.approval_notes.trim() : null, params.id]
    );

    if (!rows[0]) {
      throw new AppError(404, notFoundMessage || 'Record not found.');
    }

    res.status(200).json(rows[0]);
  });
}

module.exports = { makeApprovalHandler, approvalSchema };
