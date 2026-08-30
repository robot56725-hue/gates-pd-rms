'use strict';

const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const {
  idParamSchema,
  caseChargeParamSchema,
  caseCreateSchema,
  chargeAddSchema,
  chargeUpdateSchema,
  noteCreateSchema,
  caseStatusUpdateSchema,
  caseListQuerySchema,
} = require('../validation/caseSchema');
const { findOrCreatePerson } = require('../services/personService');

const CASE_JOIN_COLUMNS = `
  cc.id, cc.case_number, cc.case_type, cc.citation_id, cc.defendant_id, cc.filed_by_id,
  cc.case_status, cc.opened_at, cc.closed_at, cc.intake_summary, cc.created_at, cc.updated_at,
  p.first_name AS defendant_first_name, p.last_name AS defendant_last_name, p.dob AS defendant_dob,
  ec.citation_number, u.badge_number AS filed_by_badge
`;
const CASE_JOIN_FROM = `
  FROM court_cases cc
  JOIN master_persons p ON p.id = cc.defendant_id
  LEFT JOIN e_citations ec ON ec.id = cc.citation_id
  LEFT JOIN users u ON u.id = cc.filed_by_id
`;

async function insertCharge(db, caseId, charge, countNumber) {
  const inserted = await db.query(
    `INSERT INTO case_charges
        (case_id, count_number, charge_category, charge_code, charge_description, fine_amount, court_costs)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      caseId,
      countNumber,
      charge.charge_category,
      charge.charge_code.trim(),
      charge.charge_description.trim(),
      charge.fine_amount ?? null,
      charge.court_costs ?? null,
    ]
  );
  return inserted.rows[0];
}

/**
 * POST /api/cases
 *
 * Opens a case either against an existing citation (case_type
 * Traffic_Citation -- validation requires citation_id) or from scratch for
 * an ordinance violation or other matter with no citation at all. Creates
 * the case and every charge in `charges` in one transaction -- withDbAudit's
 * transaction rolls back the whole thing if any one charge fails, rather
 * than leaving a case behind with only some of its counts recorded.
 *
 * A case is a clerk's explicit act of opening it, not something citation
 * issuance triggers automatically -- see migration 011's header comment.
 * Existing citations were one-time backfilled by that migration; a citation
 * issued after that backfill has no court_cases row until a clerk opens one
 * here (or picks it up via GET /api/cases?citation_id=... in a future pass).
 */
const createCase = asyncHandler(async (req, res) => {
  const { error, value: payload } = caseCreateSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  if (payload.id) {
    const existing = await db.query('SELECT id, case_number FROM court_cases WHERE id = $1', [
      payload.id,
    ]);
    if (existing.rows[0]) {
      return res.status(200).json({ ...existing.rows[0], outcome: 'duplicate_skipped' });
    }
  }

  let citation = null;
  if (payload.citation_id) {
    const citationResult = await db.query(
      `SELECT id, citation_number, violator_id FROM e_citations WHERE id = $1`,
      [payload.citation_id]
    );
    citation = citationResult.rows[0];
    if (!citation) {
      throw new AppError(422, `citation_id ${payload.citation_id} does not exist.`);
    }
    const alreadyCased = await db.query(`SELECT id FROM court_cases WHERE citation_id = $1`, [
      payload.citation_id,
    ]);
    if (alreadyCased.rows[0]) {
      throw new AppError(409, `Citation ${citation.citation_number} already has a case open (${alreadyCased.rows[0].id}).`);
    }
  }

  // Traffic_Citation cases never accept a client-supplied defendant (Joi
  // forbids defendant_id/defendant on that branch) -- the defendant is the
  // citation's own violator_id, exactly matching migration 011's backfill
  // (`c.violator_id` -> court_cases.defendant_id), so a case can never be
  // opened against someone other than who the citation actually names.
  let defendantId;
  if (citation) {
    defendantId = citation.violator_id;
  } else if (payload.defendant_id) {
    const existing = await db.query('SELECT id FROM master_persons WHERE id = $1', [payload.defendant_id]);
    if (!existing.rows[0]) {
      throw new AppError(422, `defendant_id ${payload.defendant_id} does not exist.`);
    }
    defendantId = payload.defendant_id;
  } else {
    defendantId = await findOrCreatePerson(db, payload.defendant);
  }

  // Case number: reuse the citation's own number for a traffic case (so a
  // case and its citation are recognizable as the same matter at a glance,
  // matching the backfill's convention in migration 011); otherwise draw
  // from the same GMC-YYYY-####### sequence generator that backfill's
  // sibling function pairs with.
  const caseNumber = citation
    ? citation.citation_number
    : (await db.query(`SELECT generate_court_case_number() AS n`)).rows[0].n;

  const caseResult = await db.query(
    `INSERT INTO court_cases (id, case_number, case_type, citation_id, defendant_id, filed_by_id, intake_summary)
     VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      payload.id || null,
      caseNumber,
      payload.case_type,
      payload.citation_id || null,
      defendantId,
      req.user.id,
      payload.intake_summary || null,
    ]
  );
  const courtCase = caseResult.rows[0];

  const charges = [];
  for (let i = 0; i < payload.charges.length; i++) {
    charges.push(await insertCharge(db, courtCase.id, payload.charges[i], i + 1));
  }

  res.status(201).json({ ...courtCase, charges });
});

