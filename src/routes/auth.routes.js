'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { login } = require('../controllers/auth.controller');

const router = express.Router();

// Brute-force mitigation: 10 attempts per 15 minutes per IP on the login
// route specifically. Counts failed AND successful attempts deliberately
// (a tight cap here is a much smaller usability cost than letting an
// attacker grind through a password list).
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' },
});

router.post('/login', loginRateLimiter, login);

module.exports = router;
