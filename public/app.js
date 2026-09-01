'use strict';

/**
 * Gates PD RMS -- mobile-friendly single-page front end.
 *
 * Talks to the API on the same origin it's served from (relative fetch
 * paths), so this works identically whether that origin is
 * http://localhost:3000 during development or the deployed HTTPS URL --
 * no CORS configuration needed for this page itself.
 *
 * Session token lives in sessionStorage (cleared when the tab/browser
 * closes) -- acceptable for a real deployed origin; this is NOT the
 * in-conversation preview restriction, this file only ever runs on the
 * app's own deployed domain.
 */

const TOKEN_KEY = 'gatespd_token';
const PROFILE_KEY = 'gatespd_profile';

// ------------------------------------------------------------------
// Auth / session helpers
// ------------------------------------------------------------------

function getToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}

function getProfile() {
  try {
    return JSON.parse(sessionStorage.getItem(PROFILE_KEY) || 'null');
  } catch {
    return null;
  }
}

function setSession(token, profile) {
  sessionStorage.setItem(TOKEN_KEY, token);
  sessionStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

function clearSession() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(PROFILE_KEY);
}

/**
 * True if the signed-in account's primary role OR any of its
 * additional_roles (db/migrations/008_..._multirole_...sql) matches one of
 * the given roles -- mirrors requireRoles() server side (src/middleware/auth.js),
 * which also checks the full roles array, not just the primary role.
 */
function hasAnyRole(...roles) {
  const profile = getProfile();
  if (!profile) return false;
  const userRoles = profile.roles && profile.roles.length > 0 ? profile.roles : [profile.role];
  return roles.some((r) => userRoles.includes(r));
}

/**
 * Wrapper around fetch(): attaches the bearer token, parses JSON, and
 * forces a return to the login screen on a 401 (expired/invalid token)
 * rather than leaving the user staring at a silently-broken screen.
 */
async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = Object.assign({}, options.headers, {
    Authorization: token ? `Bearer ${token}` : undefined,
  });
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(path, { ...options, headers });

  if (res.status === 401) {
    clearSession();
    showLogin('Your session has expired. Please log in again.');
    throw new Error('Session expired');
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }

  if (!res.ok) {
    const message = (data && (data.error || data.message)) || `Request failed (${res.status})`;
    const err = new Error(message);
    err.details = data && data.details;
    err.status = res.status;
    throw err;
  }

  return data;
}

// ------------------------------------------------------------------
// View switching
// ------------------------------------------------------------------

const loginView = document.getElementById('view-login');
const appShell = document.getElementById('app-shell');
const mainContent = document.getElementById('main-content');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');

function showLogin(message) {
  appShell.hidden = true;
  loginView.hidden = false;
  if (message) {
    loginError.textContent = message;
    loginError.hidden = false;
  } else {
    loginError.hidden = true;
  }
}

function showApp() {
  loginView.hidden = true;
  appShell.hidden = false;

  const profile = getProfile();
  document.getElementById('user-name').textContent = profile ? profile.badge_number : '';
  document.getElementById('user-role').textContent = profile ? profile.role.replace(/_/g, ' ') : '';

  // Only sworn personnel who can actually issue citations see that tab. Uses
  // hasAnyRole() (primary role OR additional_roles), not just profile.role,
  // so a multi-role account (db/migrations/008_..._multirole_...sql) sees
  // every tab its granted roles allow -- e.g. a Court_Clerk also granted
  // Patrol_Officer as an additional role still sees Issue Citation.
  document.getElementById('nav-issue').hidden = !hasAnyRole('Patrol_Officer', 'Supervisor');

  // Personnel management is System_Admin only -- matches the API's own
  // requireRoles('System_Admin') guard on /api/users (see users.routes.js).
  document.getElementById('nav-personnel').hidden = !hasAnyRole('System_Admin');

  // Incidents/Crashes/Evidence tabs -- same role set as the API's own
  // requireRoles('Patrol_Officer', 'Supervisor', 'System_Admin') guard on
  // POST /api/incidents, /api/crashes, /api/evidence. Court_Clerk has no
  // reason to file these, so the tab (which is create-first, same as the
  // Issue Citation tab) stays hidden unless that's one of the account's roles.
  const canOperateCases = hasAnyRole('Patrol_Officer', 'Supervisor', 'System_Admin');
  document.getElementById('nav-incidents').hidden = !canOperateCases;
  document.getElementById('nav-crashes').hidden = !canOperateCases;
  document.getElementById('nav-evidence').hidden = !canOperateCases;

  // Court Case Management tab -- same role set as the API's own
  // requireRoles('Court_Clerk', 'Supervisor', 'System_Admin') guard on every
  // write route under /api/cases (see cases.routes.js). Patrol_Officer has
  // no reason to open/manage a court case, so this stays hidden for that
  // role exactly like Court_Clerk stays hidden from Incidents/Crashes/
  // Evidence above.
  document.getElementById('nav-cases').hidden = !hasAnyRole('Court_Clerk', 'Supervisor', 'System_Admin');

  // Court admin tab (docket/judges/payments/reminders) -- same role gate as
  // Cases above. Payment recording is further restricted to Court_Clerk +
  // System_Admin only within the tab itself (court_payments RLS -- see the
  // note in payments.routes.js), not at the tab-visibility level, since
  // Supervisor can still view dockets/judges/reminders here.
  document.getElementById('nav-court-admin').hidden = !hasAnyRole('Court_Clerk', 'Supervisor', 'System_Admin');

  navigate('search');
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;

  try {
    const data = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    setSession(data.token, {
      role: data.role,
      roles: data.roles,
      badge_number: data.badge_number,
      full_name: data.full_name,
    });
    showApp();
  } catch (err) {
    loginError.textContent = err.message;
    loginError.hidden = false;
  }
});

document.getElementById('logout-btn').addEventListener('click', () => {
  clearSession();
  showLogin();
});

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => navigate(btn.dataset.view));
});

function setActiveNav(view) {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
}

function navigate(view) {
  setActiveNav(view);
  if (view === 'search') renderSearch();
  else if (view === 'citations') renderCitationsList();
  else if (view === 'issue') renderIssueForm();
  else if (view === 'personnel') renderPersonnel();
  else if (view === 'incidents') renderIncidents();
  else if (view === 'crashes') renderCrashes();
  else if (view === 'evidence') renderEvidence();
  else if (view === 'cases') renderCases();
  else if (view === 'court-admin') renderCourtAdmin();
}

function mount(templateId) {
  const tpl = document.getElementById(templateId);
  mainContent.innerHTML = '';
  mainContent.appendChild(tpl.content.cloneNode(true));
}

// ------------------------------------------------------------------
// Formatting helpers
// ------------------------------------------------------------------

function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString();
}

function fmtDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

function fmtMoney(value) {
  if (value === null || value === undefined) return '—';
  return `$${Number(value).toFixed(2)}`;
}

function fmtStatus(value) {
  return value ? value.replace(/_/g, ' ') : 'Pending';
}

function fmtDateOnly(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString();
}

function fmtTimeOnly(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtHeight(inches) {
  if (inches === null || inches === undefined) return '—';
  const feet = Math.floor(inches / 12);
  const remainder = inches % 12;
  return `${feet}'${remainder}"`;
}

function fmtYesNo(value) {
  if (value === null || value === undefined) return '—';
  return value ? 'Yes' : 'No';
}

function fmtEnum(value) {
  return value ? String(value).replace(/_/g, ' ') : '—';
}

function fmtOrDash(value) {
  return value === null || value === undefined || value === '' ? '—' : value;
}

// ------------------------------------------------------------------
// Shared: approval workflow, edit-toggle, print -- reused across the
// citation/incident/crash/evidence detail views, which all carry the same
// approval_status/approved_by/approved_at/approval_notes columns (see
// db/migrations/008_..._multirole_...sql) and the same PATCH /:id/approval
// shape (src/utils/approval.js).
// ------------------------------------------------------------------

function approvalBadgeClass(status) {
  if (status === 'Approved') return 'badge-approved';
  if (status === 'Rejected') return 'badge-rejected';
  return 'badge-pending';
}

/**
 * Renders the approval badge + detail line, and -- only for a
 * Supervisor/System_Admin viewer -- wires the Approve/Reject buttons.
 * `record` is the API response for the case (must carry approval_status,
 * approved_by_name, approved_at, approval_notes). `apiPath` is the route
 * segment ('citations'/'incidents'/'crashes'/'evidence'). `onSaved` re-runs
 * after a successful decision so the badge/detail line reflect it.
 */
function wireApprovalSection({ record, id, apiPath, badgeEl, detailEl, formEl, notesEl, errorEl, successEl, onSaved }) {
  const status = record.approval_status || 'Pending';
  badgeEl.innerHTML = `<span class="${approvalBadgeClass(status)}">${status}</span>`;
  detailEl.textContent = record.approved_by_name
    ? `${status} by ${record.approved_by_name} on ${fmtDateTime(record.approved_at)}${
        record.approval_notes ? ' — ' + record.approval_notes : ''
      }`
    : 'Awaiting Supervisor/System_Admin review.';

  // A Patrol_Officer should not be able to approve their own submission --
  // matches the API's requireRoles('Supervisor', 'System_Admin') guard on
  // every PATCH /:id/approval route.
  if (!hasAnyRole('Supervisor', 'System_Admin')) {
    formEl.hidden = true;
    return;
  }
  formEl.hidden = false;
  notesEl.value = '';
  errorEl.hidden = true;
  successEl.hidden = true;

  formEl.querySelectorAll('[data-decision]').forEach((btn) => {
    btn.onclick = async () => {
      errorEl.hidden = true;
      successEl.hidden = true;
      try {
        await apiFetch(`/api/${apiPath}/${id}/approval`, {
          method: 'PATCH',
          body: JSON.stringify({
            approval_status: btn.dataset.decision,
            approval_notes: notesEl.value.trim() || undefined,
          }),
        });
        successEl.textContent = `Marked ${btn.dataset.decision}.`;
        successEl.hidden = false;
        // Give the confirmation a moment on screen before onSaved
        // potentially re-mounts this whole view (citation/incident/crash
        // detail all do a full mount() on refresh, which would otherwise
        // wipe this message before it ever paints -- same fix as the
        // personnel edit form's save handler).
        if (onSaved) setTimeout(onSaved, 900);
      } catch (err) {
        errorEl.textContent = formErrorMessage(err);
        errorEl.hidden = false;
      }
    };
  });
}

/** Shows/hides an edit form behind a toggle button -- same pattern on every detail view. */
function wireEditToggle(toggleBtn, formEl) {
  toggleBtn.onclick = () => {
    formEl.hidden = !formEl.hidden;
  };
}

/** Every report detail view has an identical Print button -- browser print,
 * scoped by the .no-print CSS class (styles.css) to hide nav/buttons/forms
 * and print only the letterhead + report content. */
function wirePrintButton(btn) {
  if (btn) btn.onclick = () => window.print();
}

// ------------------------------------------------------------------
// Search view
// ------------------------------------------------------------------

let searchScope = 'persons';

function renderSearch() {
  mount('tpl-search');

  const scopeButtons = mainContent.querySelectorAll('.scope-btn');
  scopeButtons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.scope === searchScope);
    btn.addEventListener('click', () => {
      searchScope = btn.dataset.scope;
      scopeButtons.forEach((b) => b.classList.toggle('active', b === btn));
    });
  });

  const form = document.getElementById('search-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = document.getElementById('search-input').value.trim();
    await runSearch(searchScope, q);
  });
}