/**
 * GET /api/cases
 *
 * q matches case_number, defendant name, or (for traffic cases) the linked
 * citation number -- a clerk usually starts a search from whichever one a
 * defendant mentions on the phone.
 */
const listCases = asyncHandler(async (req, res) => {
  const { error, value: query } = caseListQuerySchema.validate(req.query);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;
  const status = query.case_status || null;
  const caseType = query.case_type || null;
  const term = query.q ? query.q : null;

  const { rows } = await db.query(
    `SELECT ${CASE_JOIN_COLUMNS}, count(*) OVER() AS total_count
       ${CASE_JOIN_FROM}
      WHERE ($1::text IS NULL OR cc.case_status = $1)
        AND ($2::text IS NULL OR cc.case_type = $2)
        AND (
              $3::text IS NULL
              OR cc.case_number ILIKE '%' || $3 || '%'
              OR p.last_name ILIKE '%' || $3 || '%'
              OR p.first_name ILIKE '%' || $3 || '%'
              OR ec.citation_number ILIKE '%' || $3 || '%'
            )
      ORDER BY cc.opened_at DESC
      LIMIT $4 OFFSET $5`,
    [status, caseType, term, query.limit, query.offset]
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
 * GET /api/cases/:id -- full detail: the case row, every charge, and every
 * note (oldest first -- notes are append-only, so reading them in the order
 * they were written reads as a running log).
 */
const getCaseById = asyncHandler(async (req, res) => {
  const { error: paramError, value: params } = idParamSchema.validate(req.params);
  if (paramError) throw Object.assign(paramError, { isJoi: true });

  const db = req.db;

  const caseResult = await db.query(`SELECT ${CASE_JOIN_COLUMNS} ${CASE_JOIN_FROM} WHERE cc.id = $1`, [
    params.id,
  ]);
  const courtCase = caseResult.rows[0];
  if (!courtCase) {
    throw new AppError(404, 'Case not found.');
  }

  const charges = await db.query(
    `SELECT * FROM case_charges WHERE case_id = $1 ORDER BY count_number`,
    [params.id]
  );

  const notes = await db.query(
    `SELECT cn.id, cn.note_text, cn.created_at, cn.author_id, u.badge_number AS author_badge
       FROM case_notes cn
       LEFT JOIN users u ON u.id = cn.author_id
      WHERE cn.case_id = $1
      ORDER BY cn.created_at ASC`,
    [params.id]
  );

  res.status(200).json({ ...courtCase, charges: charges.rows, notes: notes.rows });
});

/**
 * POST /api/cases/:id/charges -- add an additional count to an already-open
 * case (e.g. a clerk discovers a second violation on the same matter).
 * count_number is the next integer after the highest existing one, not
 * simply charges.length + 1, so a prior charge's removal (there is no
 * delete endpoint today, but the uq_charges_case_count constraint doesn't
 * assume contiguous numbering either) never risks a collision.
 */
const addCharge = asyncHandler(async (req, res) => {
  const { error: paramError, value: params } = idParamSchema.validate(req.params);
  if (paramError) throw Object.assign(paramError, { isJoi: true });

  const { error, value: charge } = chargeAddSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const caseResult = await db.query('SELECT id FROM court_cases WHERE id = $1', [params.id]);
  if (!caseResult.rows[0]) {
    throw new AppError(404, 'Case not found.');
  }

  const maxCount = await db.query(
    `SELECT COALESCE(MAX(count_number), 0) AS max_count FROM case_charges WHERE case_id = $1`,
    [params.id]
  );
  const nextCount = Number(maxCount.rows[0].max_count) + 1;

  const inserted = await insertCharge(db, params.id, charge, nextCount);
  res.status(201).json(inserted);
});

/**
 * PATCH /api/cases/:id/charges/:chargeId -- record a plea and/or
 * disposition, adjust the assessed fine/costs. disposed_at is stamped the
 * moment disposition moves off 'Pending' and cleared if it's ever moved
 * back (a clerk undoing a mistaken disposition) -- never client-supplied,
 * so it can't drift from what disposition actually says.
 */
const updateCharge = asyncHandler(async (req, res) => {
  const { error: paramError, value: params } = caseChargeParamSchema.validate(req.params);
  if (paramError) throw Object.assign(paramError, { isJoi: true });

  const { error, value: updates } = chargeUpdateSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const existing = await db.query(
    `SELECT * FROM case_charges WHERE id = $1 AND case_id = $2`,
    [params.chargeId, params.id]
  );
  if (!existing.rows[0]) {
    throw new AppError(404, 'Charge not found on this case.');
  }

  const prospectiveDisposition = updates.disposition ?? existing.rows[0].disposition;
  const disposedAt = prospectiveDisposition === 'Pending' ? null : new Date();

  const updated = await db.query(
    `UPDATE case_charges
        SET plea         = COALESCE($1, plea),
            disposition  = COALESCE($2, disposition),
            fine_amount  = COALESCE($3, fine_amount),
            court_costs  = COALESCE($4, court_costs),
            disposed_at  = $5
      WHERE id = $6
      RETURNING *`,
    [
      updates.plea ?? null,
      updates.disposition ?? null,
      updates.fine_amount ?? null,
      updates.court_costs ?? null,
      disposedAt,
      params.chargeId,
    ]
  );

  res.status(200).json(updated.rows[0]);
});

/**
 * POST /api/cases/:id/notes -- append-only (case_notes has no UPDATE/DELETE
 * route at all, and the DB triggers block those statements outright even if
 * one were added by mistake -- see migration 011).
 */
const addNote = asyncHandler(async (req, res) => {
  const { error: paramError, value: params } = idParamSchema.validate(req.params);
  if (paramError) throw Object.assign(paramError, { isJoi: true });

  const { error, value: payload } = noteCreateSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const caseResult = await db.query('SELECT id FROM court_cases WHERE id = $1', [params.id]);
  if (!caseResult.rows[0]) {
    throw new AppError(404, 'Case not found.');
  }

  const inserted = await db.query(
    `INSERT INTO case_notes (case_id, author_id, note_text)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [params.id, req.user.id, payload.note_text.trim()]
  );

  res.status(201).json(inserted.rows[0]);
});

/**
 * PATCH /api/cases/:id/status -- close or reopen. closed_at is set/cleared
 * server-side to match case_status, matching the ck_cases_closed_at_matches_status
 * CHECK constraint in migration 011 exactly (so a bug here surfaces as a
 * clean 422 via that constraint, not silent drift).
 */
const updateCaseStatus = asyncHandler(async (req, res) => {
  const { error: paramError, value: params } = idParamSchema.validate(req.params);
  if (paramError) throw Object.assign(paramError, { isJoi: true });

  const { error, value: payload } = caseStatusUpdateSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const closedAt = payload.case_status === 'Closed' ? new Date() : null;

  const updated = await db.query(
    `UPDATE court_cases
        SET case_status = $1,
            closed_at   = $2
      WHERE id = $3
      RETURNING *`,
    [payload.case_status, closedAt, params.id]
  );

  if (!updated.rows[0]) {
    throw new AppError(404, 'Case not found.');
  }

  res.status(200).json(updated.rows[0]);
});

module.exports = {
  createCase,
  listCases,
  getCaseById,
  addCharge,
  updateCharge,
  addNote,
  updateCaseStatus,
};
