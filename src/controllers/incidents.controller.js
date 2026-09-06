'use strict';

const env = require('../config/env');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const {
  incidentCreateSchema,
  incidentUpdateSchema,
  narrativeCreateSchema,
  incidentListQuerySchema,
} = require('../validation/incidentSchema');
const { idParamSchema } = require('../validation/common');
const { findOrCreatePerson } = require('../services/personService');
const { makeApprovalHandler } = require('../utils/approval');

/**
 * Whole years between `dob` and `asOf` -- used to show a person's age as of
 * the incident (see getIncidentById), not their current age, which would
 * silently drift every time an old report is reopened.
 */
function calculateAgeAsOf(dob, asOf) {
  const dobDate = new Date(dob);
  const asOfDate = new Date(asOf);
  let age = asOfDate.getUTCFullYear() - dobDate.getUTCFullYear();
  const monthDiff = asOfDate.getUTCMonth() - dobDate.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && asOfDate.getUTCDate() < dobDate.getUTCDate())) {
    age -= 1;
  }
  return age;
}

/**
 * Inserts one incident_persons row per entry in `persons`, resolving each to
 * a master_persons id -- either directly (`person_id`, e.g. selected from a
 * prior search) or via findOrCreatePerson (same dedupe-by-DL logic
 * citations.controller.js uses). Returns an array parallel to `persons`
 * giving each entry's resulting {id, role}, so relationship entries (which
 * reference persons by their position in the request) can be resolved
 * afterward without the client needing to know a not-yet-created person's
 * future database id.
 */