async function runSearch(scope, q) {
  const statusEl = document.getElementById('search-status');
  const resultsEl = document.getElementById('search-results');
  statusEl.textContent = 'Searching...';
  resultsEl.innerHTML = '';

  // incidents/crashes/evidence don't have their own /api/<scope>?q= route
  // named identically to their nav tabs' underlying endpoints -- they do
  // (see incidents.routes.js / crashes.routes.js / evidence.routes.js, all
  // of which accept the same q= free-text filter citations/persons/vehicles
  // already use), so this reuses the exact same apiFetch call shape.
  try {
    const data = await apiFetch(`/api/${scope}?q=${encodeURIComponent(q)}&limit=25`);
    statusEl.textContent = `${data.total} result${data.total === 1 ? '' : 's'}`;
    data.results.forEach((row) => {
      const li = document.createElement('li');
      li.className = 'result-item';
      if (scope === 'persons') {
        li.innerHTML = `<div class="r-title">${escapeHtml(row.last_name)}, ${escapeHtml(row.first_name)}</div>
          <div class="r-sub">DL ${escapeHtml(row.drivers_license_num || '—')} (${escapeHtml(row.dl_state || '')})</div>`;
        li.addEventListener('click', () => renderPersonDetail(row.id));
      } else if (scope === 'vehicles') {
        li.innerHTML = `<div class="r-title">${escapeHtml(row.plate_number)} (${escapeHtml(row.plate_state)})</div>
          <div class="r-sub">${escapeHtml(row.year || '')} ${escapeHtml(row.make)} ${escapeHtml(row.model)} — ${escapeHtml(row.color)}</div>`;
        li.addEventListener('click', () => renderVehicleDetail(row.id));
      } else if (scope === 'citations') {
        li.innerHTML = `<div class="r-title">${escapeHtml(row.citation_number)}</div>
          <div class="r-sub">${escapeHtml(row.violator_last_name)}, ${escapeHtml(row.violator_first_name)} — ${fmtStatus(row.court_status)}</div>`;
        li.addEventListener('click', () => renderCitationDetail(row.id, 'search'));
      } else if (scope === 'incidents') {
        li.innerHTML = `<div class="r-title">${escapeHtml(row.case_number)}</div>
          <div class="r-sub">${escapeHtml(row.location_address)} — ${fmtStatus(row.status)}</div>`;
        li.addEventListener('click', () => renderIncidentDetail(row.id));
      } else if (scope === 'crashes') {
        li.innerHTML = `<div class="r-title">${escapeHtml(row.report_number)}</div>
          <div class="r-sub">${escapeHtml(row.location)} — ${humanize(row.crash_severity)}</div>`;
        li.addEventListener('click', () => renderCrashDetail(row.id));
      } else if (scope === 'evidence') {
        li.innerHTML = `<div class="r-title">${escapeHtml(row.item_number)} — ${humanize(row.category)}</div>
          <div class="r-sub">${escapeHtml(row.description)} — ${fmtStatus(row.status)}</div>`;
        li.addEventListener('click', () => renderEvidenceDetail(row.id));
      }
      resultsEl.appendChild(li);
    });
  } catch (err) {
    statusEl.textContent = err.message;
  }
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ------------------------------------------------------------------
// Person detail
// ------------------------------------------------------------------

async function renderPersonDetail(id) {
  mount('tpl-person-detail');
  mainContent.querySelector('.back-btn').addEventListener('click', () => navigate('search'));

  try {
    const p = await apiFetch(`/api/persons/${id}`);
    mainContent.querySelector('.person-name').textContent = `${p.last_name}, ${p.first_name}`;
    mainContent.querySelector('.p-dob').textContent = fmtDate(p.dob);
    mainContent.querySelector('.p-dl').textContent = `${p.drivers_license_num || '—'} (${p.dl_state || ''})`;
    mainContent.querySelector('.p-dlclass').textContent = p.dl_class || '—';
    mainContent.querySelector('.p-cdl').textContent = p.is_cdl ? 'Yes' : 'No';
    mainContent.querySelector('.p-phone').textContent = p.phone || '—';
    mainContent.querySelector('.p-address').textContent = p.address || '—';

    const list = mainContent.querySelector('.p-citations');
    if (p.citations.length === 0) {
      list.innerHTML = '<li class="hint">No citations on file.</li>';
    }
    p.citations.forEach((c) => {
      const li = document.createElement('li');
      li.className = 'result-item';
      li.innerHTML = `<div class="r-title">${escapeHtml(c.citation_number)}</div>
        <div class="r-sub">${fmtDate(c.offense_date)} — ${escapeHtml(c.tca_code)} — ${fmtStatus(c.court_status)}</div>`;
      li.addEventListener('click', () => renderCitationDetail(c.id, 'search'));
      list.appendChild(li);
    });
  } catch (err) {
    mainContent.querySelector('.person-name').textContent = err.message;
  }
}

// ------------------------------------------------------------------
// Vehicle detail
// ------------------------------------------------------------------

async function renderVehicleDetail(id) {
  mount('tpl-vehicle-detail');
  mainContent.querySelector('.back-btn').addEventListener('click', () => navigate('search'));

  try {
    const v = await apiFetch(`/api/vehicles/${id}`);
    mainContent.querySelector('.vehicle-title').textContent = `${v.plate_number} (${v.plate_state})`;
    mainContent.querySelector('.v-vin').textContent = v.vin || '—';
    mainContent.querySelector('.v-owner').textContent = v.owner_name || '—';
    mainContent.querySelector('.v-year').textContent = `${v.year || ''} ${v.make} ${v.model}`.trim();
    mainContent.querySelector('.v-color').textContent = v.color || '—';
    mainContent.querySelector('.v-plateyear').textContent = v.plate_year || '—';

    const list = mainContent.querySelector('.v-citations');
    if (v.citations.length === 0) {
      list.innerHTML = '<li class="hint">No citations on file.</li>';
    }
    v.citations.forEach((c) => {
      const li = document.createElement('li');
      li.className = 'result-item';
      li.innerHTML = `<div class="r-title">${escapeHtml(c.citation_number)}</div>
        <div class="r-sub">${escapeHtml(c.violator_last_name)}, ${escapeHtml(c.violator_first_name)} — ${fmtStatus(c.court_status)}</div>`;
      li.addEventListener('click', () => renderCitationDetail(c.id, 'search'));
      list.appendChild(li);
    });
  } catch (err) {
    mainContent.querySelector('.vehicle-title').textContent = err.message;
  }
}

// ------------------------------------------------------------------
// Citations list
// ------------------------------------------------------------------

let citationsOffset = 0;
const CITATIONS_PAGE_SIZE = 20;

function renderCitationsList() {
  mount('tpl-citations');
  citationsOffset = 0;

  document.getElementById('filter-mine').addEventListener('change', loadCitationsPage);
  document.getElementById('filter-status').addEventListener('change', loadCitationsPage);
  document.getElementById('citations-prev').addEventListener('click', () => {
    citationsOffset = Math.max(0, citationsOffset - CITATIONS_PAGE_SIZE);
    loadCitationsPage();
  });
  document.getElementById('citations-next').addEventListener('click', () => {
    citationsOffset += CITATIONS_PAGE_SIZE;
    loadCitationsPage();
  });

  loadCitationsPage();
}

async function loadCitationsPage() {
  const listEl = document.getElementById('citations-list');
  const pageInfo = document.getElementById('citations-page-info');
  const mine = document.getElementById('filter-mine').checked;
  const status = document.getElementById('filter-status').value;

  const params = new URLSearchParams({
    limit: String(CITATIONS_PAGE_SIZE),
    offset: String(citationsOffset),
  });
  if (mine) params.set('mine', 'true');
  if (status) params.set('status', status);

  listEl.innerHTML = '<li class="hint">Loading...</li>';
  try {
    const data = await apiFetch(`/api/citations?${params.toString()}`);
    listEl.innerHTML = '';
    if (data.results.length === 0) {
      listEl.innerHTML = '<li class="hint">No citations match.</li>';
    }
    data.results.forEach((c) => {
      const li = document.createElement('li');
      li.className = 'result-item';
      li.innerHTML = `<div class="r-title">${escapeHtml(c.citation_number)} — ${escapeHtml(c.violator_last_name)}, ${escapeHtml(c.violator_first_name)}</div>
        <div class="r-sub">${fmtDate(c.offense_date)} — ${escapeHtml(c.plate_number)} — ${fmtStatus(c.court_status)}</div>`;
      li.addEventListener('click', () => renderCitationDetail(c.id, 'citations'));
      listEl.appendChild(li);
    });
    const start = data.total === 0 ? 0 : citationsOffset + 1;
    const end = Math.min(citationsOffset + CITATIONS_PAGE_SIZE, data.total);
    pageInfo.textContent = `${start}-${end} of ${data.total}`;
  } catch (err) {
    listEl.innerHTML = `<li class="hint">${escapeHtml(err.message)}</li>`;
  }
}

// ------------------------------------------------------------------
// Citation detail (+ court disposition update for Court_Clerk)
// ------------------------------------------------------------------

async function renderCitationDetail(id, backTo) {
  mount('tpl-citation-detail');
  mainContent.querySelector('.back-btn').addEventListener('click', () => navigate(backTo || 'citations'));
  wirePrintButton(mainContent.querySelector('.print-btn'));

  try {
    const c = await apiFetch(`/api/citations/${id}`);
    mainContent.querySelector('.c-number').textContent = c.citation_number;

    // Violator
    mainContent.querySelector('.c-violator-name').textContent = `${c.violator_last_name}, ${c.violator_first_name}`;
    mainContent.querySelector('.c-violator-dob').textContent = fmtDateOnly(c.violator_dob);
    mainContent.querySelector('.c-violator-sex').textContent = fmtEnum(c.violator_sex);
    mainContent.querySelector('.c-violator-race').textContent = fmtEnum(c.violator_race);
    mainContent.querySelector('.c-violator-height').textContent = fmtHeight(c.violator_height_inches);
    mainContent.querySelector('.c-violator-weight').textContent = c.violator_weight_lbs != null ? `${c.violator_weight_lbs} lbs` : '—';
    mainContent.querySelector('.c-violator-eyes').textContent = fmtOrDash(c.violator_eye_color);
    mainContent.querySelector('.c-violator-hair').textContent = fmtOrDash(c.violator_hair_color);
    mainContent.querySelector('.c-violator-address').textContent = fmtOrDash(c.violator_address);
    mainContent.querySelector('.c-violator-dl').textContent = fmtOrDash(c.violator_dl_number);
    mainContent.querySelector('.c-violator-dl-state').textContent = fmtOrDash(c.violator_dl_state);
    mainContent.querySelector('.c-violator-dl-class').textContent = fmtOrDash(c.violator_dl_class);
    mainContent.querySelector('.c-violator-cdl').textContent = fmtYesNo(c.violator_is_cdl);

    // Vehicle
    mainContent.querySelector('.c-plate').textContent = fmtOrDash(c.plate_number);
    mainContent.querySelector('.c-plate-state').textContent = fmtOrDash(c.plate_state);
    mainContent.querySelector('.c-plate-year').textContent = fmtOrDash(c.plate_year);
    mainContent.querySelector('.c-vehicle-year').textContent = fmtOrDash(c.vehicle_year);
    mainContent.querySelector('.c-make').textContent = fmtOrDash(c.make);
    mainContent.querySelector('.c-model').textContent = fmtOrDash(c.model);
    mainContent.querySelector('.c-color').textContent = fmtOrDash(c.vehicle_color);
    mainContent.querySelector('.c-vin').textContent = fmtOrDash(c.vehicle_vin);
    mainContent.querySelector('.c-owner').textContent = fmtOrDash(c.vehicle_owner_name);

    // Offense
    mainContent.querySelector('.c-offense-date').textContent = fmtDateOnly(c.offense_date);
    mainContent.querySelector('.c-offense-time').textContent = fmtTimeOnly(c.offense_date);
    mainContent.querySelector('.c-location').textContent = c.location;
    mainContent.querySelector('.c-description').textContent = c.offense_description;
    mainContent.querySelector('.c-tca').textContent = c.tca_code;
    mainContent.querySelector('.c-speed-detection').textContent = fmtEnum(c.speed_detection_method);
    mainContent.querySelector('.c-flag-cmv').classList.toggle('flag-active', !!c.is_cmv);
    mainContent.querySelector('.c-flag-hazmat').classList.toggle('flag-active', !!c.is_hazmat);
    mainContent.querySelector('.c-flag-16plus').classList.toggle('flag-active', !!c.passenger_capacity_16plus);

    // Officer / agency
    const officerLine = `${c.officer_name}${c.officer_rank ? ' — ' + fmtEnum(c.officer_rank) : ''} (Badge #${c.officer_badge})`;
    mainContent.querySelectorAll('.c-officer, .c-officer-2').forEach((el) => { el.textContent = officerLine; });
    mainContent.querySelector('.c-agency').textContent = fmtOrDash(c.officer_agency);

    // Court / disposition
    mainContent.querySelector('.c-court-date').textContent = fmtDateTime(c.court_date);
    mainContent.querySelector('.c-court-name').textContent = `${c.court_name} — ${c.court_location}`;
    mainContent.querySelector('.c-deadline').textContent = fmtDateTime(c.court_filing_deadline);
    mainContent.querySelector('.c-status').textContent = fmtStatus(c.court_status);
    mainContent.querySelector('.c-fine').textContent = fmtMoney(c.fine_amount_due);
    mainContent.querySelector('.c-paid').textContent = fmtMoney(c.amount_paid);

    const sigImg = mainContent.querySelector('.c-signature-img');
    const sigRefused = mainContent.querySelector('.c-signature-refused');
    if (c.violator_signature) {
      sigImg.src = c.violator_signature;
      sigImg.hidden = false;
      sigRefused.hidden = true;
    } else if (c.violator_refused_to_sign) {
      sigImg.hidden = true;
      sigRefused.hidden = false;
    }

    wireApprovalSection({
      record: c,
      id,
      apiPath: 'citations',
      badgeEl: mainContent.querySelector('.c-approval-badge'),
      detailEl: mainContent.querySelector('.c-approval-detail'),
      formEl: document.getElementById('citation-approval-form'),
      notesEl: document.getElementById('citation-approval-notes'),
      errorEl: mainContent.querySelector('.c-approval-error'),
      successEl: mainContent.querySelector('.c-approval-success'),
      onSaved: () => renderCitationDetail(id, backTo),
    });

    const editToggle = document.getElementById('citation-edit-toggle');
    const editForm = document.getElementById('citation-edit-form');
    if (hasAnyRole('Patrol_Officer', 'Supervisor', 'System_Admin')) {
      editToggle.hidden = false;
      wireEditToggle(editToggle, editForm);
      document.getElementById('ce-description').value = c.offense_description || '';
      document.getElementById('ce-tca').value = c.tca_code || '';
      document.getElementById('ce-speed-detection').value = '';
      document.getElementById('ce-location').value = c.location || '';
      document.getElementById('ce-latitude').value = c.latitude ?? '';
      document.getElementById('ce-longitude').value = c.longitude ?? '';
      if (c.court_date) {
        const d = new Date(c.court_date);
        if (!Number.isNaN(d.getTime())) {
          document.getElementById('ce-court-date').value = d.toISOString().slice(0, 10);
          document.getElementById('ce-court-time').value = d.toISOString().slice(11, 16);
        }
      }
      document.getElementById('ce-court-location').value = c.court_location || '';
      document.getElementById('ce-court-name').value = c.court_name || '';

      editForm.onsubmit = async (e) => {
        e.preventDefault();
        const errorEl = mainContent.querySelector('.ce-error');
        const successEl = mainContent.querySelector('.ce-success');
        errorEl.hidden = true;
        successEl.hidden = true;

        const val = (elId) => document.getElementById(elId).value.trim();
        const body = {};
        if (val('ce-description')) body.offense_description = val('ce-description');
        if (val('ce-tca')) body.tca_code = val('ce-tca');
        if (val('ce-speed-detection')) body.speed_detection_method = val('ce-speed-detection');
        if (val('ce-location')) body.location = val('ce-location');
        if (val('ce-latitude') !== '' && val('ce-longitude') !== '') {
          body.latitude = Number(val('ce-latitude'));
          body.longitude = Number(val('ce-longitude'));
        }
        if (val('ce-court-date') && val('ce-court-time')) {
          body.court_date = val('ce-court-date');
          body.court_time = val('ce-court-time');
        }
        if (val('ce-court-location')) body.court_location = val('ce-court-location');
        if (val('ce-court-name')) body.court_name = val('ce-court-name');

        try {
          await apiFetch(`/api/citations/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
          successEl.textContent = 'Citation updated.';
          successEl.hidden = false;
          // See the identical note on the approval save handler above --
          // renderCitationDetail() re-mounts the view, which would wipe
          // this message before it ever paints if called immediately.
          setTimeout(() => renderCitationDetail(id, backTo), 900);
        } catch (err) {
          errorEl.textContent = formErrorMessage(err);
          errorEl.hidden = false;
        }
      };
    } else {
      editToggle.hidden = true;
      editForm.hidden = true;
    }

    if (hasAnyRole('Court_Clerk')) {
      const form = document.getElementById('ledger-form');
      form.hidden = false;
      if (c.court_status) document.getElementById('ledger-status').value = c.court_status;
      if (c.fine_amount_due !== null) document.getElementById('ledger-fine').value = c.fine_amount_due;
      if (c.amount_paid !== null) document.getElementById('ledger-paid').value = c.amount_paid;

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const errorEl = form.querySelector('.ledger-error');
        const successEl = form.querySelector('.ledger-success');
        errorEl.hidden = true;
        successEl.hidden = true;

        const body = {};
        const status = document.getElementById('ledger-status').value;
        const fine = document.getElementById('ledger-fine').value;
        const paid = document.getElementById('ledger-paid').value;
        const paymentDate = document.getElementById('ledger-payment-date').value;
        const notes = document.getElementById('ledger-notes').value;
        if (status) body.court_status = status;
        if (fine !== '') body.fine_amount_due = Number(fine);
        if (paid !== '') body.amount_paid = Number(paid);
        if (paymentDate) body.payment_date = paymentDate;
        if (notes) body.disposition_notes = notes;

        if (Object.keys(body).length === 0) {
          errorEl.textContent = 'Change at least one field before saving.';
          errorEl.hidden = false;
          return;
        }

        try {
          await apiFetch(`/api/court/citations/${id}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
          });
          successEl.textContent = 'Disposition saved.';
          successEl.hidden = false;
          // See the note on the citation edit save handler below --
          // renderCitationDetail() re-mounts the view immediately, which
          // was wiping this message before it ever painted.
          setTimeout(() => renderCitationDetail(id, backTo), 900);
        } catch (err) {
          errorEl.textContent = err.message;
          errorEl.hidden = false;
        }
      });
    }
  } catch (err) {
    mainContent.querySelector('.c-number').textContent = err.message;
  }
}

// ------------------------------------------------------------------
// Issue citation form
// ------------------------------------------------------------------

/**
 * Wires an HTML5 canvas as a simple signature pad -- pointer events cover
 * mouse, touch, and stylus input in one listener set (no separate
 * touchstart/mousedown handling needed). Returns { hasSignature, clear,
 * toDataUrl } so the caller can check/reset/capture it without reaching
 * back into canvas internals.
 */
function setupSignaturePad(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#1c2431';
  let drawing = false;
  let hasSignature = false;

  function pos(e) {
    const rect = canvas.getBoundingClientRect();
    // The canvas's drawing-buffer size (width/height attributes) can differ
    // from its on-screen CSS size, so map pointer coordinates through the
    // ratio rather than assuming 1:1 -- otherwise strokes land in the wrong
    // place on any layout where CSS scales the canvas down.
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  canvas.addEventListener('pointerdown', (e) => {
    drawing = true;
    hasSignature = true;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  });
  const stop = () => {
    drawing = false;
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  canvas.addEventListener('pointerleave', stop);

  return {
    get hasSignature() {
      return hasSignature;
    },
    clear() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      hasSignature = false;
    },
    toDataUrl() {
      return canvas.toDataURL('image/png');
    },
  };
}

function renderIssueForm() {
  mount('tpl-issue');
  const form = document.getElementById('issue-form');

  const signaturePad = setupSignaturePad(document.getElementById('i-signature-pad'));
  const signatureRefused = document.getElementById('i-signature-refused');
  document.getElementById('i-signature-clear').addEventListener('click', () => signaturePad.clear());
  // Signing and "refused to sign" are mutually exclusive (see the
  // .xor('violator_signature', 'violator_refused_to_sign') note in
  // src/validation/citationSchema.js) -- checking refused clears any drawn
  // signature so the two can never both be sent.
  signatureRefused.addEventListener('change', () => {
    if (signatureRefused.checked) signaturePad.clear();
  });

  const useLocationBtn = document.getElementById('i-use-location');
  const locationStatus = document.getElementById('i-location-status');
  useLocationBtn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      locationStatus.textContent = 'Geolocation is not available on this device.';
      return;
    }
    locationStatus.textContent = 'Getting location...';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        document.getElementById('i-latitude').value = pos.coords.latitude.toFixed(7);
        document.getElementById('i-longitude').value = pos.coords.longitude.toFixed(7);
        locationStatus.textContent = `Location captured (±${Math.round(pos.coords.accuracy)}m accuracy).`;
      },
      (err) => {
        locationStatus.textContent = `Could not get location: ${err.message}`;
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('issue-error');
    const successEl = document.getElementById('issue-success');
    errorEl.hidden = true;
    successEl.hidden = true;

    const val = (id) => document.getElementById(id).value.trim();
    const checked = (id) => document.getElementById(id).checked;

    const payload = {
      citation_number: val('i-citation-number'),
      violator: {
        first_name: val('i-first-name'),
        middle_name: val('i-middle-name') || undefined,
        last_name: val('i-last-name'),
        dob: val('i-dob'),
        sex: val('i-sex'),
        race: val('i-race'),
        height_inches: Number(val('i-height')),
        weight_lbs: Number(val('i-weight')),
        eye_color: val('i-eye-color'),
        hair_color: val('i-hair-color'),
        drivers_license_num: val('i-dl-num'),
        dl_state: val('i-dl-state').toUpperCase(),
        dl_class: val('i-dl-class'),
        is_cdl: checked('i-is-cdl'),
        phone: val('i-phone') || undefined,
        address: val('i-address') || undefined,
      },
      vehicle: {
        vin: val('i-vin') || undefined,
        make: val('i-make'),
        model: val('i-model'),
        year: val('i-year'),
        color: val('i-color'),
        owner_name: val('i-owner'),
        plate_number: val('i-plate'),
        plate_year: val('i-plate-year'),
        plate_state: val('i-plate-state').toUpperCase(),
      },
      offense: {
        offense_date: val('i-offense-date'),
        offense_time: val('i-offense-time'),
        location: val('i-location'),
        latitude: Number(val('i-latitude')),
        longitude: Number(val('i-longitude')),
        offense_description: val('i-description'),
        tca_code: val('i-tca'),
        is_cmv: checked('i-is-cmv'),
        is_hazmat: checked('i-is-hazmat'),
        passenger_capacity_16plus: checked('i-is-16plus'),
        speed_detection_method: val('i-speed-detection') || undefined,
      },
      court: {
        court_date: val('i-court-date'),
        court_time: val('i-court-time'),
        court_location: val('i-court-location'),
        court_name: val('i-court-name'),
      },
    };

    // Exactly one of these two, matching the server's .xor() -- see
    // src/validation/citationSchema.js's signatureSchema comment for why
    // neither field carries a default there.
    if (signatureRefused.checked) {
      payload.violator_refused_to_sign = true;
    } else if (signaturePad.hasSignature) {
      payload.violator_signature = signaturePad.toDataUrl();
    } else {
      errorEl.textContent = 'Have the violator sign above, or check "Violator Refused to Sign".';
      errorEl.hidden = false;
      return;
    }

    try {
      const result = await apiFetch('/api/citations', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      successEl.textContent = `Citation ${result.citation_number} submitted. Court filing deadline: ${fmtDate(result.court_filing_deadline)}.`;
      successEl.hidden = false;
      form.reset();
      signaturePad.clear();
    } catch (err) {
      let message = err.message;
      if (Array.isArray(err.details)) {
        message += ': ' + err.details.map((d) => d.message || d).join('; ');
      } else if (err.details && Array.isArray(err.details.details)) {
        message += ': ' + err.details.details.map((d) => d.message).join('; ');
      }
      errorEl.textContent = message;
      errorEl.hidden = false;
    }
  });
}

