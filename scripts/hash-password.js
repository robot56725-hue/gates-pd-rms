#!/usr/bin/env node
'use strict';

/**
 * One-off utility for seeding the first accounts (there is no user-creation
 * endpoint in this API surface -- account provisioning is presumed to be an
 * out-of-band administrative process).
 *
 * Usage:
 *   node scripts/hash-password.js '<plaintext password>'
 *
 * Paste the printed hash into an INSERT against `users.password_hash`, run
 * as a database superuser (or otherwise bypassing RLS) since
 * db/migrations/001_init_schema.sql's FORCE ROW LEVEL SECURITY on `users`
 * blocks inserts from the application's own restricted DB role unless
 * `app.actor_role` is already set to 'System_Admin' for that session.
 */
const bcrypt = require('bcrypt');

const plaintext = process.argv[2];
if (!plaintext) {
  console.error('Usage: node scripts/hash-password.js "<plaintext password>"');
  process.exit(1);
}

bcrypt
  .hash(plaintext, 12)
  .then((hash) => {
    console.log(hash);
  })
  .catch((err) => {
    console.error('Failed to hash password:', err);
    process.exit(1);
  });
