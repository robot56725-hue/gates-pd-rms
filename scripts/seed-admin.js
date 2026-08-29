#!/usr/bin/env node
'use strict';

/**
 * Bootstraps the very first account in a fresh database -- there is no
 * user-creation endpoint in this API, account provisioning is an
 * out-of-band administrative action.
 *
 * Despite `users` having FORCE ROW LEVEL SECURITY (see
 * db/migrations/001_init_schema.sql, Section 9), this script does NOT need
 * superuser access or table ownership to insert the first row. The RLS
 * policy checks the *session GUC* `app.actor_role`, not who is connected --
 * so any role holding INSERT privilege on `users` (i.e. the same
 * gates_app_user the API itself connects as) can create the first
 * System_Admin, as long as it sets that GUC to 'System_Admin' first, inside
 * the same transaction, exactly like the API's own withDbAudit middleware
 * does for every request.
 *
 * Usage:
 *   DATABASE_URL=postgresql://gates_app_user:...@host:5432/dbname \
 *     node scripts/seed-admin.js --username admin1 --password 'Str0ng!Pass' \
 *       --full-name "Alice Admin" --badge A-001 --role System_Admin
 *
 * --role defaults to System_Admin but accepts any of the four valid roles,
 * so this same script also seeds the first officer/supervisor/clerk
 * accounts you'll want for testing.
 */
require('dotenv').config();
const bcrypt = require('bcrypt');
const { Client } = require('pg');

const VALID_ROLES = ['Patrol_Officer', 'Supervisor', 'Court_Clerk', 'System_Admin'];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    args[key] = argv[i + 1];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { username, password, badge } = args;
  const fullName = args['full-name'];
  const role = args.role || 'System_Admin';
  const officerRank = args['officer-rank'] || null;

  if (!username || !password || !fullName || !badge) {
    console.error(
      'Usage: node scripts/seed-admin.js --username <u> --password <p> --full-name "<name>" --badge <badge> [--role <role>] [--officer-rank <rank>]'
    );
    process.exit(1);
  }
  if (!VALID_ROLES.includes(role)) {
    console.error(`--role must be one of: ${VALID_ROLES.join(', ')}`);
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL must be set (same connection string the API itself uses).');
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    // Same session-GUC bootstrap the API's dbAudit middleware performs per
    // request -- see db/migrations/001_init_schema.sql, current_app_role().
    await client.query(`SELECT set_config('app.actor_role', 'System_Admin', true)`);
    const result = await client.query(
      `INSERT INTO users (username, password_hash, role, badge_number, full_name, officer_rank, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING id, username, role, badge_number`,
      [username, passwordHash, role, badge, fullName, officerRank]
    );
    await client.query('COMMIT');
    console.log('Account created:', result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed to create account:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
