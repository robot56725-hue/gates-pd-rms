'use strict';

const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const {
  idParamSchema,
  paymentCreateSchema,
  paymentListQuerySchema,
  fundDistributionQuerySchema,
} = require('../validation/paymentSchema');

const PAYMENT_JOIN_COLUMNS = `
  cp.id, cp.case_id, cp.charge_id, cp.amount, cp.payment_method, cp.payment_type,
  cp.fund_category_id, cp.received_by_id, cp.receipt_number, cp.voids_payment_id,
  cp.notes, cp.paid_at, cp.created_at,
  cc.case_number, fc.name AS fund_category_name, u.badge_number AS received_by_badge
`;
const PAYMENT_JOIN_FROM = `
  FROM court_payments cp
  JOIN court_cases cc ON cc.id = cp.case_id
  LEFT JOIN fund_categories fc ON fc.id = cp.fund_category_id
  LEFT JOIN users u ON u.id = cp.received_by_id
`;

/**
 * POST /api/payments -- records a payment, or a void/reversal of one (see
 * paymentSchema.js's note on the amount/voids_payment_id relationship).
 * court_payments has no PATCH/DELETE anywhere in this API -- migration 011's
 * triggers block UPDATE/DELETE at the DB level outright, so this insert is
 * the only way the ledger ever changes.
 *
 * RLS note: court_payments FORCE ROW LEVEL SECURITY with
 * payments_write_clerk_admin_only allowing INSERT only for
 * current_app_role() IN ('Court_Clerk', 'System_Admin') -- NOT Supervisor
 * (migration 011). This route's requireRoles must match that exactly (see
 * payments.routes.js) so a Supervisor is cleanly 403'd at the app layer
 * instead of hitting a raw RLS policy violation from Postgres.
 */
const createPayment = asyncHandler(async (req, res) => {
  const { error, value: payload } = paymentCreateSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const caseResult = await db.query('SELECT id FROM court_cases WHERE id = $1', [payload.case_id]);
  if (!caseResult.rows[0]) {
    throw new AppError(422, `case_id ${payload.case_id} does not exist.`);
  }

  if (payload.charge_id) {
    const chargeResult = await db.query('SELECT id FROM case_charges WHERE id = $1 AND case_id = $2', [
      payload.charge_id,
      payload.case_id,
    ]);
    if (!chargeResult.rows[0]) {
      throw new AppError(422, `charge_id ${payload.charge_id} does not exist on this case.`);
    }
  }

  if (payload.fund_category_id) {
    const fundResult = await db.query('SELECT id FROM fund_categories WHERE id = $1', [payload.fund_category_id]);
    if (!fundResult.rows[0]) {
      throw new AppError(422, `fund_category_id ${payload.fund_category_id} does not exist.`);
    }
  }

  if (payload.voids_payment_id) {
    const voidedResult = await db.query('SELECT id, case_id, amount FROM court_payments WHERE id = $1', [
      payload.voids_payment_id,
    ]);
    const voided = voidedResult.rows[0];
    if (!voided) {
      throw new AppError(422, `voids_payment_id ${payload.voids_payment_id} does not exist.`);
    }
    if (voided.case_id !== payload.case_id) {
      throw new AppError(422, 'voids_payment_id must reference a payment on the same case.');
    }
  }

  const receiptResult = await db.query(`SELECT generate_receipt_number() AS n`);
  const receiptNumber = receiptResult.rows[0].n;

  const inserted = await db.query(
    `INSERT INTO court_payments
        (case_id, charge_id, amount, payment_method, payment_type, fund_category_id,
         received_by_id, receipt_number, voids_payment_id, notes, paid_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, now()))
     RETURNING *`,
    [
      payload.case_id,
      payload.charge_id || null,
      payload.amount,
      payload.payment_method,
      payload.payment_type,
      payload.fund_category_id || null,
      req.user.id,
      receiptNumber,
      payload.voids_payment_id || null,
      payload.notes || null,
      payload.paid_at || null,
    ]
  );

  res.status(201).json(inserted.rows[0]);
});

