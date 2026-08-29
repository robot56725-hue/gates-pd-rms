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

  // Only sworn personnel who can actually issue citations see that tab.
  const canIssue = profile && ['Patrol_Officer', 'Supervisor'].includes(profile.role);
  document.getElementById('nav-issue').hidden = !canIssue;

  // Personnel management is System_Admin only -- matches the API's own
  // requireRoles('System_Admin') guard on /api/users (see users.routes.js).
  const canManagePersonnel = profile && profile.role === 'System_Admin';
  document.getElementById('nav-personnel').hidden = !canManagePersonnel;

  // Incidents/Crashes/Evidence tabs -- same role set as the API's own
  // requireRoles('Patrol_Officer', 'Supervisor', 'System_Admin') guard on
  // POST /api/incidents, /api/crashes, /api/evidence. Court_Clerk has no
  // reason to file these, so the tab (which is create-first, same as the
  // Issue Citation tab) stays hidden for that role.
  const canOperateCases = profile && ['Patrol_Officer', 'Supervisor', 'System_Admin'].includes(profile.role);
  document.getElementById('nav-incidents').hidden = !canOperateCases;
  document.getElementById('nav-crashes').hidden = !canOperateCases;
  document.getElementById('nav-evidence').hidden = !canOperateCases;

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
    setSession(data.token, { role: data.role, badge_number: data.badge_number });
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
      } else {
        li.innerHTML = `<div class="r-title">${escapeHtml(row.citation_number)}</div>
          <div class="r-sub">${escapeHtml(row.violator_last_name)}, ${escapeHtml(row.violator_first_name)} — ${fmtStatus(row.court_status)}</div>`;
        li.addEventListener('click', () => renderCitationDetail(row.id, 'search'));
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

  try {
    const c = await apiFetch(`/api/citations/${id}`);
    mainContent.querySelector('.c-number').textContent = c.citation_number;
    mainContent.querySelector('.c-violator').textContent = `${c.violator_last_name}, ${c.violator_first_name}`;
    mainContent.querySelector('.c-vehicle').textContent = `${c.plate_number} (${c.plate_state}) — ${c.make} ${c.model}`;
    mainContent.querySelector('.c-officer').textContent = `${c.officer_name} (#${c.officer_badge})`;
    mainContent.querySelector('.c-offense-date').textContent = fmtDateTime(c.offense_date);
    mainContent.querySelector('.c-location').textContent = c.location;
    mainContent.querySelector('.c-description').textContent = c.offense_description;
    mainContent.querySelector('.c-tca').textContent = c.tca_code;
    mainContent.querySelector('.c-court-date').textContent = fmtDateTime(c.court_date);
    mainContent.querySelector('.c-court-name').textContent = `${c.court_name} — ${c.court_location}`;
    mainContent.querySelector('.c-deadline').textContent = fmtDateTime(c.court_filing_deadline);
    mainContent.querySelector('.c-status').textContent = fmtStatus(c.court_status);
    mainContent.querySelector('.c-fine').textContent = fmtMoney(c.fine_amount_due);
    mainContent.querySelector('.c-paid').textContent = fmtMoney(c.amount_paid);

    const profile = getProfile();
    if (profile && profile.role === 'Court_Clerk') {
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
          renderCitationDetail(id, backTo);
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

function renderIssueForm() {
  mount('tpl-issue');
  const form = document.getElementById('issue-form');

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
      },
      court: {
        court_date: val('i-court-date'),
        court_time: val('i-court-time'),
        court_location: val('i-court-location'),
        court_name: val('i-court-name'),
      },
    };

    try {
      const result = await apiFetch('/api/citations', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      successEl.textContent = `Citation ${result.citation_number} submitted. Court filing deadline: ${fmtDate(result.court_filing_deadline)}.`;
      successEl.hidden = false;
      form.reset();
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

    const payload = {
      username: document.getElementById('pn-username').value.trim(),
      password: document.getElementById('pn-password').value,
      full_name: document.getElementById('pn-full-name').value.trim(),
      badge_number: document.getElementById('pn-badge').value.trim(),
      officer_rank: document.getElementById('pn-rank').value.trim() || undefined,
      agency: document.getElementById('pn-agency').value.trim(),
      role: document.getElementById('pn-role').value,
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
      li.innerHTML = `<div class="r-title">${escapeHtml(u.full_name)} — ${escapeHtml(u.username)} ${
        u.is_active ? '' : '<span class="badge">Deactivated</span>'
      }</div>
        <div class="r-sub">${escapeHtml(u.role.replace(/_/g, ' '))} · Badge ${escapeHtml(u.badge_number)} · ${escapeHtml(
        u.officer_rank || ''
      )} · ${escapeHtml(u.agency)}</div>`;

      if (!isSelf) {
        const toggleBtn = document.createElement('button');
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
        li.appendChild(toggleBtn);
      }

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

  document.getElementById('ev-status-select').innerHTML = optionsHtml(EVIDENCE_STATUSES);
  document.getElementById('cu-action').innerHTML = optionsHtml(EVIDENCE_CUSTODY_ACTIONS);

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
// Boot
// ------------------------------------------------------------------

if (getToken()) {
  showApp();
} else {
  showLogin();
}
