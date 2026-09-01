'use strict';

const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const {
  morCreateSchema,
  morUpdateSchema,
  morAddPersonSchema,
  morListQuerySchema,
} = require('../validation/morSchema');
const { idParamSchema } = require('../validation/common');
const { findOrCreatePerson } = require('../services/personService');
const { makeApprovalHandler } = require('../utils/approval');

/**
 * Inserts one mor_persons row per entry in `persons`, resolving each to a
 * master_persons id -- either directly (`person_id`) or via
 * findOrCreatePerson, same dedupe-by-DL logic every other module uses.
 * Mirrors incidents.controller.js's insertIncidentPersons, simplified: no
 * physical-description fields, and role is just Involved_Party/Witness.
 */
async function insertMorPersons(db, morId, persons) {
  const roleSequence = {};

  for (const person of persons) {
    let personId = person.person_id;
    if (personId) {
      const existing = await db.query('SELECT id FROM master_persons WHERE id = $1', [personId]);
      if (!existing.rows[0]) {
        throw new AppError(422, `persons: person_id ${personId} does not exist.`);
      }
    } else {
      if (!person.first_name || !person.last_name) {
        throw new AppError(
          422,
          'persons: first_name and last_name are required when person_id is not supplied.'
        );
      }
      personId = await findOrCreatePerson(db, person);
    }

    const nextSeq = (roleSequence[person.role] || 0) + 1;
    roleSequence[person.role] = nextSeq;

    await db.query(
      `INSERT INTO mor_persons (mor_id, person_id, role, sequence_number)
       VALUES ($1, $2, $3, $4)`,
      [morId, personId, person.role, nextSeq]
    );
  }
}

/**
 * POST /api/mor
 *
 * Creates a Matter of Record: the non-arrest counterpart to POST
 * /api/incidents (incidents.controller.js) for documenting a response, a
 * mediated dispute, a welfare check, or similar -- anything that never
 * involved a TIBRS-reportable offense. No offenses/property/victim-offender
 * relationships here; just the header fields, a narrative, and whoever was
 * involved or witnessed it.
 */
const createMor = asyncHandler(async (req, res) => {
  const { error, value: payload } = morCreateSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  // Idempotency, same pattern as citations/incidents: an offline client
  // retrying a sync should never create a duplicate matter of record.
  if (payload.id) {
    const existing = await db.query('SELECT id, report_number FROM matters_of_record WHERE id = $1', [
      payload.id,
    ]);
    if (existing.rows[0]) {
      return res.status(200).json({ ...existing.rows[0], outcome: 'duplicate_skipped' });
    }
  }

  const deviceCreatedAt = payload.device_created_at || new Date();

  const inserted = await db.query(
    `INSERT INTO matters_of_record
        (id, report_number, category, reporting_officer_id, occurrence_date,
         location_address, latitude, longitude, narrative, device_created_at)
     VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, report_number, created_at`,
    [
      payload.id || null,
      payload.report_number.trim(),
      payload.category,
      req.user.id,
      payload.occurrence_date,
      payload.location_address.trim(),
      payload.latitude ?? null,
      payload.longitude ?? null,
      payload.narrative.trim(),
      deviceCreatedAt,
    ]
  );
  const mor = inserted.rows[0];

  await insertMorPersons(db, mor.id, payload.persons);

  res.status(201).json({
    id: mor.id,
    report_number: mor.report_number,
    person_count: payload.persons.length,
    outcome: 'created',
  });
});

const MOR_LIST_COLUMNS = `
  m.id, m.report_number, m.category, m.occurrence_date, m.location_address,
  m.approval_status, m.approved_by_id, m.approved_at, m.approval_notes,
  approver.full_name AS approved_by_name,
  u.full_name AS officer_name, u.badge_number AS officer_badge
`;

/**
 * GET /api/mor?q=&category=&approval_status=&limit=&offset=
 *
 * Open to every authenticated role -- matters_of_record carries no RLS
 * restricting SELECT, same as incidents/crash reports. Only creation/
 * updates are role-gated (see mor.routes.js).
 */
