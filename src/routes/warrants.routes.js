'use strict';

const express = require('express');
const { authenticate, requireRoles } = require('../middleware/auth');
const { withDbAudit } = require('../middleware/dbAudit');
const { createWarrant, listWarrants, getWarrantById, updateWarrantStatus } = require('../controllers/warrants.controller');

const router = express.Router();

// Read access open to every authenticated role -- an officer serving
// warrants needs to see what's outstanding as much as a clerk tracking
// them. court_warrants carries no RLS (unlike court_payments), so nothing
// at the DB layer narrows this further.
router.get('/', authenticate, withDbAudit('court_warrants'), listWarrants);
router.get('/:id', authenticate, withDbAudit('court_warrants'), getWarrantById);

// Write access -- Court_Clerk + Supervisor/System_Admin only, same split as
// cases.routes.js/dockets.routes.js/judges.routes.js: preparing and
// tracking a warrant application is clerk/court administration.
//
// withDbAudit runs BEFORE requireRoles, same convention as the rest of this
// module.
router.post(
  '/',
  authenticate,
  withDbAudit('court_warrants'),
  requireRoles('Court_Clerk', 'Supervisor', 'System_Admin'),
  createWarrant
);

router.patch(
  '/:id/status',
  authenticate,
  withDbAudit('court_warrants'),
  requireRoles('Court_Clerk', 'Supervisor', 'System_Admin'),
  updateWarrantStatus
);

module.exports = router;
