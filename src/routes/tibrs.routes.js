'use strict';

const express = require('express');
const { authenticate } = require('../middleware/auth');
const { withDbAudit } = require('../middleware/dbAudit');
const { getMonthlyValidation } = require('../controllers/tibrs.controller');

const router = express.Router();

// Read-only, open to every authenticated role -- this is a report over data
// everyone can already read individually via /api/incidents, just
// pre-aggregated into "what's not submission-ready yet."
router.get('/monthly-validation', authenticate, withDbAudit('incidents'), getMonthlyValidation);

module.exports = router;
