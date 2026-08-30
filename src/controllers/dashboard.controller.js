'use strict';

const asyncHandler = require('../utils/asyncHandler');
const { upcomingAppearancesQuerySchema } = require('../validation/dashboardSchema');

/**
 * GET /api/dashboard/upcoming-appearances
 *
 * Every scheduled court appearance in the next `days_ahead` days (default
 * 14): docket entries still Scheduled, on a docket that isn't Cancelled,
 * from today through the window -- exactly the list a clerk or officer
 * needs to answer "who's due in court soon." Ordered soonest-first so it
 * reads directly as a work queue.
 */
const getUpcomingAppearances = asyncHandler(async (req, res) => {
  const { error, value: query } = upcomingAppearancesQuerySchema.validate(req.query);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const { rows } = await db.query(
    `SELECT de.id AS docket_entry_id, de.appearance_status, de.sequence_number,
            cd.id AS docket_id, cd.docket_date, cd.docket_time, cd.docket_type, cd.location, cd.docket_status,
            cj.full_name AS judge_name,
            cc.id AS case_id, cc.case_number, cc.case_type,
            p.first_name AS defendant_first_name, p.last_name AS defendant_last_name
       FROM docket_entries de
       JOIN court_dockets cd ON cd.id = de.docket_id
       LEFT JOIN court_judges cj ON cj.id = cd.judge_id
       JOIN court_cases cc ON cc.id = de.case_id
       JOIN master_persons p ON p.id = cc.defendant_id
      WHERE de.appearance_status = 'Scheduled'
        AND cd.docket_status <> 'Cancelled'
        AND cd.docket_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + $1::int)
      ORDER BY cd.docket_date ASC, cd.docket_time ASC NULLS LAST, de.sequence_number ASC NULLS LAST`,
    [query.days_ahead]
  );

  res.status(200).json({ days_ahead: query.days_ahead, results: rows });
});

module.exports = { getUpcomingAppearances };
