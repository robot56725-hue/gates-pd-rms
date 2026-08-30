'use strict';

const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const {
  evidenceCreateSchema,
  evidenceUpdateSchema,
  custodyLogCreateSchema,
  evidenceListQuerySchema,
} = require('../validation/evidenceSchema');
const { idParamSchema } = require('../validation/common');

/**
 * POST /api/evidence
 *
 * Logs one collected evidence item against an incident or crash report, and
 * writes the opening 'Collected' chain-of-custody entry in the same
 * transaction -- an item never exists without at least one custody record.
 */
const createEvidence = asyncHandler(async (req, res) => {
  const { error, value: payload } = evidenceCreateSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  if (payload.incident_id) {
    const existing = await db.query('SELECT id FROM incidents WHERE id = $1', [payload.incident_id]);
    if (!existing.rows[0]) {
      throw new AppError(422, `incident_id ${payload.incident_id} does not exist.`);
    }
  }
  if (payload.crash_report_id) {
    const existing = await db.query('SELECT id FROM crash_reports WHERE id = $1', [
      payload.crash_report_id,
    ]);
    if (!existing.rows[0]) {
      throw new AppError(422, `crash_report_id ${payload.crash_report_id} does not exist.`);
    }
  }

  const deviceCreatedAt = payload.device_created_at || new Date();

  let item;
  try {
    const result = await db.query(
      `INSERT INTO evidence_items
          (item_number, incident_id, crash_report_id, category, description, quantity,
           location_collected, date_collected, collected_by_id, storage_location, device_created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, item_number, status, created_at`,
      [
        payload.item_number.trim(),
        payload.incident_id || null,
        payload.crash_report_id || null,
        payload.category,
        payload.description.trim(),
        payload.quantity,
        payload.location_collected ? payload.location_collected.trim() : null,
        payload.date_collected,
        req.user.id,
        payload.storage_location ? payload.storage_location.trim() : null,
        deviceCreatedAt,
      ]
    );
    item = result.rows[0];
  } catch (err) {
    if (err.code === '23505') {
      throw new AppError(409, `Evidence item number "${payload.item_number}" already exists.`);
    }
    throw err;
  }

  await db.query(
    `INSERT INTO evidence_custody_log (evidence_item_id, action, to_custodian, notes, performed_by_id)
     VALUES ($1, 'Collected', $2, $3, $4)`,
    [item.id, payload.storage_location || null, 'Initial collection.', req.user.id]
  );

  res.status(201).json({ ...item, outcome: 'created' });
});

const EVIDENCE_LIST_COLUMNS = `
  e.id, e.item_number, e.category, e.description, e.quantity, e.status,
  e.date_collected, e.storage_location, e.incident_id, e.crash_report_id,
  u.full_name AS collected_by_name, u.badge_number AS collected_by_badge
`;

/**
 * GET /api/evidence?q=&category=&status=&incident_id=&crash_report_id=&mine=&limit=&offset=
 */
