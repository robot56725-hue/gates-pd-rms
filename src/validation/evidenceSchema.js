'use strict';

const Joi = require('joi');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mirrors the ENUMs in db/migrations/007_add_evidence_module.sql exactly --
// kept in sync by hand, same convention as incidentSchema.js/crashSchema.js.
const EVIDENCE_CATEGORIES = [
  'Weapon',
  'Firearm',
  'Ammunition',
  'Drug_Narcotic',
  'Drug_Paraphernalia',
  'Document',
  'Electronic_Device',
  'Biological',
  'Currency',
  'Vehicle',
  'Photograph',
  'Video_Audio_Recording',
  'Clothing',
  'Tool',
  'Fingerprint_Impression',
  'Other',
];

const EVIDENCE_STATUSES = [
  'In_Storage',
  'Checked_Out',
  'Transferred',
  'Released_To_Owner',
  'Submitted_To_Lab',
  'Court_Evidence',
  'Destroyed',
];

const EVIDENCE_CUSTODY_ACTIONS = [
  'Collected',
  'Transferred',
  'Checked_Out',
  'Checked_In',
  'Submitted_To_Lab',
  'Returned_From_Lab',
  'Released',
  'Destroyed',
];

// Exactly one of incident_id / crash_report_id must be provided -- matches
// the chk_evidence_linked_to_case CHECK constraint in the migration; every
// piece of evidence belongs to a specific case file.
const evidenceCreateSchema = Joi.object({
  item_number: Joi.string().trim().min(1).max(40).required(),
  incident_id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').optional(),
  crash_report_id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').optional(),
  category: Joi.string()
    .valid(...EVIDENCE_CATEGORIES)
    .required(),
  description: Joi.string().trim().min(1).max(500).required(),
  quantity: Joi.number().integer().min(1).max(100000).default(1),
  location_collected: Joi.string().trim().max(255).allow('', null).optional(),
  date_collected: Joi.date().iso().required(),
  storage_location: Joi.string().trim().max(120).allow('', null).optional(),
  device_created_at: Joi.date().iso().optional(),
})
  .xor('incident_id', 'crash_report_id')
  .options({ abortEarly: false });

const evidenceUpdateSchema = Joi.object({
  status: Joi.string()
    .valid(...EVIDENCE_STATUSES)
    .optional(),
  storage_location: Joi.string().trim().max(120).allow('', null).optional(),
  disposition_notes: Joi.string().trim().max(2000).allow('', null).optional(),

  category: Joi.string()
    .valid(...EVIDENCE_CATEGORIES)
    .optional(),
  description: Joi.string().trim().min(1).max(500).optional(),
  quantity: Joi.number().integer().min(1).max(100000).optional(),
  location_collected: Joi.string().trim().max(255).allow('', null).optional(),
  date_collected: Joi.date().iso().optional(),
})
  .min(1)
  .message('At least one field must be provided to update the evidence item.')
  .options({ abortEarly: false });

// Adds one entry to an item's chain-of-custody log. from_custodian is
// optional for the very first 'Collected' entry (nothing to transfer from).
const custodyLogCreateSchema = Joi.object({
  action: Joi.string()
    .valid(...EVIDENCE_CUSTODY_ACTIONS)
    .required(),
  from_custodian: Joi.string().trim().max(120).allow('', null).optional(),
  to_custodian: Joi.string().trim().max(120).allow('', null).optional(),
  notes: Joi.string().trim().max(1000).allow('', null).optional(),
}).options({ abortEarly: false });

const evidenceListQuerySchema = Joi.object({
  q: Joi.string().trim().max(120).allow('', null).optional(),
  category: Joi.string()
    .valid(...EVIDENCE_CATEGORIES)
    .optional(),
  status: Joi.string()
    .valid(...EVIDENCE_STATUSES)
    .optional(),
  incident_id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').optional(),
  crash_report_id: Joi.string().pattern(UUID_RE).message('must be a valid UUID').optional(),
  mine: Joi.boolean().optional(),
  limit: Joi.number().integer().min(1).max(100).default(25),
  offset: Joi.number().integer().min(0).default(0),
}).options({ abortEarly: false, presence: 'optional' });

module.exports = {
  evidenceCreateSchema,
  evidenceUpdateSchema,
  custodyLogCreateSchema,
  evidenceListQuerySchema,
  EVIDENCE_CATEGORIES,
  EVIDENCE_STATUSES,
  EVIDENCE_CUSTODY_ACTIONS,
};
