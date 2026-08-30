'use strict';

const express = require('express');
const { authenticate } = require('../middleware/auth');
const { withDbAudit } = require('../middleware/dbAudit');
const { listFundCategories } = require('../controllers/payments.controller');

const router = express.Router();

// Read-only reference list, open to every authenticated role -- needed to
// populate a payment form's fund dropdown. No writes: fund_categories is
// seeded administrative config (migration 011), not managed through this
// API today.
router.get('/', authenticate, withDbAudit('fund_categories'), listFundCategories);

module.exports = router;
