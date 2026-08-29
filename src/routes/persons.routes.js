'use strict';

const express = require('express');
const { authenticate } = require('../middleware/auth');
const { withDbAudit } = require('../middleware/dbAudit');
const { searchPersons, getPersonById } = require('../controllers/persons.controller');

const router = express.Router();

// Read access is intentionally open to every authenticated role --
// master_persons carries no RLS policy restricting SELECT (see
// db/migrations/001_init_schema.sql). Any sworn officer or clerk may need
// to look up a person's record; writes to civilian data only ever happen
// as a byproduct of submitting a citation (see citations.routes.js), never
// through this router.
router.get('/', authenticate, withDbAudit('master_persons'), searchPersons);
router.get('/:id', authenticate, withDbAudit('master_persons'), getPersonById);

module.exports = router;
