'use strict';

const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { citationRequestSchema, citationListQuerySchema } = require('../validation/citationSchema');
const { idParamSchema } = require('../validation/common');
const { validateMandatoryFields, COURT_FILING_DEADLINE_DAYS } = require('../utils/tcaFields');
const { findOrCreatePerson } = require('../services/personService');
const { findOrCreateVehicle } = require('../services/vehicleService');

/**
 * Combines a YYYY-MM-DD date string and an HH:MM[:SS] time string into a
 * single timestamp. Interpreted in the server's session time zone (set
 * DATABASE session `TimeZone` to the department's local zone in production,
 * e.g. America/Chicago -- offense/court times are recorded by officers using
 * local wall-clock time, not UTC).
 */
function combineDateTime(dateStr, timeStr) {
  const normalizedTime = timeStr.length === 5 ? `${timeStr}:00` : timeStr;
  return `${dateStr}T${normalizedTime}`;
}

/**
 * Loads the authenticated officer's profile fields required to satisfy
 * T.C.A. 55-10-207(i)(12) (name, rank, badge, agency) and re-verifies the
 * account is still active -- a token can be valid for up to 30 minutes
 * after an account is deactivated mid-session, and issuing a citation is
 * exactly the kind of action that should re-check that.
 */
async function loadIssuingOfficer(db, userId) {
  const { rows } = await db.query(
    `SELECT id, full_name, officer_rank, badge_number, agency, role, is_active
       FROM users
      WHERE id = $1`,
    [userId]
  );
  const officer = rows[0];
  if (!officer || !officer.is_active) {
    throw new AppError(401, 'Your account is no longer active.');
  }
  return officer;
}

const createCitation = asyncHandler(async (req, res) => {
  const { error, value: payload } = citationRequestSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db; // RLS-scoped transaction client attached by withDbAudit()

  // Idempotency: an offline client retrying a sync should never create a
  // duplicate citation. If it supplied its own id and that citation already
  // exists, hand back the existing record instead of erroring.
  if (payload.id) {
    const existing = await db.query(
      `SELECT id, citation_number, court_filing_deadline FROM e_citations WHERE id = $1`,
      [payload.id]
    );
    if (existing.rows[0]) {
      return res.status(200).json({ ...existing.rows[0], outcome: 'duplicate_skipped' });
    }
  }

  const officer = await loadIssuingOfficer(db, req.user.id);

  // Defense-in-depth: independently re-check all 13 T.C.A. 55-10-207(i)
  // points against the parsed payload PLUS the resolved officer profile,
  // even though the Joi schema above already enforces most of them.
  const fieldErrors = validateMandatoryFields({ ...payload, officer });
  if (fieldErrors.length > 0) {
    throw new AppError(422, 'Citation is missing legally mandated data points.', fieldErrors);
  }

  const violatorId = await findOrCreatePerson(db, payload.violator);
  const vehicleId = await findOrCreateVehicle(db, payload.vehicle);

  const offenseTimestamp = combineDateTime(payload.offense.offense_date, payload.offense.offense_time);
  const courtTimestamp = combineDateTime(payload.court.court_date, payload.court.court_time);
  const deviceCreatedAt = payload.device_created_at || new Date();

  const insertResult = await db.query(
    `INSERT INTO e_citations
        (id, citation_number, violator_id, vehicle_id, officer_id,
         offense_date, location, latitude, longitude, offense_description, tca_code,
         is_cmv, is_hazmat, passenger_capacity_16plus,
         court_date, court_location, court_name,
         device_created_at)
     VALUES
        (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5,
         $6, $7, $8, $9, $10, $11,
         $12, $13, $14,
         $15, $16, $17,
         $18)
     RETURNING id, citation_number, court_filing_deadline, device_created_at`,
    [
      payload.id || null,
      payload.citation_number.trim(),
      violatorId,
      vehicleId,
      req.user.id,
      offenseTimestamp,
      payload.offense.location.trim(),
      payload.offense.latitude,
      payload.offense.longitude,
      payload.offense.offense_description.trim(),
      payload.offense.tca_code.trim(),
      payload.offense.is_cmv,
      payload.offense.is_hazmat,
      payload.offense.passenger_capacity_16plus,
      courtTimestamp,
      payload.court.court_location.trim(),
      payload.court.court_name.trim(),
      deviceCreatedAt,
    ]
  );

  const citation = insertResult.rows[0];
  res.status(201).json({
    id: citation.id,
    citation_number: citation.citation_number,
    device_created_at: citation.device_created_at,
    court_filing_deadline: citation.court_filing_deadline,
    court_filing_deadline_days: COURT_FILING_DEADLINE_DAYS,
    outcome: 'created',
  });
});

