'use strict';

const express = require('express');
const { authenticate, requireRoles } = require('../middleware/auth');
const { withDbAudit } = require('../middleware/dbAudit');
const { createPayment, listPayments, getPaymentById, getFundDistributionReport } = require('../controllers/payments.controller');

const router = express.Router();

// Read access open to every authenticated role -- same rationale as the
// rest of this module. court_payments itself also carries
// payments_select_all (migration 011: FOR SELECT USING (true)), so the DB
// layer agrees reads are unrestricted.
//
// /fund-distribution-report is registered before /:id so it's never
// swallowed by the :id param route.
router.get('/fund-distribution-report', authenticate, withDbAudit('court_payments'), getFundDistributionReport);
router.get('/', authenticate, withDbAudit('court_payments'), listPayments);
router.get('/:id', authenticate, withDbAudit('court_payments'), getPaymentById);

// Write access -- Court_Clerk + System_Admin ONLY, deliberately narrower
// than every other write route in this module (which also allow
// Supervisor): court_payments FORCE ROW LEVEL SECURITY with
// payments_write_clerk_admin_only (migration 011) permitting INSERT only
// for current_app_role() IN ('Court_Clerk', 'System_Admin'). requireRoles
// here must match that set exactly, or a Supervisor would pass this app-
// layer check only to be rejected by Postgres's RLS policy with a raw,
// unhelpful error instead of a clean 403.
//
// withDbAudit runs BEFORE requireRoles, same convention as the rest of this
// module.
router.post(
  '/',
  authenticate,
  withDbAudit('court_payments'),
  requireRoles('Court_Clerk', 'System_Admin'),
  createPayment
);

module.exports = router;
