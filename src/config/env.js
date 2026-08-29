'use strict';

/**
 * Centralized, fail-fast environment configuration.
 *
 * Loaded once at process startup. Any missing required variable throws
 * immediately rather than letting the server boot into a half-configured,
 * insecure state (e.g. a missing JWT_SECRET silently falling back to
 * `undefined` and every token verifying against nothing).
 */
require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function optionalBool(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return value.toLowerCase() === 'true';
}

function optionalInt(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got: ${value}`);
  }
  return parsed;
}

const env = {
  nodeEnv: optional('NODE_ENV', 'development'),
  port: optionalInt('PORT', 3000),
  trustProxy: optionalBool('TRUST_PROXY', false),

  databaseUrl: required('DATABASE_URL'),
  pgPoolMax: optionalInt('PGPOOL_MAX', 10),
  pgPoolIdleTimeoutMs: optionalInt('PGPOOL_IDLE_TIMEOUT_MS', 30000),

  jwtSecret: required('JWT_SECRET'),
  jwtIssuer: optional('JWT_ISSUER', 'gates-pd-rms'),
  jwtAudience: optional('JWT_AUDIENCE', 'gates-pd-rms-api'),

  // Symmetric key passed to the database's pgcrypto-based encrypt_ssn()/
  // decrypt_ssn() helpers (see db/migrations/001_init_schema.sql). Optional
  // at the env level because not every citation captures an SSN, but any
  // request that DOES include one is rejected with a clear 500 if this is
  // unset, rather than silently storing plaintext or silently dropping it.
  ssnEncryptionKey: optional('SSN_ENCRYPTION_KEY', undefined),

  corsAllowedOrigins: optional('CORS_ALLOWED_ORIGINS', '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
};

env.isProduction = env.nodeEnv === 'production';

if (env.isProduction && env.jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters in production.');
}

module.exports = env;
