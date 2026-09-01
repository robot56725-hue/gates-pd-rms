'use strict';

const jwt = require('jsonwebtoken');
const env = require('../config/env');
const AppError = require('../utils/AppError');

const VALID_ROLES = new Set(['Patrol_Officer', 'Supervisor', 'Court_Clerk', 'System_Admin']);

/**
 * Verifies the bearer JWT (signature, expiry, issuer, audience) and attaches
 * the decoded identity to req.user. Does not consult the database -- this is
 * pure token verification. Authorization (which roles may proceed) is a
 * separate concern, see requireRoles() below, so every route gets a fully
 * populated identity even on a path that will end up 403ing.
 */
function authenticate(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(new AppError(401, 'Not authenticated.'));
  }

  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret, {
      algorithms: ['HS256'],
      issuer: env.jwtIssuer,
      audience: env.jwtAudience,
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return next(new AppError(401, 'Token has expired.'));
    }
    return next(new AppError(401, 'Could not validate credentials.'));
  }

  if (!payload.sub || !payload.role) {
    return next(new AppError(401, 'Token is missing required claims.'));
  }

  // Fail closed: an unrecognized role is treated as no access at all, never
  // defaulted to some baseline role.
  if (!VALID_ROLES.has(payload.role)) {
    return next(new AppError(403, 'Token role is not recognized by this system.'));
  }

  // roles (plural) is the account's primary role plus any additional_roles
  // granted by a System_Admin (db/migrations/008_..._multirole_...sql) --
  // an array so a Supervisor cross-trained to issue citations, say, can
  // pass BOTH a Supervisor-only guard and a Patrol_Officer-only guard.
  // Older tokens issued before this field existed won't carry it; fall back
  // to the single primary role so they keep working.
  const roles = Array.isArray(payload.roles) && payload.roles.length > 0 ? payload.roles : [payload.role];

  req.user = {
    id: payload.sub,
    badge: payload.badge,
    role: payload.role,
    roles,
  };

  next();
}

/**
 * Dependency-factory-style RBAC guard. Deny-by-default: a role not
 * explicitly listed is rejected. Checks req.user.roles (primary role plus
 * any additional_roles granted to the account), so a multi-role account
 * passes if ANY of its roles is in allowedRoles.
 *
 *   router.patch('/court/citations/:id', authenticate, requireRoles('Court_Clerk'), handler);
 */
function requireRoles(...allowedRoles) {
  if (allowedRoles.length === 0) {
    throw new Error('requireRoles() must be called with at least one role');
  }

  return function roleGuard(req, res, next) {
    if (!req.user) {
      return next(new AppError(401, 'Not authenticated.'));
    }
    const userRoles = req.user.roles || [req.user.role];
    if (!userRoles.some((r) => allowedRoles.includes(r))) {
      return next(
        new AppError(403, `Role '${req.user.role}' is not permitted to perform this action.`)
      );
    }
    next();
  };
}

/**
 * Same shape as requireRoles(), but checks ONLY req.user.role (the account's
 * single primary role) -- never additional_roles. Use this exclusively for
 * routes that write to the two tables whose RLS policy is keyed to primary
 * role by deliberate design (db/migrations/008_..._multirole_...sql's own
 * comment: "current_app_role() policies [on users, court_ledger]... stay
 * keyed to a person's primary employment classification, not to any
 * operational role they've been additionally granted"):
 *   - users (INSERT/UPDATE/DELETE -- users_write_admin_only /
 *     users_update_admin_only / users_delete_admin_only, all
 *     `current_app_role() = 'System_Admin'`)
 *   - court_ledger (INSERT/UPDATE -- ledger_write_clerk_only /
 *     ledger_update_clerk_only, `current_app_role() = 'Court_Clerk'`)
 *
 * withDbAudit sets the RLS session GUC from req.user.role alone (see
 * middleware/dbAudit.js), never from additional_roles. Guarding one of
 * these routes with the ordinary requireRoles() lets a multi-role account
 * (e.g. a Supervisor additionally granted System_Admin) pass the app-layer
 * check and reach the controller, where the write then silently affects
 * zero rows under RLS -- surfacing as a confusing "not found" instead of an
 * honest 403. requirePrimaryRole() keeps the two layers in agreement.
 */
function requirePrimaryRole(...allowedRoles) {
  if (allowedRoles.length === 0) {
    throw new Error('requirePrimaryRole() must be called with at least one role');
  }

  return function primaryRoleGuard(req, res, next) {
    if (!req.user) {
      return next(new AppError(401, 'Not authenticated.'));
    }
    if (!allowedRoles.includes(req.user.role)) {
      return next(
        new AppError(
          403,
          `Your primary role ('${req.user.role}') is not permitted to perform this action, even if you've been granted it as an additional role elsewhere.`
        )
      );
    }
    next();
  };
}

module.exports = { authenticate, requireRoles, requirePrimaryRole, VALID_ROLES };
