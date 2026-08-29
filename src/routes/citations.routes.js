'use strict';

const express = require('express');
const { authenticate, requireRoles } = require('../middleware/auth');
const { withDbAudit } = require('../middleware/dbAudit');
const { createCitation, listCitations, getCitationById } = require('../controllers/citations.controller');

const router = express.Router();

// Read access is open to every authenticated role -- e_citations carries no
// RLS restricting SELECT (see db/migrations/001_init_schema.sql). A
// Court_Clerk needs this to find what still needs a disposition; a Patrol
// Officer/Supervisor to review what they've issued; System_Admin for
// oversight. Only the POST below is role-gated.
router.get('/', authenticate, withDbAudit('e_citations'), listCitations);
router.get('/:id', authenticate, withDbAudit('e_citations'), getCitationById);

// Only sworn personnel who actually issue citations may submit them.
// Court_Clerk and System_Admin have no business creating a citation record.
//
// withDbAudit runs BEFORE requireRoles, deliberately: the audit row must be
// written for every authenticated request that reaches this route,
// including one an unauthorized role gets 403'd for -- a rejected access
// attempt is exactly the kind of event an audit trail exists to catch, and
// putting the RBAC gate first would mean a blocked request short-circuits
// before ever being audited.
router.post(
  '/',
  authenticate,
  withDbAudit('e_citations'),
  requireRoles('Patrol_Officer', 'Supervisor', 'System_Admin'),
  createCitation
);

module.exports = router;
