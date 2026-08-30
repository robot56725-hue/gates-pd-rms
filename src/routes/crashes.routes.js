'use strict';

const express = require('express');
const { authenticate, requireRoles } = require('../middleware/auth');
const { withDbAudit } = require('../middleware/dbAudit');
const {
  createCrash,
  listCrashes,
  getCrashById,
  updateCrash,
  approveCrash,
} = require('../controllers/crashes.controller');

const router = express.Router();

// Read access open to every authenticated role -- crash_reports carries no
// RLS restricting SELECT (see db/migrations/006_add_ecrash_module.sql).
router.get('/', authenticate, withDbAudit('crash_reports'), listCrashes);
router.get('/:id', authenticate, withDbAudit('crash_reports'), getCrashById);

// Same role set as citations/incidents -- sworn personnel who work the
// scene file the report; Court_Clerk and System_Admin do not.
router.post(
  '/',
  authenticate,
  withDbAudit('crash_reports'),
  requireRoles('Patrol_Officer', 'Supervisor', 'System_Admin'),
  createCrash
);

// Correcting a mistake on an already-filed crash report -- same role set as
// creation.
router.patch(
  '/:id',
  authenticate,
  withDbAudit('crash_reports'),
  requireRoles('Patrol_Officer', 'Supervisor', 'System_Admin'),
  updateCrash
);

// Approve/Reject -- Supervisor and System_Admin only. Deliberately excludes
// Patrol_Officer: an officer should not be able to approve their own report.
router.patch(
  '/:id/approval',
  authenticate,
  withDbAudit('crash_reports'),
  requireRoles('Supervisor', 'System_Admin'),
  approveCrash
);

module.exports = router;
