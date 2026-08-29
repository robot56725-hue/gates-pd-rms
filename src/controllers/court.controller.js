'use strict';

const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const {
  citationIdParamSchema,
  courtLedgerUpdateSchema,
} = require('../validation/courtLedgerSchema');

/**
 * PATCH /api/court/citations/:id
 *
 * Route-level RBAC (requireRoles('Court_Clerk') in routes/court.routes.js)
 * is the primary gate here. The database's court_ledger RLS policy (see
 * db/migrations/001_init_schema.sql, Section 9) is a second, independent
 * backstop keyed off the same role via the `app.actor_role` session GUC
 * that withDbAudit() sets -- so even a bug in the route wiring above still
 * can't let a non-clerk write this table.
 */
const updateCourtLedger = asyncHandler(async (req, res) => {
  const { error: paramError, value: params } = citationIdParamSchema.validate(req.params);
  if (paramError) throw Object.assign(paramError, { isJoi: true });

  const { error: bodyError, value: updates } = courtLedgerUpdateSchema.validate(req.body);
  if (bodyError) throw Object.assign(bodyError, { isJoi: true });

  const db = req.db;
  const citationId = params.id;

  const citationResult = await db.query(
    `SELECT id, offense_date FROM e_citations WHERE id = $1`,
    [citationId]
  );
  if (!citationResult.rows[0]) {
    throw new AppError(404, 'Citation not found.');
  }

  const ledgerResult = await db.query(`SELECT * FROM court_ledger WHERE citation_id = $1`, [
    citationId,
  ]);
  const existingLedger = ledgerResult.rows[0] || null;

  // Sanity check spanning both existing and incoming values: a clerk should
  // never be able to record more paid than owed, on top of the same
  // guarantee the database's own CHECK constraint enforces.
  const prospectiveFine =
    updates.fine_amount_due !== undefined
      ? updates.fine_amount_due
      : existingLedger
        ? existingLedger.fine_amount_due
        : null;
  const prospectivePaid =
    updates.amount_paid !== undefined
      ? updates.amount_paid
      : existingLedger
        ? existingLedger.amount_paid
        : 0;

  if (prospectiveFine !== null && Number(prospectivePaid) > Number(prospectiveFine)) {
    throw new AppError(422, 'amount_paid cannot exceed fine_amount_due.');
  }

  let ledgerRow;

  if (existingLedger) {
    // Partial update: COALESCE(new value, existing value) per field so an
    // omitted field is left untouched -- never JS-side defaulted, which
    // would silently stomp an existing value the clerk didn't intend to
    // change.
    const updateResult = await db.query(
      `UPDATE court_ledger
          SET court_status            = COALESCE($1, court_status),
              fine_amount_due         = COALESCE($2, fine_amount_due),
              amount_paid             = COALESCE($3, amount_paid),
              payment_date            = COALESCE($4, payment_date),
              disposition_notes       = COALESCE($5, disposition_notes),
              last_updated_by_user_id = $6
        WHERE citation_id = $7
        RETURNING *`,
      [
        updates.court_status ?? null,
        updates.fine_amount_due ?? null,
        updates.amount_paid ?? null,
        updates.payment_date ?? null,
        updates.disposition_notes ?? null,
        req.user.id,
        citationId,
      ]
    );
    ledgerRow = updateResult.rows[0];
  } else {
    // First disposition on this citation: apply the same column defaults
    // the schema itself uses (Pending / 0), so behavior matches whether the
    // ledger row already existed or not.
    const insertResult = await db.query(
      `INSERT INTO court_ledger
          (citation_id, court_status, fine_amount_due, amount_paid, payment_date,
           disposition_notes, last_updated_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        citationId,
        updates.court_status ?? 'Pending',
        updates.fine_amount_due ?? null,
        updates.amount_paid ?? 0,
        updates.payment_date ?? null,
        updates.disposition_notes ?? null,
        req.user.id,
      ]
    );
    ledgerRow = insertResult.rows[0];
  }

  res.status(200).json({
    citation_id: ledgerRow.citation_id,
    court_status: ledgerRow.court_status,
    fine_amount_due: ledgerRow.fine_amount_due,
    amount_paid: ledgerRow.amount_paid,
    payment_date: ledgerRow.payment_date,
    disposition_notes: ledgerRow.disposition_notes,
    last_updated_by_user_id: ledgerRow.last_updated_by_user_id,
    updated_at: ledgerRow.updated_at,
  });
});

module.exports = { updateCourtLedger };
