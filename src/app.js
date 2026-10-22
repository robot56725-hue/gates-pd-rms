'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const env = require('./config/env');
const requestId = require('./middleware/requestId');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

const authRoutes = require('./routes/auth.routes');
const citationsRoutes = require('./routes/citations.routes');
const courtRoutes = require('./routes/court.routes');
const personsRoutes = require('./routes/persons.routes');
const vehiclesRoutes = require('./routes/vehicles.routes');
const incidentsRoutes = require('./routes/incidents.routes');
const crashesRoutes = require('./routes/crashes.routes');
const tibrsRoutes = require('./routes/tibrs.routes');
const usersRoutes = require('./routes/users.routes');
const evidenceRoutes = require('./routes/evidence.routes');
const morRoutes = require('./routes/mor.routes');
const casesRoutes = require('./routes/cases.routes');
const judgesRoutes = require('./routes/judges.routes');
const docketsRoutes = require('./routes/dockets.routes');
const remindersRoutes = require('./routes/reminders.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const paymentsRoutes = require('./routes/payments.routes');
const fundCategoriesRoutes = require('./routes/fundCategories.routes');
const warrantsRoutes = require('./routes/warrants.routes');
const reportsRoutes = require('./routes/reports.routes');
const photosRoutes = require('./routes/photos.routes');

const app = express();

if (env.trustProxy) {
  app.set('trust proxy', 1);
}

app.use(helmet());
app.use(
  cors({
    origin: env.corsAllowedOrigins.length > 0 ? env.corsAllowedOrigins : false,
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  })
);
// Photos arrive as base64 JSON (see src/validation/photoSchema.js for why
// -- no multipart-parsing dependency anywhere else in this app), which
// inflates an 8 MB image (case_photos' own size cap,
// db/migrations/014_add_case_photos.sql) to roughly 11 MB of base64 text
// plus a little JSON overhead. That needs a body-size limit well above the
// 100kb every other route gets. Scoping the larger limit to /api/photos
// specifically -- mounted BEFORE the general-purpose parser below -- means
// only this one route pays for a bigger allowed payload; body-parser skips
// re-parsing a request whose body a prior middleware already consumed, so
// the 100kb parser below is a no-op for anything that matched here.
app.use('/api/photos', express.json({ limit: '12mb' }));
// Cap body size: input sanitization starts with not accepting an
// unbounded payload from an unauthenticated (pre-JWT-check) client.
app.use(express.json({ limit: '100kb' }));
app.use(requestId);

app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok' }));

// Mobile-friendly front end (public/index.html + app.js + styles.css) is
// served from the same origin/process as the API -- one deployable service,
// and it means app.js's relative fetch('/api/...') calls never need CORS
// configured for the page itself (see public/app.js's own top-of-file note).
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', authRoutes);
app.use('/api/citations', citationsRoutes);
app.use('/api/court', courtRoutes);
app.use('/api/persons', personsRoutes);
app.use('/api/vehicles', vehiclesRoutes);
app.use('/api/incidents', incidentsRoutes);
app.use('/api/crashes', crashesRoutes);
app.use('/api/tibrs', tibrsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/evidence', evidenceRoutes);
app.use('/api/mor', morRoutes);
app.use('/api/cases', casesRoutes);
app.use('/api/judges', judgesRoutes);
app.use('/api/dockets', docketsRoutes);
app.use('/api/reminders', remindersRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/fund-categories', fundCategoriesRoutes);
app.use('/api/warrants', warrantsRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/photos', photosRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
