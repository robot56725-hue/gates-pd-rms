'use strict';

const Joi = require('joi');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mirrors db/migrations/011_add_court_case_management.sql's enum types.
const REMINDER_TYPES = ['Court_Date', 'FTA_Warning'];
const REMINDER_CHANNELS = ['Email', 'SMS', 'None'];
const REMINDER_STATUSES = ['Pending', 'Sent', 'Cancelled', 'Failed', 'Not_Configured'];

const idParamSchema = Joi.object({
  id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').required(),
});

// POST /api/reminders -- queues a reminder. status is NEVER accepted from
// the client: migration 011's own comment is explicit that it defaults to
// 'Not_Configured' rather than 'Pending' so "an unwired provider can never
// be mistaken for reminders actually sent" -- letting a caller set
// 'Sent'/'Failed' here would defeat that guarantee, so the controller
// always inserts with the table default regardless of what's posted.
const reminderCreateSchema = Joi.object({
  case_id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').required(),
  docket_entry_id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').optional(),
  reminder_type: Joi.string()
    .valid(...REMINDER_TYPES)
    .required(),
  channel: Joi.string()
    .valid(...REMINDER_CHANNELS)
    .optional(),
  scheduled_send_at: Joi.string().isoDate().message('must be an ISO-8601 date-time').required(),
  notes: Joi.string().trim().max(2000).allow('', null).optional(),
}).options({ abortEarly: false });

// PATCH /api/reminders/:id -- reschedule (scheduled_send_at/channel/notes)
// and/or cancel. 'Cancelled' is the only status value ever accepted from
// the client, for the same reason createReminder never accepts one at all:
// 'Sent'/'Failed' would claim a delivery that never happened while no real
// provider is wired up. The controller additionally refuses to modify a
// reminder that's already Sent or Cancelled -- see the note above that
// check in reminders.controller.js.
const reminderUpdateSchema = Joi.object({
  scheduled_send_at: Joi.string().isoDate().message('must be an ISO-8601 date-time').optional(),
  channel: Joi.string()
    .valid(...REMINDER_CHANNELS)
    .optional(),
  notes: Joi.string().trim().max(2000).allow('', null).optional(),
  status: Joi.string()
    .valid('Cancelled')
    .messages({ 'any.only': 'status may only be set to Cancelled through this endpoint.' })
    .optional(),
})
  .min(1)
  .message('At least one field must be provided to update a reminder.')
  .options({ abortEarly: false });

const reminderListQuerySchema = Joi.object({
  case_id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').optional(),
  status: Joi.string()
    .valid(...REMINDER_STATUSES)
    .optional(),
  scheduled_from: Joi.string().isoDate().message('must be an ISO-8601 date-time').optional(),
  scheduled_to: Joi.string().isoDate().message('must be an ISO-8601 date-time').optional(),
  limit: Joi.number().integer().min(1).max(100).default(25),
  offset: Joi.number().integer().min(0).default(0),
}).options({ abortEarly: false, presence: 'optional' });

module.exports = {
  REMINDER_TYPES,
  REMINDER_CHANNELS,
  REMINDER_STATUSES,
  idParamSchema,
  reminderCreateSchema,
  reminderUpdateSchema,
  reminderListQuerySchema,
};
