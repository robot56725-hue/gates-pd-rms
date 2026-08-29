'use strict';

const env = require('../config/env');
const AppError = require('../utils/AppError');

/**
 * Finds an existing master_persons row by (drivers_license_num, dl_state) or
 * creates one. Shared by citations.controller.js and incidents.controller.js
 * so "how do we identify/dedupe a person" never has two competing
 * implementations that quietly drift apart.
 *
 * Deliberately never overwrites an existing person's stored fields -- a
 * roadside/scene data-entry typo on a repeat contact should not corrupt a
 * more authoritative existing record. dl number/state are optional here
 * (an incident's victim or witness may have no driver's license at all);
 * dedup only runs when BOTH are supplied.
 *
 * `person` accepts either camelCase-free API field names directly:
 *   first_name, last_name, dob, drivers_license_num, dl_state, dl_class,
 *   is_cdl, ssn, phone, address, sex, race, height_inches, weight_lbs,
 *   eye_color, hair_color
 */
async function findOrCreatePerson(db, person) {
  const dlNumber = person.drivers_license_num ? person.drivers_license_num.trim() : null;
  const dlState = person.dl_state ? person.dl_state.trim().toUpperCase() : null;

  if (dlNumber && dlState) {
    const existing = await db.query(
      `SELECT id FROM master_persons WHERE drivers_license_num = $1 AND dl_state = $2`,
      [dlNumber, dlState]
    );
    if (existing.rows[0]) {
      return existing.rows[0].id;
    }
  }

  let ssnEncrypted = null;
  if (person.ssn) {
    if (!env.ssnEncryptionKey) {
      throw new AppError(
        500,
        'Server is not configured to store SSNs (missing SSN_ENCRYPTION_KEY); resubmit without an SSN or contact IT.'
      );
    }
    const encrypted = await db.query(`SELECT encrypt_ssn($1, $2) AS ciphertext`, [
      person.ssn.replace(/-/g, ''),
      env.ssnEncryptionKey,
    ]);
    ssnEncrypted = encrypted.rows[0].ciphertext;
  }

  const inserted = await db.query(
    `INSERT INTO master_persons
        (first_name, last_name, dob, ssn_encrypted, drivers_license_num, dl_state, dl_class, is_cdl,
         phone, address, sex, race, height_inches, weight_lbs, eye_color, hair_color)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING id`,
    [
      person.first_name.trim(),
      person.last_name.trim(),
      person.dob || null,
      ssnEncrypted,
      dlNumber,
      dlState,
      person.dl_class ? person.dl_class.trim() : null,
      person.is_cdl ?? false,
      person.phone || null,
      person.address || null,
      person.sex || null,
      person.race || null,
      person.height_inches ?? null,
      person.weight_lbs ?? null,
      person.eye_color || null,
      person.hair_color || null,
    ]
  );
  return inserted.rows[0].id;
}

module.exports = { findOrCreatePerson };
