'use strict';

const bcrypt = require('bcrypt');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { createUserSchema, updateUserSchema } = require('../validation/userSchema');

const BCRYPT_ROUNDS = 12;

const USER_COLUMNS = `id, username, role, badge_number, full_name, officer_rank, agency, is_active, created_at, updated_at`;

/**
 * GET /api/users -- personnel roster. System_Admin only (see
 * users.routes.js). Every account ever created is listed, active or not --
 * deactivated rows are never deleted (see the note on deleteUser below), so
 * this doubles as the department's full account history.
 */
const listUsers = asyncHandler(async (req, res) => {
  const { rows } = await req.db.query(`SELECT ${USER_COLUMNS} FROM users ORDER BY created_at`);
  res.status(200).json({ results: rows });
});

/**
 * POST /api/users -- create a new personnel account. System_Admin only.
 *
 * Runs on req.db (see middleware/dbAudit.js), which has already set
 * app.actor_role='System_Admin' for this transaction -- the same value the
 * `users_write_admin_only` RLS policy (db/migrations/001_init_schema.sql)
 * requires for an INSERT. The route-level requireRoles('System_Admin') guard
 * and this RLS policy are deliberately redundant: the route guard gives a
 * clean 403 with a helpful message, the RLS policy is the backstop that
 * still holds even if a route were ever miswired.
 */
const createUser = asyncHandler(async (req, res) => {
  const { error, value } = createUserSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const passwordHash = await bcrypt.hash(value.password, BCRYPT_ROUNDS);

  try {
    const { rows } = await req.db.query(
      `INSERT INTO users (username, password_hash, role, badge_number, full_name, officer_rank, agency)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${USER_COLUMNS}`,
      [
        value.username,
        passwordHash,
        value.role,
        value.badge_number,
        value.full_name,
        value.officer_rank || null,
        value.agency,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      // uq_users_username or uq_users_badge_number -- either is a client
      // error (pick a different username/badge), never a 500.
      const field = err.constraint === 'uq_users_badge_number' ? 'badge_number' : 'username';
      throw new AppError(409, `That ${field} is already in use by another account.`);
    }
    throw err;
  }
});

/**
 * PATCH /api/users/:id -- update role/badge/name/rank/agency, activate or
 * deactivate an account, or reset a password. System_Admin only.
 *
 * There is deliberately no DELETE endpoint. db/migrations/001_init_schema.sql
 * gives the `users` table a SELECT policy and admin-only INSERT/UPDATE
 * policies, but no DELETE policy at all -- under FORCE ROW LEVEL SECURITY
 * that means every role, including System_Admin, is unconditionally denied
 * at the database layer. That's intentional: an account's history (who held
 * a badge number, when) is itself a record worth keeping. Deactivating
 * (is_active=false) achieves the practical goal -- the account can no longer
 * log in (see controllers/auth.controller.js) -- without erasing that history.
 */
const updateUser = asyncHandler(async (req, res) => {
  const { error, value } = updateUserSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  // Guard rail, not an RLS-level rule: stop the one System_Admin on duty from
  // locking themselves out by deactivating their own account through this
  // endpoint. (Nothing stops a SECOND admin from deactivating the first.)
  if (req.params.id === req.user.id && value.is_active === false) {
    throw new AppError(400, 'You cannot deactivate your own account.');
  }

  const passwordHash = value.new_password ? await bcrypt.hash(value.new_password, BCRYPT_ROUNDS) : null;

  let rows;
  try {
    ({ rows } = await req.db.query(
      `UPDATE users SET
          role          = COALESCE($1, role),
          badge_number  = COALESCE($2, badge_number),
          full_name     = COALESCE($3, full_name),
          officer_rank  = COALESCE($4, officer_rank),
          agency        = COALESCE($5, agency),
          is_active     = COALESCE($6, is_active),
          password_hash = COALESCE($7, password_hash)
        WHERE id = $8
        RETURNING ${USER_COLUMNS}`,
      [
        value.role ?? null,
        value.badge_number ?? null,
        value.full_name ?? null,
        value.officer_rank ?? null,
        value.agency ?? null,
        value.is_active ?? null,
        passwordHash,
        req.params.id,
      ]
    ));
  } catch (err) {
    if (err.code === '23505') {
      throw new AppError(409, 'That badge_number is already in use by another account.');
    }
    throw err;
  }

  if (!rows[0]) {
    throw new AppError(404, 'No such user account.');
  }

  res.status(200).json(rows[0]);
});

module.exports = { listUsers, createUser, updateUser };
