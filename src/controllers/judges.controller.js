'use strict';

const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const {
  idParamSchema,
  unavailabilityParamSchema,
  judgeCreateSchema,
  judgeUpdateSchema,
  judgeListQuerySchema,
  unavailabilityCreateSchema,
} = require('../validation/judgeSchema');

/**
 * POST /api/judges -- court_judges is a lightweight reference list, not a
 * user account (see migration 011's own comment); no email/password/role,
 * just enough to name a judge on a docket or warrant.
 */
const createJudge = asyncHandler(async (req, res) => {
  const { error, value: payload } = judgeCreateSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const inserted = await db.query(
    `INSERT INTO court_judges (full_name, is_active) VALUES ($1, $2) RETURNING *`,
    [payload.full_name.trim(), payload.is_active ?? true]
  );

  res.status(201).json(inserted.rows[0]);
});

/**
 * GET /api/judges -- defaults to every judge (active and inactive) unless
 * is_active is explicitly supplied, so a clerk assigning a docket sees the
 * active roster by passing ?is_active=true, while an admin auditing the
 * full reference list sees everyone by omitting it.
 */
const listJudges = asyncHandler(async (req, res) => {
  const { error, value: query } = judgeListQuerySchema.validate(req.query);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;
  const isActive = query.is_active === undefined ? null : query.is_active;

  const { rows } = await db.query(
    `SELECT *, count(*) OVER() AS total_count
       FROM court_judges
      WHERE ($1::boolean IS NULL OR is_active = $1)
      ORDER BY full_name ASC
      LIMIT $2 OFFSET $3`,
    [isActive, query.limit, query.offset]
  );

  const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
  res.status(200).json({
    results: rows.map(({ total_count, ...row }) => row),
    total,
    limit: query.limit,
    offset: query.offset,
  });
});

const getJudgeById = asyncHandler(async (req, res) => {
  const { error: paramError, value: params } = idParamSchema.validate(req.params);
  if (paramError) throw Object.assign(paramError, { isJoi: true });

  const db = req.db;

  const judgeResult = await db.query('SELECT * FROM court_judges WHERE id = $1', [params.id]);
  const judge = judgeResult.rows[0];
  if (!judge) {
    throw new AppError(404, 'Judge not found.');
  }

  const unavailability = await db.query(
    `SELECT * FROM judge_unavailability WHERE judge_id = $1 ORDER BY start_date DESC`,
    [params.id]
  );

  res.status(200).json({ ...judge, unavailability: unavailability.rows });
});

const updateJudge = asyncHandler(async (req, res) => {
  const { error: paramError, value: params } = idParamSchema.validate(req.params);
  if (paramError) throw Object.assign(paramError, { isJoi: true });

  const { error, value: updates } = judgeUpdateSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const updated = await db.query(
    `UPDATE court_judges
        SET full_name = COALESCE($1, full_name),
            is_active = COALESCE($2, is_active)
      WHERE id = $3
      RETURNING *`,
    [updates.full_name ? updates.full_name.trim() : null, updates.is_active ?? null, params.id]
  );

  if (!updated.rows[0]) {
    throw new AppError(404, 'Judge not found.');
  }

  res.status(200).json(updated.rows[0]);
});

/**
 * POST /api/judges/:id/unavailability -- record a date range this judge
 * cannot sit. Exception-based per migration 011's comment: a judge is
 * assumed available unless a range here says otherwise, so this is additive
 * (no calendar of positive availability to maintain).
 */
const addUnavailability = asyncHandler(async (req, res) => {
  const { error: paramError, value: params } = idParamSchema.validate(req.params);
  if (paramError) throw Object.assign(paramError, { isJoi: true });

  const { error, value: payload } = unavailabilityCreateSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const judgeResult = await db.query('SELECT id FROM court_judges WHERE id = $1', [params.id]);
  if (!judgeResult.rows[0]) {
    throw new AppError(404, 'Judge not found.');
  }

  const inserted = await db.query(
    `INSERT INTO judge_unavailability (judge_id, start_date, end_date, reason)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [params.id, payload.start_date, payload.end_date, payload.reason || null]
  );

  res.status(201).json(inserted.rows[0]);
});

/**
 * DELETE /api/judges/:id/unavailability/:unavailabilityId -- corrects a
 * mistaken entry. judge_unavailability carries no legal-record/append-only
 * trigger (unlike case_notes/court_payments) -- it's scheduling metadata,
 * not a record of what happened, so a plain delete is appropriate here.
 */
const removeUnavailability = asyncHandler(async (req, res) => {
  const { error: paramError, value: params } = unavailabilityParamSchema.validate(req.params);
  if (paramError) throw Object.assign(paramError, { isJoi: true });

  const db = req.db;

  const deleted = await db.query(
    `DELETE FROM judge_unavailability WHERE id = $1 AND judge_id = $2 RETURNING id`,
    [params.unavailabilityId, params.id]
  );

  if (!deleted.rows[0]) {
    throw new AppError(404, 'Unavailability entry not found for this judge.');
  }

  res.status(204).send();
});

module.exports = {
  createJudge,
  listJudges,
  getJudgeById,
  updateJudge,
  addUnavailability,
  removeUnavailability,
};
