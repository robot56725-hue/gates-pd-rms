'use strict';

const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const {
  idParamSchema,
  reminderCreateSchema,
  reminderUpdateSchema,
  reminderListQuerySchema,
} = require('../validation/reminderSchema');

/**
 * POST /api/reminders -- queues a reminder against a case (and optionally a
 * specific docket appearance). Always inserted with status defaulting to
 * the table's own 'Not_Configured' (migration 011) -- see the note in
 * reminderSchema.js; the client can never set status here.
 */
const createReminder = asyncHandler(async (req, res) => {
  const { error, value: payload } = reminderCreateSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const caseResult = await db.query('SELECT id FROM court_cases WHERE id = $1', [payload.case_id]);
  if (!caseResult.rows[0]) {
    throw new AppError(422, `case_id ${payload.case_id} does not exist.`);
  }

  if (payload.docket_entry_id) {
    const entryResult = await db.query('SELECT id FROM docket_entries WHERE id = $1 AND case_id = $2', [
      payload.docket_entry_id,
      payload.case_id,
    ]);
    if (!entryResult.rows[0]) {
      throw new AppError(422, `docket_entry_id ${payload.docket_entry_id} does not exist on this case.`);
    }
  }

  const inserted = await db.query(
    `INSERT INTO court_reminders (case_id, docket_entry_id, reminder_type, channel, scheduled_send_at, notes)
     VALUES ($1, $2, $3, COALESCE($4, 'None'), $5, $6)
     RETURNING *`,
    [
      payload.case_id,
      payload.docket_entry_id || null,
      payload.reminder_type,
      payload.channel || null,
      payload.scheduled_send_at,
      payload.notes || null,
    ]
  );

  res.status(201).json(inserted.rows[0]);
});

/**
 * GET /api/reminders -- the queue view. Defaults to no filter (every
 * reminder, any status) -- a clerk building the "what's outstanding" view
 * narrows with ?status=Pending, a dashboard chart pulls Sent/Failed
 * separately once a real provider exists.
 */
const listReminders = asyncHandler(async (req, res) => {
  const { error, value: query } = reminderListQuerySchema.validate(req.query);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const { rows } = await db.query(
    `SELECT cr.*, cc.case_number, count(*) OVER() AS total_count
       FROM court_reminders cr
       JOIN court_cases cc ON cc.id = cr.case_id
      WHERE ($1::uuid IS NULL OR cr.case_id = $1)
        AND ($2::text IS NULL OR cr.status = $2)
        AND ($3::timestamptz IS NULL OR cr.scheduled_send_at >= $3)
        AND ($4::timestamptz IS NULL OR cr.scheduled_send_at <= $4)
      ORDER BY cr.scheduled_send_at ASC
      LIMIT $5 OFFSET $6`,
    [
      query.case_id || null,
      query.status || null,
      query.scheduled_from || null,
      query.scheduled_to || null,
      query.limit,
      query.offset,
    ]
  );

  const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
  res.status(200).json({
    results: rows.map(({ total_count, ...row }) => row),
    total,
    limit: query.limit,
    offset: query.offset,
  });
});

const getReminderById = asyncHandler(async (req, res) => {
  const { error: paramError, value: params } = idParamSchema.validate(req.params);
  if (paramError) throw Object.assign(paramError, { isJoi: true });

  const db = req.db;

  const result = await db.query(
    `SELECT cr.*, cc.case_number
       FROM court_reminders cr
       JOIN court_cases cc ON cc.id = cr.case_id
      WHERE cr.id = $1`,
    [params.id]
  );
  if (!result.rows[0]) {
    throw new AppError(404, 'Reminder not found.');
  }

  res.status(200).json(result.rows[0]);
});

/**
 * PATCH /api/reminders/:id -- reschedule and/or cancel. Refuses to modify a
 * reminder that's already Sent or Cancelled: a Sent reminder is a record of
 * something that (once a real provider exists) already happened, and a
 * Cancelled one is done -- rescheduling either back to life belongs to a
 * fresh POST, not an edit of history.
 */
const updateReminder = asyncHandler(async (req, res) => {
  const { error: paramError, value: params } = idParamSchema.validate(req.params);
  if (paramError) throw Object.assign(paramError, { isJoi: true });

  const { error, value: updates } = reminderUpdateSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;

  const existingResult = await db.query('SELECT * FROM court_reminders WHERE id = $1', [params.id]);
  const existing = existingResult.rows[0];
  if (!existing) {
    throw new AppError(404, 'Reminder not found.');
  }
  if (existing.status === 'Sent' || existing.status === 'Cancelled') {
    throw new AppError(409, `This reminder is already ${existing.status} and cannot be modified.`);
  }

  const updated = await db.query(
    `UPDATE court_reminders
        SET scheduled_send_at = COALESCE($1, scheduled_send_at),
            channel           = COALESCE($2, channel),
            notes             = COALESCE($3, notes),
            status            = COALESCE($4, status)
      WHERE id = $5
      RETURNING *`,
    [
      updates.scheduled_send_at || null,
      updates.channel || null,
      updates.notes || null,
      updates.status || null,
      params.id,
    ]
  );

  res.status(200).json(updated.rows[0]);
});

module.exports = { createReminder, listReminders, getReminderById, updateReminder };
