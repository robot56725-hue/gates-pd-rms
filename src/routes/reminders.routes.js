'use strict';

const express = require('express');
const { authenticate, requireRoles } = require('../middleware/auth');
const { withDbAudit } = require('../middleware/dbAudit');
const { createReminder, listReminders, getReminderById, updateReminder } = require('../controllers/reminders.controller');

const router = express.Router();

// Read access open to every authenticated role -- same rationale as
// cases.routes.js/dockets.routes.js.
router.get('/', authenticate, withDbAudit('court_reminders'), listReminders);
router.get('/:id', authenticate, withDbAudit('court_reminders'), getReminderById);

// Write access -- Court_Clerk + Supervisor/System_Admin only, same split as
// every other court-administration resource in this module.
//
// withDbAudit runs BEFORE requireRoles on every route below, deliberately --
// same convention as cases.routes.js/citations.routes.js.
router.post(
  '/',
  authenticate,
  withDbAudit('court_reminders'),
  requireRoles('Court_Clerk', 'Supervisor', 'System_Admin'),
  createReminder
);

router.patch(
  '/:id',
  authenticate,
  withDbAudit('court_reminders'),
  requireRoles('Court_Clerk', 'Supervisor', 'System_Admin'),
  updateReminder
);

module.exports = router;
