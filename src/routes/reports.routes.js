'use strict';

const express = require('express');
const { authenticate } = require('../middleware/auth');
const { withDbAudit } = require('../middleware/dbAudit');
const { getMonthlySummary } = require('../controllers/reports.controller');

const router = express.Router();

// Read-only, open to every authenticated role -- an aggregate activity
// report carries no per-defendant detail sensitive enough to restrict
// further, and a Supervisor/officer reviewing court-module throughput is a
// legitimate use just as much as a clerk or admin.
router.get('/monthly-summary', authenticate, withDbAudit('court_cases'), getMonthlySummary);

module.exports = router;
