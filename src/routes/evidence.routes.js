'use strict';

const express = require('express');
const { authenticate, requireRoles } = require('../middleware/auth');
const { withDbAudit } = require('../middleware/dbAudit');
const {
  createEvidence,
  listEvidence,
  getEvidenceById,
  updateEvidence,
  addCustodyEntry,
} = require('../controllers/evidence.controller');

const router = express.Router();

// Read access open to every authenticated role -- evidence_items carries no
// RLS restricting SELECT (see db/migrations/007_add_evidence_module.sql).
router.get('/', authenticate, withDbAudit('evidence_items'), listEvidence);
router.get('/:id', authenticate, withDbAudit('evidence_items'), getEvidenceById);

// Same role set as incidents/crashes -- sworn personnel who work the scene
// log the evidence; Court_Clerk and System_Admin do not collect evidence.
router.post(
  '/',
  authenticate,
  withDbAudit('evidence_items'),
  requireRoles('Patrol_Officer', 'Supervisor', 'System_Admin'),
  createEvidence
);

router.patch(
  '/:id',
  authenticate,
  withDbAudit('evidence_items'),
  requireRoles('Patrol_Officer', 'Supervisor', 'System_Admin'),
  updateEvidence
);

router.post(
  '/:id/custody',
  authenticate,
  withDbAudit('evidence_custody_log'),
  requireRoles('Patrol_Officer', 'Supervisor', 'System_Admin'),
  addCustodyEntry
);

module.exports = router;
