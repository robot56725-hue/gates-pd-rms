'use strict';

const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const {
  idParamSchema,
  docketEntryParamSchema,
  docketCreateSchema,
  docketUpdateSchema,
  docketListQuerySchema,
  docketEntryCreateSchema,
  docketEntryUpdateSchema,
} = require('../validation/docketSchema');

const DOCKET_JOIN_COLUMNS = `
  cd.id, cd.docket_date, cd.docket_time, cd.judge_id, cd.docket_type, cd.location,
  cd.docket_status, cd.notes, cd.created_by_id, cd.created_at, cd.updated_at,
  cj.full_name AS judge_name
`;
const DOCKET_JOIN_FROM = `
  FROM court_dockets cd
  LEFT JOIN court_judges cj ON cj.id = cd.judge_id
`;

/**
 * Throws a 409 if `judgeId` has a judge_unavailability row covering
 * `docketDate` -- judge_unavailability is exception-based (migration 011):
 * a judge is assumed available unless a range here says otherwise, so this
 * is the one place that assumption gets enforced rather than left as
 * reference data nothing ever reads.
 */
async function assertJudgeAvailable(db, judgeId, docketDate) {
  if (!judgeId) return;
  const conflict = await db.query(
    `SELECT ju.start_date, ju.end_date, ju.reason, cj.full_name
       FROM judge_unavailability ju
       JOIN court_judges cj ON cj.id = ju.judge_id
      WHERE ju.judge_id = $1
        AND $2::date BETWEEN ju.start_date AND ju.end_date`,
    [judgeId, docketDate]
  );
  const row = conflict.rows[0];
  if (row) {
    const reasonSuffix = row.reason ? ` (${row.reason})` : '';
    throw new AppError(
      409,
      `${row.full_name} is marked unavailable ${row.start_date.toISOString().slice(0, 10)} to ${row.end_date
        .toISOString()
        .slice(0, 10)}${reasonSuffix} and cannot be assigned to a docket on ${docketDate}.`
    );
  }
}

/**
 * POST /api/dockets -- schedules a court session. judge_id is optional at
 * creation (a clerk may block off a date/time before a judge is confirmed)
 * but when supplied is checked against judge_unavailability first.
 */
const createDocket = asyncHandler(async (req, res) => {
  const { error, value: payload } = docketCreateSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  if (payload.id) {
    const existing = await db.query('SELECT id FROM court_dockets WHERE id = $1', [payload.id]);
    if (existing.rows[0]) {
      return res.status(200).json({ ...existing.rows[0], outcome: 'duplicate_skipped' });
    }
  }

  if (payload.judge_id) {
    const judgeResult = await db.query('SELECT id FROM court_judges WHERE id = $1', [payload.judge_id]);
    if (!judgeResult.rows[0]) {
      throw new AppError(422, `judge_id ${payload.judge_id} does not exist.`);
    }
    await assertJudgeAvailable(db, payload.judge_id, payload.docket_date);
  }

  const inserted = await db.query(
    `INSERT INTO court_dockets (id, docket_date, docket_time, judge_id, docket_type, location, notes, created_by_id)
     VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, COALESCE($5, 'Traffic'), $6, $7, $8)
     RETURNING *`,
    [
      payload.id || null,
      payload.docket_date,
      payload.docket_time || null,
      payload.judge_id || null,
      payload.docket_type || null,
      payload.location || null,
      payload.notes || null,
      req.user.id,
    ]
  );

  res.status(201).json(inserted.rows[0]);
});

const listDockets = asyncHandler(async (req, res) => {
  const { error, value: query } = docketListQuerySchema.validate(req.query);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const { rows } = await db.query(
    `SELECT ${DOCKET_JOIN_COLUMNS}, count(*) OVER() AS total_count
       ${DOCKET_JOIN_FROM}
      WHERE ($1::date IS NULL OR cd.docket_date >= $1)
        AND ($2::date IS NULL OR cd.docket_date <= $2)
        AND ($3::uuid IS NULL OR cd.judge_id = $3)
        AND ($4::text IS NULL OR cd.docket_status = $4)
      ORDER BY cd.docket_date ASC, cd.docket_time ASC NULLS LAST
      LIMIT $5 OFFSET $6`,
    [
      query.docket_date_from || null,
      query.docket_date_to || null,
      query.judge_id || null,
      query.docket_status || null,
      query.limit,
      query.offset,
    ]
  );

  const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
  res.status(200).json({
    results: rows.map(({ total_count, ...row }) => row),
    total,
    limit: query.limit,
    offset: query.offset,
  });
});

/**
 * GET /api/dockets/:id -- full detail: the docket row plus every entry
 * (case appearance), joined against court_cases/master_persons so the
 * calendar view can render a defendant's name without a second round trip
 * per entry.
 */
const getDocketById = asyncHandler(async (req, res) => {
  const { error: paramError, value: params } = idParamSchema.validate(req.params);
  if (paramError) throw Object.assign(paramError, { isJoi: true });

  const db = req.db;

  const docketResult = await db.query(`SELECT ${DOCKET_JOIN_COLUMNS} ${DOCKET_JOIN_FROM} WHERE cd.id = $1`, [
    params.id,
  ]);
  const docket = docketResult.rows[0];
  if (!docket) {
    throw new AppError(404, 'Docket not found.');
  }

  const entries = await db.query(
    `SELECT de.id, de.docket_id, de.case_id, de.sequence_number, de.appearance_status, de.notes,
            de.created_at, de.updated_at,
            cc.case_number, cc.case_type,
            p.first_name AS defendant_first_name, p.last_name AS defendant_last_name
       FROM docket_entries de
       JOIN court_cases cc ON cc.id = de.case_id
       JOIN master_persons p ON p.id = cc.defendant_id
      WHERE de.docket_id = $1
      ORDER BY de.sequence_number ASC NULLS LAST, de.created_at ASC`,
    [params.id]
  );

  res.status(200).json({ ...docket, entries: entries.rows });
});