const listEvidence = asyncHandler(async (req, res) => {
  const { error, value: query } = evidenceListQuerySchema.validate(req.query);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;
  const officerId = query.mine ? req.user.id : null;

  const { rows } = await db.query(
    `SELECT ${EVIDENCE_LIST_COLUMNS}, count(*) OVER() AS total_count
       FROM evidence_items e
       JOIN users u ON u.id = e.collected_by_id
      WHERE ($1::uuid IS NULL OR e.collected_by_id = $1)
        AND ($2::text IS NULL OR e.category::text = $2)
        AND ($3::text IS NULL OR e.status::text = $3)
        AND ($4::uuid IS NULL OR e.incident_id = $4)
        AND ($5::uuid IS NULL OR e.crash_report_id = $5)
        AND (
              $6::text IS NULL
              OR e.item_number ILIKE '%' || $6 || '%'
              OR e.description ILIKE '%' || $6 || '%'
            )
      ORDER BY e.date_collected DESC, e.created_at DESC
      LIMIT $7 OFFSET $8`,
    [
      officerId,
      query.category || null,
      query.status || null,
      query.incident_id || null,
      query.crash_report_id || null,
      query.q || null,
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
 * GET /api/evidence/:id
 */
const getEvidenceById = asyncHandler(async (req, res) => {
  const { error, value: params } = idParamSchema.validate(req.params);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const itemResult = await db.query(
    `SELECT ${EVIDENCE_LIST_COLUMNS}, e.disposition_notes, e.created_at, e.updated_at,
            i.case_number AS incident_case_number, c.report_number AS crash_report_number
       FROM evidence_items e
       JOIN users u ON u.id = e.collected_by_id
       LEFT JOIN incidents i ON i.id = e.incident_id
       LEFT JOIN crash_reports c ON c.id = e.crash_report_id
      WHERE e.id = $1`,
    [params.id]
  );
  const item = itemResult.rows[0];
  if (!item) {
    throw new AppError(404, 'Evidence item not found.');
  }

  const custodyResult = await db.query(
    `SELECT cl.id, cl.action, cl.from_custodian, cl.to_custodian, cl.notes, cl.performed_at,
            u.full_name AS performed_by_name
       FROM evidence_custody_log cl
       JOIN users u ON u.id = cl.performed_by_id
      WHERE cl.evidence_item_id = $1
      ORDER BY cl.performed_at`,
    [params.id]
  );

  res.status(200).json({ ...item, custody_log: custodyResult.rows });
});

/**
 * PATCH /api/evidence/:id
 *
 * Updates status/storage/disposition notes only -- category, description,
 * and which case it belongs to are not editable after the fact (matches
 * the append-only spirit of incident narratives: fix a mistaken entry by
 * logging a correcting custody event, not by silently rewriting history).
 */
const updateEvidence = asyncHandler(async (req, res) => {
  const { error: paramsError, value: params } = idParamSchema.validate(req.params);
  if (paramsError) throw Object.assign(paramsError, { isJoi: true });

  const { error, value: payload } = evidenceUpdateSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const result = await db.query(
    `UPDATE evidence_items
        SET status = COALESCE($1, status),
            storage_location = COALESCE($2, storage_location),
            disposition_notes = COALESCE($3, disposition_notes)
      WHERE id = $4
      RETURNING id, item_number, status, storage_location, disposition_notes`,
    [
      payload.status || null,
      payload.storage_location ?? null,
      payload.disposition_notes ?? null,
      params.id,
    ]
  );
  const updated = result.rows[0];
  if (!updated) {
    throw new AppError(404, 'Evidence item not found.');
  }

  res.status(200).json(updated);
});

/**
 * POST /api/evidence/:id/custody
 *
 * Appends one chain-of-custody entry -- transfer, checkout, lab submission,
 * release, destruction, etc. Never edits or deletes an existing entry.
 */
const addCustodyEntry = asyncHandler(async (req, res) => {
  const { error: paramsError, value: params } = idParamSchema.validate(req.params);
  if (paramsError) throw Object.assign(paramsError, { isJoi: true });

  const { error, value: payload } = custodyLogCreateSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const existing = await db.query('SELECT id FROM evidence_items WHERE id = $1', [params.id]);
  if (!existing.rows[0]) {
    throw new AppError(404, 'Evidence item not found.');
  }

  const result = await db.query(
    `INSERT INTO evidence_custody_log (evidence_item_id, action, from_custodian, to_custodian, notes, performed_by_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, action, from_custodian, to_custodian, notes, performed_at`,
    [
      params.id,
      payload.action,
      payload.from_custodian ? payload.from_custodian.trim() : null,
      payload.to_custodian ? payload.to_custodian.trim() : null,
      payload.notes ? payload.notes.trim() : null,
      req.user.id,
    ]
  );

  res.status(201).json(result.rows[0]);
});

module.exports = {
  createEvidence,
  listEvidence,
  getEvidenceById,
  updateEvidence,
  addCustodyEntry,
};
