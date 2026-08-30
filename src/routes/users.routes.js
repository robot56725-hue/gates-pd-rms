'use strict';

const express = require('express');
const { authenticate, requireRoles } = require('../middleware/auth');
const { withDbAudit } = require('../middleware/dbAudit');
const { listUsers, createUser, updateUser } = require('../controllers/users.controller');

const router = express.Router();

// Personnel management -- adding, deactivating, and reassigning roles for
// this department's own accounts. System_Admin only, at both the route
// guard here AND the RLS policy on the `users` table itself (see
// controllers/users.controller.js for why both exist).
router.get('/', authenticate, requireRoles('System_Admin'), withDbAudit('users'), listUsers);
router.post('/', authenticate, requireRoles('System_Admin'), withDbAudit('users'), createUser);
router.patch('/:id', authenticate, requireRoles('System_Admin'), withDbAudit('users'), updateUser);

module.exports = router;
