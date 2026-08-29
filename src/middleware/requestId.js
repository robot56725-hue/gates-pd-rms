'use strict';

const crypto = require('crypto');

/**
 * Attaches a unique request ID for log/error correlation and echoes it back
 * as X-Request-ID so a client-reported issue can be traced to a server log
 * line without exposing any internal detail.
 */
function requestId(req, res, next) {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-ID', req.id);
  next();
}

module.exports = requestId;