async function insertIncidentPersons(db, incidentId, persons) {
  const roleSequence = {};
  const incidentPersons = [];

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

    const inserted = await db.query(
      `INSERT INTO incident_persons (incident_id, person_id, role, sequence_number, injury_type)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [incidentId, personId, person.role, nextSeq, person.injury_type || null]
    );
    incidentPersons.push({ id: inserted.rows[0].id, role: person.role });
  }

  return incidentPersons;
}

/**
 * POST /api/incidents
 *
 * Creates an incident together with everything TIBRS needs in one
 * transaction: up to 10 offenses, every involved person (with role),
 * victim-to-offender relationships, and property loss/recovery records.
 * All-or-nothing -- withDbAudit's transaction rolls back the whole incident
 * if any one piece (e.g. a bad offense code, a relationship pointing at the
 * wrong role) fails, rather than leaving a half-recorded incident behind.
 */
const createIncident = asyncHandler(async (req, res) => {
  const { error, value: payload } = incidentCreateSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  // Idempotency, same pattern as citations.controller.js: an offline
  // client retrying a sync should never create a duplicate incident.
  if (payload.id) {
    const existing = await db.query('SELECT id, case_number FROM incidents WHERE id = $1', [
      payload.id,
    ]);
    if (existing.rows[0]) {
      return res.status(200).json({ ...existing.rows[0], outcome: 'duplicate_skipped' });
    }
  }

  const deviceCreatedAt = payload.device_created_at || new Date();

  const incidentResult = await db.query(
    `INSERT INTO incidents
        (id, case_number, reporting_officer_id, occurrence_date, location_address, location_type,
         latitude, longitude, device_created_at)
     VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, case_number, created_at`,
    [
      payload.id || null,
      payload.case_number.trim(),
      req.user.id,
      payload.occurrence_date,
      payload.location_address.trim(),
      payload.location_type,
      payload.latitude ?? null,
      payload.longitude ?? null,
      deviceCreatedAt,
    ]
  );
  const incident = incidentResult.rows[0];

  // Offense sequence is assigned by array position (1-based) -- the order
  // the officer entered them in. A bad tibrs_offense_code surfaces as a
  // clean 409 via the FK constraint + the shared PG_ERROR_MAP in
  // middleware/errorHandler.js, not a raw SQL error.
  for (let i = 0; i < payload.offenses.length; i++) {
    const offense = payload.offenses[i];
    await db.query(
      `INSERT INTO incident_offenses (incident_id, offense_sequence, tibrs_offense_code, attempted_completed)
       VALUES ($1, $2, $3, $4)`,
      [incident.id, i + 1, offense.tibrs_offense_code, offense.attempted_completed]
    );
  }

  const incidentPersons = await insertIncidentPersons(db, incident.id, payload.persons);

  // Relationships reference persons by their position in the request's
  // `persons` array. Pre-validate bounds/roles here so a client mistake
  // comes back as a clean 422 instead of tripping the DB trigger backstop
  // (see db/migrations/005_add_tibrs_incident_module.sql) -- that trigger
  // exists as defense-in-depth against a bug in THIS code, not as the
  // primary validation path.
  for (const rel of payload.relationships) {
    const victim = incidentPersons[rel.victim_index];
    const offender = incidentPersons[rel.offender_index];
    if (!victim || victim.role !== 'Victim') {
      throw new AppError(
        422,
        `relationships: victim_index ${rel.victim_index} does not refer to a person with role Victim.`
      );
    }
    if (!offender || offender.role !== 'Offender') {
      throw new AppError(
        422,
        `relationships: offender_index ${rel.offender_index} does not refer to a person with role Offender.`
      );
    }
    await db.query(
      `INSERT INTO incident_victim_offender_relationships
          (incident_id, victim_incident_person_id, offender_incident_person_id, relationship)
       VALUES ($1, $2, $3, $4)`,
      [incident.id, victim.id, offender.id, rel.relationship]
    );
  }

  for (const item of payload.property) {
    await db.query(
      `INSERT INTO incident_property
          (incident_id, property_loss_type, property_category, property_description, value_amount, date_recovered)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        incident.id,
        item.property_loss_type,
        item.property_category,
        item.property_description.trim(),
        item.value_amount ?? null,
        item.date_recovered ?? null,
      ]
    );
  }

  // tca_charges' offender_index, like relationships' victim_index/
  // offender_index above, is a position into THIS request's `persons` array
  // -- same bounds/role pre-check for the same reason (a clean 422 instead
  // of tripping db/migrations/013_add_incident_tca_charges.sql's trigger
  // backstop).
  for (let i = 0; i < payload.tca_charges.length; i++) {
    const charge = payload.tca_charges[i];
    let offenderIncidentPersonId = null;
    if (charge.offender_index !== undefined) {
      const offender = incidentPersons[charge.offender_index];
      if (!offender || offender.role !== 'Offender') {
        throw new AppError(
          422,
          `tca_charges: offender_index ${charge.offender_index} does not refer to a person with role Offender.`
        );
      }
      offenderIncidentPersonId = offender.id;
    }
    await db.query(
      `INSERT INTO incident_tca_charges
          (incident_id, charge_sequence, tca_code, charge_description, charge_classification, offender_incident_person_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        incident.id,
        i + 1,
        charge.tca_code.trim(),
        charge.charge_description.trim(),
        charge.charge_classification ? charge.charge_classification.trim() : null,
        offenderIncidentPersonId,
      ]
    );
  }

  if (payload.narrative) {
    await db.query(
      `INSERT INTO incident_narratives (incident_id, author_id, narrative_text, version_number, device_created_at)
       VALUES ($1, $2, $3, 1, $4)`,
      [incident.id, req.user.id, payload.narrative.trim(), deviceCreatedAt]
    );
  }

  res.status(201).json({
    id: incident.id,
    case_number: incident.case_number,
    offense_count: payload.offenses.length,
    person_count: payload.persons.length,
    property_count: payload.property.length,
    tca_charge_count: payload.tca_charges.length,
    outcome: 'created',
  });
});

const INCIDENT_LIST_COLUMNS = `
  i.id, i.case_number, i.occurrence_date, i.location_address, i.location_type,
  i.status, i.exceptional_clearance, i.cleared_date,
  i.approval_status, i.approved_by_id, i.approved_at, i.approval_notes,
  approver.full_name AS approved_by_name,
  u.full_name AS officer_name, u.badge_number AS officer_badge
`;

/**
 * GET /api/incidents?q=&status=&mine=&limit=&offset=
 *
 * Open to every authenticated role -- incidents carries no RLS restricting
 * SELECT. Only creation/updates are role-gated (see incidents.routes.js).
 */
const listIncidents = asyncHandler(async (req, res) => {
  const { error, value: query } = incidentListQuerySchema.validate(req.query);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;
  const officerId = query.mine ? req.user.id : null;
  const status = query.status || null;
  const term = query.q ? query.q : null;

  const { rows } = await db.query(
    `SELECT ${INCIDENT_LIST_COLUMNS}, count(*) OVER() AS total_count
       FROM incidents i
       JOIN users u ON u.id = i.reporting_officer_id
       LEFT JOIN users approver ON approver.id = i.approved_by_id
      WHERE ($1::uuid IS NULL OR i.reporting_officer_id = $1)
        AND ($2::text IS NULL OR i.status::text = $2)
        AND (
              $3::text IS NULL
              OR i.case_number ILIKE '%' || $3 || '%'
              OR i.location_address ILIKE '%' || $3 || '%'
            )
      ORDER BY i.occurrence_date DESC
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
 * GET /api/incidents/:id
 *
 * Full detail: the incident itself plus every offense, involved person,
 * victim-offender relationship, property record, and narrative -- the
 * complete picture a real TIBRS Group A Incident Report represents, not
 * just the bare incidents row.
 */
const getIncidentById = asyncHandler(async (req, res) => {
  const { error, value: params } = idParamSchema.validate(req.params);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const incidentResult = await db.query(
    `SELECT ${INCIDENT_LIST_COLUMNS}, i.latitude, i.longitude, i.reporting_officer_id,
            i.created_at, i.updated_at, i.tibrs_submitted_at, i.tibrs_submission_batch
       FROM incidents i
       JOIN users u ON u.id = i.reporting_officer_id
       LEFT JOIN users approver ON approver.id = i.approved_by_id
      WHERE i.id = $1`,
    [params.id]
  );
  const incident = incidentResult.rows[0];
  if (!incident) {
    throw new AppError(404, 'Incident not found.');
  }

  const offensesResult = await db.query(
    `SELECT io.offense_sequence, io.tibrs_offense_code, io.attempted_completed,
            toc.description AS offense_description, toc.crime_against
       FROM incident_offenses io
       JOIN tibrs_offense_codes toc ON toc.code = io.tibrs_offense_code
      WHERE io.incident_id = $1
      ORDER BY io.offense_sequence`,
    [params.id]
  );

  // Full person detail, not just name/dob/sex/race: a real incident report
  // is expected to carry everything master_persons stores about someone
  // involved (see incidentSchema.js's incidentPersonSchema, which has
  // always accepted these fields on write -- this was purely a read-side
  // gap, master_persons already had every column). ssn_encrypted is
  // decrypted here specifically -- a deliberate, one-time exception to the
  // "SSN is never a byproduct of a general lookup" rule
  // persons.controller.js documents and otherwise follows everywhere else
  // in this app, made because a full incident report is expected to
  // include it. decrypt_ssn() is STRICT (001_init_schema.sql), so a NULL
  // ssn_encrypted or a NULL/unconfigured key both safely yield NULL rather
  // than an error.
  const personsResult = await db.query(
    `SELECT ip.id, ip.role, ip.sequence_number, ip.injury_type,
            p.id AS person_id, p.first_name, p.last_name, p.dob, p.sex, p.race,
            p.height_inches, p.weight_lbs, p.eye_color, p.hair_color,
            p.drivers_license_num, p.dl_state, p.dl_class, p.is_cdl,
            p.phone, p.address,
            decrypt_ssn(p.ssn_encrypted, $2) AS ssn
       FROM incident_persons ip
       JOIN master_persons p ON p.id = ip.person_id
      WHERE ip.incident_id = $1
      ORDER BY ip.role, ip.sequence_number`,
    [params.id, env.ssnEncryptionKey ?? null]
  );

  // Age as of the incident, not "as of right now" -- a report written up
  // weeks or years later should still say how old someone was when it
  // actually happened. Computed here rather than in SQL so it stays a
  // simple, easily-tested unit instead of a date_part()/age() expression
  // duplicated across every query that ever needs it.
  personsResult.rows.forEach((p) => {
    p.age = p.dob ? calculateAgeAsOf(p.dob, incident.occurrence_date) : null;
  });

  const relationshipsResult = await db.query(
    `SELECT vor.id, vor.relationship,
            v.id AS victim_incident_person_id,
            vp.first_name AS victim_first_name, vp.last_name AS victim_last_name,
            o.id AS offender_incident_person_id,
            op.first_name AS offender_first_name, op.last_name AS offender_last_name
       FROM incident_victim_offender_relationships vor
       JOIN incident_persons v ON v.id = vor.victim_incident_person_id
       JOIN master_persons vp ON vp.id = v.person_id
       JOIN incident_persons o ON o.id = vor.offender_incident_person_id
       JOIN master_persons op ON op.id = o.person_id
      WHERE vor.incident_id = $1`,
    [params.id]
  );

  const propertyResult = await db.query(
    `SELECT id, property_loss_type, property_category, property_description, value_amount, date_recovered
       FROM incident_property
      WHERE incident_id = $1
      ORDER BY created_at`,
    [params.id]
  );

  const narrativesResult = await db.query(
    `SELECT n.id, n.narrative_text, n.version_number, n.created_at, u.full_name AS author_name
       FROM incident_narratives n
       JOIN users u ON u.id = n.author_id
      WHERE n.incident_id = $1
      ORDER BY n.created_at`,
    [params.id]
  );

  // TCA (Tennessee Code Annotated) charges -- the actual statute charge(s),
  // distinct from the TIBRS/NIBRS classification codes in `offenses` above
  // (see db/migrations/013_add_incident_tca_charges.sql). offender is a
  // LEFT JOIN since offender_incident_person_id is nullable -- a charge can
  // be recorded before a specific offender is confirmed.
  const tcaChargesResult = await db.query(
    `SELECT tc.id, tc.charge_sequence, tc.tca_code, tc.charge_description, tc.charge_classification,
            tc.offender_incident_person_id,
            op.first_name AS offender_first_name, op.last_name AS offender_last_name
       FROM incident_tca_charges tc
       LEFT JOIN incident_persons oip ON oip.id = tc.offender_incident_person_id
       LEFT JOIN master_persons op ON op.id = oip.person_id
      WHERE tc.incident_id = $1
      ORDER BY tc.charge_sequence`,
    [params.id]
  );

  res.status(200).json({
    ...incident,
    offenses: offensesResult.rows,
    persons: personsResult.rows,
    victim_offender_relationships: relationshipsResult.rows,
    property: propertyResult.rows,
    tca_charges: tcaChargesResult.rows,
    narratives: narrativesResult.rows,
  });
});

/**
 * PATCH /api/incidents/:id
 *
 * Covers status/clearance disposition (usually settled well after the
 * incident is first opened) plus the core top-level fields (location,
 * occurrence date/time, GPS) for correcting a mistake made at intake.
 * Re-working the nested offenses/persons/relationships/property collections
 * is a rarer, higher-stakes correction handled separately, not through this
 * endpoint.
 */
const updateIncident = asyncHandler(async (req, res) => {
  const { error: paramError, value: params } = idParamSchema.validate(req.params);
  if (paramError) throw Object.assign(paramError, { isJoi: true });

  const { error, value: updates } = incidentUpdateSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const result = await db.query(
    `UPDATE incidents
        SET status                = COALESCE($1, status),
            exceptional_clearance = COALESCE($2, exceptional_clearance),
            cleared_date          = COALESCE($3, cleared_date),
            occurrence_date       = COALESCE($4, occurrence_date),
            location_address      = COALESCE($5, location_address),
            location_type         = COALESCE($6, location_type),
            latitude              = COALESCE($7, latitude),
            longitude             = COALESCE($8, longitude),
            updated_at            = now()
      WHERE id = $9
      RETURNING id, case_number, status, exceptional_clearance, cleared_date,
                occurrence_date, location_address, location_type, latitude, longitude, updated_at`,
    [
      updates.status ?? null,
      updates.exceptional_clearance ?? null,
      updates.cleared_date ?? null,
      updates.occurrence_date ?? null,
      updates.location_address ? updates.location_address.trim() : null,
      updates.location_type ?? null,
      updates.latitude ?? null,
      updates.longitude ?? null,
      params.id,
    ]
  );

  if (!result.rows[0]) {
    throw new AppError(404, 'Incident not found.');
  }

  res.status(200).json({ ...result.rows[0], outcome: 'updated' });
});

const approveIncident = makeApprovalHandler('incidents', 'Incident not found.');

/**
 * POST /api/incidents/:id/narratives
 *
 * incident_narratives has existed since the very first schema migration but
 * was never reachable through the API until now -- version_number
 * auto-increments per incident so a supplemental report never overwrites
 * an earlier officer's narrative.
 */
const addNarrative = asyncHandler(async (req, res) => {
  const { error: paramError, value: params } = idParamSchema.validate(req.params);
  if (paramError) throw Object.assign(paramError, { isJoi: true });

  const { error, value: body } = narrativeCreateSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const incidentCheck = await db.query('SELECT id FROM incidents WHERE id = $1', [params.id]);
  if (!incidentCheck.rows[0]) {
    throw new AppError(404, 'Incident not found.');
  }

  const versionResult = await db.query(
    'SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version FROM incident_narratives WHERE incident_id = $1',
    [params.id]
  );
  const nextVersion = versionResult.rows[0].next_version;

  const inserted = await db.query(
    `INSERT INTO incident_narratives (incident_id, author_id, narrative_text, version_number)
     VALUES ($1, $2, $3, $4)
     RETURNING id, narrative_text, version_number, created_at`,
    [params.id, req.user.id, body.narrative_text.trim(), nextVersion]
  );

  res.status(201).json(inserted.rows[0]);
});

module.exports = {
  createIncident,
  listIncidents,
  getIncidentById,
  updateIncident,
  approveIncident,
  addNarrative,
};
