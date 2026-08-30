'use strict';

const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { crashCreateSchema, crashListQuerySchema } = require('../validation/crashSchema');
const { idParamSchema } = require('../validation/common');
const { findOrCreatePerson } = require('../services/personService');
const { findOrCreateVehicle } = require('../services/vehicleService');

/**
 * POST /api/crashes
 *
 * Creates a crash (accident) report together with every involved vehicle
 * and person in one transaction -- Tennessee's e-Crash counterpart to
 * e-Citations. A person's `vehicle_index` (0-based position into this same
 * request's `vehicles` array) is how the request says who was in/struck by
 * which vehicle; when that person's role is 'Driver', the referenced
 * vehicle's driver_person_id is backfilled automatically so the client
 * never has to state the same fact twice.
 */
const createCrash = asyncHandler(async (req, res) => {
  const { error, value: payload } = crashCreateSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  if (payload.id) {
    const existing = await db.query('SELECT id, report_number FROM crash_reports WHERE id = $1', [
      payload.id,
    ]);
    if (existing.rows[0]) {
      return res.status(200).json({ ...existing.rows[0], outcome: 'duplicate_skipped' });
    }
  }

  const deviceCreatedAt = payload.device_created_at || new Date();

  const crashResult = await db.query(
    `INSERT INTO crash_reports
        (id, report_number, reporting_officer_id, crash_date, location, latitude, longitude,
         weather_condition, road_surface_condition, light_condition, crash_severity, narrative,
         device_created_at)
     VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id, report_number, created_at`,
    [
      payload.id || null,
      payload.report_number.trim(),
      req.user.id,
      payload.crash_date,
      payload.location.trim(),
      payload.latitude ?? null,
      payload.longitude ?? null,
      payload.weather_condition,
      payload.road_surface_condition,
      payload.light_condition,
      payload.crash_severity,
      payload.narrative ? payload.narrative.trim() : null,
      deviceCreatedAt,
    ]
  );
  const crash = crashResult.rows[0];

  const vehicleRowIds = [];
  for (let i = 0; i < payload.vehicles.length; i++) {
    const v = payload.vehicles[i];
    let vehicleId = v.vehicle_id;
    if (vehicleId) {
      const existing = await db.query('SELECT id FROM master_vehicles WHERE id = $1', [vehicleId]);
      if (!existing.rows[0]) {
        throw new AppError(422, `vehicles[${i}]: vehicle_id ${vehicleId} does not exist.`);
      }
    } else {
      vehicleId = await findOrCreateVehicle(db, v);
    }

    const inserted = await db.query(
      `INSERT INTO crash_involved_vehicles
          (crash_report_id, vehicle_id, sequence_number, damage_description, damage_estimate)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [crash.id, vehicleId, i + 1, v.damage_description || null, v.damage_estimate ?? null]
    );
    vehicleRowIds.push(inserted.rows[0].id);
  }

  let personCount = 0;
  for (const person of payload.persons) {
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

    let involvedVehicleRowId = null;
    if (person.vehicle_index !== undefined) {
      involvedVehicleRowId = vehicleRowIds[person.vehicle_index];
      if (!involvedVehicleRowId) {
        throw new AppError(422, `persons: vehicle_index ${person.vehicle_index} is out of range.`);
      }
    }

    await db.query(
      `INSERT INTO crash_involved_persons (crash_report_id, person_id, role, injury_severity, vehicle_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [crash.id, personId, person.role, person.injury_severity, involvedVehicleRowId]
    );
    personCount += 1;

    if (person.role === 'Driver' && involvedVehicleRowId) {
      await db.query(`UPDATE crash_involved_vehicles SET driver_person_id = $1 WHERE id = $2`, [
        personId,
        involvedVehicleRowId,
      ]);
    }
  }

  res.status(201).json({
    id: crash.id,
    report_number: crash.report_number,
    vehicle_count: payload.vehicles.length,
    person_count: personCount,
    outcome: 'created',
  });
});

const CRASH_LIST_COLUMNS = `
  c.id, c.report_number, c.crash_date, c.location, c.crash_severity,
  u.full_name AS officer_name, u.badge_number AS officer_badge
`;

/**
 * GET /api/crashes?q=&severity=&mine=&limit=&offset=
 */
const listCrashes = asyncHandler(async (req, res) => {
  const { error, value: query } = crashListQuerySchema.validate(req.query);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;
  const officerId = query.mine ? req.user.id : null;
  const severity = query.severity || null;
  const term = query.q ? query.q : null;

  const { rows } = await db.query(
    `SELECT ${CRASH_LIST_COLUMNS}, count(*) OVER() AS total_count
       FROM crash_reports c
       JOIN users u ON u.id = c.reporting_officer_id
      WHERE ($1::uuid IS NULL OR c.reporting_officer_id = $1)
        AND ($2::text IS NULL OR c.crash_severity::text = $2)
        AND (
              $3::text IS NULL
              OR c.report_number ILIKE '%' || $3 || '%'
              OR c.location ILIKE '%' || $3 || '%'
            )
      ORDER BY c.crash_date DESC
      LIMIT $4 OFFSET $5`,
    [officerId, severity, term, query.limit, query.offset]
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
 * GET /api/crashes/:id
 */
const getCrashById = asyncHandler(async (req, res) => {
  const { error, value: params } = idParamSchema.validate(req.params);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const crashResult = await db.query(
    `SELECT ${CRASH_LIST_COLUMNS}, c.latitude, c.longitude, c.weather_condition,
            c.road_surface_condition, c.light_condition, c.narrative, c.created_at
       FROM crash_reports c
       JOIN users u ON u.id = c.reporting_officer_id
      WHERE c.id = $1`,
    [params.id]
  );
  const crash = crashResult.rows[0];
  if (!crash) {
    throw new AppError(404, 'Crash report not found.');
  }

  const vehiclesResult = await db.query(
    `SELECT civ.id, civ.sequence_number, civ.damage_description, civ.damage_estimate,
            v.id AS vehicle_id, v.plate_number, v.plate_state, v.make, v.model, v.year, v.color,
            dp.id AS driver_person_id, dp.first_name AS driver_first_name, dp.last_name AS driver_last_name
       FROM crash_involved_vehicles civ
       JOIN master_vehicles v ON v.id = civ.vehicle_id
       LEFT JOIN master_persons dp ON dp.id = civ.driver_person_id
      WHERE civ.crash_report_id = $1
      ORDER BY civ.sequence_number`,
    [params.id]
  );

  const personsResult = await db.query(
    `SELECT cip.id, cip.role, cip.injury_severity, cip.vehicle_id AS involved_vehicle_id,
            p.id AS person_id, p.first_name, p.last_name
       FROM crash_involved_persons cip
       JOIN master_persons p ON p.id = cip.person_id
      WHERE cip.crash_report_id = $1`,
    [params.id]
  );

  res.status(200).json({
    ...crash,
    vehicles: vehiclesResult.rows,
    persons: personsResult.rows,
  });
});

module.exports = { createCrash, listCrashes, getCrashById };
