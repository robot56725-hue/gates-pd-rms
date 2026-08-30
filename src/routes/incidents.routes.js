'use strict';

const express = require('express');
const { authenticate, requireRoles } = require('../middleware/auth');
const { withDbAudit } = require('../middleware/dbAudit');
const {
  createIncident,
  listIncidents,
  getIncidentById,
  updateIncident,
  approveIncident,
  addNarrative,
} = require('../controllers/incidents.controller');

const router = express.Router();

// Read access open to every authenticated role -- incidents carries no RLS
// restricting SELECT (see db/migrations/001_init_schema.sql /
// 005_add_tibrs_incident_module.sql).
router.get('/', authenticate, withDbAudit('incidents'), listIncidents);
router.get('/:id', authenticate, withDbAudit('incidents'), getIncidentById);

// Only sworn personnel who actually work the incident may file or amend it.
// Same role set as citations.routes.js -- Court_Clerk and System_Admin have
// no business authoring a field incident report.
router.post(
  '/',
  authenticate,
  withDbAudit('incidents'),
  requireRoles('Patrol_Officer', 'Supervisor', 'System_Admin'),
  createIncident
);

router.patch(
  '/:id',
  authenticate,
  withDbAudit('incidents'),
  requireRoles('Patrol_Officer', 'Supervisor', 'System_Admin'),
  updateIncident
);

router.post(
  '/:id/narratives',
  authenticate,
  withDbAudit('incident_narratives'),
  requireRoles('Patrol_Officer', 'Supervisor', 'System_Admin'),
  addNarrative
);

// Approve/Reject -- Supervisor and System_Admin only. Deliberately excludes
// Patrol_Officer: an officer should not be able to approve their own report.
router.patch(
  '/:id/approval',
  authenticate,
  withDbAudit('incidents'),
  requireRoles('Supervisor', 'System_Admin'),
  approveIncident
);

module.exports = router;
