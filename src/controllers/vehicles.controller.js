'use strict';

const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { idParamSchema, listQuerySchema } = require('../validation/common');

const VEHICLE_COLUMNS = `
  id, vin, plate_number, plate_state, plate_year, make, model, year, color,
  owner_name, created_at, updated_at
`;

/**
 * GET /api/vehicles?q=&limit=&offset=
 *
 * Matches on plate number or VIN. Open to every authenticated role, same
 * rationale as searchPersons -- master_vehicles carries no RLS restriction.
 */
const searchVehicles = asyncHandler(async (req, res) => {
  const { error, value: query } = listQuerySchema.validate(req.query);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;
  const term = query.q ? query.q : null;

  const { rows } = await db.query(
    `SELECT ${VEHICLE_COLUMNS}, count(*) OVER() AS total_count
       FROM master_vehicles
      WHERE $1::text IS NULL
         OR plate_number ILIKE '%' || $1 || '%'
         OR vin ILIKE '%' || $1 || '%'
         OR owner_name ILIKE '%' || $1 || '%'
      ORDER BY plate_number
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
 * GET /api/vehicles/:id
 *
 * Vehicle detail plus its citation history.
 */
const getVehicleById = asyncHandler(async (req, res) => {
  const { error, value: params } = idParamSchema.validate(req.params);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const vehicleResult = await db.query(
    `SELECT ${VEHICLE_COLUMNS} FROM master_vehicles WHERE id = $1`,
    [params.id]
  );
  const vehicle = vehicleResult.rows[0];
  if (!vehicle) {
    throw new AppError(404, 'Vehicle not found.');
  }

  const citationsResult = await db.query(
    `SELECT c.id, c.citation_number, c.offense_date, c.location, c.offense_description, c.tca_code,
            c.court_date, c.court_location, c.court_name,
            p.id AS violator_id, p.first_name AS violator_first_name, p.last_name AS violator_last_name,
            u.full_name AS officer_name, u.badge_number AS officer_badge,
            cl.court_status, cl.fine_amount_due, cl.amount_paid
       FROM e_citations c
       JOIN master_persons p ON p.id = c.violator_id
       JOIN users u ON u.id = c.officer_id
       LEFT JOIN court_ledger cl ON cl.citation_id = c.id
      WHERE c.vehicle_id = $1
      ORDER BY c.offense_date DESC`,
    [params.id]
  );

  res.status(200).json({ ...vehicle, citations: citationsResult.rows });
});

module.exports = { searchVehicles, getVehicleById };
