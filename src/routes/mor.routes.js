'use strict';

const express = require('express');
const { authenticate, requireRoles } = require('../middleware/auth');
const { withDbAudit } = require('../middleware/dbAudit');
const {
  createMor,
  listMor,
  getMorById,
  updateMor,
  addMorPerson,
  approveMor,
} = require('../controllers/mor.controller');

const router = express.Router();

// Read access open to every authenticated role -- matters_of_record carries
// no RLS restricting SELECT (see db/migrations/012_add_matters_of_record.sql).
router.get('/', authenticate, withDbAudit('matters_of_record'), listMor);
router.get('/:id', authenticate, withDbAudit('matters_of_record'), getMorById);

// Same role set as incidents.routes.js -- Court_Clerk and System_Admin have
// no business authoring a field report; only sworn personnel who actually
// responded may file or amend one.
router.post(
  '/',
  authenticate,
  withDbAudit('matters_of_record'),
  requireRoles('Patrol_Officer', 'Supervisor', 'System_Admin'),
  createMor
);

router.patch(
  '/:id',
  authenticate,
  withDbAudit('matters_of_record'),
  requireRoles('Patrol_Officer', 'Supervisor', 'System_Admin'),
  updateMor
);

router.post(
  '/:id/persons',
  authenticate,
  withDbAudit('mor_persons'),
  requireRoles('Patrol_Officer', 'Supervisor', 'System_Admin'),
  addMorPerson
);

// Approve/Reject -- Supervisor and System_Admin only, same reasoning as
// incidents.routes.js: an officer should not be able to approve their own
// report.
router.patch(
  '/:id/approval',
  authenticate,
  withDbAudit('matters_of_record'),
  requireRoles('Supervisor', 'System_Admin'),
  approveMor
);

module.exports = router;
