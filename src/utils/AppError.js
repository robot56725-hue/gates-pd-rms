'use strict';

/**
 * A recognized, intentional application error carrying an HTTP status code
 * and a client-safe message. Anything thrown that is NOT an AppError is
 * treated by the error handler as unexpected and never has its message or
 * stack leaked to the client (see middleware/errorHandler.js).
 */
class AppError extends Error {
  constructor(statusCode, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace?.(this, AppError);
  }
}

module.exports = AppError;
