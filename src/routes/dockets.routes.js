'use strict';

const express = require('express');
const { authenticate, requireRoles } = require('../middleware/auth');
const { withDbAudit } = require('../middleware/dbAudit');
const {
  createDocket,
  listDockets,
  getDocketById,
  updateDocket,
  addDocketEntry,
  updateDocketEntry,
} = require('../controllers/dockets.controller');

const router = express.Router();

// Read access open to every authenticated role -- same rationale as
// cases.routes.js/judges.routes.js: an officer needs to see when they're
// due in court, a clerk builds the docket, a supervisor/admin needs
// oversight. Only the writes below are role-gated.
router.get('/', authenticate, withDbAudit('court_dockets'), listDockets);
router.get('/:id', authenticate, withDbAudit('court_dockets'), getDocketById);

// Write access -- Court_Clerk + Supervisor/System_Admin only, same split as
// cases.routes.js/judges.routes.js: scheduling/calendaring is clerk/court
// administration, not field work.
//
// withDbAudit runs BEFORE requireRoles on every route below, deliberately --
// same convention as cases.routes.js/citations.routes.js.
router.post(
  '/',
  authenticate,
  withDbAudit('court_dockets'),
  requireRoles('Court_Clerk', 'Supervisor', 'System_Admin'),
  createDocket
);

router.patch(
  '/:id',
  authenticate,
  withDbAudit('court_dockets'),
  requireRoles('Court_Clerk', 'Supervisor', 'System_Admin'),
  updateDocket
);

router.post(
  '/:id/entries',
  authenticate,
  withDbAudit('docket_entries'),
  requireRoles('Court_Clerk', 'Supervisor', 'System_Admin'),
  addDocketEntry
);

router.patch(
  '/:id/entries/:entryId',
  authenticate,
  withDbAudit('docket_entries'),
  requireRoles('Court_Clerk', 'Supervisor', 'System_Admin'),
  updateDocketEntry
);

module.exports = router;
