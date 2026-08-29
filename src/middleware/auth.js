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

  req.user = {
    id: payload.sub,
    badge: payload.badge,
    role: payload.role,
  };

  next();
}

/**
 * Dependency-factory-style RBAC guard. Deny-by-default: a role not
 * explicitly listed is rejected.
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
    if (!allowedRoles.includes(req.user.role)) {
      return next(
        new AppError(403, `Role '${req.user.role}' is not permitted to perform this action.`)
      );
    }
    next();
  };
}

module.exports = { authenticate, requireRoles, VALID_ROLES };
