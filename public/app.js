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
// Boot
// ------------------------------------------------------------------

if (getToken()) {
  showApp();
} else {
  showLogin();
}