// Shared join, reused by both listCitations and getCitationById, so the two
// endpoints can never quietly drift into returning different shapes of the
// same underlying record.
const CITATION_JOIN_COLUMNS = `
  c.id, c.citation_number, c.offense_date, c.location, c.latitude, c.longitude,
  c.offense_description, c.tca_code,
  c.is_cmv, c.is_hazmat, c.passenger_capacity_16plus,
  c.court_date, c.court_location, c.court_name, c.court_filing_deadline,
  c.device_created_at, c.created_at,
  p.id AS violator_id, p.first_name AS violator_first_name, p.last_name AS violator_last_name,
  p.sex AS violator_sex, p.race AS violator_race,
  v.id AS vehicle_id, v.plate_number, v.plate_state, v.make, v.model,
  u.id AS officer_id, u.full_name AS officer_name, u.badge_number AS officer_badge,
  cl.court_status, cl.fine_amount_due, cl.amount_paid
`;

const CITATION_JOIN_FROM = `
  FROM e_citations c
  JOIN master_persons p ON p.id = c.violator_id
  JOIN master_vehicles v ON v.id = c.vehicle_id
  JOIN users u ON u.id = c.officer_id
  LEFT JOIN court_ledger cl ON cl.citation_id = c.id
`;

/**
 * GET /api/citations?q=&status=&mine=&limit=&offset=
 *
 * Open to every authenticated role (Patrol_Officer/Supervisor to find their
 * own citations, Court_Clerk to find what still needs a disposition,
 * System_Admin for oversight) -- e_citations carries no RLS restricting
 * SELECT. A Court_Clerk cannot WRITE here (see citations.routes.js), only
 * read.
 *
 * status matches against court_ledger.court_status, treating a citation
 * with no court_ledger row yet (nothing has been disposed) as implicitly
 * 'Pending' -- that's the common case a clerk actually wants to filter on
 * ("what's still awaiting disposition"), not a literal DB value yet.
 */
const listCitations = asyncHandler(async (req, res) => {
  const { error, value: query } = citationListQuerySchema.validate(req.query);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;
  const officerId = query.mine ? req.user.id : null;
  const status = query.status || null;
  const term = query.q ? query.q : null;

  const { rows } = await db.query(
    `SELECT ${CITATION_JOIN_COLUMNS}, count(*) OVER() AS total_count
       ${CITATION_JOIN_FROM}
      WHERE ($1::uuid IS NULL OR c.officer_id = $1)
        AND (
              $2::text IS NULL
              OR cl.court_status::text = $2
              OR ($2 = 'Pending' AND cl.court_status IS NULL)
            )
        AND (
              $3::text IS NULL
              OR c.citation_number ILIKE '%' || $3 || '%'
              OR p.last_name ILIKE '%' || $3 || '%'
              OR p.first_name ILIKE '%' || $3 || '%'
              OR v.plate_number ILIKE '%' || $3 || '%'
            )
      ORDER BY c.offense_date DESC
      LIMIT $4 OFFSET $5`,
    [officerId, status, term, query.limit, query.offset]
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
 * GET /api/citations/:id
 */
const getCitationById = asyncHandler(async (req, res) => {
  const { error, value: params } = idParamSchema.validate(req.params);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const { rows } = await db.query(
    `SELECT ${CITATION_JOIN_COLUMNS}
       ${CITATION_JOIN_FROM}
      WHERE c.id = $1`,
    [params.id]
  );

  const citation = rows[0];
  if (!citation) {
    throw new AppError(404, 'Citation not found.');
  }

  res.status(200).json(citation);
});

module.exports = { createCitation, listCitations, getCitationById };
