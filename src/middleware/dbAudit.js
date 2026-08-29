'use strict';

const pool = require('../db/pool');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const METHOD_TO_ACTION = {
  GET: 'READ',
  HEAD: 'READ',
  OPTIONS: 'READ',
  POST: 'WRITE',
  PUT: 'WRITE',
  PATCH: 'WRITE',
  DELETE: 'DELETE',
};

/**
 * Per-route middleware factory. Attach it AFTER `authenticate` (and after
 * any `requireRoles` guard) so req.user is populated, and pass the DB table
 * this route touches so the audit row is specific and useful:
 *
 *   router.post('/citations', authenticate, requireRoles(...), withDbAudit('e_citations'), controller.create);
 *
 * Does two separate things, deliberately in two separate transactions:
 *
 *  1. AUDIT FIRST, FAIL CLOSED. Writes one row to audit_logs and commits it
 *     immediately, before the route's controller runs at all -- this is the
 *     literal requirement ("...before proceeding") and it means a request
 *     that the controller later rejects (a 403, a 422, a 500) is STILL on
 *     the audit trail. If this table write itself fails, the request is
 *     rejected with 503 rather than silently proceeding unaudited.
 *
 *  2. A SECOND, independent transaction scoped to the controller's own
 *     business-logic queries, with the RLS session GUC `app.actor_role` set
 *     from the verified JWT role (see db/migrations/001_init_schema.sql,
 *     Section 9). This transaction commits on a successful response and
 *     rolls back on an error response, and is what req.db refers to.
 *
 * Deliberately NOT the same transaction: if the audit insert and the
 * controller's work shared one transaction that only commits on success,
 * a rejected/denied request (exactly the kind of thing you most want on the
 * audit trail) would have its audit row rolled back along with everything
 * else.
 */
function withDbAudit(targetTable) {
  return async function dbAuditMiddleware(req, res, next) {
    const client = await pool.connect();

    const targetRecordId =
      req.params && typeof req.params.id === 'string' && UUID_RE.test(req.params.id)
        ? req.params.id
        : null;

    // --- Phase 1: audit row, committed immediately, independent of outcome. ---
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO audit_logs (user_id, action_type, target_table, target_record_id, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          req.user?.id ?? null,
          METHOD_TO_ACTION[req.method] || 'WRITE',
          targetTable,
          targetRecordId,
          req.ip,
          req.get('user-agent') || null,
        ]
      );
      await client.query('COMMIT');
    } catch (auditErr) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {
        /* connection likely already broken; fall through to release */
      }
      client.release();
      // eslint-disable-next-line no-console
      console.error(`[audit] failed to write audit log for ${req.method} ${req.originalUrl}`, auditErr);
      res.status(503).json({ error: 'Audit logging is unavailable. Please try again shortly.' });
      return;
    }

    // --- Phase 2: RLS-scoped transaction for the controller's own queries. ---
    try {
      await client.query('BEGIN');
      // set_config(..., true) === SET LOCAL, but parameterized -- never
      // interpolate the role string directly into a SET statement.
      await client.query(`SELECT set_config('app.actor_role', $1, true)`, [req.user?.role ?? '']);
    } catch (txnErr) {
      client.release();
      return next(txnErr);
    }

    req.db = client;

    let finished = false;
    const finalize = async () => {
      if (finished) return;
      finished = true;
      try {
        if (res.statusCode >= 200 && res.statusCode < 400) {
          await client.query('COMMIT');
        } else {
          await client.query('ROLLBACK');
        }
      } catch (finalizeErr) {
        // eslint-disable-next-line no-console
        console.error('[db] failed to finalize request transaction', finalizeErr);
      } finally {
        client.release();
      }
    };

    res.on('finish', finalize);
    res.on('close', finalize); // client disconnected before a response was sent

    next();
  };
}

module.exports = { withDbAudit };
