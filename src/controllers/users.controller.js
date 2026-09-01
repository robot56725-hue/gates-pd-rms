'use strict';

const bcrypt = require('bcrypt');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { createUserSchema, updateUserSchema } = require('../validation/userSchema');

const BCRYPT_ROUNDS = 12;

// additional_roles is casted to text[] because it's a Postgres array of a
// custom ENUM type (user_role[]) -- node-postgres only ships a built-in
// array parser for well-known type OIDs (text[], int4[], etc), not for a
// database-specific enum array, so left uncasted it comes back as the raw
// wire-format string "{Supervisor}" instead of a JS array, breaking
// anything downstream that calls .filter()/.map() on it (see updateUser).
const USER_COLUMNS = `id, username, role, additional_roles::text[] AS additional_roles, badge_number, full_name, officer_rank, agency, is_active, created_at, updated_at`;

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

  // additional_roles is purely additive on top of the primary role -- strip
  // out a redundant copy of the primary role itself so role/additional_roles
  // never disagree about whether the account "has" its own primary role.
  const additionalRoles = (value.additional_roles || []).filter((r) => r !== value.role);

  try {
    const { rows } = await req.db.query(
      `INSERT INTO users (username, password_hash, role, additional_roles, badge_number, full_name, officer_rank, agency)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${USER_COLUMNS}`,
      [
        value.username,
        passwordHash,
        value.role,
        additionalRoles,
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
 * PATCH /api/users/:id -- update role/additional_roles/badge/name/rank/
 * agency, activate or deactivate an account, or reset a password.
 * System_Admin only.
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

  // additional_roles is only touched when the PATCH actually includes it --
  // see the "no default()" note in userSchema.js. Any overlap with the
  // primary role is tidied up after the UPDATE below (once we know the
  // row's final `role`, whether or not this request changed it).
  const additionalRoles = value.additional_roles !== undefined ? value.additional_roles : null;

  let rows;
  try {
    ({ rows } = await req.db.query(
      `UPDATE users SET
          role             = COALESCE($1, role),
          additional_roles = COALESCE($2, additional_roles),
          badge_number     = COALESCE($3, badge_number),
          full_name        = COALESCE($4, full_name),
          officer_rank     = COALESCE($5, officer_rank),
          agency           = COALESCE($6, agency),
          is_active        = COALESCE($7, is_active),
          password_hash    = COALESCE($8, password_hash)
        WHERE id = $9
        RETURNING ${USER_COLUMNS}`,
      [
        value.role ?? null,
        additionalRoles,
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

  // additional_roles may still contain the (now-current) primary role if
  // only `role` changed this request without also resending
  // additional_roles -- harmless for access checks (requireRoles just needs
  // ANY match) but tidy it up for display.
  rows[0].additional_roles = (rows[0].additional_roles || []).filter((r) => r !== rows[0].role);

  res.status(200).json(rows[0]);
});

/**
 * DELETE /api/users/:id -- permanently remove a personnel account.
 * System_Admin only (db/migrations/008_..._multirole_...sql added the RLS
 * policy that allows this; before that migration DELETE was unconditionally
 * denied at the database layer for every role).
 *
 * Deliberately NOT guarded against an account with history by application
 * code -- every table that references users.id (e_citations.officer_id,
 * incidents.reporting_officer_id, evidence_items.collected_by_id, etc.) does
 * so with an explicit ON DELETE RESTRICT or NO ACTION, so the database itself
 * refuses to delete an account with any real record attached to it and
 * Postgres does the enforcing, not a checklist of every table this code has
 * to remember to check. Use deactivation (PATCH is_active=false) for an
 * account with a history; DELETE is for a never-used or mistakenly-created
 * account.
 *
 * RESTRICT and NO ACTION are NOT the same Postgres error code, even though
 * they enforce the same thing: NO ACTION raises 23503
 * (foreign_key_violation, the standard one), but an explicit RESTRICT raises
 * 23001 (restrict_violation) instead -- a different SQLSTATE most people
 * (this codebase included, until this fix) don't know exists. Most of the
 * FKs into users.id here were deliberately declared RESTRICT rather than
 * left as the implicit NO ACTION default, so catching only 23503 caught
 * just the minority (approved_by_id columns, evidence_items/evidence_
 * custody_log) and let every RESTRICT violation (incidents.reporting_
 * officer_id, incident_narratives.author_id, e_citations.officer_id,
 * court_cases.filed_by_id, court_dockets.created_by_id, court_payments.
 * received_by_id, court_warrants.created_by_id, crash_reports.reporting_
 * officer_id, case_notes.author_id, matters_of_record.reporting_officer_id
 * -- i.e. most real accounts) fall through unrecognized to errorHandler.js's
 * generic 500, instead of this friendly 409.
 */
const deleteUser = asyncHandler(async (req, res) => {
  if (req.params.id === req.user.id) {
    throw new AppError(400, 'You cannot delete your own account.');
  }

  let rows;
  try {
    ({ rows } = await req.db.query(`DELETE FROM users WHERE id = $1 RETURNING id, username`, [
      req.params.id,
    ]));
  } catch (err) {
    if (err.code === '23503' || err.code === '23001') {
      throw new AppError(
        409,
        'This account has citations, incidents, crash reports, evidence, court records, or matters of record on file and cannot be deleted. Deactivate it instead.'
      );
    }
    throw err;
  }

  if (!rows[0]) {
    throw new AppError(404, 'No such user account.');
  }

  res.status(200).json({ id: rows[0].id, username: rows[0].username, outcome: 'deleted' });
});

module.exports = { listUsers, createUser, updateUser, deleteUser };
