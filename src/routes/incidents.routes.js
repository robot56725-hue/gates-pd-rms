'use strict';

const express = require('express');
const { authenticate, requireRoles } = require('../middleware/auth');
const { withDbAudit } = require('../middleware/dbAudit');
const {
  createIncident,
  listIncidents,
  getIncidentById,
  updateIncident,
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
  requireRoles('Patrol_Officer', 'Supervisor'),
  createIncident
);

router.patch(
  '/:id',
  authenticate,
  withDbAudit('incidents'),
  requireRoles('Patrol_Officer', 'Supervisor'),
  updateIncident
);

router.post(
  '/:id/narratives',
  authenticate,
  withDbAudit('incident_narratives'),
  requireRoles('Patrol_Officer', 'Supervisor'),
  addNarrative
);

module.exports = router;