// ------------------------------------------------------------------
// Personnel management (System_Admin only)
// ------------------------------------------------------------------

async function renderPersonnel() {
  mount('tpl-personnel');

  const addBtn = document.getElementById('personnel-add-btn');
  const addForm = document.getElementById('personnel-add-form');
  const listEl = document.getElementById('personnel-list');
  const myProfile = getProfile();

  addBtn.addEventListener('click', () => {
    addForm.hidden = !addForm.hidden;
  });

  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('personnel-add-error');
    const successEl = document.getElementById('personnel-add-success');
    errorEl.hidden = true;
    successEl.hidden = true;

    const additionalRoles = Array.from(
      document.querySelectorAll('#pn-additional-roles input:checked')
    ).map((el) => el.value);

    const payload = {
      username: document.getElementById('pn-username').value.trim(),
      password: document.getElementById('pn-password').value,
      full_name: document.getElementById('pn-full-name').value.trim(),
      badge_number: document.getElementById('pn-badge').value.trim(),
      officer_rank: document.getElementById('pn-rank').value.trim() || undefined,
      agency: document.getElementById('pn-agency').value.trim(),
      role: document.getElementById('pn-role').value,
      additional_roles: additionalRoles,
    };

    try {
      await apiFetch('/api/users', { method: 'POST', body: JSON.stringify(payload) });
      successEl.textContent = `Account "${payload.username}" created.`;
      successEl.hidden = false;
      addForm.reset();
      document.getElementById('pn-agency').value = 'Gates Police Department';
      loadPersonnelList(listEl, myProfile);
    } catch (err) {
      let message = err.message;
      if (err.details && Array.isArray(err.details.details)) {
        message += ': ' + err.details.details.map((d) => d.message).join('; ');
      }
      errorEl.textContent = message;
      errorEl.hidden = false;
    }
  });

  await loadPersonnelList(listEl, myProfile);
}

// Matches src/validation/userSchema.js's ROLE_VALUES (VALID_ROLES in
// src/middleware/auth.js) -- kept in sync by hand like every other enum
// list in this file.
const PERSONNEL_ROLE_VALUES = ['Patrol_Officer', 'Supervisor', 'Court_Clerk', 'System_Admin'];

async function loadPersonnelList(listEl, myProfile) {
  listEl.innerHTML = '<li class="hint">Loading...</li>';
  try {
    const data = await apiFetch('/api/users');
    listEl.innerHTML = '';
    if (data.results.length === 0) {
      listEl.innerHTML = '<li class="hint">No accounts on file.</li>';
      return;
    }
    data.results.forEach((u) => {
      const li = document.createElement('li');
      li.className = 'result-item';
      const isSelf = myProfile && myProfile.badge_number === u.badge_number;
      const allRoles = [u.role, ...(u.additional_roles || [])];
      li.innerHTML = `<div class="r-title">${escapeHtml(u.full_name)} — ${escapeHtml(u.username)} ${
        u.is_active ? '' : '<span class="badge">Deactivated</span>'
      }</div>
        <div class="r-sub">${escapeHtml(allRoles.map(humanize).join(', '))} · Badge ${escapeHtml(u.badge_number)} · ${escapeHtml(
        u.officer_rank || ''
      )} · ${escapeHtml(u.agency)}</div>`;

      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'personnel-actions';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn-secondary';
      editBtn.textContent = 'Edit';
      actionsDiv.appendChild(editBtn);

      if (!isSelf) {
        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'btn btn-secondary';
        toggleBtn.textContent = u.is_active ? 'Deactivate' : 'Reactivate';
        toggleBtn.addEventListener('click', async () => {
          try {
            await apiFetch(`/api/users/${u.id}`, {
              method: 'PATCH',
              body: JSON.stringify({ is_active: !u.is_active }),
            });
            loadPersonnelList(listEl, myProfile);
          } catch (err) {
            alert(err.message);
          }
        });
        actionsDiv.appendChild(toggleBtn);

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'btn btn-secondary btn-danger';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', async () => {
          if (!confirm(`Permanently delete the account "${u.username}"? This cannot be undone.`)) return;
          try {
            await apiFetch(`/api/users/${u.id}`, { method: 'DELETE' });
            loadPersonnelList(listEl, myProfile);
          } catch (err) {
            // A 409 here means the account has citations/incidents/crashes/
            // evidence on file -- src/controllers/users.controller.js's
            // deleteUser already gives a clear message for that case, so
            // just surface it rather than adding a second one.
            alert(err.message);
          }
        });
        actionsDiv.appendChild(deleteBtn);
      }

      li.appendChild(actionsDiv);

      // Inline edit form -- built once per row, toggled by Edit. Primary
      // role is a single <select>; additional_roles is a checkbox group
      // (see db/migrations/008_..._multirole_...sql) that includes every
      // role, including the primary one -- the server dedupes on save
      // (see updateUser in src/controllers/users.controller.js), so
      // checking a role that's already primary is harmless.
      const editForm = document.createElement('form');
      editForm.className = 'personnel-edit-form';
      editForm.hidden = true;
      editForm.innerHTML = `
        <label>Full Name</label><input class="pe-full-name" value="${escapeHtml(u.full_name)}" />
        <label>Badge Number</label><input class="pe-badge" value="${escapeHtml(u.badge_number)}" />
        <label>Rank</label><input class="pe-rank" value="${escapeHtml(u.officer_rank || '')}" />
        <label>Agency</label><input class="pe-agency" value="${escapeHtml(u.agency)}" />
        <label>Primary Role</label>
        <select class="pe-role">${optionsHtml(PERSONNEL_ROLE_VALUES)}</select>
        <label>Additional Roles</label>
        <div class="role-checkboxes pe-additional-roles">
          ${PERSONNEL_ROLE_VALUES.map(
            (r) =>
              `<label class="checkbox-label"><input type="checkbox" value="${r}" ${
                allRoles.includes(r) && r !== u.role ? 'checked' : ''
              } /> ${humanize(r)}</label>`
          ).join('')}
        </div>
        <label>Reset Password <span class="hint">(optional)</span></label>
        <input class="pe-password" type="text" minlength="10" placeholder="Leave blank to keep current password" />
        <button type="submit" class="btn btn-primary">Save Changes</button>
        <p class="pe-error error-text" hidden></p>
        <p class="pe-success success-text" hidden></p>`;
      editForm.querySelector('.pe-role').value = u.role;

      editBtn.addEventListener('click', () => {
        editForm.hidden = !editForm.hidden;
      });

      editForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const errorEl = editForm.querySelector('.pe-error');
        const successEl = editForm.querySelector('.pe-success');
        errorEl.hidden = true;
        successEl.hidden = true;

        const body = {
          full_name: editForm.querySelector('.pe-full-name').value.trim(),
          badge_number: editForm.querySelector('.pe-badge').value.trim(),
          officer_rank: editForm.querySelector('.pe-rank').value.trim() || undefined,
          agency: editForm.querySelector('.pe-agency').value.trim(),
          role: editForm.querySelector('.pe-role').value,
          additional_roles: Array.from(editForm.querySelectorAll('.pe-additional-roles input:checked')).map(
            (el) => el.value
          ),
        };
        const newPassword = editForm.querySelector('.pe-password').value;
        if (newPassword) body.new_password = newPassword;

        try {
          await apiFetch(`/api/users/${u.id}`, { method: 'PATCH', body: JSON.stringify(body) });
          successEl.textContent = 'Account updated.';
          successEl.hidden = false;
          // Give the confirmation a moment on screen before the list
          // reload replaces this form's DOM node entirely -- an immediate
          // reload here would wipe the message before it ever paints.
          setTimeout(() => loadPersonnelList(listEl, myProfile), 900);
        } catch (err) {
          errorEl.textContent = formErrorMessage(err);
          errorEl.hidden = false;
        }
      });

      li.appendChild(editForm);
      listEl.appendChild(li);
    });
  } catch (err) {
    listEl.innerHTML = `<li class="error-text">${escapeHtml(err.message)}</li>`;
  }
}

// ------------------------------------------------------------------
// Shared enum option lists -- mirror the Joi validation schemas server
// side exactly (src/validation/incidentSchema.js, crashSchema.js,
// evidenceSchema.js, citationSchema.js). Kept in sync by hand, same
// documented convention the server-side files themselves use.
// ------------------------------------------------------------------

function humanize(v) {
  return v ? v.replace(/_/g, ' ') : '';
}

function optionsHtml(values, placeholder) {
  const opts = values.map((v) => `<option value="${v}">${humanize(v)}</option>`).join('');
  return placeholder ? `<option value="">${placeholder}</option>${opts}` : opts;
}

// [code, description] -- the 49 TIBRS/NIBRS Group A offense codes seeded in
// tibrs_offense_codes (db/migrations/005_add_tibrs_incident_module.sql).
const TIBRS_OFFENSE_CODES = [
  ['09A', 'Murder & Nonnegligent Manslaughter'],
  ['09B', 'Negligent Manslaughter'],
  ['09C', 'Justifiable Homicide'],
  ['100', 'Kidnapping/Abduction'],
  ['11A', 'Rape'],
  ['11B', 'Sodomy'],
  ['11C', 'Sexual Assault With An Object'],
  ['11D', 'Fondling'],
  ['13A', 'Aggravated Assault'],
  ['13B', 'Simple Assault'],
  ['13C', 'Intimidation'],
  ['36A', 'Incest'],
  ['36B', 'Statutory Rape'],
  ['64A', 'Human Trafficking, Commercial Sex Acts'],
  ['64B', 'Human Trafficking, Involuntary Servitude'],
  ['200', 'Arson'],
  ['210', 'Extortion/Blackmail'],
  ['220', 'Burglary/Breaking & Entering'],
  ['23A', 'Pocket-picking'],
  ['23B', 'Purse-snatching'],
  ['23C', 'Shoplifting'],
  ['23D', 'Theft From Building'],
  ['23E', 'Theft From Coin-Operated Machine'],
  ['23F', 'Theft From Motor Vehicle'],
  ['23G', 'Theft Of Motor Vehicle Parts/Accessories'],
  ['23H', 'All Other Larceny'],
  ['240', 'Motor Vehicle Theft'],
  ['250', 'Counterfeiting/Forgery'],
  ['270', 'Embezzlement'],
  ['26A', 'False Pretenses/Swindle/Confidence Game'],
  ['26B', 'Credit Card/ATM Fraud'],
  ['26C', 'Impersonation'],
  ['26D', 'Welfare Fraud'],
  ['26E', 'Wire Fraud'],
  ['26F', 'Identity Theft'],
  ['26G', 'Hacking/Computer Invasion'],
  ['280', 'Stolen Property Offenses'],
  ['290', 'Destruction/Damage/Vandalism of Property'],
  ['510', 'Bribery'],
  ['35A', 'Drug/Narcotic Violations'],
  ['35B', 'Drug Equipment Violations'],
  ['39A', 'Betting/Wagering'],
  ['39B', 'Operating/Promoting/Assisting Gambling'],
  ['39C', 'Gambling Equipment Violation'],
  ['39D', 'Sports Tampering'],
  ['370', 'Pornography/Obscene Material'],
  ['40A', 'Prostitution'],
  ['40B', 'Assisting or Promoting Prostitution'],
  ['520', 'Weapon Law Violations'],
];

function offenseOptionsHtml() {
  return (
    '<option value="">-- select --</option>' +
    TIBRS_OFFENSE_CODES.map(([code, desc]) => `<option value="${code}">${code} - ${escapeHtml(desc)}</option>`).join('')
  );
}

// Mirrors src/validation/incidentSchema.js's LOCATION_TYPES exactly -- used
// to build the Location Type <select> on the incident edit form (the
// create form's copy is written out as static HTML options).
const LOCATION_TYPES = [
  'Air_Bus_Train_Terminal',
  'Bank_Savings_Loan',
  'Bar_Nightclub',
  'Church_Synagogue_Temple_Mosque',
  'Commercial_Office_Building',
  'Construction_Site',
  'Convenience_Store',
  'Department_Discount_Store',
  'Drug_Store_Doctors_Office_Hospital',
  'Field_Woods',
  'Government_Public_Building',
  'Grocery_Supermarket',
  'Highway_Road_Alley_Street_Sidewalk',
  'Hotel_Motel',
  'Jail_Prison',
  'Lake_Waterway_Beach',
  'Liquor_Store',
  'Parking_Lot_Garage',
  'Park_Playground',
  'Rental_Storage_Facility',
  'Residence_Home',
  'Restaurant',
  'School_College',
  'Service_Gas_Station',
  'Shopping_Mall',
  'Specialty_Store',
  'Other',
  'Unknown',
];
const INCIDENT_STATUSES = ['Open', 'Under_Review', 'Closed'];
const EXCEPTIONAL_CLEARANCE_VALUES = [
  'Not_Applicable',
  'Death_of_Offender',
  'Prosecution_Declined',
  'In_Custody_of_Other_Jurisdiction',
  'Victim_Refused_to_Cooperate',
  'Juvenile_No_Custody',
];

const INCIDENT_PERSON_ROLES = ['Victim', 'Offender', 'Witness', 'Reporting_Party'];
const INJURY_TYPES = [
  'None',
  'Apparent_Broken_Bones',
  'Possible_Internal_Injury',
  'Severe_Laceration',
  'Apparent_Minor_Injury',
  'Loss_of_Teeth',
  'Unconsciousness',
  'Other_Major_Injury',
];
const VOR_RELATIONSHIPS = [
  'Spouse',
  'Common_Law_Spouse',
  'Ex_Spouse',
  'Parent',
  'Sibling',
  'Child',
  'Grandparent',
  'Grandchild',
  'In_Law',
  'Stepparent',
  'Stepchild',
  'Stepsibling',
  'Other_Family',
  'Boyfriend_Girlfriend',
  'Acquaintance',
  'Friend',
  'Neighbor',
  'Employee',
  'Employer',
  'Otherwise_Known',
  'Stranger',
  'Victim_Was_Offender',
  'Relationship_Unknown',
];
const PROPERTY_LOSS_TYPES = [
  'None',
  'Stolen',
  'Burned',
  'Counterfeited_Forged',
  'Damaged_Destroyed_Vandalized',
  'Recovered',
  'Seized',
  'Other',
];
const PROPERTY_CATEGORIES = [
  'Automobiles',
  'Other_Motor_Vehicles',
  'Bicycles',
  'Watercraft',
  'Firearms',
  'Household_Goods',
  'Jewelry_Precious_Metals',
  'Electronics_Computer_Equipment',
  'Office_Equipment',
  'Tools',
  'Clothes_Furs',
  'Money',
  'Negotiable_Instruments',
  'Credit_Debit_Cards',
  'Identity_Documents',
  'Drugs_Narcotics',
  'Drug_Equipment',
  'Firearm_Accessories',
  'Structures',
  'Merchandise',
  'Purses_Handbags_Wallets',
  'Consumable_Goods',
  'Recreational_Vehicles',
  'Other',
  'Not_Applicable',
];
const PERSON_SEX_VALUES = ['Male', 'Female', 'Unknown'];
const PERSON_RACE_VALUES = [
  'White',
  'Black',
  'American_Indian_Alaska_Native',
  'Asian',
  'Native_Hawaiian_Pacific_Islander',
  'Unknown',
];

const WEATHER_CONDITIONS = [
  'Clear',
  'Cloudy',
  'Rain',
  'Sleet_Hail',
  'Snow',
  'Fog_Smog_Smoke',
  'Severe_Crosswinds',
  'Blowing_Sand_Soil_Dirt',
  'Other',
  'Unknown',
];
const ROAD_SURFACE_CONDITIONS = [
  'Dry',
  'Wet',
  'Snow',
  'Ice',
  'Sand_Mud_Dirt_Gravel',
  'Water_Standing_Moving',
  'Slush',
  'Other',
  'Unknown',
];
const LIGHT_CONDITIONS = [
  'Daylight',
  'Dusk',
  'Dawn',
  'Dark_Lighted',
  'Dark_Not_Lighted',
  'Dark_Unknown_Lighting',
  'Other',
  'Unknown',
];
const CRASH_SEVERITIES = ['Property_Damage_Only', 'Injury', 'Fatality'];
const CRASH_PERSON_ROLES = ['Driver', 'Passenger', 'Pedestrian', 'Cyclist', 'Other'];
const CRASH_INJURY_SEVERITIES = [
  'No_Apparent_Injury',
  'Possible_Injury',
  'Suspected_Minor_Injury',
  'Suspected_Serious_Injury',
  'Fatal_Injury',
];

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

