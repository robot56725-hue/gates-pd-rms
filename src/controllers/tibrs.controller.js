'use strict';

const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { monthlyValidationQuerySchema } = require('../validation/tibrsSchema');

/**
 * GET /api/tibrs/monthly-validation?month=YYYY-MM
 *
 * "Automatic error checking before monthly submission to prevent rejected
 * files": runs the same completeness checks a state TIBRS intake system
 * would reject a file over, but ahead of time and against this department's
 * own data, so gaps get fixed here instead of discovered as a bounced
 * submission.
 *
 * This is NOT a live connection to Tennessee's TIBRS/TBI intake system --
 * building that would require the state to issue this department API
 * credentials/certification, which is outside what this endpoint (or this
 * codebase) can set up. What this DOES do is check every incident that
 * occurred in the given month against the structural rules a real
 * submission depends on:
 *
 *   - at least one offense on file (see incident_offenses)
 *   - a location type recorded
 *   - a victim on file for any offense classified "Crime Against Person"
 *   - a property record on file for any offense classified
 *     "Crime Against Property"
 *   - a recorded victim-to-offender relationship whenever both a victim
 *     and an offender are on file for the same incident
 */
const getMonthlyValidation = asyncHandler(async (req, res) => {
  const { error, value: query } = monthlyValidationQuerySchema.validate(req.query);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;
  const monthStart = `${query.month}-01`;

  const { rows } = await db.query(
    `SELECT
        i.id, i.case_number, i.occurrence_date, i.status, i.location_type,
        (SELECT count(*) FROM incident_offenses io WHERE io.incident_id = i.id) AS offense_count,
        (SELECT count(*) FROM incident_persons ip WHERE ip.incident_id = i.id AND ip.role = 'Victim') AS victim_count,
        (SELECT count(*) FROM incident_persons ip WHERE ip.incident_id = i.id AND ip.role = 'Offender') AS offender_count,
        (SELECT count(*) FROM incident_victim_offender_relationships vor WHERE vor.incident_id = i.id) AS relationship_count,
        (SELECT count(*) FROM incident_property prop WHERE prop.incident_id = i.id) AS property_count,
        COALESCE(
          (SELECT bool_or(toc.crime_against = 'Person')
             FROM incident_offenses io2
             JOIN tibrs_offense_codes toc ON toc.code = io2.tibrs_offense_code
            WHERE io2.incident_id = i.id),
          false
        ) AS has_person_offense,
        COALESCE(
          (SELECT bool_or(toc.crime_against = 'Property')
             FROM incident_offenses io3
             JOIN tibrs_offense_codes toc ON toc.code = io3.tibrs_offense_code
            WHERE io3.incident_id = i.id),
          false
        ) AS has_property_offense
      FROM incidents i
     WHERE i.occurrence_date >= $1::date
       AND i.occurrence_date < ($1::date + INTERVAL '1 month')
     ORDER BY i.occurrence_date`,
    [monthStart]
  );

  const flagged = [];
  for (const row of rows) {
    const issues = [];

    if (Number(row.offense_count) === 0) {
      issues.push('No offenses recorded -- TIBRS requires at least one offense per incident.');
    }
    if (!row.location_type) {
      issues.push('Missing location type.');
    }
    if (row.has_person_offense && Number(row.victim_count) === 0) {
      issues.push('A crime against a person is recorded but no victim is on file.');
    }
    if (row.has_property_offense && Number(row.property_count) === 0) {
      issues.push('A crime against property is recorded but no property loss/recovery record is on file.');
    }
    if (Number(row.victim_count) > 0 && Number(row.offender_count) > 0 && Number(row.relationship_count) === 0) {
      issues.push('Both a victim and an offender are on file but no victim-offender relationship was recorded.');
    }

    if (issues.length > 0) {
      flagged.push({
        id: row.id,
        case_number: row.case_number,
        occurrence_date: row.occurrence_date,
        status: row.status,
        issues,
      });
    }
  }

  res.status(200).json({
    month: query.month,
    total_incidents: rows.length,
    incidents_with_issues: flagged.length,
    ready_to_submit: flagged.length === 0,
    flagged_incidents: flagged,
  });
});

module.exports = { getMonthlyValidation };
