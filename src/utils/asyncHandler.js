'use strict';

/**
 * Wraps an async Express handler so a rejected promise is forwarded to
 * next(err) instead of becoming an unhandled rejection that crashes the
 * process or hangs the request.
 */
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