const listPayments = asyncHandler(async (req, res) => {
  const { error, value: query } = paymentListQuerySchema.validate(req.query);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const { rows } = await db.query(
    `SELECT ${PAYMENT_JOIN_COLUMNS}, count(*) OVER() AS total_count
       ${PAYMENT_JOIN_FROM}
      WHERE ($1::uuid IS NULL OR cp.case_id = $1)
        AND ($2::text IS NULL OR cp.payment_type = $2)
        AND ($3::text IS NULL OR cp.payment_method = $3)
        AND ($4::uuid IS NULL OR cp.fund_category_id = $4)
        AND ($5::timestamptz IS NULL OR cp.paid_at >= $5)
        AND ($6::timestamptz IS NULL OR cp.paid_at <= $6)
      ORDER BY cp.paid_at DESC
      LIMIT $7 OFFSET $8`,
    [
      query.case_id || null,
      query.payment_type || null,
      query.payment_method || null,
      query.fund_category_id || null,
      query.paid_from || null,
      query.paid_to || null,
      query.limit,
      query.offset,
    ]
  );

  const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
  res.status(200).json({
    results: rows.map(({ total_count, ...row }) => row),
    total,
    limit: query.limit,
    offset: query.offset,
  });
});

const getPaymentById = asyncHandler(async (req, res) => {
  const { error: paramError, value: params } = idParamSchema.validate(req.params);
  if (paramError) throw Object.assign(paramError, { isJoi: true });

  const db = req.db;

  const result = await db.query(`SELECT ${PAYMENT_JOIN_COLUMNS} ${PAYMENT_JOIN_FROM} WHERE cp.id = $1`, [
    params.id,
  ]);
  if (!result.rows[0]) {
    throw new AppError(404, 'Payment not found.');
  }

  res.status(200).json(result.rows[0]);
});

/**
 * GET /api/payments/fund-distribution-report -- total collected per fund
 * category over an optional date window, for remittance/finance-office
 * reporting. Includes an explicit "Unassigned" bucket for any payment
 * never given a fund_category_id, so the report always reconciles against
 * every dollar in the ledger for the window, not just the categorized
 * portion.
 */
const getFundDistributionReport = asyncHandler(async (req, res) => {
  const { error, value: query } = fundDistributionQuerySchema.validate(req.query);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const { rows } = await db.query(
    `SELECT fc.id AS fund_category_id, fc.name AS fund_category, fc.is_active,
            COALESCE(SUM(cp.amount), 0) AS total_amount, COUNT(cp.id) AS payment_count
       FROM fund_categories fc
       LEFT JOIN court_payments cp
              ON cp.fund_category_id = fc.id
             AND ($1::timestamptz IS NULL OR cp.paid_at >= $1)
             AND ($2::timestamptz IS NULL OR cp.paid_at <= $2)
      GROUP BY fc.id, fc.name, fc.is_active
      UNION ALL
      SELECT NULL, 'Unassigned', NULL,
             COALESCE(SUM(amount), 0), COUNT(*)
        FROM court_payments
       WHERE fund_category_id IS NULL
         AND ($1::timestamptz IS NULL OR paid_at >= $1)
         AND ($2::timestamptz IS NULL OR paid_at <= $2)
      ORDER BY fund_category ASC`,
    [query.date_from || null, query.date_to || null]
  );

  const grandTotal = rows.reduce((sum, row) => sum + Number(row.total_amount), 0);

  res.status(200).json({
    date_from: query.date_from || null,
    date_to: query.date_to || null,
    funds: rows,
    grand_total: grandTotal,
  });
});

/**
 * GET /api/fund-categories -- reference list for populating a payment
 * form's fund dropdown. Includes inactive categories unless
 * ?is_active=true is passed, mirroring judges.controller.js's
 * listJudges convention.
 */
const listFundCategories = asyncHandler(async (req, res) => {
  const isActiveParam = req.query.is_active;
  const isActive = isActiveParam === undefined ? null : isActiveParam === 'true';

  const db = req.db;
  const { rows } = await db.query(
    `SELECT * FROM fund_categories WHERE ($1::boolean IS NULL OR is_active = $1) ORDER BY name ASC`,
    [isActive]
  );

  res.status(200).json({ results: rows });
});

module.exports = {
  createPayment,
  listPayments,
  getPaymentById,
  getFundDistributionReport,
  listFundCategories,
};
