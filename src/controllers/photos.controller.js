'use strict';

const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { idParamSchema } = require('../validation/common');
const {
  MAX_FILE_SIZE_BYTES,
  photoCreateSchema,
  photoUpdateSchema,
  photoListQuerySchema,
} = require('../validation/photoSchema');

// Maps the photo_record_type enum value (case_photos.record_type,
// db/migrations/014_add_case_photos.sql) to the table it must reference and
// the FK column that holds the link -- used both to verify the target
// record actually exists before accepting an upload, and to build the
// INSERT/SELECT for whichever column is relevant. Keeping this table-driven
// (rather than three near-identical if/else branches) is what lets
// create/list/get/delete all share one implementation instead of four.
const RECORD_TYPE_INFO = {
  Incident: { table: 'incidents', column: 'incident_id' },
  MOR: { table: 'matters_of_record', column: 'mor_id' },
  Crash: { table: 'crash_reports', column: 'crash_report_id' },
};

/**
 * POST /api/photos
 *
 * Attaches one photo to an incident, matter of record, or crash report.
 * Images are stored as BYTEA directly in Postgres -- see the note on
 * case_photos (014_add_case_photos.sql) for why -- so this is the only
 * write path for case_photos.file_data; it is never edited afterward
 * (PATCH /:id only ever touches caption, see updatePhotoCaption below).
 */
const createPhoto = asyncHandler(async (req, res) => {
  const { error, value: payload } = photoCreateSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const info = RECORD_TYPE_INFO[payload.record_type];
  const db = req.db;

  const existing = await db.query(`SELECT id FROM ${info.table} WHERE id = $1`, [payload.record_id]);
  if (!existing.rows[0]) {
    throw new AppError(422, `${payload.record_type} ${payload.record_id} does not exist.`);
  }

  const fileBuffer = Buffer.from(payload.file_data_base64, 'base64');
  // Joi's base64() check only validates the string's shape, not how big the
  // decoded image actually is -- that's checked here, matching
  // chk_case_photos_size, so an oversized upload is rejected with a clear
  // 422 instead of failing opaquely on the database's own CHECK constraint.
  if (fileBuffer.length === 0 || fileBuffer.length > MAX_FILE_SIZE_BYTES) {
    throw new AppError(
      422,
      `Photo must be between 1 byte and ${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB after decoding.`
    );
  }

  const result = await db.query(
    `INSERT INTO case_photos (record_type, ${info.column}, mime_type, file_data, file_size_bytes, caption, uploaded_by_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, record_type, mime_type, file_size_bytes, caption, uploaded_at`,
    [
      payload.record_type,
      payload.record_id,
      payload.mime_type,
      fileBuffer,
      fileBuffer.length,
      payload.caption ? payload.caption.trim() : null,
      req.user.id,
    ]
  );

  res.status(201).json({ ...result.rows[0], outcome: 'created' });
});

/**
 * GET /api/photos?record_type=&record_id=
 *
 * Metadata only -- never file_data -- so a case with several photos stays a
 * cheap list call. Each photo's actual bytes are fetched individually via
 * GET /api/photos/:id/file once the frontend wants to render/display it.
 */
const listPhotos = asyncHandler(async (req, res) => {
  const { error, value: query } = photoListQuerySchema.validate(req.query);
  if (error) throw Object.assign(error, { isJoi: true });

  const info = RECORD_TYPE_INFO[query.record_type];
  const db = req.db;

  const { rows } = await db.query(
    `SELECT p.id, p.record_type, p.mime_type, p.file_size_bytes, p.caption, p.uploaded_at,
            u.full_name AS uploaded_by_name
       FROM case_photos p
       JOIN users u ON u.id = p.uploaded_by_id
      WHERE p.${info.column} = $1
      ORDER BY p.uploaded_at`,
    [query.record_id]
  );

  res.status(200).json({ results: rows });
});

/**
 * GET /api/photos/:id/file
 *
 * Streams the raw image bytes with the stored mime type. Same auth as every
 * other route (JWT bearer token) -- deliberately NOT a bare <img src="...">
 * -able URL, since the browser never attaches an Authorization header to an
 * <img> request. The frontend fetches this with its normal authenticated
 * fetch() call and turns the response into an object URL (see
 * loadPhotoThumbnail() in app.js).
 */
const getPhotoFile = asyncHandler(async (req, res) => {
  const { error, value: params } = idParamSchema.validate(req.params);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;
  const result = await db.query('SELECT mime_type, file_data FROM case_photos WHERE id = $1', [params.id]);
  const photo = result.rows[0];
  if (!photo) {
    throw new AppError(404, 'Photo not found.');
  }

  res.set('Content-Type', photo.mime_type);
  // Private, long-lived cache: the bytes behind one photo id are immutable
  // (uploading a replacement means deleting this row and creating a new
  // one, never overwriting file_data -- see the note on createPhoto).
  res.set('Cache-Control', 'private, max-age=86400, immutable');
  res.send(photo.file_data);
});

/**
 * PATCH /api/photos/:id
 *
 * Caption only -- the image itself is never replaced in place (see
 * createPhoto's note). Re-shooting a bad photo means deleting it and
 * uploading again.
 */
const updatePhotoCaption = asyncHandler(async (req, res) => {
  const { error: paramsError, value: params } = idParamSchema.validate(req.params);
  if (paramsError) throw Object.assign(paramsError, { isJoi: true });

  const { error, value: payload } = photoUpdateSchema.validate(req.body);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;
  const result = await db.query(
    `UPDATE case_photos SET caption = $1, updated_at = now() WHERE id = $2
     RETURNING id, caption`,
    [payload.caption ? payload.caption.trim() : null, params.id]
  );
  if (!result.rows[0]) {
    throw new AppError(404, 'Photo not found.');
  }

  res.status(200).json({ ...result.rows[0], outcome: 'updated' });
});

/**
 * DELETE /api/photos/:id
 *
 * Hard delete -- unlike most of this schema, a photo carries no
 * chain-of-custody/evidentiary weight by itself (evidence_items is the
 * module that needs an immutable audit trail; see evidence_custody_log).
 * Removing a wrongly-attached or duplicate photo is meant to actually
 * remove it, not just hide it.
 */
const deletePhoto = asyncHandler(async (req, res) => {
  const { error, value: params } = idParamSchema.validate(req.params);
  if (error) throw Object.assign(error, { isJoi: true });

  const db = req.db;
  const result = await db.query('DELETE FROM case_photos WHERE id = $1 RETURNING id', [params.id]);
  if (!result.rows[0]) {
    throw new AppError(404, 'Photo not found.');
  }

  res.status(200).json({ id: params.id, outcome: 'deleted' });
});

module.exports = {
  createPhoto,
  listPhotos,
  getPhotoFile,
  updatePhotoCaption,
  deletePhoto,
};