function wireUseLocation(btnId, latId, lngId, statusId) {
  const btn = document.getElementById(btnId);
  const statusEl = document.getElementById(statusId);
  btn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      statusEl.textContent = 'Geolocation is not available on this device.';
      return;
    }
    statusEl.textContent = 'Getting location...';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        document.getElementById(latId).value = pos.coords.latitude.toFixed(7);
        document.getElementById(lngId).value = pos.coords.longitude.toFixed(7);
        statusEl.textContent = `Location captured (±${Math.round(pos.coords.accuracy)}m accuracy).`;
      },
      (err) => {
        statusEl.textContent = `Could not get location: ${err.message}`;
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

function formErrorMessage(err) {
  let message = err.message;
  if (Array.isArray(err.details)) {
    message += ': ' + err.details.map((d) => d.message || d).join('; ');
  } else if (err.details && Array.isArray(err.details.details)) {
    message += ': ' + err.details.details.map((d) => d.message).join('; ');
  }
  return message;
}

function makeRemovableRow(container, className, innerHtml) {
  const div = document.createElement('div');
  div.className = `dyn-row ${className}`;
  div.dataset.rowId = String(++makeRemovableRow._seq || (makeRemovableRow._seq = 1));
  div.innerHTML = innerHtml + '<button type="button" class="btn btn-link remove-row">Remove</button>';
  div.querySelector('.remove-row').addEventListener('click', () => {
    div.remove();
    if (div._onRemove) div._onRemove();
  });
  container.appendChild(div);
  return div;
}

// ------------------------------------------------------------------
// Incidents
// ------------------------------------------------------------------

function refreshRelationshipPersonSelects() {
  const personRows = Array.from(document.querySelectorAll('#incident-person-rows .dyn-row'));
  const optsHtml =
    '<option value="">-- select --</option>' +
    personRows
      .map((row, idx) => {
        const first = row.querySelector('.p-first-name').value.trim();
        const last = row.querySelector('.p-last-name').value.trim();
        const role = row.querySelector('.p-role').value;
        const label = `#${idx + 1} ${first} ${last}`.trim() + (role ? ` (${humanize(role)})` : '');
        return `<option value="${row.dataset.rowId}">${escapeHtml(label)}</option>`;
      })
      .join('');
  document.querySelectorAll('#incident-relationship-rows .rel-victim, #incident-relationship-rows .rel-offender').forEach((sel) => {
    const prev = sel.value;
    sel.innerHTML = optsHtml;
    if (Array.from(sel.options).some((o) => o.value === prev)) sel.value = prev;
  });
}

function addIncidentOffenseRow() {
  const container = document.getElementById('incident-offense-rows');
  makeRemovableRow(
    container,
    'offense-row',
    `<label>Offense Code</label>
     <select class="off-code" required>${offenseOptionsHtml()}</select>
     <label>Attempted / Completed</label>
     <select class="off-status">
       <option value="Completed">Completed</option>
       <option value="Attempted">Attempted</option>
     </select>`
  );
}

function addIncidentPersonRow() {
  const container = document.getElementById('incident-person-rows');
  const row = makeRemovableRow(
    container,
    'person-row',
    `<label>Role</label>
     <select class="p-role" required><option value="">-- select --</option>${optionsHtml(INCIDENT_PERSON_ROLES)}</select>
     <label>First Name</label>
     <input class="p-first-name" />
     <label>Last Name</label>
     <input class="p-last-name" />
     <label>Date of Birth</label>
     <input class="p-dob" type="date" />
     <label>Sex</label>
     <select class="p-sex"><option value="">-- select --</option>${optionsHtml(PERSON_SEX_VALUES)}</select>
     <label>Race</label>
     <select class="p-race"><option value="">-- select --</option>${optionsHtml(PERSON_RACE_VALUES)}</select>
     <label>Injury Type</label>
     <select class="p-injury"><option value="">-- select --</option>${optionsHtml(INJURY_TYPES)}</select>`
  );
  row.querySelector('.p-role').addEventListener('change', refreshRelationshipPersonSelects);
  row.querySelector('.p-first-name').addEventListener('input', refreshRelationshipPersonSelects);
  row.querySelector('.p-last-name').addEventListener('input', refreshRelationshipPersonSelects);
  row._onRemove = refreshRelationshipPersonSelects;
  refreshRelationshipPersonSelects();
}

function addIncidentRelationshipRow() {
  const container = document.getElementById('incident-relationship-rows');
  makeRemovableRow(
    container,
    'relationship-row',
    `<label>Victim</label>
     <select class="rel-victim" required></select>
     <label>Offender</label>
     <select class="rel-offender" required></select>
     <label>Relationship</label>
     <select class="rel-type" required><option value="">-- select --</option>${optionsHtml(VOR_RELATIONSHIPS)}</select>`
  );
  refreshRelationshipPersonSelects();
}

function addIncidentPropertyRow() {
  const container = document.getElementById('incident-property-rows');
  makeRemovableRow(
    container,
    'property-row',
    `<label>Loss Type</label>
     <select class="prop-loss-type" required>${optionsHtml(PROPERTY_LOSS_TYPES)}</select>
     <label>Category</label>
     <select class="prop-category" required>${optionsHtml(PROPERTY_CATEGORIES)}</select>
     <label>Description</label>
     <input class="prop-description" required />
     <label>Value ($)</label>
     <input class="prop-value" type="number" step="0.01" min="0" />
     <label>Date Recovered</label>
     <input class="prop-date-recovered" type="date" />`
  );
}

function renderIncidents() {
  mount('tpl-incidents');
  const newBtn = document.getElementById('incident-new-btn');
  const form = document.getElementById('incident-form');
  newBtn.addEventListener('click', () => {
    form.hidden = !form.hidden;
  });

  document.getElementById('incident-offense-rows').innerHTML = '';
  document.getElementById('incident-person-rows').innerHTML = '';
  document.getElementById('incident-relationship-rows').innerHTML = '';
  document.getElementById('incident-property-rows').innerHTML = '';

  document.getElementById('incident-add-offense').addEventListener('click', addIncidentOffenseRow);
  document.getElementById('incident-add-person').addEventListener('click', addIncidentPersonRow);
  document.getElementById('incident-add-relationship').addEventListener('click', addIncidentRelationshipRow);
  document.getElementById('incident-add-property').addEventListener('click', addIncidentPropertyRow);

  addIncidentOffenseRow();

  wireUseLocation('in-use-location', 'in-latitude', 'in-longitude', 'in-location-status');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('incident-form-error');
    const successEl = document.getElementById('incident-form-success');
    errorEl.hidden = true;
    successEl.hidden = true;

    const val = (id) => document.getElementById(id).value.trim();

    const personRows = Array.from(document.querySelectorAll('#incident-person-rows .dyn-row'));
    const personIndexByRowId = {};
    const persons = personRows.map((row, idx) => {
      personIndexByRowId[row.dataset.rowId] = idx;
      const q = (sel) => row.querySelector(sel).value.trim();
      const person = { role: q('.p-role') };
      if (q('.p-first-name')) person.first_name = q('.p-first-name');
      if (q('.p-last-name')) person.last_name = q('.p-last-name');
      if (q('.p-dob')) person.dob = q('.p-dob');
      if (q('.p-sex')) person.sex = q('.p-sex');
      if (q('.p-race')) person.race = q('.p-race');
      if (q('.p-injury')) person.injury_type = q('.p-injury');
      return person;
    });

    const offenses = Array.from(document.querySelectorAll('#incident-offense-rows .dyn-row')).map((row) => ({
      tibrs_offense_code: row.querySelector('.off-code').value,
      attempted_completed: row.querySelector('.off-status').value,
    }));

    const relationships = Array.from(document.querySelectorAll('#incident-relationship-rows .dyn-row')).map((row) => ({
      victim_index: personIndexByRowId[row.querySelector('.rel-victim').value],
      offender_index: personIndexByRowId[row.querySelector('.rel-offender').value],
      relationship: row.querySelector('.rel-type').value,
    }));

    const property = Array.from(document.querySelectorAll('#incident-property-rows .dyn-row')).map((row) => {
      const q = (sel) => row.querySelector(sel).value.trim();
      const item = {
        property_loss_type: q('.prop-loss-type'),
        property_category: q('.prop-category'),
        property_description: q('.prop-description'),
      };
      if (q('.prop-value') !== '') item.value_amount = Number(q('.prop-value'));
      if (q('.prop-date-recovered')) item.date_recovered = q('.prop-date-recovered');
      return item;
    });

    const payload = {
      case_number: val('in-case-number'),
      occurrence_date: `${val('in-occurrence-date')}T${val('in-occurrence-time') || '00:00'}:00`,
      location_address: val('in-location-address'),
      location_type: val('in-location-type'),
      offenses,
      persons,
      relationships,
      property,
    };
    const lat = val('in-latitude');
    const lng = val('in-longitude');
    if (lat !== '' && lng !== '') {
      payload.latitude = Number(lat);
      payload.longitude = Number(lng);
    }
    if (val('in-narrative')) payload.narrative = val('in-narrative');

    try {
      const result = await apiFetch('/api/incidents', { method: 'POST', body: JSON.stringify(payload) });
      successEl.textContent = `Incident ${result.case_number} submitted (${result.offense_count} offense(s), ${result.person_count} person(s)).`;
      successEl.hidden = false;
      // Reset the form in place rather than calling renderIncidents() again --
      // a full remount would wipe this success message before it's readable.
      form.reset();
      document.getElementById('incident-offense-rows').innerHTML = '';
      document.getElementById('incident-person-rows').innerHTML = '';
      document.getElementById('incident-relationship-rows').innerHTML = '';
      document.getElementById('incident-property-rows').innerHTML = '';
      addIncidentOffenseRow();
      loadIncidentsList();
    } catch (err) {
      errorEl.textContent = formErrorMessage(err);
      errorEl.hidden = false;
    }
  });

  loadIncidentsList();
}

async function loadIncidentsList() {
  const listEl = document.getElementById('incidents-list');
  listEl.innerHTML = '<li class="hint">Loading...</li>';
  try {
    const data = await apiFetch('/api/incidents?limit=25');
    listEl.innerHTML = '';
    if (data.results.length === 0) {
      listEl.innerHTML = '<li class="hint">No incident reports match.</li>';
    }
    data.results.forEach((inc) => {
      const li = document.createElement('li');
      li.className = 'result-item';
      li.innerHTML = `<div class="r-title">${escapeHtml(inc.case_number)} — ${escapeHtml(fmtStatus(inc.status))}</div>
        <div class="r-sub">${fmtDate(inc.occurrence_date)} — ${escapeHtml(inc.location_address)}</div>`;
      li.addEventListener('click', () => renderIncidentDetail(inc.id));
      listEl.appendChild(li);
    });
  } catch (err) {
    listEl.innerHTML = `<li class="error-text">${escapeHtml(err.message)}</li>`;
  }
}

