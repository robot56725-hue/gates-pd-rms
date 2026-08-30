'use strict';

const express = require('express');
const { authenticate, requireRoles } = require('../middleware/auth');
const { withDbAudit } = require('../middleware/dbAudit');
const {
  createCase,
  listCases,
  getCaseById,
  addCharge,
  updateCharge,
  addNote,
  updateCaseStatus,
  getFtaNotice,
} = require('../controllers/cases.controller');

const router = express.Router();

// Read access is open to every authenticated role, same rationale as
// citations.routes.js: a Patrol_Officer/Supervisor needs to see what's
// happened to a case after it left the field, System_Admin for oversight,
// Court_Clerk to work the docket. Only the write routes below are role-gated.
router.get('/', authenticate, withDbAudit('court_cases'), listCases);
router.get('/:id', authenticate, withDbAudit('court_cases'), getCaseById);

// Document-automation data feed for an FTA notice -- read-only, same access
// as every other GET on this router.
router.get('/:id/fta-notice', authenticate, withDbAudit('court_cases'), getFtaNotice);

// Write access -- Court_Clerk + Supervisor/System_Admin only. Patrol_Officer
// issues citations and writes incident narratives, but opening/managing a
// court case (charges, pleas, dispositions, notes, status) is clerk/court
// work, not field work.
//
// withDbAudit runs BEFORE requireRoles on every route below, deliberately --
// same convention as citations.routes.js/court.routes.js: a role that gets
// 403'd here must still land on the audit trail.
router.post(
  '/',
  authenticate,
  withDbAudit('court_cases'),
  requireRoles('Court_Clerk', 'Supervisor', 'System_Admin'),
  createCase
);

router.patch(
  '/:id/status',
  authenticate,
  withDbAudit('court_cases'),
  requireRoles('Court_Clerk', 'Supervisor', 'System_Admin'),
  updateCaseStatus
);

router.post(
  '/:id/charges',
  authenticate,
  withDbAudit('case_charges'),
  requireRoles('Court_Clerk', 'Supervisor', 'System_Admin'),
  addCharge
);

router.patch(
  '/:id/charges/:chargeId',
  authenticate,
  withDbAudit('case_charges'),
  requireRoles('Court_Clerk', 'Supervisor', 'System_Admin'),
  updateCharge
);

router.post(
  '/:id/notes',
  authenticate,
  withDbAudit('case_notes'),
  requireRoles('Court_Clerk', 'Supervisor', 'System_Admin'),
  addNote
);

module.exports = router;
