'use strict';

const express = require('express');
const { authenticate, requireRoles } = require('../middleware/auth');
const { withDbAudit } = require('../middleware/dbAudit');
const {
  createJudge,
  listJudges,
  getJudgeById,
  updateJudge,
  addUnavailability,
  removeUnavailability,
} = require('../controllers/judges.controller');

const router = express.Router();

// Read access open to every authenticated role -- same rationale as
// cases.routes.js: anyone scheduling around a judge (clerk, supervisor,
// even an officer confirming a court date) needs to see the roster and its
// unavailability. Only the writes below are role-gated.
router.get('/', authenticate, withDbAudit('court_judges'), listJudges);
router.get('/:id', authenticate, withDbAudit('court_judges'), getJudgeById);

// Write access -- Court_Clerk + Supervisor/System_Admin only, same split as
// cases.routes.js: maintaining the judge reference list and its
// availability exceptions is clerk/court administration, not field work.
//
// withDbAudit runs BEFORE requireRoles on every route below, deliberately --
// same convention as cases.routes.js/citations.routes.js.
router.post(
  '/',
  authenticate,
  withDbAudit('court_judges'),
  requireRoles('Court_Clerk', 'Supervisor', 'System_Admin'),
  createJudge
);

router.patch(
  '/:id',
  authenticate,
  withDbAudit('court_judges'),
  requireRoles('Court_Clerk', 'Supervisor', 'System_Admin'),
  updateJudge
);

router.post(
  '/:id/unavailability',
  authenticate,
  withDbAudit('judge_unavailability'),
  requireRoles('Court_Clerk', 'Supervisor', 'System_Admin'),
  addUnavailability
);

router.delete(
  '/:id/unavailability/:unavailabilityId',
  authenticate,
  withDbAudit('judge_unavailability'),
  requireRoles('Court_Clerk', 'Supervisor', 'System_Admin'),
  removeUnavailability
);

module.exports = router;
