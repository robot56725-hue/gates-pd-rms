'use strict';

const Joi = require('joi');
const { UUID_RE } = require('./common');

// Matches case_photos' own CHECK constraints
// (db/migrations/014_add_case_photos.sql) -- kept in sync by hand, same
// convention every other *Schema.js file in this directory follows.
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024; // 8 MB, matches chk_case_photos_size

const RECORD_TYPES = ['Incident', 'MOR', 'Crash'];

// Upload is base64 JSON rather than multipart/form-data -- this app has no
// multipart-parsing dependency (no multer, etc.) anywhere else, and a JSON
// body fits the same apiFetch()/fetch() pattern public/app.js already uses
// for every other endpoint. The ~33% base64 inflation is why the photos
// route gets its own larger body-size limit in app.js rather than raising
// the global cap for every endpoint -- see the comment there.
const photoCreateSchema = Joi.object({
  record_type: Joi.string()
    .valid(...RECORD_TYPES)
    .required(),
  record_id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').required(),
  mime_type: Joi.string()
    .valid(...ALLOWED_MIME_TYPES)
    .required(),
  // Plain base64, no "data:image/jpeg;base64," prefix -- the frontend strips
  // that before sending (see photosApi.upload in app.js).
  file_data_base64: Joi.string().base64({ paddingRequired: false }).required(),
  caption: Joi.string().trim().max(500).allow('', null).optional(),
}).options({ abortEarly: false });

const photoUpdateSchema = Joi.object({
  caption: Joi.string().trim().max(500).allow('', null).required(),
}).options({ abortEarly: false });

const photoListQuerySchema = Joi.object({
  record_type: Joi.string()
    .valid(...RECORD_TYPES)
    .required(),
  record_id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').required(),
}).options({ abortEarly: false });

module.exports = {
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
  RECORD_TYPES,
  photoCreateSchema,
  photoUpdateSchema,
  photoListQuerySchema,
};
