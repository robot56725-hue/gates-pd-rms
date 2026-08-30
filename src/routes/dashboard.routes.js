'use strict';

const express = require('express');
const { authenticate } = require('../middleware/auth');
const { withDbAudit } = require('../middleware/dbAudit');
const { getUpcomingAppearances } = require('../controllers/dashboard.controller');

const router = express.Router();

// Read-only, open to every authenticated role -- an officer checking their
// own upcoming court dates needs this exactly as much as a clerk building
// the day's queue. No writes exist on this router.
router.get('/upcoming-appearances', authenticate, withDbAudit('docket_entries'), getUpcomingAppearances);

module.exports = router;