/**
 * PATCH /api/dockets/:id -- partial update. If either docket_date or
 * judge_id is changing, re-checks judge availability against the resulting
 * (possibly-unchanged) pairing -- moving a docket's date, or reassigning its
 * judge, must not silently create a conflict that a create-time check would
 * have caught.
 */
const updateDocket = asyncHandler(async (req, res) => {
  const { error: paramError, value: params } = idParamSchema.validate(req.params);
  if (paramError) throw Object.assign(paramError, { isJoi: true });

  const { error, value: updates } = docketUpdateSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const existingResult = await db.query('SELECT * FROM court_dockets WHERE id = $1', [params.id]);
  const existing = existingResult.rows[0];
  if (!existing) {
    throw new AppError(404, 'Docket not found.');
  }

  const nextJudgeId = updates.judge_id !== undefined ? updates.judge_id : existing.judge_id;
  const nextDocketDate = updates.docket_date || existing.docket_date;

  if (nextJudgeId) {
    const judgeResult = await db.query('SELECT id FROM court_judges WHERE id = $1', [nextJudgeId]);
    if (!judgeResult.rows[0]) {
      throw new AppError(422, `judge_id ${nextJudgeId} does not exist.`);
    }
    await assertJudgeAvailable(db, nextJudgeId, nextDocketDate);
  }

  const updated = await db.query(
    `UPDATE court_dockets
        SET docket_date   = COALESCE($1, docket_date),
            docket_time   = CASE WHEN $2 THEN $3 ELSE docket_time END,
            judge_id      = CASE WHEN $4 THEN $5 ELSE judge_id END,
            docket_type   = COALESCE($6, docket_type),
            location      = COALESCE($7, location),
            docket_status = COALESCE($8, docket_status),
            notes         = COALESCE($9, notes)
      WHERE id = $10
      RETURNING *`,
    [
      updates.docket_date || null,
      updates.docket_time !== undefined,
      updates.docket_time ?? null,
      updates.judge_id !== undefined,
      updates.judge_id ?? null,
      updates.docket_type || null,
      updates.location || null,
      updates.docket_status || null,
      updates.notes || null,
      params.id,
    ]
  );

  res.status(200).json(updated.rows[0]);
});

/**
 * POST /api/dockets/:id/entries -- puts one case onto this docket.
 * uq_docket_entries_docket_case (migration 011) blocks the same case
 * appearing twice on one docket at the DB level; surfaced here as a clean
 * 409 rather than a raw constraint-violation 500.
 */
const addDocketEntry = asyncHandler(async (req, res) => {
  const { error: paramError, value: params } = idParamSchema.validate(req.params);
  if (paramError) throw Object.assign(paramError, { isJoi: true });

  const { error, value: payload } = docketEntryCreateSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const docketResult = await db.query('SELECT id FROM court_dockets WHERE id = $1', [params.id]);
  if (!docketResult.rows[0]) {
    throw new AppError(404, 'Docket not found.');
  }

  const caseResult = await db.query('SELECT id FROM court_cases WHERE id = $1', [payload.case_id]);
  if (!caseResult.rows[0]) {
    throw new AppError(422, `case_id ${payload.case_id} does not exist.`);
  }

  const alreadyOnDocket = await db.query(
    `SELECT id FROM docket_entries WHERE docket_id = $1 AND case_id = $2`,
    [params.id, payload.case_id]
  );
  if (alreadyOnDocket.rows[0]) {
    throw new AppError(409, 'This case is already on this docket.');
  }

  let sequenceNumber = payload.sequence_number;
  if (sequenceNumber === undefined) {
    const maxSeq = await db.query(
      `SELECT COALESCE(MAX(sequence_number), 0) AS max_seq FROM docket_entries WHERE docket_id = $1`,
      [params.id]
    );
    sequenceNumber = Number(maxSeq.rows[0].max_seq) + 1;
  }

  const inserted = await db.query(
    `INSERT INTO docket_entries (docket_id, case_id, sequence_number, notes)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [params.id, payload.case_id, sequenceNumber, payload.notes || null]
  );

  res.status(201).json(inserted.rows[0]);
});

/**
 * PATCH /api/dockets/:id/entries/:entryId -- most commonly used to record
 * appearance_status (Appeared/FTA/Continued/Removed) after the session, or
 * to reorder the call sequence beforehand.
 */
const updateDocketEntry = asyncHandler(async (req, res) => {
  const { error: paramError, value: params } = docketEntryParamSchema.validate(req.params);
  if (paramError) throw Object.assign(paramError, { isJoi: true });

  const { error, value: updates } = docketEntryUpdateSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const updated = await db.query(
    `UPDATE docket_entries
        SET appearance_status = COALESCE($1, appearance_status),
            sequence_number   = COALESCE($2, sequence_number),
            notes             = COALESCE($3, notes)
      WHERE id = $4 AND docket_id = $5
      RETURNING *`,
    [updates.appearance_status ?? null, updates.sequence_number ?? null, updates.notes ?? null, params.entryId, params.id]
  );

  if (!updated.rows[0]) {
    throw new AppError(404, 'Docket entry not found on this docket.');
  }

  res.status(200).json(updated.rows[0]);
});

module.exports = {
  createDocket,
  listDockets,
  getDocketById,
  updateDocket,
  addDocketEntry,
  updateDocketEntry,
};
