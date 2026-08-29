'use strict';

const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { idParamSchema, listQuerySchema } = require('../validation/common');

// Deliberately never selected: ssn_encrypted. This column exists so a
// citation submission can record an SSN when one was captured (see
// citations.controller.js), not so any authenticated read endpoint can hand
// it back out, encrypted or not. If a legitimate need to decrypt an SSN
// ever arises, that should be its own separate, tightly role-gated,
// heavily audited endpoint -- never a byproduct of a general lookup.
const PERSON_COLUMNS = `
  id, first_name, last_name, dob, sex, race, height_inches, weight_lbs, eye_color, hair_color,
  drivers_license_num, dl_state, dl_class,
  is_cdl, phone, address, created_at, updated_at
`;

/**
 * GET /api/persons?q=&limit=&offset=
 *
 * Open to every authenticated role -- master_persons has no RLS policy
 * restricting SELECT (see db/migrations/001_init_schema.sql), and any
 * sworn officer or clerk may legitimately need to look someone up.
 */
const searchPersons = asyncHandler(async (req, res) => {
  const { error, value: query } = listQuerySchema.validate(req.query);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;
  const term = query.q ? query.q : null;

  const { rows } = await db.query(
    `SELECT ${PERSON_COLUMNS}, count(*) OVER() AS total_count
       FROM master_persons
      WHERE $1::text IS NULL
         OR first_name ILIKE '%' || $1 || '%'
         OR last_name ILIKE '%' || $1 || '%'
         OR drivers_license_num ILIKE '%' || $1 || '%'
      ORDER BY last_name, first_name
      LIMIT $2 OFFSET $3`,
    [term, query.limit, query.offset]
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
 * GET /api/persons/:id
 *
 * Person detail plus their citation history -- the whole point of looking
 * someone up roadside is usually "what's this person's history," not just
 * their name/DL on file.
 */
const getPersonById = asyncHandler(async (req, res) => {
  const { error, value: params } = idParamSchema.validate(req.params);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const personResult = await db.query(
    `SELECT ${PERSON_COLUMNS} FROM master_persons WHERE id = $1`,
    [params.id]
  );
  const person = personResult.rows[0];
  if (!person) {
    throw new AppError(404, 'Person not found.');
  }

  const citationsResult = await db.query(
    `SELECT c.id, c.citation_number, c.offense_date, c.location, c.offense_description, c.tca_code,
            c.court_date, c.court_location, c.court_name,
            v.id AS vehicle_id, v.plate_number, v.plate_state, v.make, v.model,
            u.full_name AS officer_name, u.badge_number AS officer_badge,
            cl.court_status, cl.fine_amount_due, cl.amount_paid
       FROM e_citations c
       JOIN master_vehicles v ON v.id = c.vehicle_id
       JOIN users u ON u.id = c.officer_id
       LEFT JOIN court_ledger cl ON cl.citation_id = c.id
      WHERE c.violator_id = $1
      ORDER BY c.offense_date DESC`,
    [params.id]
  );

  res.status(200).json({ ...person, citations: citationsResult.rows });
});

module.exports = { searchPersons, getPersonById };
