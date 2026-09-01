'use strict';

const AppError = require('../utils/AppError');

// PostgreSQL error codes we translate into clean client responses instead of
// leaking a raw constraint name or SQL fragment.
// https://www.postgresql.org/docs/current/errcodes-appendix.html
const PG_ERROR_MAP = {
  '23505': { status: 409, message: 'A record with the same unique value already exists.' },
  '23503': { status: 409, message: 'The referenced record does not exist.' },
  // Same underlying problem as 23503 (foreign_key_violation) -- a row this
  // one references, or that references this one, is in the way -- but a
  // different SQLSTATE: Postgres raises 23001 specifically for a foreign key
  // declared with an explicit ON DELETE/UPDATE RESTRICT, rather than the
  // implicit NO ACTION default that raises 23503. Several tables in this app
  // (e.g. incidents.reporting_officer_id, e_citations.officer_id) use
  // RESTRICT deliberately, so this is a real, reachable code path, not a
  // hypothetical -- see the note in users.controller.js's deleteUser, where
  // this exact gap first surfaced as an unhandled 500 on personnel deletion.
  '23001': { status: 409, message: 'The referenced record does not exist.' },
  '23514': { status: 422, message: 'The request violates a data integrity rule.' },
  '22P02': { status: 400, message: 'Malformed input value.' },
};

/**
 * Centralized error handler -- the last middleware registered. Keeps
 * responses informative for legitimate client bugs but never leaks stack
 * traces, SQL text, or internal file paths to the caller. Everything is
 * logged server-side with the request ID for correlation.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return; // let Express's default handler close the connection
  }

  if (err && err.name === 'AppError') {
    return res.status(err.statusCode).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }

  if (err && err.isJoi) {
    return res.status(400).json({
      error: 'Request validation failed.',
      details: err.details.map((d) => ({ field: d.path.join('.'), message: d.message })),
    });
  }

  if (err && typeof err.code === 'string' && PG_ERROR_MAP[err.code]) {
    const mapped = PG_ERROR_MAP[err.code];
    // eslint-disable-next-line no-console
    console.error(`[pg:${err.code}] request=${req.id}`, err.message);
    return res.status(mapped.status).json({ error: mapped.message, request_id: req.id });
  }

  // eslint-disable-next-line no-console
  console.error(`[unhandled] request=${req.id}`, err);
  return res.status(500).json({
    error: 'An unexpected error occurred. Please contact IT support with this request ID.',
    request_id: req.id,
  });
}

function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Not found.' });
}

module.exports = { errorHandler, notFoundHandler };
