'use strict';

const express = require('express');
const { authenticate, requireRoles } = require('../middleware/auth');
const { withDbAudit } = require('../middleware/dbAudit');
const {
  createPhoto,
  listPhotos,
  getPhotoFile,
  updatePhotoCaption,
  deletePhoto,
} = require('../controllers/photos.controller');

const router = express.Router();

// Read access open to every authenticated role -- case_photos carries no
// RLS restricting SELECT, same as every other module (see
// db/migrations/014_add_case_photos.sql).
router.get('/', authenticate, withDbAudit('case_photos'), listPhotos);
router.get('/:id/file', authenticate, withDbAudit('case_photos'), getPhotoFile);

// Same role set as incidents/mor/crashes' own create routes -- whoever can
// author one of those reports can attach a photo to it; Court_Clerk and
// System_Admin (minus System_Admin's blanket access) don't work scenes.
router.post(
  '/',
  authenticate,
  withDbAudit('case_photos'),
  requireRoles('Patrol_Officer', 'Supervisor', 'System_Admin'),
  createPhoto
);

router.patch(
  '/:id',
  authenticate,
  withDbAudit('case_photos'),
  requireRoles('Patrol_Officer', 'Supervisor', 'System_Admin'),
  updatePhotoCaption
);

router.delete(
  '/:id',
  authenticate,
  withDbAudit('case_photos'),
  requireRoles('Patrol_Officer', 'Supervisor', 'System_Admin'),
  deletePhoto
);

module.exports = router;