async function renderIncidentDetail(id) {
  mount('tpl-incident-detail');
  mainContent.querySelector('.back-btn').addEventListener('click', () => navigate('incidents'));
  wirePrintButton(mainContent.querySelector('.print-btn'));

  try {
    const inc = await apiFetch(`/api/incidents/${id}`);
    mainContent.querySelector('.i-case-number').textContent = inc.case_number;
    mainContent.querySelector('.i-occurrence-date').textContent = fmtDateTime(inc.occurrence_date);
    mainContent.querySelector('.i-location').textContent = inc.location_address;
    mainContent.querySelector('.i-location-type').textContent = humanize(inc.location_type);
    mainContent.querySelector('.i-status').textContent = fmtStatus(inc.status);
    mainContent.querySelector('.i-clearance').textContent = humanize(inc.exceptional_clearance);
    mainContent.querySelector('.i-narrative').textContent = inc.narrative || '—';

    const offensesEl = mainContent.querySelector('.i-offenses');
    offensesEl.innerHTML =
      inc.offenses.length === 0
        ? '<li class="hint">None.</li>'
        : inc.offenses
            .map(
              (o) =>
                `<li class="result-item"><div class="r-title">${escapeHtml(o.tibrs_offense_code)} — ${escapeHtml(
                  o.offense_description
                )}</div><div class="r-sub">${escapeHtml(o.attempted_completed)}</div></li>`
            )
            .join('');

    const personsEl = mainContent.querySelector('.i-persons');
    personsEl.innerHTML =
      inc.persons.length === 0
        ? '<li class="hint">None.</li>'
        : inc.persons
            .map(
              (p) =>
                `<li class="result-item"><div class="r-title">${escapeHtml(p.last_name)}, ${escapeHtml(
                  p.first_name
                )} (${humanize(p.role)})</div><div class="r-sub">${humanize(p.injury_type || '')}</div></li>`
            )
            .join('');

    const relEl = mainContent.querySelector('.i-relationships');
    relEl.innerHTML =
      inc.victim_offender_relationships.length === 0
        ? '<li class="hint">None.</li>'
        : inc.victim_offender_relationships
            .map(
              (r) =>
                `<li class="result-item"><div class="r-title">${escapeHtml(r.victim_first_name)} ${escapeHtml(
                  r.victim_last_name
                )} &larr; ${humanize(r.relationship)} &rarr; ${escapeHtml(r.offender_first_name)} ${escapeHtml(
                  r.offender_last_name
                )}</div></li>`
            )
            .join('');

    const propEl = mainContent.querySelector('.i-property');
    propEl.innerHTML =
      inc.property.length === 0
        ? '<li class="hint">None.</li>'
        : inc.property
            .map(
              (p) =>
                `<li class="result-item"><div class="r-title">${escapeHtml(p.property_description)}</div><div class="r-sub">${humanize(
                  p.property_category
                )} — ${humanize(p.property_loss_type)} — ${fmtMoney(p.value_amount)}</div></li>`
            )
            .join('');

    wireApprovalSection({
      record: inc,
      id,
      apiPath: 'incidents',
      badgeEl: mainContent.querySelector('.i-approval-badge'),
      detailEl: mainContent.querySelector('.i-approval-detail'),
      formEl: document.getElementById('incident-approval-form'),
      notesEl: document.getElementById('incident-approval-notes'),
      errorEl: mainContent.querySelector('.i-approval-error'),
      successEl: mainContent.querySelector('.i-approval-success'),
      onSaved: () => renderIncidentDetail(id),
    });

    const editToggle = document.getElementById('incident-edit-toggle');
    const editForm = document.getElementById('incident-edit-form');
    if (hasAnyRole('Patrol_Officer', 'Supervisor', 'System_Admin')) {
      editToggle.hidden = false;
      wireEditToggle(editToggle, editForm);

      const locSelect = document.getElementById('ie-location-type');
      locSelect.innerHTML = optionsHtml(LOCATION_TYPES);
      locSelect.value = inc.location_type || '';
      const statusSelect = document.getElementById('ie-status');
      statusSelect.innerHTML = optionsHtml(INCIDENT_STATUSES);
      statusSelect.value = inc.status || '';
      const clearanceSelect = document.getElementById('ie-clearance');
      clearanceSelect.innerHTML = optionsHtml(EXCEPTIONAL_CLEARANCE_VALUES);
      clearanceSelect.value = inc.exceptional_clearance || '';

      if (inc.occurrence_date) {
        const d = new Date(inc.occurrence_date);
        if (!Number.isNaN(d.getTime())) document.getElementById('ie-occurrence-date').value = d.toISOString().slice(0, 10);
      }
      document.getElementById('ie-location-address').value = inc.location_address || '';
      document.getElementById('ie-latitude').value = inc.latitude ?? '';
      document.getElementById('ie-longitude').value = inc.longitude ?? '';
      document.getElementById('ie-cleared-date').value = inc.cleared_date ? String(inc.cleared_date).slice(0, 10) : '';

      editForm.onsubmit = async (e) => {
        e.preventDefault();
        const errorEl = mainContent.querySelector('.ie-error');
        const successEl = mainContent.querySelector('.ie-success');
        errorEl.hidden = true;
        successEl.hidden = true;

        const val = (elId) => document.getElementById(elId).value.trim();
        const body = {};
        if (val('ie-occurrence-date')) body.occurrence_date = val('ie-occurrence-date');
        if (val('ie-location-address')) body.location_address = val('ie-location-address');
        if (val('ie-location-type')) body.location_type = val('ie-location-type');
        if (val('ie-latitude') !== '' && val('ie-longitude') !== '') {
          body.latitude = Number(val('ie-latitude'));
          body.longitude = Number(val('ie-longitude'));
        }
        if (val('ie-status')) body.status = val('ie-status');
        if (val('ie-clearance')) body.exceptional_clearance = val('ie-clearance');
        if (val('ie-cleared-date')) body.cleared_date = val('ie-cleared-date');

        try {
          await apiFetch(`/api/incidents/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
          successEl.textContent = 'Incident updated.';
          successEl.hidden = false;
          // See the identical note on the citation edit save handler --
          // renderIncidentDetail() re-mounts the view.
          setTimeout(() => renderIncidentDetail(id), 900);
        } catch (err) {
          errorEl.textContent = formErrorMessage(err);
          errorEl.hidden = false;
        }
      };
    } else {
      editToggle.hidden = true;
      editForm.hidden = true;
    }
  } catch (err) {
    mainContent.querySelector('.i-case-number').textContent = err.message;
  }
}

// ------------------------------------------------------------------
// Crashes
// ------------------------------------------------------------------

function refreshCrashPersonVehicleSelects() {
  const vehicleRows = Array.from(document.querySelectorAll('#crash-vehicle-rows .dyn-row'));
  const optsHtml =
    '<option value="">-- none / not applicable --</option>' +
    vehicleRows
      .map((row, idx) => {
        const plate = row.querySelector('.v-plate').value.trim();
        const make = row.querySelector('.v-make').value.trim();
        const model = row.querySelector('.v-model').value.trim();
        const label = `#${idx + 1} ${make} ${model} (${plate})`.trim();
        return `<option value="${row.dataset.rowId}">${escapeHtml(label)}</option>`;
      })
      .join('');
  document.querySelectorAll('#crash-person-rows .cp-vehicle').forEach((sel) => {
    const prev = sel.value;
    sel.innerHTML = optsHtml;
    if (Array.from(sel.options).some((o) => o.value === prev)) sel.value = prev;
  });
}

function addCrashVehicleRow() {
  const container = document.getElementById('crash-vehicle-rows');
  const row = makeRemovableRow(
    container,
    'vehicle-row',
    `<label>Make</label><input class="v-make" required />
     <label>Model</label><input class="v-model" required />
     <label>Year</label><input class="v-year" maxlength="4" required />
     <label>Color</label><input class="v-color" required />
     <label>Owner Name</label><input class="v-owner" required />
     <label>Plate Number</label><input class="v-plate" required />
     <label>Plate Year</label><input class="v-plate-year" maxlength="4" required />
     <label>Plate State</label><input class="v-plate-state" maxlength="2" required />
     <label>Damage Description</label><input class="v-damage-desc" />
     <label>Damage Estimate ($)</label><input class="v-damage-estimate" type="number" step="0.01" min="0" />`
  );
  ['v-plate', 'v-make', 'v-model'].forEach((cls) =>
    row.querySelector(`.${cls}`).addEventListener('input', refreshCrashPersonVehicleSelects)
  );
  row._onRemove = refreshCrashPersonVehicleSelects;
  refreshCrashPersonVehicleSelects();
}

function addCrashPersonRow() {
  const container = document.getElementById('crash-person-rows');
  makeRemovableRow(
    container,
    'person-row',
    `<label>Role</label>
     <select class="cp-role" required>${optionsHtml(CRASH_PERSON_ROLES)}</select>
     <label>First Name</label><input class="cp-first-name" />
     <label>Last Name</label><input class="cp-last-name" />
     <label>Date of Birth</label><input class="cp-dob" type="date" />
     <label>Sex</label><select class="cp-sex"><option value="">-- select --</option>${optionsHtml(PERSON_SEX_VALUES)}</select>
     <label>Race</label><select class="cp-race"><option value="">-- select --</option>${optionsHtml(PERSON_RACE_VALUES)}</select>
     <label>Injury Severity</label><select class="cp-injury">${optionsHtml(CRASH_INJURY_SEVERITIES)}</select>
     <label>Vehicle</label><select class="cp-vehicle"></select>`
  );
  refreshCrashPersonVehicleSelects();
}

function renderCrashes() {
  mount('tpl-crashes');
  const newBtn = document.getElementById('crash-new-btn');
  const form = document.getElementById('crash-form');
  newBtn.addEventListener('click', () => {
    form.hidden = !form.hidden;
  });

  document.getElementById('cr-weather').innerHTML = optionsHtml(WEATHER_CONDITIONS);
  document.getElementById('cr-road-surface').innerHTML = optionsHtml(ROAD_SURFACE_CONDITIONS);
  document.getElementById('cr-light').innerHTML = optionsHtml(LIGHT_CONDITIONS);
  document.getElementById('cr-severity').innerHTML = optionsHtml(CRASH_SEVERITIES);

  document.getElementById('crash-vehicle-rows').innerHTML = '';
  document.getElementById('crash-person-rows').innerHTML = '';
  document.getElementById('crash-add-vehicle').addEventListener('click', addCrashVehicleRow);
  document.getElementById('crash-add-person').addEventListener('click', addCrashPersonRow);
  addCrashVehicleRow();

  wireUseLocation('cr-use-location', 'cr-latitude', 'cr-longitude', 'cr-location-status');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('crash-form-error');
    const successEl = document.getElementById('crash-form-success');
    errorEl.hidden = true;
    successEl.hidden = true;

    const val = (id) => document.getElementById(id).value.trim();

    const vehicleRows = Array.from(document.querySelectorAll('#crash-vehicle-rows .dyn-row'));
    const vehicleIndexByRowId = {};
    const vehicles = vehicleRows.map((row, idx) => {
      vehicleIndexByRowId[row.dataset.rowId] = idx;
      const q = (sel) => row.querySelector(sel).value.trim();
      const vehicle = {
        make: q('.v-make'),
        model: q('.v-model'),
        year: q('.v-year'),
        color: q('.v-color'),
        owner_name: q('.v-owner'),
        plate_number: q('.v-plate'),
        plate_year: q('.v-plate-year'),
        plate_state: q('.v-plate-state').toUpperCase(),
      };
      if (q('.v-damage-desc')) vehicle.damage_description = q('.v-damage-desc');
      if (q('.v-damage-estimate') !== '') vehicle.damage_estimate = Number(q('.v-damage-estimate'));
      return vehicle;
    });

    const persons = Array.from(document.querySelectorAll('#crash-person-rows .dyn-row')).map((row) => {
      const q = (sel) => row.querySelector(sel).value.trim();
      const person = { role: q('.cp-role'), injury_severity: q('.cp-injury') };
      if (q('.cp-first-name')) person.first_name = q('.cp-first-name');
      if (q('.cp-last-name')) person.last_name = q('.cp-last-name');
      if (q('.cp-dob')) person.dob = q('.cp-dob');
      if (q('.cp-sex')) person.sex = q('.cp-sex');
      if (q('.cp-race')) person.race = q('.cp-race');
      const vehicleRowId = row.querySelector('.cp-vehicle').value;
      if (vehicleRowId !== '') person.vehicle_index = vehicleIndexByRowId[vehicleRowId];
      return person;
    });

    const payload = {
      report_number: val('cr-report-number'),
      crash_date: `${val('cr-crash-date')}T${val('cr-crash-time') || '00:00'}:00`,
      location: val('cr-location'),
      weather_condition: val('cr-weather'),
      road_surface_condition: val('cr-road-surface'),
      light_condition: val('cr-light'),
      crash_severity: val('cr-severity'),
      vehicles,
      persons,
    };
    const lat = val('cr-latitude');
    const lng = val('cr-longitude');
    if (lat !== '' && lng !== '') {
      payload.latitude = Number(lat);
      payload.longitude = Number(lng);
    }
    if (val('cr-narrative')) payload.narrative = val('cr-narrative');

    try {
      const result = await apiFetch('/api/crashes', { method: 'POST', body: JSON.stringify(payload) });
      successEl.textContent = `Crash report ${result.report_number} submitted (${result.vehicle_count} vehicle(s), ${result.person_count} person(s)).`;
      successEl.hidden = false;
      // Reset in place -- see the matching note in the incident submit handler.
      form.reset();
      document.getElementById('crash-vehicle-rows').innerHTML = '';
      document.getElementById('crash-person-rows').innerHTML = '';
      addCrashVehicleRow();
      loadCrashesList();
    } catch (err) {
      errorEl.textContent = formErrorMessage(err);
      errorEl.hidden = false;
    }
  });

  loadCrashesList();
}

async function loadCrashesList() {
  const listEl = document.getElementById('crashes-list');
  listEl.innerHTML = '<li class="hint">Loading...</li>';
  try {
    const data = await apiFetch('/api/crashes?limit=25');
    listEl.innerHTML = '';
    if (data.results.length === 0) {
      listEl.innerHTML = '<li class="hint">No crash reports match.</li>';
    }
    data.results.forEach((c) => {
      const li = document.createElement('li');
      li.className = 'result-item';
      li.innerHTML = `<div class="r-title">${escapeHtml(c.report_number)} — ${humanize(c.crash_severity)}</div>
        <div class="r-sub">${fmtDate(c.crash_date)} — ${escapeHtml(c.location)}</div>`;
      li.addEventListener('click', () => renderCrashDetail(c.id));
      listEl.appendChild(li);
    });
  } catch (err) {
    listEl.innerHTML = `<li class="error-text">${escapeHtml(err.message)}</li>`;
  }
}

async function renderCrashDetail(id) {
  mount('tpl-crash-detail');
  mainContent.querySelector('.back-btn').addEventListener('click', () => navigate('crashes'));
  wirePrintButton(mainContent.querySelector('.print-btn'));

  try {
    const c = await apiFetch(`/api/crashes/${id}`);
    mainContent.querySelector('.cr-report-number').textContent = c.report_number;
    mainContent.querySelector('.cr-crash-date').textContent = fmtDateTime(c.crash_date);
    mainContent.querySelector('.cr-location').textContent = c.location;
    mainContent.querySelector('.cr-severity').textContent = humanize(c.crash_severity);
    mainContent.querySelector('.cr-weather').textContent = humanize(c.weather_condition);
    mainContent.querySelector('.cr-road-surface').textContent = humanize(c.road_surface_condition);
    mainContent.querySelector('.cr-light').textContent = humanize(c.light_condition);
    mainContent.querySelector('.cr-officer').textContent = `${c.officer_name} (#${c.officer_badge})`;
    mainContent.querySelector('.cr-narrative').textContent = c.narrative || '—';

    const vehiclesEl = mainContent.querySelector('.cr-vehicles');
    vehiclesEl.innerHTML =
      c.vehicles.length === 0
        ? '<li class="hint">None.</li>'
        : c.vehicles
            .map(
              (v) =>
                `<li class="result-item"><div class="r-title">${escapeHtml(v.plate_number)} (${escapeHtml(
                  v.plate_state
                )}) — ${escapeHtml(v.year || '')} ${escapeHtml(v.make)} ${escapeHtml(v.model)}</div><div class="r-sub">${escapeHtml(
                  v.damage_description || ''
                )} ${v.damage_estimate ? fmtMoney(v.damage_estimate) : ''}</div></li>`
            )
            .join('');

    const personsEl = mainContent.querySelector('.cr-persons');
    personsEl.innerHTML =
      c.persons.length === 0
        ? '<li class="hint">None.</li>'
        : c.persons
            .map(
              (p) =>
                `<li class="result-item"><div class="r-title">${escapeHtml(p.last_name)}, ${escapeHtml(
                  p.first_name
                )} (${humanize(p.role)})</div><div class="r-sub">${humanize(p.injury_severity)}</div></li>`
            )
            .join('');

    wireApprovalSection({
      record: c,
      id,
      apiPath: 'crashes',
      badgeEl: mainContent.querySelector('.cr-approval-badge'),
      detailEl: mainContent.querySelector('.cr-approval-detail'),
      formEl: document.getElementById('crash-approval-form'),
      notesEl: document.getElementById('crash-approval-notes'),
      errorEl: mainContent.querySelector('.cr-approval-error'),
      successEl: mainContent.querySelector('.cr-approval-success'),
      onSaved: () => renderCrashDetail(id),
    });

    const editToggle = document.getElementById('crash-edit-toggle');
    const editForm = document.getElementById('crash-edit-form');
    if (hasAnyRole('Patrol_Officer', 'Supervisor', 'System_Admin')) {
      editToggle.hidden = false;
      wireEditToggle(editToggle, editForm);

      document.getElementById('cre-weather').innerHTML = optionsHtml(WEATHER_CONDITIONS);
      document.getElementById('cre-road-surface').innerHTML = optionsHtml(ROAD_SURFACE_CONDITIONS);
      document.getElementById('cre-light').innerHTML = optionsHtml(LIGHT_CONDITIONS);
      document.getElementById('cre-severity').innerHTML = optionsHtml(CRASH_SEVERITIES);
      document.getElementById('cre-weather').value = c.weather_condition || '';
      document.getElementById('cre-road-surface').value = c.road_surface_condition || '';
      document.getElementById('cre-light').value = c.light_condition || '';
      document.getElementById('cre-severity').value = c.crash_severity || '';

      if (c.crash_date) {
        const d = new Date(c.crash_date);
        if (!Number.isNaN(d.getTime())) document.getElementById('cre-crash-date').value = d.toISOString().slice(0, 10);
      }
      document.getElementById('cre-location').value = c.location || '';
      document.getElementById('cre-latitude').value = c.latitude ?? '';
      document.getElementById('cre-longitude').value = c.longitude ?? '';
      document.getElementById('cre-narrative').value = c.narrative || '';

      editForm.onsubmit = async (e) => {
        e.preventDefault();
        const errorEl = mainContent.querySelector('.cre-error');
        const successEl = mainContent.querySelector('.cre-success');
        errorEl.hidden = true;
        successEl.hidden = true;

        const val = (elId) => document.getElementById(elId).value.trim();
        const body = {};
        if (val('cre-crash-date')) body.crash_date = val('cre-crash-date');
        if (val('cre-location')) body.location = val('cre-location');
        if (val('cre-latitude') !== '' && val('cre-longitude') !== '') {
          body.latitude = Number(val('cre-latitude'));
          body.longitude = Number(val('cre-longitude'));
        }
        if (val('cre-weather')) body.weather_condition = val('cre-weather');
        if (val('cre-road-surface')) body.road_surface_condition = val('cre-road-surface');
        if (val('cre-light')) body.light_condition = val('cre-light');
        if (val('cre-severity')) body.crash_severity = val('cre-severity');
        if (val('cre-narrative')) body.narrative = val('cre-narrative');

        try {
          await apiFetch(`/api/crashes/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
          successEl.textContent = 'Crash report updated.';
          successEl.hidden = false;
          // See the identical note on the citation edit save handler --
          // renderCrashDetail() re-mounts the view.
          setTimeout(() => renderCrashDetail(id), 900);
        } catch (err) {
          errorEl.textContent = formErrorMessage(err);
          errorEl.hidden = false;
        }
      };
    } else {
      editToggle.hidden = true;
      editForm.hidden = true;
    }
  } catch (err) {
    mainContent.querySelector('.cr-report-number').textContent = err.message;
  }
}

// ------------------------------------------------------------------
// Evidence
// ------------------------------------------------------------------

let evidenceLinkedCase = null; // { type: 'incidents'|'crashes', id }

function renderEvidence() {
  mount('tpl-evidence');
  evidenceLinkedCase = null;

  const newBtn = document.getElementById('evidence-new-btn');
  const form = document.getElementById('evidence-form');
  newBtn.addEventListener('click', () => {
    form.hidden = !form.hidden;
  });

  document.getElementById('ev-category').innerHTML = optionsHtml(EVIDENCE_CATEGORIES);

  const findBtn = document.getElementById('ev-find-case');
  const caseStatus = document.getElementById('ev-case-status');
  const caseResults = document.getElementById('ev-case-results');
  findBtn.addEventListener('click', async () => {
    const caseType = document.getElementById('ev-case-type').value;
    const caseNumber = document.getElementById('ev-case-number').value.trim();
    if (!caseNumber) {
      caseStatus.textContent = 'Enter a case/report number first.';
      return;
    }
    caseStatus.textContent = 'Searching...';
    caseResults.innerHTML = '';
    try {
      const data = await apiFetch(`/api/${caseType}?q=${encodeURIComponent(caseNumber)}&limit=5`);
      if (data.results.length === 0) {
        caseStatus.textContent = 'No matching case found.';
        return;
      }
      caseStatus.textContent = `${data.results.length} match(es) — select one:`;
      data.results.forEach((row) => {
        const li = document.createElement('li');
        li.className = 'result-item';
        const number = caseType === 'incidents' ? row.case_number : row.report_number;
        li.innerHTML = `<div class="r-title">${escapeHtml(number)}</div><div class="r-sub">${escapeHtml(
          row.location || row.location_address || ''
        )}</div>`;
        li.addEventListener('click', () => {
          evidenceLinkedCase = { type: caseType, id: row.id };
          caseStatus.textContent = `Linked to ${caseType === 'incidents' ? 'incident' : 'crash'} ${number}.`;
          caseResults.innerHTML = '';
        });
        caseResults.appendChild(li);
      });
    } catch (err) {
      caseStatus.textContent = err.message;
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('evidence-form-error');
    const successEl = document.getElementById('evidence-form-success');
    errorEl.hidden = true;
    successEl.hidden = true;

    if (!evidenceLinkedCase) {
      errorEl.textContent = 'Find and select the case this evidence belongs to first.';
      errorEl.hidden = false;
      return;
    }

    const val = (id) => document.getElementById(id).value.trim();
    const payload = {
      item_number: val('ev-item-number'),
      category: val('ev-category'),
      description: val('ev-description'),
      quantity: Number(val('ev-quantity') || '1'),
      date_collected: val('ev-date-collected'),
    };
    if (val('ev-location-collected')) payload.location_collected = val('ev-location-collected');
    if (val('ev-storage-location')) payload.storage_location = val('ev-storage-location');
    if (evidenceLinkedCase.type === 'incidents') payload.incident_id = evidenceLinkedCase.id;
    else payload.crash_report_id = evidenceLinkedCase.id;

    try {
      const result = await apiFetch('/api/evidence', { method: 'POST', body: JSON.stringify(payload) });
      successEl.textContent = `Evidence item ${result.item_number} logged.`;
      successEl.hidden = false;
      // Reset in place -- see the matching note in the incident submit handler.
      form.reset();
      evidenceLinkedCase = null;
      caseStatus.textContent = '';
      caseResults.innerHTML = '';
      loadEvidenceList();
    } catch (err) {
      errorEl.textContent = formErrorMessage(err);
      errorEl.hidden = false;
    }
  });

  loadEvidenceList();
}

async function loadEvidenceList() {
  const listEl = document.getElementById('evidence-list');
  listEl.innerHTML = '<li class="hint">Loading...</li>';
  try {
    const data = await apiFetch('/api/evidence?limit=25');
    listEl.innerHTML = '';
    if (data.results.length === 0) {
      listEl.innerHTML = '<li class="hint">No evidence items on file.</li>';
    }
    data.results.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'result-item';
      li.innerHTML = `<div class="r-title">${escapeHtml(item.item_number)} — ${humanize(item.category)}</div>
        <div class="r-sub">${fmtStatus(item.status)} — ${escapeHtml(item.description)}</div>`;
      li.addEventListener('click', () => renderEvidenceDetail(item.id));
      listEl.appendChild(li);
    });
  } catch (err) {
    listEl.innerHTML = `<li class="error-text">${escapeHtml(err.message)}</li>`;
  }
}

async function renderEvidenceDetail(id) {
  mount('tpl-evidence-detail');
  mainContent.querySelector('.back-btn').addEventListener('click', () => navigate('evidence'));
  wirePrintButton(mainContent.querySelector('.print-btn'));

  document.getElementById('ev-status-select').innerHTML = optionsHtml(EVIDENCE_STATUSES);
  document.getElementById('cu-action').innerHTML = optionsHtml(EVIDENCE_CUSTODY_ACTIONS);
  document.getElementById('eve-category').innerHTML = optionsHtml(EVIDENCE_CATEGORIES);

  async function loadDetail() {
    const item = await apiFetch(`/api/evidence/${id}`);
    mainContent.querySelector('.ev-item-number').textContent = item.item_number;
    mainContent.querySelector('.ev-category').textContent = humanize(item.category);
    mainContent.querySelector('.ev-description').textContent = item.description;
    mainContent.querySelector('.ev-quantity').textContent = item.quantity;
    mainContent.querySelector('.ev-status').textContent = fmtStatus(item.status);
    mainContent.querySelector('.ev-date-collected').textContent = fmtDate(item.date_collected);
    mainContent.querySelector('.ev-location-collected').textContent = item.location_collected || '—';
    mainContent.querySelector('.ev-storage-location').textContent = item.storage_location || '—';
    mainContent.querySelector('.ev-linked-case').textContent = item.incident_case_number
      ? `Incident ${item.incident_case_number}`
      : item.crash_report_number
      ? `Crash ${item.crash_report_number}`
      : '—';
    mainContent.querySelector('.ev-collected-by').textContent = `${item.collected_by_name} (#${item.collected_by_badge})`;

    document.getElementById('ev-status-select').value = item.status;
    document.getElementById('ev-disposition-notes').value = item.disposition_notes || '';

    const custodyEl = mainContent.querySelector('.ev-custody-log');
    custodyEl.innerHTML = item.custody_log
      .map(
        (c) =>
          `<li class="result-item"><div class="r-title">${humanize(c.action)}</div><div class="r-sub">${escapeHtml(
            c.from_custodian || ''
          )} ${c.from_custodian && c.to_custodian ? '&rarr;' : ''} ${escapeHtml(c.to_custodian || '')} — ${fmtDateTime(
            c.performed_at
          )} by ${escapeHtml(c.performed_by_name)}${c.notes ? ' — ' + escapeHtml(c.notes) : ''}</div></li>`
      )
      .join('');

    wireApprovalSection({
      record: item,
      id,
      apiPath: 'evidence',
      badgeEl: mainContent.querySelector('.ev-approval-badge'),
      detailEl: mainContent.querySelector('.ev-approval-detail'),
      formEl: document.getElementById('evidence-approval-form'),
      notesEl: document.getElementById('evidence-approval-notes'),
      errorEl: mainContent.querySelector('.ev-approval-error'),
      successEl: mainContent.querySelector('.ev-approval-success'),
      onSaved: loadDetail,
    });

    const editToggle = document.getElementById('evidence-edit-toggle');
    const editForm = document.getElementById('evidence-edit-form');
    if (hasAnyRole('Patrol_Officer', 'Supervisor', 'System_Admin')) {
      editToggle.hidden = false;
      wireEditToggle(editToggle, editForm);
      document.getElementById('eve-category').value = item.category || '';
      document.getElementById('eve-description').value = item.description || '';
      document.getElementById('eve-quantity').value = item.quantity ?? '';
      document.getElementById('eve-location-collected').value = item.location_collected || '';
      document.getElementById('eve-date-collected').value = item.date_collected ? String(item.date_collected).slice(0, 10) : '';

      editForm.onsubmit = async (e) => {
        e.preventDefault();
        const errorEl = mainContent.querySelector('.eve-error');
        const successEl = mainContent.querySelector('.eve-success');
        errorEl.hidden = true;
        successEl.hidden = true;

        const val = (elId) => document.getElementById(elId).value.trim();
        const body = {};
        if (val('eve-category')) body.category = val('eve-category');
        if (val('eve-description')) body.description = val('eve-description');
        if (val('eve-quantity') !== '') body.quantity = Number(val('eve-quantity'));
        if (val('eve-location-collected')) body.location_collected = val('eve-location-collected');
        if (val('eve-date-collected')) body.date_collected = val('eve-date-collected');

        try {
          await apiFetch(`/api/evidence/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
          successEl.textContent = 'Evidence item updated.';
          successEl.hidden = false;
          await loadDetail();
        } catch (err) {
          errorEl.textContent = formErrorMessage(err);
          errorEl.hidden = false;
        }
      };
    } else {
      editToggle.hidden = true;
      editForm.hidden = true;
    }

    return item;
  }

  try {
    await loadDetail();
  } catch (err) {
    mainContent.querySelector('.ev-item-number').textContent = err.message;
    return;
  }

  document.getElementById('evidence-status-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = mainContent.querySelector('.ev-status-error');
    const successEl = mainContent.querySelector('.ev-status-success');
    errorEl.hidden = true;
    successEl.hidden = true;
    try {
      await apiFetch(`/api/evidence/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: document.getElementById('ev-status-select').value,
          disposition_notes: document.getElementById('ev-disposition-notes').value.trim() || undefined,
        }),
      });
      successEl.textContent = 'Status updated.';
      successEl.hidden = false;
      await loadDetail();
    } catch (err) {
      errorEl.textContent = formErrorMessage(err);
      errorEl.hidden = false;
    }
  });

  document.getElementById('custody-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = mainContent.querySelector('.cu-error');
    const successEl = mainContent.querySelector('.cu-success');
    errorEl.hidden = true;
    successEl.hidden = true;
    try {
      await apiFetch(`/api/evidence/${id}/custody`, {
        method: 'POST',
        body: JSON.stringify({
          action: document.getElementById('cu-action').value,
          from_custodian: document.getElementById('cu-from').value.trim() || undefined,
          to_custodian: document.getElementById('cu-to').value.trim() || undefined,
          notes: document.getElementById('cu-notes').value.trim() || undefined,
        }),
      });
      successEl.textContent = 'Custody entry added.';
      successEl.hidden = false;
      document.getElementById('custody-form').reset();
      await loadDetail();
    } catch (err) {
      errorEl.textContent = formErrorMessage(err);
      errorEl.hidden = false;
    }
  });
}

// ------------------------------------------------------------------
// Cases (Court Case Management -- db/migrations/011_..._court_case_management.sql)
// ------------------------------------------------------------------

let caseLinkedCitation = null; // { id, citation_number } -- set via the citation-find widget below
let casesOffset = 0;
const CASES_PAGE_SIZE = 20;

const CHARGE_CATEGORIES = ['TCA_Traffic', 'Municipal_Ordinance', 'Other'];
const PLEA_TYPES = ['Not_Entered', 'Guilty', 'Not_Guilty', 'No_Contest'];
const CASE_DISPOSITION_STATUSES = ['Pending', 'Guilty', 'Not_Guilty', 'Dismissed', 'FTA_Failure_To_Appear', 'Continued'];

function addCaseChargeRow() {
  const container = document.getElementById('case-charge-rows');
  makeRemovableRow(
    container,
    'charge-row',
    `<label>Category</label>
     <select class="chg-category">${optionsHtml(CHARGE_CATEGORIES)}</select>
     <label>Charge Code</label>
     <input class="chg-code" required />
     <label>Description</label>
     <input class="chg-description" required />
     <label>Fine Amount ($)</label>
     <input class="chg-fine" type="number" step="0.01" min="0" />
     <label>Court Costs ($)</label>
     <input class="chg-costs" type="number" step="0.01" min="0" />`
  );
}

function renderCases() {
  mount('tpl-cases');
  casesOffset = 0;
  caseLinkedCitation = null;

  const newBtn = document.getElementById('case-new-btn');
  const form = document.getElementById('case-form');
  newBtn.addEventListener('click', () => {
    form.hidden = !form.hidden;
  });

  document.getElementById('case-charge-rows').innerHTML = '';
  document.getElementById('case-add-charge').addEventListener('click', addCaseChargeRow);
  addCaseChargeRow();

  const caseTypeSelect = document.getElementById('case-type');
  const citationFieldset = document.getElementById('case-citation-fieldset');
  const defendantFieldset = document.getElementById('case-defendant-fieldset');

  function syncCaseTypeFieldsets() {
    const isTraffic = caseTypeSelect.value === 'Traffic_Citation';
    citationFieldset.hidden = !isTraffic;
    defendantFieldset.hidden = isTraffic;
    if (!isTraffic) {
      caseLinkedCitation = null;
      document.getElementById('case-citation-status').textContent = '';
      document.getElementById('case-citation-results').innerHTML = '';
    }
  }
  caseTypeSelect.addEventListener('change', syncCaseTypeFieldsets);
  syncCaseTypeFieldsets();

  const findBtn = document.getElementById('case-find-citation');
  const citationStatus = document.getElementById('case-citation-status');
  const citationResults = document.getElementById('case-citation-results');
  findBtn.addEventListener('click', async () => {
    const term = document.getElementById('case-citation-search').value.trim();
    if (!term) {
      citationStatus.textContent = 'Enter a citation number or violator name first.';
      return;
    }
    citationStatus.textContent = 'Searching...';
    citationResults.innerHTML = '';
    try {
      const data = await apiFetch(`/api/citations?q=${encodeURIComponent(term)}&limit=5`);
      if (data.results.length === 0) {
        citationStatus.textContent = 'No matching citation found.';
        return;
      }
      citationStatus.textContent = `${data.results.length} match(es) — select one:`;
      data.results.forEach((c) => {
        const li = document.createElement('li');
        li.className = 'result-item';
        li.innerHTML = `<div class="r-title">${escapeHtml(c.citation_number)}</div><div class="r-sub">${escapeHtml(
          c.violator_last_name
        )}, ${escapeHtml(c.violator_first_name)} — ${fmtDate(c.offense_date)}</div>`;
        li.addEventListener('click', () => {
          caseLinkedCitation = { id: c.id, citation_number: c.citation_number };
          citationStatus.textContent = `Linked to citation ${c.citation_number}.`;
          citationResults.innerHTML = '';
        });
        citationResults.appendChild(li);
      });
    } catch (err) {
      citationStatus.textContent = err.message;
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('case-form-error');
    const successEl = document.getElementById('case-form-success');
    errorEl.hidden = true;
    successEl.hidden = true;

    const val = (id) => document.getElementById(id).value.trim();
    const caseType = caseTypeSelect.value;

    const charges = Array.from(document.querySelectorAll('#case-charge-rows .dyn-row')).map((row) => {
      const q = (sel) => row.querySelector(sel).value.trim();
      const charge = {
        charge_category: row.querySelector('.chg-category').value,
        charge_code: q('.chg-code'),
        charge_description: q('.chg-description'),
      };
      if (q('.chg-fine') !== '') charge.fine_amount = Number(q('.chg-fine'));
      if (q('.chg-costs') !== '') charge.court_costs = Number(q('.chg-costs'));
      return charge;
    });

    const payload = { case_type: caseType, charges };
    if (val('case-intake-summary')) payload.intake_summary = val('case-intake-summary');

    if (caseType === 'Traffic_Citation') {
      if (!caseLinkedCitation) {
        errorEl.textContent = 'Find and select the citation this case is for first.';
        errorEl.hidden = false;
        return;
      }
      payload.citation_id = caseLinkedCitation.id;
    } else {
      const defendant = { first_name: val('cd-first-name'), last_name: val('cd-last-name') };
      if (val('cd-dob')) defendant.dob = val('cd-dob');
      if (val('cd-dl-number')) defendant.drivers_license_num = val('cd-dl-number');
      if (val('cd-dl-state')) defendant.dl_state = val('cd-dl-state');
      if (val('cd-phone')) defendant.phone = val('cd-phone');
      if (val('cd-address')) defendant.address = val('cd-address');
      payload.defendant = defendant;
    }

    try {
      const result = await apiFetch('/api/cases', { method: 'POST', body: JSON.stringify(payload) });
      successEl.textContent = `Case ${result.case_number} opened.`;
      successEl.hidden = false;
      form.reset();
      document.getElementById('case-charge-rows').innerHTML = '';
      addCaseChargeRow();
      caseLinkedCitation = null;
      citationStatus.textContent = '';
      citationResults.innerHTML = '';
      syncCaseTypeFieldsets();
      loadCasesPage();
    } catch (err) {
      errorEl.textContent = formErrorMessage(err);
      errorEl.hidden = false;
    }
  });

  document.getElementById('case-filter-status').addEventListener('change', () => {
    casesOffset = 0;
    loadCasesPage();
  });
  document.getElementById('case-filter-type').addEventListener('change', () => {
    casesOffset = 0;
    loadCasesPage();
  });
  let caseSearchDebounce;
  document.getElementById('case-filter-q').addEventListener('input', () => {
    clearTimeout(caseSearchDebounce);
    caseSearchDebounce = setTimeout(() => {
      casesOffset = 0;
      loadCasesPage();
    }, 300);
  });
  document.getElementById('cases-prev').addEventListener('click', () => {
    casesOffset = Math.max(0, casesOffset - CASES_PAGE_SIZE);
    loadCasesPage();
  });
  document.getElementById('cases-next').addEventListener('click', () => {
    casesOffset += CASES_PAGE_SIZE;
    loadCasesPage();
  });

  loadCasesPage();
}

async function loadCasesPage() {
  const listEl = document.getElementById('cases-list');
  const pageInfo = document.getElementById('cases-page-info');
  const status = document.getElementById('case-filter-status').value;
  const caseType = document.getElementById('case-filter-type').value;
  const q = document.getElementById('case-filter-q').value.trim();

  const params = new URLSearchParams({ limit: String(CASES_PAGE_SIZE), offset: String(casesOffset) });
  if (status) params.set('case_status', status);
  if (caseType) params.set('case_type', caseType);
  if (q) params.set('q', q);

  listEl.innerHTML = '<li class="hint">Loading...</li>';
  try {
    const data = await apiFetch(`/api/cases?${params.toString()}`);
    listEl.innerHTML = '';
    if (data.results.length === 0) {
      listEl.innerHTML = '<li class="hint">No cases match.</li>';
    }
    data.results.forEach((c) => {
      const li = document.createElement('li');
      li.className = 'result-item';
      const defendantName = `${c.defendant_last_name}, ${c.defendant_first_name}`;
      const sub = c.citation_number
        ? `${escapeHtml(defendantName)} — Citation ${escapeHtml(c.citation_number)} — ${fmtStatus(c.case_status)}`
        : `${escapeHtml(defendantName)} — ${humanize(c.case_type)} — ${fmtStatus(c.case_status)}`;
      li.innerHTML = `<div class="r-title">${escapeHtml(c.case_number)}</div><div class="r-sub">${sub}</div>`;
      li.addEventListener('click', () => renderCaseDetail(c.id));
      listEl.appendChild(li);
    });
    const start = data.total === 0 ? 0 : casesOffset + 1;
    const end = Math.min(casesOffset + CASES_PAGE_SIZE, data.total);
    pageInfo.textContent = `${start}-${end} of ${data.total}`;
  } catch (err) {
    listEl.innerHTML = `<li class="hint">${escapeHtml(err.message)}</li>`;
  }
}

function renderCaseCharges(container, charges, caseId) {
  container.innerHTML = charges
    .map(
      (ch) => `
    <div class="dyn-row charge-card" data-charge-id="${ch.id}">
      <div class="r-title">${escapeHtml(ch.charge_code)} — ${escapeHtml(ch.charge_description)}</div>
      <div class="r-sub">${humanize(ch.charge_category)} — Count ${ch.count_number}</div>
      <label>Plea</label>
      <select class="chg-plea">${optionsHtml(PLEA_TYPES)}</select>
      <label>Disposition</label>
      <select class="chg-disposition">${optionsHtml(CASE_DISPOSITION_STATUSES)}</select>
      <label>Fine Amount ($)</label>
      <input class="chg-fine" type="number" step="0.01" min="0" />
      <label>Court Costs ($)</label>
      <input class="chg-costs" type="number" step="0.01" min="0" />
      <button type="button" class="btn btn-secondary chg-save">Save Charge</button>
      <p class="chg-error error-text" hidden></p>
      <p class="chg-success success-text" hidden></p>
    </div>`
    )
    .join('');

  charges.forEach((ch) => {
    const card = container.querySelector(`[data-charge-id="${ch.id}"]`);
    card.querySelector('.chg-plea').value = ch.plea;
    card.querySelector('.chg-disposition').value = ch.disposition;
    card.querySelector('.chg-fine').value = ch.fine_amount ?? '';
    card.querySelector('.chg-costs').value = ch.court_costs ?? '';

    card.querySelector('.chg-save').onclick = async () => {
      const errorEl = card.querySelector('.chg-error');
      const successEl = card.querySelector('.chg-success');
      errorEl.hidden = true;
      successEl.hidden = true;

      const body = {
        plea: card.querySelector('.chg-plea').value,
        disposition: card.querySelector('.chg-disposition').value,
      };
      const fine = card.querySelector('.chg-fine').value;
      const costs = card.querySelector('.chg-costs').value;
      if (fine !== '') body.fine_amount = Number(fine);
      if (costs !== '') body.court_costs = Number(costs);

      try {
        await apiFetch(`/api/cases/${caseId}/charges/${ch.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        successEl.textContent = 'Saved.';
        successEl.hidden = false;
      } catch (err) {
        errorEl.textContent = formErrorMessage(err);
        errorEl.hidden = false;
      }
    };
  });
}

async function renderCaseDetail(id) {
  mount('tpl-case-detail');
  mainContent.querySelector('.back-btn').addEventListener('click', () => navigate('cases'));
  wirePrintButton(mainContent.querySelector('.print-btn'));

  document.getElementById('cac-category').innerHTML = optionsHtml(CHARGE_CATEGORIES);

  async function loadDetail() {
    const courtCase = await apiFetch(`/api/cases/${id}`);

    mainContent.querySelector('.cs-case-number').textContent = courtCase.case_number;
    mainContent.querySelector('.cs-case-type').textContent = humanize(courtCase.case_type);
    mainContent.querySelector('.cs-status').textContent = fmtStatus(courtCase.case_status);
    mainContent.querySelector('.cs-defendant').textContent = `${courtCase.defendant_last_name}, ${courtCase.defendant_first_name}${
      courtCase.defendant_dob ? ' (DOB ' + fmtDateOnly(courtCase.defendant_dob) + ')' : ''
    }`;
    mainContent.querySelector('.cs-citation').textContent = courtCase.citation_number || '—';
    mainContent.querySelector('.cs-opened').textContent = fmtDateTime(courtCase.opened_at);
    mainContent.querySelector('.cs-closed').textContent = courtCase.closed_at ? fmtDateTime(courtCase.closed_at) : '—';
    mainContent.querySelector('.cs-filed-by').textContent = courtCase.filed_by_badge ? `Badge #${courtCase.filed_by_badge}` : '—';
    mainContent.querySelector('.cs-intake-summary').textContent = courtCase.intake_summary || '';

    document.getElementById('case-status-select').value = courtCase.case_status;

    renderCaseCharges(mainContent.querySelector('.cs-charges'), courtCase.charges, id);

    const notesEl = mainContent.querySelector('.cs-notes');
    notesEl.innerHTML =
      courtCase.notes.length === 0
        ? '<li class="hint">None.</li>'
        : courtCase.notes
            .map(
              (n) =>
                `<li class="result-item"><div class="r-title">${fmtDateTime(n.created_at)}${
                  n.author_badge ? ' — Badge #' + escapeHtml(String(n.author_badge)) : ''
                }</div><div class="r-sub">${escapeHtml(n.note_text)}</div></li>`
            )
            .join('');

    document.getElementById('case-status-form').onsubmit = async (e) => {
      e.preventDefault();
      const errorEl = mainContent.querySelector('.case-status-error');
      const successEl = mainContent.querySelector('.case-status-success');
      errorEl.hidden = true;
      successEl.hidden = true;
      try {
        await apiFetch(`/api/cases/${id}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ case_status: document.getElementById('case-status-select').value }),
        });
        successEl.textContent = 'Status updated.';
        successEl.hidden = false;
        await loadDetail();
      } catch (err) {
        errorEl.textContent = formErrorMessage(err);
        errorEl.hidden = false;
      }
    };

    document.getElementById('case-add-charge-form').onsubmit = async (e) => {
      e.preventDefault();
      const errorEl = mainContent.querySelector('.cac-error');
      const successEl = mainContent.querySelector('.cac-success');
      errorEl.hidden = true;
      successEl.hidden = true;

      const val = (elId) => document.getElementById(elId).value.trim();
      const body = {
        charge_category: document.getElementById('cac-category').value,
        charge_code: val('cac-code'),
        charge_description: val('cac-description'),
      };
      if (val('cac-fine') !== '') body.fine_amount = Number(val('cac-fine'));
      if (val('cac-costs') !== '') body.court_costs = Number(val('cac-costs'));

      try {
        await apiFetch(`/api/cases/${id}/charges`, { method: 'POST', body: JSON.stringify(body) });
        successEl.textContent = 'Charge added.';
        successEl.hidden = false;
        document.getElementById('case-add-charge-form').reset();
        await loadDetail();
      } catch (err) {
        errorEl.textContent = formErrorMessage(err);
        errorEl.hidden = false;
      }
    };

    document.getElementById('case-add-note-form').onsubmit = async (e) => {
      e.preventDefault();
      const errorEl = mainContent.querySelector('.can-error');
      const successEl = mainContent.querySelector('.can-success');
      errorEl.hidden = true;
      successEl.hidden = true;
      const noteText = document.getElementById('case-note-text').value.trim();
      if (!noteText) {
        errorEl.textContent = 'Enter note text first.';
        errorEl.hidden = false;
        return;
      }
      try {
        await apiFetch(`/api/cases/${id}/notes`, { method: 'POST', body: JSON.stringify({ note_text: noteText }) });
        successEl.textContent = 'Note added.';
        successEl.hidden = false;
        document.getElementById('case-note-text').value = '';
        await loadDetail();
      } catch (err) {
        errorEl.textContent = formErrorMessage(err);
        errorEl.hidden = false;
      }
    };

    return courtCase;
  }

  try {
    await loadDetail();
  } catch (err) {
    mainContent.querySelector('.cs-case-number').textContent = err.message;
  }
}

// ------------------------------------------------------------------
// Court Admin (Dashboard / Docket / Judges / Payments / Reminders --
// db/migrations/011_..._court_case_management.sql)
// ------------------------------------------------------------------

let courtScope = 'dashboard';
let selectedDocketId = null;
let selectedJudgeId = null;
let pmSelectedCase = null; // { id, case_number } -- payment-form's linked case
let rmSelectedCase = null; // reminder-form's linked case
let ddSelectedCase = null; // docket-detail's "add this case to the docket" selection

/**
 * Reusable find-a-case-by-number-or-defendant-name widget -- same
 * find-and-select pattern as the citation linker in renderCases() and the
 * Evidence tab's case linker (both apiFetch a q= search, render results as
 * clickable .result-item rows, and hand the chosen row to a callback).
 * Shared here across the docket-entry, payment, and reminder forms so that
 * pattern isn't triplicated.
 */
function wireCaseLookup(searchInputId, findBtnId, statusId, resultsId, onSelect) {
  const findBtn = document.getElementById(findBtnId);
  const statusEl = document.getElementById(statusId);
  const resultsEl = document.getElementById(resultsId);
  findBtn.onclick = async () => {
    const term = document.getElementById(searchInputId).value.trim();
    if (!term) {
      statusEl.textContent = 'Enter a case number or defendant name first.';
      return;
    }
    statusEl.textContent = 'Searching...';
    resultsEl.innerHTML = '';
    try {
      const data = await apiFetch(`/api/cases?q=${encodeURIComponent(term)}&limit=5`);
      if (data.results.length === 0) {
        statusEl.textContent = 'No matching case found.';
        return;
      }
      statusEl.textContent = `${data.results.length} match(es) — select one:`;
      data.results.forEach((c) => {
        const li = document.createElement('li');
        li.className = 'result-item';
        li.innerHTML = `<div class="r-title">${escapeHtml(c.case_number)}</div><div class="r-sub">${escapeHtml(
          c.defendant_last_name
        )}, ${escapeHtml(c.defendant_first_name)}</div>`;
        li.addEventListener('click', () => {
          onSelect(c);
          statusEl.textContent = `Selected case ${c.case_number}.`;
          resultsEl.innerHTML = '';
        });
        resultsEl.appendChild(li);
      });
    } catch (err) {
      statusEl.textContent = err.message;
    }
  };
}

function renderCourtAdmin() {
  mount('tpl-court-admin');
  courtScope = 'dashboard';

  const scopeButtons = mainContent.querySelectorAll('.scope-btn');
  const panels = mainContent.querySelectorAll('.court-scope-panel');
  scopeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      courtScope = btn.dataset.courtScope;
      scopeButtons.forEach((b) => b.classList.toggle('active', b === btn));
      panels.forEach((p) => {
        p.hidden = p.dataset.courtPanel !== courtScope;
      });
      loadCourtScope(courtScope);
    });
  });

  // Payment recording is Court_Clerk/System_Admin ONLY -- court_payments
  // FORCE ROW LEVEL SECURITY with payments_write_clerk_admin_only permits
  // INSERT for only those two roles (migration 011), NOT Supervisor. Hiding
  // the button here for a Supervisor viewer avoids a confusing 403 from a
  // button that looked like it should work.
  document.getElementById('payment-new-btn').hidden = !hasAnyRole('Court_Clerk', 'System_Admin');

  wireDocketPanel();
  wireJudgesPanel();
  wirePaymentsPanel();
  wireRemindersPanel();

  loadCourtScope('dashboard');
}

function loadCourtScope(scope) {
  if (scope === 'dashboard') loadCourtDashboard();
  else if (scope === 'docket') loadDocketsList();
  else if (scope === 'judges') loadJudgesList();
  else if (scope === 'payments') loadPaymentsList();
  else if (scope === 'reminders') loadRemindersList();
}

async function loadCourtDashboard() {
  const listEl = document.getElementById('court-dashboard-list');
  listEl.innerHTML = '<li class="hint">Loading...</li>';
  try {
    const data = await apiFetch('/api/dashboard/upcoming-appearances?days_ahead=14');
    listEl.innerHTML = '';
    if (data.results.length === 0) {
      listEl.innerHTML = '<li class="hint">Nothing scheduled in the next 14 days.</li>';
    }
    data.results.forEach((r) => {
      const li = document.createElement('li');
      li.className = 'result-item';
      li.innerHTML = `<div class="r-title">${fmtDateOnly(r.docket_date)}${
        r.docket_time ? ' ' + fmtTimeOnly(r.docket_time) : ''
      } — ${escapeHtml(r.case_number)}</div><div class="r-sub">${escapeHtml(r.defendant_last_name)}, ${escapeHtml(
        r.defendant_first_name
      )} — ${r.judge_name ? escapeHtml(r.judge_name) : 'No judge assigned'}${
        r.location ? ' — ' + escapeHtml(r.location) : ''
      }</div>`;
      li.addEventListener('click', () => renderCaseDetail(r.case_id));
      listEl.appendChild(li);
    });
  } catch (err) {
    listEl.innerHTML = `<li class="hint">${escapeHtml(err.message)}</li>`;
  }
}

// ---------------- Docket ----------------

function wireDocketPanel() {
  const newBtn = document.getElementById('docket-new-btn');
  const form = document.getElementById('docket-form');
  newBtn.onclick = () => {
    form.hidden = !form.hidden;
  };

  document.getElementById('docket-filter-date-from').onchange = loadDocketsList;
  document.getElementById('docket-filter-date-to').onchange = loadDocketsList;
  document.getElementById('docket-filter-status').onchange = loadDocketsList;

  form.onsubmit = async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('docket-form-error');
    const successEl = document.getElementById('docket-form-success');
    errorEl.hidden = true;
    successEl.hidden = true;

    const val = (id) => document.getElementById(id).value.trim();
    const body = { docket_date: val('dk-date'), docket_type: document.getElementById('dk-type').value };
    if (val('dk-time')) body.docket_time = val('dk-time');
    if (val('dk-judge')) body.judge_id = val('dk-judge');
    if (val('dk-location')) body.location = val('dk-location');
    if (val('dk-notes')) body.notes = val('dk-notes');

    try {
      const result = await apiFetch('/api/dockets', { method: 'POST', body: JSON.stringify(body) });
      successEl.textContent = `Docket scheduled for ${fmtDateOnly(result.docket_date)}.`;
      successEl.hidden = false;
      form.reset();
      loadDocketsList();
    } catch (err) {
      errorEl.textContent = formErrorMessage(err);
      errorEl.hidden = false;
    }
  };

  document.getElementById('docket-detail-back').onclick = () => {
    document.getElementById('docket-detail').hidden = true;
    document.getElementById('dockets-list').hidden = false;
    mainContent.querySelector('[data-court-panel="docket"] .filter-row').hidden = false;
    document.getElementById('docket-new-btn').hidden = false;
    selectedDocketId = null;
  };

  document.getElementById('docket-status-form').onsubmit = async (e) => {
    e.preventDefault();
    if (!selectedDocketId) return;
    const errorEl = document.querySelector('.dd-status-error');
    const successEl = document.querySelector('.dd-status-success');
    errorEl.hidden = true;
    successEl.hidden = true;
    try {
      await apiFetch(`/api/dockets/${selectedDocketId}`, {
        method: 'PATCH',
        body: JSON.stringify({ docket_status: document.getElementById('docket-status-select').value }),
      });
      successEl.textContent = 'Status updated.';
      successEl.hidden = false;
    } catch (err) {
      errorEl.textContent = formErrorMessage(err);
      errorEl.hidden = false;
    }
  };

  wireCaseLookup('dd-case-search', 'dd-case-find', 'dd-case-status', 'dd-case-results', (c) => {
    ddSelectedCase = c;
    document.getElementById('dd-add-entry-btn').disabled = false;
  });

  document.getElementById('dd-add-entry-btn').onclick = async () => {
    if (!selectedDocketId || !ddSelectedCase) return;
    const errorEl = document.querySelector('.dd-entry-error');
    const successEl = document.querySelector('.dd-entry-success');
    errorEl.hidden = true;
    successEl.hidden = true;
    try {
      await apiFetch(`/api/dockets/${selectedDocketId}/entries`, {
        method: 'POST',
        body: JSON.stringify({ case_id: ddSelectedCase.id }),
      });
      successEl.textContent = `Added case ${ddSelectedCase.case_number} to this docket.`;
      successEl.hidden = false;
      ddSelectedCase = null;
      document.getElementById('dd-add-entry-btn').disabled = true;
      document.getElementById('dd-case-search').value = '';
      await renderDocketDetail(selectedDocketId);
    } catch (err) {
      errorEl.textContent = formErrorMessage(err);
      errorEl.hidden = false;
    }
  };
}

async function populateJudgeSelect(selectEl, includeBlank) {
  try {
    const data = await apiFetch('/api/judges?is_active=true&limit=100');
    selectEl.innerHTML =
      (includeBlank ? '<option value="">-- unassigned --</option>' : '') +
      data.results.map((j) => `<option value="${j.id}">${escapeHtml(j.full_name)}</option>`).join('');
  } catch {
    /* leave select as-is if this fails -- not worth blocking the rest of the panel over */
  }
}

async function loadDocketsList() {
  await populateJudgeSelect(document.getElementById('dk-judge'), true);

  const listEl = document.getElementById('dockets-list');
  const from = document.getElementById('docket-filter-date-from').value;
  const to = document.getElementById('docket-filter-date-to').value;
  const status = document.getElementById('docket-filter-status').value;
  const params = new URLSearchParams({ limit: '50' });
  if (from) params.set('docket_date_from', from);
  if (to) params.set('docket_date_to', to);
  if (status) params.set('docket_status', status);

  listEl.innerHTML = '<li class="hint">Loading...</li>';
  try {
    const data = await apiFetch(`/api/dockets?${params.toString()}`);
    listEl.innerHTML = '';
    if (data.results.length === 0) listEl.innerHTML = '<li class="hint">No dockets match.</li>';
    data.results.forEach((d) => {
      const li = document.createElement('li');
      li.className = 'result-item';
      li.innerHTML = `<div class="r-title">${fmtDateOnly(d.docket_date)}${
        d.docket_time ? ' ' + fmtTimeOnly(d.docket_time) : ''
      } — ${humanize(d.docket_type)}</div><div class="r-sub">${
        d.judge_name ? escapeHtml(d.judge_name) : 'No judge assigned'
      } — ${fmtStatus(d.docket_status)}</div>`;
      li.addEventListener('click', () => renderDocketDetail(d.id));
      listEl.appendChild(li);
    });
  } catch (err) {
    listEl.innerHTML = `<li class="hint">${escapeHtml(err.message)}</li>`;
  }
}

function promptEntryStatusUpdate(docketId, entryId, li) {
  if (li.querySelector('select')) return; // already expanded -- don't stack a second editor
  const currentText = li.querySelector('.r-sub').textContent;
  const editDiv = document.createElement('div');
  editDiv.className = 'entry-edit';
  editDiv.innerHTML = `<select class="entry-status-select">${optionsHtml([
    'Scheduled',
    'Appeared',
    'FTA',
    'Continued',
    'Removed',
  ])}</select><button type="button" class="btn btn-secondary entry-save-btn">Save</button><p class="entry-error error-text" hidden></p>`;
  li.appendChild(editDiv);
  const select = editDiv.querySelector('.entry-status-select');
  if ([...select.options].some((o) => o.value === currentText)) select.value = currentText;

  editDiv.querySelector('.entry-save-btn').onclick = async (ev) => {
    ev.stopPropagation();
    const errorEl = editDiv.querySelector('.entry-error');
    errorEl.hidden = true;
    try {
      await apiFetch(`/api/dockets/${docketId}/entries/${entryId}`, {
        method: 'PATCH',
        body: JSON.stringify({ appearance_status: select.value }),
      });
      await renderDocketDetail(docketId);
    } catch (err) {
      errorEl.textContent = formErrorMessage(err);
      errorEl.hidden = false;
    }
  };
}

async function renderDocketDetail(id) {
  selectedDocketId = id;
  document.getElementById('dockets-list').hidden = true;
  document.getElementById('docket-form').hidden = true;
  document.getElementById('docket-new-btn').hidden = true;
  mainContent.querySelector('[data-court-panel="docket"] .filter-row').hidden = true;
  const detailEl = document.getElementById('docket-detail');
  detailEl.hidden = false;
  document.getElementById('dd-case-results').innerHTML = '';
  document.getElementById('dd-case-status').textContent = '';
  document.getElementById('dd-add-entry-btn').disabled = true;
  ddSelectedCase = null;

  try {
    const docket = await apiFetch(`/api/dockets/${id}`);
    detailEl.querySelector('.dd-date').textContent = fmtDateOnly(docket.docket_date);
    detailEl.querySelector('.dd-time').textContent = docket.docket_time ? fmtTimeOnly(docket.docket_time) : '—';
    detailEl.querySelector('.dd-judge').textContent = docket.judge_name || '—';
    detailEl.querySelector('.dd-type').textContent = humanize(docket.docket_type);
    detailEl.querySelector('.dd-location').textContent = docket.location || '—';
    document.getElementById('docket-status-select').value = docket.docket_status;

    const entriesEl = detailEl.querySelector('.dd-entries');
    entriesEl.innerHTML =
      docket.entries.length === 0
        ? '<li class="hint">No cases on this docket yet.</li>'
        : docket.entries
            .map(
              (e) =>
                `<li class="result-item" data-entry-id="${e.id}"><div class="r-title">${escapeHtml(
                  e.case_number
                )} — ${escapeHtml(e.defendant_last_name)}, ${escapeHtml(e.defendant_first_name)}</div><div class="r-sub">${fmtStatus(
                  e.appearance_status
                )}</div></li>`
            )
            .join('');
    entriesEl.querySelectorAll('li[data-entry-id]').forEach((li) => {
      li.addEventListener('click', () => promptEntryStatusUpdate(id, li.dataset.entryId, li));
    });
  } catch (err) {
    detailEl.querySelector('.dd-date').textContent = err.message;
  }
}

// ---------------- Judges ----------------

function wireJudgesPanel() {
  const newBtn = document.getElementById('judge-new-btn');
  const form = document.getElementById('judge-form');
  newBtn.onclick = () => {
    form.hidden = !form.hidden;
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('judge-form-error');
    const successEl = document.getElementById('judge-form-success');
    errorEl.hidden = true;
    successEl.hidden = true;
    try {
      const result = await apiFetch('/api/judges', {
        method: 'POST',
        body: JSON.stringify({ full_name: document.getElementById('jg-name').value.trim() }),
      });
      successEl.textContent = `Judge ${result.full_name} added.`;
      successEl.hidden = false;
      form.reset();
      loadJudgesList();
    } catch (err) {
      errorEl.textContent = formErrorMessage(err);
      errorEl.hidden = false;
    }
  };

  document.getElementById('judge-detail-back').onclick = () => {
    document.getElementById('judge-detail').hidden = true;
    document.getElementById('judges-list').hidden = false;
    document.getElementById('judge-form').hidden = true;
    document.getElementById('judge-new-btn').hidden = false;
    selectedJudgeId = null;
  };

  document.getElementById('judge-active-form').onsubmit = async (e) => {
    e.preventDefault();
    if (!selectedJudgeId) return;
    const errorEl = document.querySelector('.jd-active-error');
    const successEl = document.querySelector('.jd-active-success');
    errorEl.hidden = true;
    successEl.hidden = true;
    try {
      await apiFetch(`/api/judges/${selectedJudgeId}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: document.getElementById('jd-active').checked }),
      });
      successEl.textContent = 'Saved.';
      successEl.hidden = false;
    } catch (err) {
      errorEl.textContent = formErrorMessage(err);
      errorEl.hidden = false;
    }
  };

  document.getElementById('jd-unavail-form').onsubmit = async (e) => {
    e.preventDefault();
    if (!selectedJudgeId) return;
    const errorEl = document.querySelector('.jd-un-error');
    const successEl = document.querySelector('.jd-un-success');
    errorEl.hidden = true;
    successEl.hidden = true;
    const val = (id) => document.getElementById(id).value.trim();
    try {
      await apiFetch(`/api/judges/${selectedJudgeId}/unavailability`, {
        method: 'POST',
        body: JSON.stringify({
          start_date: val('jd-un-start'),
          end_date: val('jd-un-end'),
          reason: val('jd-un-reason') || undefined,
        }),
      });
      successEl.textContent = 'Added.';
      successEl.hidden = false;
      document.getElementById('jd-unavail-form').reset();
      await renderJudgeDetail(selectedJudgeId);
    } catch (err) {
      errorEl.textContent = formErrorMessage(err);
      errorEl.hidden = false;
    }
  };
}

async function loadJudgesList() {
  const listEl = document.getElementById('judges-list');
  listEl.innerHTML = '<li class="hint">Loading...</li>';
  try {
    const data = await apiFetch('/api/judges?limit=100');
    listEl.innerHTML = '';
    if (data.results.length === 0) listEl.innerHTML = '<li class="hint">No judges yet.</li>';
    data.results.forEach((j) => {
      const li = document.createElement('li');
      li.className = 'result-item';
      li.innerHTML = `<div class="r-title">${escapeHtml(j.full_name)}</div><div class="r-sub">${
        j.is_active ? 'Active' : 'Inactive'
      }</div>`;
      li.addEventListener('click', () => renderJudgeDetail(j.id));
      listEl.appendChild(li);
    });
  } catch (err) {
    listEl.innerHTML = `<li class="hint">${escapeHtml(err.message)}</li>`;
  }
}

async function renderJudgeDetail(id) {
  selectedJudgeId = id;
  document.getElementById('judges-list').hidden = true;
  document.getElementById('judge-form').hidden = true;
  document.getElementById('judge-new-btn').hidden = true;
  const detailEl = document.getElementById('judge-detail');
  detailEl.hidden = false;

  try {
    const judge = await apiFetch(`/api/judges/${id}`);
    detailEl.querySelector('.jd-name').textContent = judge.full_name;
    document.getElementById('jd-active').checked = judge.is_active;

    const unavailEl = detailEl.querySelector('.jd-unavailability');
    unavailEl.innerHTML =
      judge.unavailability.length === 0
        ? '<li class="hint">None on file.</li>'
        : judge.unavailability
            .map(
              (u) =>
                `<li class="result-item" data-unavail-id="${u.id}"><div class="r-title">${fmtDateOnly(
                  u.start_date
                )} to ${fmtDateOnly(u.end_date)}</div><div class="r-sub">${escapeHtml(u.reason || '')}</div></li>`
            )
            .join('');
    unavailEl.querySelectorAll('li[data-unavail-id]').forEach((li) => {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn btn-link';
      removeBtn.textContent = 'Remove';
      removeBtn.onclick = async (ev) => {
        ev.stopPropagation();
        const errorEl = detailEl.querySelector('.jd-un-error');
        errorEl.hidden = true;
        try {
          await apiFetch(`/api/judges/${id}/unavailability/${li.dataset.unavailId}`, { method: 'DELETE' });
          await renderJudgeDetail(id);
        } catch (err) {
          errorEl.textContent = formErrorMessage(err);
          errorEl.hidden = false;
        }
      };
      li.appendChild(removeBtn);
    });
  } catch (err) {
    detailEl.querySelector('.jd-name').textContent = err.message;
  }
}

// ---------------- Payments ----------------

function wirePaymentsPanel() {
  const newBtn = document.getElementById('payment-new-btn');
  const form = document.getElementById('payment-form');
  newBtn.onclick = () => {
    form.hidden = !form.hidden;
  };

  wireCaseLookup('pm-case-search', 'pm-case-find', 'pm-case-status', 'pm-case-results', (c) => {
    pmSelectedCase = c;
  });

  populateFundCategorySelect();

  document.getElementById('payment-filter-type').onchange = loadPaymentsList;

  form.onsubmit = async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('payment-form-error');
    const successEl = document.getElementById('payment-form-success');
    errorEl.hidden = true;
    successEl.hidden = true;

    if (!pmSelectedCase) {
      errorEl.textContent = 'Find and select the case this payment is for first.';
      errorEl.hidden = false;
      return;
    }

    const body = {
      case_id: pmSelectedCase.id,
      amount: Number(document.getElementById('pm-amount').value),
      payment_method: document.getElementById('pm-method').value,
      payment_type: document.getElementById('pm-type').value,
    };
    const fund = document.getElementById('pm-fund').value;
    if (fund) body.fund_category_id = fund;
    const notes = document.getElementById('pm-notes').value.trim();
    if (notes) body.notes = notes;

    try {
      const result = await apiFetch('/api/payments', { method: 'POST', body: JSON.stringify(body) });
      successEl.textContent = `Payment recorded (Receipt ${result.receipt_number}).`;
      successEl.hidden = false;
      form.reset();
      pmSelectedCase = null;
      document.getElementById('pm-case-status').textContent = '';
      loadPaymentsList();
    } catch (err) {
      errorEl.textContent = formErrorMessage(err);
      errorEl.hidden = false;
    }
  };

  document.getElementById('fund-report-btn').onclick = () => {
    const panel = document.getElementById('fund-report-panel');
    panel.hidden = !panel.hidden;
  };
  document.getElementById('fund-report-run').onclick = loadFundReport;
}

async function populateFundCategorySelect() {
  try {
    const data = await apiFetch('/api/fund-categories?is_active=true');
    const select = document.getElementById('pm-fund');
    select.innerHTML =
      '<option value="">-- none --</option>' +
      data.results.map((f) => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('');
  } catch {
    /* leave select as-is if this fails */
  }
}

async function loadPaymentsList() {
  const listEl = document.getElementById('payments-list');
  const type = document.getElementById('payment-filter-type').value;
  const params = new URLSearchParams({ limit: '30' });
  if (type) params.set('payment_type', type);

  listEl.innerHTML = '<li class="hint">Loading...</li>';
  try {
    const data = await apiFetch(`/api/payments?${params.toString()}`);
    listEl.innerHTML = '';
    if (data.results.length === 0) listEl.innerHTML = '<li class="hint">No payments match.</li>';
    data.results.forEach((p) => {
      const li = document.createElement('li');
      li.className = 'result-item';
      li.innerHTML = `<div class="r-title">${fmtMoney(p.amount)} — ${escapeHtml(p.case_number)}</div><div class="r-sub">${humanize(
        p.payment_type
      )} — ${humanize(p.payment_method)} — Receipt ${escapeHtml(p.receipt_number)} — ${fmtDateTime(p.paid_at)}</div>`;
      listEl.appendChild(li);
    });
  } catch (err) {
    listEl.innerHTML = `<li class="hint">${escapeHtml(err.message)}</li>`;
  }
}

async function loadFundReport() {
  const resultsEl = document.getElementById('fund-report-results');
  const totalEl = document.getElementById('fund-report-total');
  const from = document.getElementById('fund-report-from').value;
  const to = document.getElementById('fund-report-to').value;
  const params = new URLSearchParams();
  if (from) params.set('date_from', from);
  if (to) params.set('date_to', to);

  resultsEl.innerHTML = '<li class="hint">Loading...</li>';
  totalEl.textContent = '';
  try {
    const data = await apiFetch(`/api/payments/fund-distribution-report?${params.toString()}`);
    resultsEl.innerHTML = data.funds
      .map(
        (f) =>
          `<li class="result-item"><div class="r-title">${escapeHtml(f.fund_category)}</div><div class="r-sub">${fmtMoney(
            f.total_amount
          )} — ${f.payment_count} payment(s)</div></li>`
      )
      .join('');
    totalEl.textContent = `Grand total: ${fmtMoney(data.grand_total)}`;
  } catch (err) {
    resultsEl.innerHTML = `<li class="hint">${escapeHtml(err.message)}</li>`;
  }
}

// ---------------- Reminders ----------------

function wireRemindersPanel() {
  const newBtn = document.getElementById('reminder-new-btn');
  const form = document.getElementById('reminder-form');
  newBtn.onclick = () => {
    form.hidden = !form.hidden;
  };

  wireCaseLookup('rm-case-search', 'rm-case-find', 'rm-case-status', 'rm-case-results', (c) => {
    rmSelectedCase = c;
  });

  document.getElementById('reminder-filter-status').onchange = loadRemindersList;

  form.onsubmit = async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('reminder-form-error');
    const successEl = document.getElementById('reminder-form-success');
    errorEl.hidden = true;
    successEl.hidden = true;

    if (!rmSelectedCase) {
      errorEl.textContent = 'Find and select the case this reminder is for first.';
      errorEl.hidden = false;
      return;
    }
    const scheduled = document.getElementById('rm-scheduled').value;
    if (!scheduled) {
      errorEl.textContent = 'Choose a scheduled send date/time.';
      errorEl.hidden = false;
      return;
    }

    const body = {
      case_id: rmSelectedCase.id,
      reminder_type: document.getElementById('rm-type').value,
      // datetime-local has no timezone of its own -- new Date() parses it in
      // the browser's local zone, and toISOString() converts to UTC, which
      // is what scheduled_send_at (TIMESTAMPTZ) expects.
      scheduled_send_at: new Date(scheduled).toISOString(),
    };
    const channel = document.getElementById('rm-channel').value;
    if (channel) body.channel = channel;
    const notes = document.getElementById('rm-notes').value.trim();
    if (notes) body.notes = notes;

    try {
      await apiFetch('/api/reminders', { method: 'POST', body: JSON.stringify(body) });
      successEl.textContent = 'Reminder queued.';
      successEl.hidden = false;
      form.reset();
      rmSelectedCase = null;
      document.getElementById('rm-case-status').textContent = '';
      loadRemindersList();
    } catch (err) {
      errorEl.textContent = formErrorMessage(err);
      errorEl.hidden = false;
    }
  };
}

async function loadRemindersList() {
  const listEl = document.getElementById('reminders-list');
  const status = document.getElementById('reminder-filter-status').value;
  const params = new URLSearchParams({ limit: '30' });
  if (status) params.set('status', status);

  listEl.innerHTML = '<li class="hint">Loading...</li>';
  try {
    const data = await apiFetch(`/api/reminders?${params.toString()}`);
    listEl.innerHTML = '';
    if (data.results.length === 0) listEl.innerHTML = '<li class="hint">No reminders match.</li>';
    data.results.forEach((r) => {
      const li = document.createElement('li');
      li.className = 'result-item';
      li.innerHTML = `<div class="r-title">${escapeHtml(r.case_number)} — ${humanize(r.reminder_type)}</div><div class="r-sub">${fmtDateTime(
        r.scheduled_send_at
      )} — ${fmtStatus(r.status)}${r.channel && r.channel !== 'None' ? ' — ' + r.channel : ''}</div>`;
      // Cancel is only meaningful before a reminder has resolved --
      // reminders.controller.js's updateReminder refuses to touch an
      // already-Sent/Cancelled one, matching that here rather than
      // offering a button that would just 409.
      if (r.status === 'Pending' || r.status === 'Not_Configured') {
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn btn-link';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = async (ev) => {
          ev.stopPropagation();
          try {
            await apiFetch(`/api/reminders/${r.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'Cancelled' }) });
            loadRemindersList();
          } catch (err) {
            listEl.insertAdjacentHTML('afterbegin', `<li class="hint error-text">${escapeHtml(err.message)}</li>`);
          }
        };
        li.appendChild(cancelBtn);
      }
      listEl.appendChild(li);
    });
  } catch (err) {
    listEl.innerHTML = `<li class="hint">${escapeHtml(err.message)}</li>`;
  }
}

// ------------------------------------------------------------------
// Boot
// ------------------------------------------------------------------

if (getToken()) {
  showApp();
} else {
  showLogin();
}
