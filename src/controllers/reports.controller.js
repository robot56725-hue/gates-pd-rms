'use strict';

const asyncHandler = require('../utils/asyncHandler');
const { monthlySummaryQuerySchema } = require('../validation/reportSchema');

/**
 * GET /api/reports/monthly-summary?month=YYYY-MM
 *
 * One consolidated activity report for a single calendar month: citations
 * issued, cases opened/closed, charge dispositions, dockets held, FTAs,
 * payments collected, and warrant activity. Deliberately does NOT repeat
 * the fund-by-fund breakdown -- that's GET /api/payments/fund-distribution-
 * report (Task #41), which already accepts date_from/date_to and would
 * just duplicate payments.total_amount here under a different shape.
 *
 * Every query below runs sequentially against req.db, a single pooled
 * client (see middleware/dbAudit.js) -- concurrent queries on one client
 * would corrupt the wire protocol, so this is deliberately NOT
 * Promise.all'd the way independent, separately-connected work might be.
 */
const getMonthlySummary = asyncHandler(async (req, res) => {
  const { error, value: query } = monthlySummaryQuerySchema.validate(req.query);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  // Exclusive [start, end) window: start is the 1st of the requested month,
  // end is the 1st of the following month, computed in UTC so month-end
  // rollover (Dec -> Jan of the next year) is never off by a year.
  const [yearStr, monthStr] = query.month.split('-');
  const year = Number(yearStr);
  const monthIndex = Number(monthStr) - 1; // JS Date months are 0-indexed
  const start = query.month + '-01';
  const end = new Date(Date.UTC(year, monthIndex + 1, 1)).toISOString().slice(0, 10);

  const citationsIssued = await db.query(
    `SELECT COUNT(*) AS n FROM e_citations WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz`,
    [start, end]
  );

  const casesOpened = await db.query(
    `SELECT case_type, COUNT(*) AS n FROM court_cases
      WHERE opened_at >= $1::timestamptz AND opened_at < $2::timestamptz
      GROUP BY case_type ORDER BY case_type`,
    [start, end]
  );

  const casesClosed = await db.query(
    `SELECT case_type, COUNT(*) AS n FROM court_cases
      WHERE closed_at >= $1::timestamptz AND closed_at < $2::timestamptz
      GROUP BY case_type ORDER BY case_type`,
    [start, end]
  );

  const chargesDisposed = await db.query(
    `SELECT disposition, COUNT(*) AS n FROM case_charges
      WHERE disposed_at >= $1::timestamptz AND disposed_at < $2::timestamptz
      GROUP BY disposition ORDER BY disposition`,
    [start, end]
  );

  const docketsCompleted = await db.query(
    `SELECT COUNT(*) AS n FROM court_dockets
      WHERE docket_status = 'Completed' AND docket_date >= $1::date AND docket_date < $2::date`,
    [start, end]
  );

  const ftaAppearances = await db.query(
    `SELECT COUNT(*) AS n FROM docket_entries de
       JOIN court_dockets cd ON cd.id = de.docket_id
      WHERE de.appearance_status = 'FTA' AND cd.docket_date >= $1::date AND cd.docket_date < $2::date`,
    [start, end]
  );

  const paymentsByType = await db.query(
    `SELECT payment_type, COALESCE(SUM(amount), 0) AS total_amount, COUNT(*) AS n
       FROM court_payments
      WHERE paid_at >= $1::timestamptz AND paid_at < $2::timestamptz
      GROUP BY payment_type ORDER BY payment_type`,
    [start, end]
  );

  const warrantsIssued = await db.query(
    `SELECT COUNT(*) AS n FROM court_warrants WHERE issued_at >= $1::timestamptz AND issued_at < $2::timestamptz`,
    [start, end]
  );
  const warrantsRecalled = await db.query(
    `SELECT COUNT(*) AS n FROM court_warrants WHERE recalled_at >= $1::timestamptz AND recalled_at < $2::timestamptz`,
    [start, end]
  );
  const warrantsServed = await db.query(
    `SELECT COUNT(*) AS n FROM court_warrants WHERE served_at >= $1::timestamptz AND served_at < $2::timestamptz`,
    [start, end]
  );

  const paymentsTotal = paymentsByType.rows.reduce((sum, row) => sum + Number(row.total_amount), 0);

  res.status(200).json({
    month: query.month,
    period_start: start,
    period_end_exclusive: end,
    citations_issued: Number(citationsIssued.rows[0].n),
    cases: {
      opened_by_type: casesOpened.rows,
      closed_by_type: casesClosed.rows,
    },
    charges_disposed_by_disposition: chargesDisposed.rows,
    dockets_completed: Number(docketsCompleted.rows[0].n),
    fta_appearances: Number(ftaAppearances.rows[0].n),
    payments: {
      by_type: paymentsByType.rows,
      total_amount: paymentsTotal,
    },
    warrants: {
      issued: Number(warrantsIssued.rows[0].n),
      recalled: Number(warrantsRecalled.rows[0].n),
      served: Number(warrantsServed.rows[0].n),
    },
  });
});

module.exports = { getMonthlySummary };
