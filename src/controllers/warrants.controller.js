'use strict';

const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const {
  idParamSchema,
  warrantCreateSchema,
  warrantStatusUpdateSchema,
  warrantListQuerySchema,
} = require('../validation/warrantSchema');

const WARRANT_JOIN_COLUMNS = `
  cw.id, cw.case_id, cw.judge_id, cw.warrant_type, cw.warrant_status,
  cw.issued_at, cw.recalled_at, cw.served_at, cw.notes, cw.created_by_id,
  cw.created_at, cw.updated_at,
  cc.case_number, cj.full_name AS judge_name
`;
const WARRANT_JOIN_FROM = `
  FROM court_warrants cw
  JOIN court_cases cc ON cc.id = cw.case_id
  LEFT JOIN court_judges cj ON cj.id = cw.judge_id
`;

/**
 * POST /api/warrants -- records that a warrant application was prepared for
 * a case. Tracking only, per migration 011's own comment: the actual legal
 * instrument still requires a real judge's signature obtained outside this
 * system, so this is never mistaken for that signature.
 */
const createWarrant = asyncHandler(async (req, res) => {
  const { error, value: payload } = warrantCreateSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const caseResult = await db.query('SELECT id FROM court_cases WHERE id = $1', [payload.case_id]);
  if (!caseResult.rows[0]) {
    throw new AppError(422, `case_id ${payload.case_id} does not exist.`);
  }

  if (payload.judge_id) {
    const judgeResult = await db.query('SELECT id FROM court_judges WHERE id = $1', [payload.judge_id]);
    if (!judgeResult.rows[0]) {
      throw new AppError(422, `judge_id ${payload.judge_id} does not exist.`);
    }
  }

  const inserted = await db.query(
    `INSERT INTO court_warrants (case_id, judge_id, warrant_type, notes, created_by_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [payload.case_id, payload.judge_id || null, payload.warrant_type, payload.notes || null, req.user.id]
  );

  res.status(201).json(inserted.rows[0]);
});

const listWarrants = asyncHandler(async (req, res) => {
  const { error, value: query } = warrantListQuerySchema.validate(req.query);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const { rows } = await db.query(
    `SELECT ${WARRANT_JOIN_COLUMNS}, count(*) OVER() AS total_count
       ${WARRANT_JOIN_FROM}
      WHERE ($1::uuid IS NULL OR cw.case_id = $1)
        AND ($2::text IS NULL OR cw.warrant_status = $2)
      ORDER BY cw.issued_at DESC
      LIMIT $3 OFFSET $4`,
    [query.case_id || null, query.warrant_status || null, query.limit, query.offset]
  );

  const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
  res.status(200).json({
    results: rows.map(({ total_count, ...row }) => row),
    total,
    limit: query.limit,
    offset: query.offset,
  });
});

const getWarrantById = asyncHandler(async (req, res) => {
  const { error: paramError, value: params } = idParamSchema.validate(req.params);
  if (paramError) throw Object.assign(paramError, { isJoi: true });

  const db = req.db;

  const result = await db.query(`SELECT ${WARRANT_JOIN_COLUMNS} ${WARRANT_JOIN_FROM} WHERE cw.id = $1`, [
    params.id,
  ]);
  if (!result.rows[0]) {
    throw new AppError(404, 'Warrant not found.');
  }

  res.status(200).json(result.rows[0]);
});

/**
 * PATCH /api/warrants/:id/status -- Issued -> Recalled or Issued -> Served,
 * one-way. Refuses to change a warrant that's already Recalled or Served:
 * both are terminal outcomes of that specific warrant application (a
 * Recalled warrant needing reinstatement, or a Served one needing a
 * follow-up action, is a fresh POST, not an edit of this one).
 * recalled_at/served_at are stamped server-side to match, never
 * client-supplied.
 */
const updateWarrantStatus = asyncHandler(async (req, res) => {
  const { error: paramError, value: params } = idParamSchema.validate(req.params);
  if (paramError) throw Object.assign(paramError, { isJoi: true });

  const { error, value: payload } = warrantStatusUpdateSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const existingResult = await db.query('SELECT * FROM court_warrants WHERE id = $1', [params.id]);
  const existing = existingResult.rows[0];
  if (!existing) {
    throw new AppError(404, 'Warrant not found.');
  }
  if (existing.warrant_status !== 'Issued') {
    throw new AppError(409, `This warrant is already ${existing.warrant_status} and cannot be changed further.`);
  }

  const recalledAt = payload.warrant_status === 'Recalled' ? new Date() : null;
  const servedAt = payload.warrant_status === 'Served' ? new Date() : null;

  const updated = await db.query(
    `UPDATE court_warrants
        SET warrant_status = $1,
            recalled_at    = $2,
            served_at      = $3,
            notes          = COALESCE($4, notes)
      WHERE id = $5
      RETURNING *`,
    [payload.warrant_status, recalledAt, servedAt, payload.notes || null, params.id]
  );

  res.status(200).json(updated.rows[0]);
});

module.exports = { createWarrant, listWarrants, getWarrantById, updateWarrantStatus };
