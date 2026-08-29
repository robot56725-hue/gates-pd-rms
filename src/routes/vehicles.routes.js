'use strict';

const express = require('express');
const { authenticate } = require('../middleware/auth');
const { withDbAudit } = require('../middleware/dbAudit');
const { searchVehicles, getVehicleById } = require('../controllers/vehicles.controller');

const router = express.Router();

// Same rationale as persons.routes.js -- read access open to every
// authenticated role, no RLS restriction on master_vehicles.
router.get('/', authenticate, withDbAudit('master_vehicles'), searchVehicles);
router.get('/:id', authenticate, withDbAudit('master_vehicles'), getVehicleById);

module.exports = router;
