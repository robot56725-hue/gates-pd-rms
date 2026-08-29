'use strict';

const express = require('express');
const { authenticate, requireRoles } = require('../middleware/auth');
const { withDbAudit } = require('../middleware/dbAudit');
const { updateCourtLedger } = require('../controllers/court.controller');

const router = express.Router();

// Explicit RBAC block: Patrol_Officer, Supervisor, and even System_Admin are
// all rejected with 403 here. System_Admin administers the platform, not
// case dispositions -- a break-glass procedure for admins should be its own
// separate, heavily audited endpoint if one is ever needed, never an
// implicit bypass on this route.
//
// withDbAudit runs BEFORE requireRoles so a role that gets blocked here is
// still recorded on the audit trail -- see the identical note in
// citations.routes.js.
router.patch(
  '/citations/:id',
  authenticate,
  withDbAudit('court_ledger'),
  requireRoles('Court_Clerk'),
  updateCourtLedger
);

module.exports = router;
