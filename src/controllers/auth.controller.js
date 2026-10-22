'use strict';

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const env = require('../config/env');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { loginSchema } = require('../validation/authSchema');

// Was a hardcoded, strict 30-minute lifetime (see git history) -- deliberately
// tightened against a longer-lived token being treated as a casual config
// tweak. Extended to a full shift (12h) by explicit chief's-office decision
// (2026-10-22) specifically so an officer who loses signal mid-shift stays
// logged in through the gap for the offline data-entry feature -- NOT a
// walk-back of the original reasoning, a deliberate trade against it: a
// lost/unlocked duty phone now stays authenticated for up to 12h instead of
// 30m, with the phone's own lock screen as the actual line of defense during
// that window (same trust model as any other work app on a duty phone). A
// *real* refresh-token feature (short-lived access token + a separate,
// revocable refresh token) would be the more defensible way to get the same
// usability without this trade-off, and is still the better long-term fix --
// this is the fast path chosen for now. Still no refresh mechanism: once a
// token issued here expires, it's a fresh login, full stop -- which, at a
// 12h TTL, already satisfies "re-login at least once a day" on its own.
const ACCESS_TOKEN_TTL = '12h';
const ACCESS_TOKEN_TTL_SECONDS = 12 * 60 * 60;

// A bcrypt hash of an arbitrary, never-used password. Compared against on a
// failed lookup so that response timing for "no such user" and "wrong
// password" is statistically indistinguishable -- otherwise the early
// return on an unknown username (skipping bcrypt entirely) is a timing
// side-channel an attacker can use to enumerate valid usernames.
const DUMMY_HASH = '$2b$12$gqtZTSXXABTRKrVeOcwv2.v.U8y/OzxjXRTofyiJ5E3zaw6WjXQKm';

async function writeLoginFailAudit({ userId, ip, userAgent }) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (user_id, action_type, target_table, target_record_id, ip_address, user_agent)
       VALUES ($1, 'LOGIN_FAIL', 'users', $2, $3, $4)`,
      [userId, userId, ip, userAgent || null]
    );
  } catch (err) {
    // Audit logging must never crash the auth flow, but a failure here is
    // worth shouting about -- a login-failure audit trail is a core
    // security control.
    // eslint-disable-next-line no-console
    console.error('[audit] failed to record LOGIN_FAIL', err);
  }
}

async function writeLoginSuccessAudit({ userId, ip, userAgent }) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (user_id, action_type, target_table, target_record_id, ip_address, user_agent)
       VALUES ($1, 'LOGIN_SUCCESS', 'users', $1, $2, $3)`,
      [userId, ip, userAgent || null]
    );
  } catch (err) {
    // Same fail-open-but-loud posture as writeLoginFailAudit: a missing
    // audit row must never block a legitimate officer/clerk from getting
    // their token, but silently losing the "who logged in, from where"
    // record is exactly the kind of gap worth shouting about.
    // eslint-disable-next-line no-console
    console.error('[audit] failed to record LOGIN_SUCCESS', err);
  }
}

const login = asyncHandler(async (req, res) => {
  const { error, value } = loginSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const { username, password } = value;

  // additional_roles is cast to text[] -- it's a Postgres array of a custom
  // ENUM type (user_role[]), and node-postgres has no built-in parser for a
  // database-specific array OID, so left uncasted it comes back as the raw
  // wire string "{Supervisor}" rather than a JS array. Spreading a STRING
  // into the roles array below would silently fan it out character by
  // character instead of throwing, so this one is easy to miss without a
  // cast -- see the identical note on USER_COLUMNS in users.controller.js.
  const { rows } = await pool.query(
    `SELECT id, username, password_hash, role, additional_roles::text[] AS additional_roles,
            badge_number, full_name, is_active
       FROM users
      WHERE username = $1`,
    [username]
  );
  const user = rows[0];

  if (!user) {
    // Unknown username: burn roughly the same amount of time a real compare
    // would take, then respond with the SAME generic message a bad password
    // gets, so the response can't be used to enumerate valid usernames.
    await bcrypt.compare(password, DUMMY_HASH);
    await writeLoginFailAudit({ userId: null, ip: req.ip, userAgent: req.get('user-agent') });
    throw new AppError(401, 'Invalid username or password.');
  }

  const passwordMatches = await bcrypt.compare(password, user.password_hash);

  if (!passwordMatches || !user.is_active) {
    // Same generic message whether the password was wrong or the account is
    // deactivated -- do not tell an unauthenticated caller which case it was.
    await writeLoginFailAudit({ userId: user.id, ip: req.ip, userAgent: req.get('user-agent') });
    throw new AppError(401, 'Invalid username or password.');
  }

  // roles = primary role + any additional_roles granted by a System_Admin
  // (db/migrations/008_..._multirole_...sql), deduplicated. requireRoles()
  // grants access if ANY of these matches; RLS (users/court_ledger writes)
  // still keys off the single primary `role` only -- see that migration's
  // header note for why.
  const roles = Array.from(new Set([user.role, ...(user.additional_roles || [])]));

  const token = jwt.sign(
    { sub: user.id, badge: user.badge_number, role: user.role, roles },
    env.jwtSecret,
    {
      algorithm: 'HS256',
      expiresIn: ACCESS_TOKEN_TTL,
      issuer: env.jwtIssuer,
      audience: env.jwtAudience,
    }
  );

  await writeLoginSuccessAudit({ userId: user.id, ip: req.ip, userAgent: req.get('user-agent') });

  res.status(200).json({
    token,
    token_type: 'Bearer',
    expires_in_seconds: ACCESS_TOKEN_TTL_SECONDS,
    role: user.role,
    roles,
    badge_number: user.badge_number,
    full_name: user.full_name,
  });
});

module.exports = { login };
