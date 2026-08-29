'use strict';

/**
 * Finds an existing master_vehicles row by VIN or creates one. Shared by
 * citations.controller.js and crashes.controller.js so vehicle
 * identification/dedup logic lives in exactly one place.
 *
 * Deliberately does NOT dedupe on (plate_number, plate_state) -- plates are
 * reissued to different vehicles/owners over time (see
 * db/migrations/001_init_schema.sql), so matching on plate alone risks
 * silently attaching a new record to the wrong historical vehicle. Without
 * a VIN, every submission gets its own vehicle row.
 */
async function findOrCreateVehicle(db, vehicle) {
  if (vehicle.vin) {
    const existing = await db.query(`SELECT id FROM master_vehicles WHERE vin = $1`, [
      vehicle.vin,
    ]);
    if (existing.rows[0]) {
      return existing.rows[0].id;
    }
  }

  const inserted = await db.query(
    `INSERT INTO master_vehicles
        (vin, plate_number, plate_state, plate_year, make, model, year, color, owner_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      vehicle.vin || null,
      vehicle.plate_number.trim(),
      vehicle.plate_state.trim().toUpperCase(),
      parseInt(vehicle.plate_year, 10),
      vehicle.make.trim(),
      vehicle.model.trim(),
      parseInt(vehicle.year, 10),
      vehicle.color.trim(),
      vehicle.owner_name.trim(),
    ]
  );
  return inserted.rows[0].id;
}

module.exports = { findOrCreateVehicle };
