'use strict';

const express = require('express');
const { authenticate, requireRoles, requirePrimaryRole } = require('../middleware/auth');
const { withDbAudit } = require('../middleware/dbAudit');
const { listUsers, createUser, updateUser, deleteUser } = require('../controllers/users.controller');

const router = express.Router();

// Personnel management -- adding, deactivating, and reassigning roles for
// this department's own accounts.
//
// withDbAudit runs BEFORE the role guard so a blocked attempt is still on
// the audit trail -- same convention every other route in this app follows
// (see e.g. citations.routes.js/court.routes.js's identical note); this
// file previously had the two reversed, which meant a denied personnel
// action here was the one write attempt in the whole app that left no
// audit record.
//
// GET is listed as requireRoles() (any of the account's roles, primary or
// additionally granted) -- viewing personnel carries no RLS restriction, so
// this is a pure app-layer policy choice, consistent with additional_roles
// being "purely additive operational capability" per migration 008's own
// comment. POST/PATCH/DELETE are requirePrimaryRole() instead: the `users`
// table's RLS policies (001_init_schema.sql, 008_..._multirole_...sql) are
// deliberately keyed to the account's PRIMARY role only, never
// additional_roles -- using the any-role requireRoles() here let a
// Supervisor additionally granted System_Admin pass this guard and then
// hit RLS silently blocking the write, which surfaced as a confusing
// "No such user account" on delete instead of an honest 403.
router.get('/', authenticate, withDbAudit('users'), requireRoles('System_Admin'), listUsers);
router.post('/', authenticate, withDbAudit('users'), requirePrimaryRole('System_Admin'), createUser);
router.patch('/:id', authenticate, withDbAudit('users'), requirePrimaryRole('System_Admin'), updateUser);
router.delete('/:id', authenticate, withDbAudit('users'), requirePrimaryRole('System_Admin'), deleteUser);

module.exports = router;