const listMor = asyncHandler(async (req, res) => {
  const { error, value: query } = morListQuerySchema.validate(req.query);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;
  const term = query.q ? query.q : null;

  const { rows } = await db.query(
    `SELECT ${MOR_LIST_COLUMNS}, count(*) OVER() AS total_count
       FROM matters_of_record m
       JOIN users u ON u.id = m.reporting_officer_id
       LEFT JOIN users approver ON approver.id = m.approved_by_id
      WHERE ($1::text IS NULL OR m.category::text = $1)
        AND ($2::text IS NULL OR m.approval_status::text = $2)
        AND (
              $3::text IS NULL
              OR m.report_number ILIKE '%' || $3 || '%'
              OR m.location_address ILIKE '%' || $3 || '%'
            )
      ORDER BY m.occurrence_date DESC
      LIMIT $4 OFFSET $5`,
    [query.category || null, query.approval_status || null, term, query.limit, query.offset]
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
 * GET /api/mor/:id
 */
const getMorById = asyncHandler(async (req, res) => {
  const { error, value: params } = idParamSchema.validate(req.params);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const morResult = await db.query(
    `SELECT ${MOR_LIST_COLUMNS}, m.latitude, m.longitude, m.narrative,
            m.reporting_officer_id, m.created_at, m.updated_at
       FROM matters_of_record m
       JOIN users u ON u.id = m.reporting_officer_id
       LEFT JOIN users approver ON approver.id = m.approved_by_id
      WHERE m.id = $1`,
    [params.id]
  );
  const mor = morResult.rows[0];
  if (!mor) {
    throw new AppError(404, 'Matter of record not found.');
  }

  const personsResult = await db.query(
    `SELECT mp.id, mp.role, mp.sequence_number,
            p.id AS person_id, p.first_name, p.last_name, p.phone, p.address
       FROM mor_persons mp
       JOIN master_persons p ON p.id = mp.person_id
      WHERE mp.mor_id = $1
      ORDER BY mp.role, mp.sequence_number`,
    [params.id]
  );

  res.status(200).json({ ...mor, persons: personsResult.rows });
});

/**
 * PATCH /api/mor/:id
 *
 * Top-level fields only -- correcting a mistake made at intake. Adding a
 * party/witness after the fact is POST /api/mor/:id/persons, same split
 * incidents.controller.js draws between updateIncident and its nested
 * collections.
 */
const updateMor = asyncHandler(async (req, res) => {
  const { error: paramError, value: params } = idParamSchema.validate(req.params);
  if (paramError) throw Object.assign(paramError, { isJoi: true });

  const { error, value: updates } = morUpdateSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const result = await db.query(
    `UPDATE matters_of_record
        SET report_number     = COALESCE($1, report_number),
            category          = COALESCE($2, category),
            occurrence_date   = COALESCE($3, occurrence_date),
            location_address  = COALESCE($4, location_address),
            latitude          = COALESCE($5, latitude),
            longitude         = COALESCE($6, longitude),
            narrative         = COALESCE($7, narrative),
            updated_at        = now()
      WHERE id = $8
      RETURNING id, report_number, category, occurrence_date, location_address,
                latitude, longitude, narrative, updated_at`,
    [
      updates.report_number ? updates.report_number.trim() : null,
      updates.category ?? null,
      updates.occurrence_date ?? null,
      updates.location_address ? updates.location_address.trim() : null,
      updates.latitude ?? null,
      updates.longitude ?? null,
      updates.narrative ? updates.narrative.trim() : null,
      params.id,
    ]
  );

  if (!result.rows[0]) {
    throw new AppError(404, 'Matter of record not found.');
  }

  res.status(200).json({ ...result.rows[0], outcome: 'updated' });
});

/**
 * POST /api/mor/:id/persons -- add an involved party or witness discovered
 * after the initial report was filed (e.g. a witness who comes forward
 * later), without needing to touch anything else on the record.
 */
const addMorPerson = asyncHandler(async (req, res) => {
  const { error: paramError, value: params } = idParamSchema.validate(req.params);
  if (paramError) throw Object.assign(paramError, { isJoi: true });

  const { error, value: person } = morAddPersonSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const morCheck = await db.query('SELECT id FROM matters_of_record WHERE id = $1', [params.id]);
  if (!morCheck.rows[0]) {
    throw new AppError(404, 'Matter of record not found.');
  }

  await insertMorPersons(db, params.id, [person]);

  const { rows } = await db.query(
    `SELECT mp.id, mp.role, mp.sequence_number,
            p.id AS person_id, p.first_name, p.last_name, p.phone, p.address
       FROM mor_persons mp
       JOIN master_persons p ON p.id = mp.person_id
      WHERE mp.mor_id = $1
      ORDER BY mp.created_at DESC
      LIMIT 1`,
    [params.id]
  );

  res.status(201).json(rows[0]);
});

const approveMor = makeApprovalHandler('matters_of_record', 'Matter of record not found.');

module.exports = {
  createMor,
  listMor,
  getMorById,
  updateMor,
  addMorPerson,
  approveMor,
};
