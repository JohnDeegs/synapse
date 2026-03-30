'use strict';

// ── State ──────────────────────────────────────────────────────────────────────
let token     = localStorage.getItem('synapse_token');
let userEmail = localStorage.getItem('synapse_email');
let allTasks  = [];
let allTags   = [];
let allProjects = [];
let sortBy       = 'next_reminder';
let filterStatus = 'active';
let filterTag    = null; // null = all tags, number = specific tag id
let filterProject = null; // null = all projects, 'none' = no project, number = specific project id
let filterDue    = 'all'; // 'all' | 'today' | 'week' | 'month'
let selectedTaskIds = new Set();
let countdownTimer = null;
let autoRefreshTimer = null;
let pendingPatch = 0; // count of in-flight PATCH requests — suppress auto-refresh while > 0
let newTaskMDE = null; // EasyMDE instance for the new-task form (lazy-init)
let newTaskDP  = null; // DatePicker instance for the new-task form (lazy-init)
let openQuietTagId = null; // which tag's quiet-hours popout is open
// Modal state
let openModalTaskId = null;
let modalMDE        = null;
let modalDuePicker  = null;

// ── Theme ──────────────────────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('synapse_theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = saved ? saved === 'dark' : prefersDark;
  applyTheme(dark);
}

function applyTheme(dark) {
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.classList.toggle('light', !dark);
  const btn = document.getElementById('btn-theme');
  if (btn) btn.textContent = dark ? '☀️' : '🌙';
}

function toggleTheme() {
  const isDark = document.documentElement.classList.contains('dark');
  const next = !isDark;
  localStorage.setItem('synapse_theme', next ? 'dark' : 'light');
  applyTheme(next);
}

initTheme();

// ── Toast notifications ─────────────────────────────────────────────────────────
function showToast(msg, type = 'error') {
  const container = document.getElementById('toast-container') || (() => {
    const el = document.createElement('div');
    el.id = 'toast-container';
    document.body.appendChild(el);
    return el;
  })();
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast-show'));
  setTimeout(() => {
    toast.classList.remove('toast-show');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, 4000);
}

// ── EasyMDE factory ────────────────────────────────────────────────────────────
function makeMDE(el, opts = {}) {
  return new EasyMDE(Object.assign({
    element: el,
    toolbar: ['bold', 'italic', 'strikethrough', '|', 'link', 'unordered-list', 'ordered-list', '|', 'preview'],
    spellChecker: false,
    status: false,
    minHeight: '80px',
  }, opts));
}

// ── API helper ─────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status });
  return data;
}

// ── Auth ───────────────────────────────────────────────────────────────────────
async function login(email, password) {
  const data = await api('POST', '/auth/login', { email, password });
  token = data.token; userEmail = email;
  localStorage.setItem('synapse_token', token);
  localStorage.setItem('synapse_email', email);
}

async function register(email, password) {
  const data = await api('POST', '/auth/register', { email, password });
  token = data.token; userEmail = email;
  localStorage.setItem('synapse_token', token);
  localStorage.setItem('synapse_email', email);
}

function logout() {
  token = null; userEmail = null; allTasks = []; allTags = []; allProjects = [];
  filterTag = null; filterProject = null;
  selectedTaskIds.clear();
  closeTaskModal();
  localStorage.removeItem('synapse_token');
  localStorage.removeItem('synapse_email');
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
  if (telegramCountdownTimer) { clearInterval(telegramCountdownTimer); telegramCountdownTimer = null; }
  showLogin();
}

// ── Tag API ────────────────────────────────────────────────────────────────────
async function fetchTags() {
  allTags = await api('GET', '/tags');
  renderTagSidebar();
}

async function createTag(name) {
  const tag = await api('POST', '/tags', { name });
  allTags.push(tag);
  allTags.sort((a, b) => a.name.localeCompare(b.name));
  renderTagSidebar();
  renderTasks(); // refresh tag pickers on cards
}

// ── Telegram Settings ──────────────────────────────────────────────────────────
let telegramCountdownTimer = null;

async function fetchTelegramStatus() {
  try {
    const { connected } = await api('GET', '/telegram/connect');
    renderTelegramSettings(connected);
  } catch (e) {
    console.error('Failed to fetch Telegram status', e);
  }
}

function renderTelegramSettings(connected, codeData) {
  const el = document.getElementById('telegram-settings');
  if (!el) return;

  if (telegramCountdownTimer) { clearInterval(telegramCountdownTimer); telegramCountdownTimer = null; }

  if (connected) {
    el.innerHTML = `
      <p class="tg-status tg-connected">Telegram connected ✓</p>
      <button id="btn-tg-disconnect" class="btn-text btn-danger-text">Disconnect</button>
    `;
    el.querySelector('#btn-tg-disconnect').addEventListener('click', async () => {
      try {
        await api('DELETE', '/telegram/connect');
        renderTelegramSettings(false);
      } catch (e) { showToast('Failed to disconnect: ' + e.message); }
    });
    return;
  }

  if (codeData && codeData.code) {
    const expiresAt = new Date(codeData.expiresAt).getTime();
    const renderCountdown = () => {
      const secs = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      const m = Math.floor(secs / 60);
      const s = String(secs % 60).padStart(2, '0');
      const cdEl = document.getElementById('tg-code-countdown');
      if (cdEl) cdEl.textContent = `${m}:${s}`;
      if (secs === 0) {
        if (telegramCountdownTimer) { clearInterval(telegramCountdownTimer); telegramCountdownTimer = null; }
        renderTelegramSettings(false);
      }
    };
    el.innerHTML = `
      <p class="tg-instructions">Send to your bot:</p>
      <p class="tg-code"><code>/connect ${esc(codeData.code)}</code></p>
      <p class="tg-code-expiry">Expires in <span id="tg-code-countdown"></span></p>
      <button id="btn-tg-new-code" class="btn-text">Generate new code</button>
    `;
    renderCountdown();
    telegramCountdownTimer = setInterval(renderCountdown, 1000);
    el.querySelector('#btn-tg-new-code').addEventListener('click', generateTelegramCode);
    return;
  }

  el.innerHTML = `<button id="btn-tg-connect" class="btn-primary">Connect Telegram</button>`;
  el.querySelector('#btn-tg-connect').addEventListener('click', generateTelegramCode);
}

async function generateTelegramCode() {
  try {
    const data = await api('POST', '/auth/telegram-code');
    renderTelegramSettings(false, data);
  } catch (e) { showToast('Failed to generate code: ' + e.message); }
}

// ── Task API ───────────────────────────────────────────────────────────────────
async function fetchTasks() {
  if (pendingPatch > 0) return; // don't clobber in-flight mutations
  allTasks = await api('GET', '/tasks?status=all');
  // Remove selected IDs that no longer exist in the task list
  const existingIds = new Set(allTasks.map(t => t.id));
  for (const id of [...selectedTaskIds]) {
    if (!existingIds.has(id)) selectedTaskIds.delete(id);
  }
  renderTasks();
  updateStats();
}

async function createTask(title, priority, description, dueDate) {
  const body = { title, priority, description };
  if (dueDate) body.due_date = dueDate;
  const task = await api('POST', '/tasks', body);
  task.tags = [];
  allTasks.push(task);
  renderTasks();
  updateStats();
}

async function patchTask(id, body) {
  pendingPatch++;
  let freshTask = null;
  try {
    const updated = await api('PATCH', `/tasks/${id}`, body);
    const idx = allTasks.findIndex(t => t.id === id);
    if (idx !== -1) { updated.tags = allTasks[idx].tags || []; allTasks[idx] = updated; }
    freshTask = updated;
  } catch (e) {
    if (e.status === 404) {
      allTasks = allTasks.filter(t => t.id !== id);
    } else {
      pendingPatch--;
      throw e;
    }
  }
  pendingPatch--;
  renderTasks();
  updateStats();
  if (body.action === 'checkin' || body.action === 'complete') {
    fetchAndRenderHealthGrid();
  }
  // If modal is open for this task, refresh it
  if (openModalTaskId === id) {
    if (freshTask) {
      refreshModalAfterPatch(freshTask, body.action);
    } else {
      closeTaskModal();
    }
  }
}

async function deleteTask(id) {
  try {
    await api('DELETE', `/tasks/${id}`);
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  allTasks = allTasks.filter(t => t.id !== id);
  selectedTaskIds.delete(id);
  if (openModalTaskId === id) closeTaskModal();
  renderTasks();
  updateStats();
}

// ── Project API ────────────────────────────────────────────────────────────────
async function fetchProjects() {
  allProjects = await api('GET', '/projects');
  renderProjectSidebar();
}

async function createProject(name) {
  const project = await api('POST', '/projects', { name });
  allProjects.push(project);
  allProjects.sort((a, b) => a.name.localeCompare(b.name));
  renderProjectSidebar();
}

async function deleteProject(id) {
  await api('DELETE', `/projects/${id}`);
  allProjects = allProjects.filter(p => p.id !== id);
  if (filterProject === id) { filterProject = null; renderTasks(); }
  renderProjectSidebar();
}

// ── Bulk actions ───────────────────────────────────────────────────────────────
async function bulkComplete() {
  const ids = [...selectedTaskIds];
  await Promise.all(ids.map(id =>
    api('PATCH', `/tasks/${id}`, { action: 'complete' }).catch(e => console.error(e))
  ));
  selectedTaskIds.clear();
  await fetchTasks();
}

async function bulkSnooze() {
  const ids = [...selectedTaskIds];
  await Promise.all(ids.map(id =>
    api('PATCH', `/tasks/${id}`, { action: 'snooze', minutes: 60 }).catch(e => console.error(e))
  ));
  selectedTaskIds.clear();
  await fetchTasks();
}

async function bulkDelete() {
  const ids = [...selectedTaskIds];
  if (!confirm(`Delete ${ids.length} task(s)?`)) return;
  await Promise.all(ids.map(id =>
    api('DELETE', `/tasks/${id}`).catch(e => console.error(e))
  ));
  selectedTaskIds.clear();
  await fetchTasks();
}

// ── Countdown ──────────────────────────────────────────────────────────────────
function formatCountdown(isoStr) {
  const diff = new Date(isoStr).getTime() - Date.now();
  if (isNaN(diff)) return '—';
  const abs = Math.abs(diff);
  const mins = Math.floor(abs / 60000);
  const hrs  = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  let s;
  if (days > 0)     s = `${days}d ${hrs % 24}h`;
  else if (hrs > 0) s = `${hrs}h ${mins % 60}m`;
  else              s = `${mins}m`;
  return diff < 0 ? `${s} overdue` : `in ${s}`;
}

function countdownClass(isoStr) {
  const diff = new Date(isoStr).getTime() - Date.now();
  if (diff < 0) return 'countdown overdue';
  if (diff < 3_600_000) return 'countdown urgent';
  return 'countdown';
}

function updateCountdowns() {
  document.querySelectorAll('[data-countdown]').forEach(el => {
    el.textContent = formatCountdown(el.dataset.countdown);
    el.className = countdownClass(el.dataset.countdown);
  });
}

// ── Stats ──────────────────────────────────────────────────────────────────────
function updateStats() {
  const now = Date.now();
  const active = allTasks.filter(t => t.status === 'active');
  const dueIn1h = active.filter(t => new Date(t.next_reminder).getTime() - now < 3_600_000);
  const week = 7 * 24 * 3_600_000;
  const completedThisWeek = allTasks.filter(t =>
    t.status === 'completed' && now - new Date(t.created_at).getTime() < week
  );
  document.getElementById('stat-active').textContent = active.length;
  document.getElementById('stat-due').textContent = dueIn1h.length;
  document.getElementById('stat-completed').textContent = completedThisWeek.length;

  const healthEl = document.getElementById('stat-health');
  if (healthEl) {
    const anyOverdue  = active.some(t => new Date(t.next_reminder).getTime() < now);
    const anyDueSoon  = active.some(t => new Date(t.next_reminder).getTime() - now < 3_600_000);
    if (anyOverdue) {
      healthEl.textContent = 'Red';
      healthEl.className = 'stat-num stat-health-red';
    } else if (anyDueSoon) {
      healthEl.textContent = 'At risk';
      healthEl.className = 'stat-num stat-health-amber';
    } else {
      healthEl.textContent = 'Green';
      healthEl.className = 'stat-num stat-health-green';
    }
  }

  // Health bar: fill = proportion of active tasks that are on time
  const fill  = document.getElementById('health-bar-fill');
  const label = document.getElementById('health-bar-label');
  if (fill && label) {
    const onTime = active.filter(t => new Date(t.next_reminder).getTime() > now).length;
    const total  = active.length;
    const pct    = total === 0 ? 100 : Math.round(onTime / total * 100);
    fill.style.width = `${pct}%`;
    fill.className = `health-bar-fill ${pct === 100 ? 'bar-green' : pct >= 60 ? 'bar-amber' : 'bar-red'}`;
    label.textContent = total === 0 ? 'No active tasks' : `${onTime} / ${total} tasks on time`;
  }
}

async function fetchAndRenderHealthGrid() {
  try {
    const rows = await api('GET', '/health/history');
    const map = new Map(rows.map(r => [r.date, r.status]));

    // Calculate streak: consecutive green days going back from today
    let streak = 0;
    for (let i = 0; i < 365; i++) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      if (map.get(d) === 'green') { streak++; }
      else { break; }
    }

    // Build 365-day grid oldest → newest
    const days = Array.from({ length: 365 }, (_, i) =>
      new Date(Date.now() - (364 - i) * 86_400_000).toISOString().slice(0, 10)
    );

    // Pad empty cells so first day aligns to correct day-of-week column (Sun=0)
    const firstDow = new Date(days[0] + 'T00:00:00Z').getUTCDay();
    const cells = [
      ...Array.from({ length: firstDow }, () => `<span class="health-cell health-empty"></span>`),
      ...days.map(date => {
        const status = map.get(date) || 'none';
        return `<span class="health-cell health-${status}" title="${date}"></span>`;
      }),
    ].join('');

    const streakHtml = streak > 0
      ? `<span class="streak-badge">🔥 ${streak} day${streak !== 1 ? 's' : ''} in the green</span>`
      : `<span class="streak-badge streak-zero">No current streak</span>`;

    const el = document.getElementById('health-grid');
    if (el) el.innerHTML = `
      <div class="health-grid-header">
        <span class="health-grid-label">365-day health</span>
        ${streakHtml}
        <span class="health-legend"><span class="health-cell health-green"></span> Green &nbsp; <span class="health-cell health-red"></span> Red</span>
      </div>
      <div class="health-cells">${cells}</div>
    `;
  } catch { /* non-critical — silently skip */ }
}

// ── Sort & Filter ──────────────────────────────────────────────────────────────
const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };

function matchesDueFilter(task) {
  if (filterDue === 'all') return true;
  if (!task.due_date) return false;
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const due = new Date(task.due_date + 'T00:00:00');
  if (filterDue === 'today') return task.due_date === todayStr;
  if (filterDue === 'week') {
    const weekEnd = new Date(today); weekEnd.setDate(weekEnd.getDate() + 7);
    return due >= new Date(todayStr + 'T00:00:00') && due <= weekEnd;
  }
  if (filterDue === 'month') {
    return due.getMonth() === today.getMonth() && due.getFullYear() === today.getFullYear();
  }
  return true;
}

function getSortedFilteredTasks() {
  const filtered = allTasks.filter(t => {
    if (filterStatus === 'active')    return t.status === 'active';
    if (filterStatus === 'completed') return t.status === 'completed';
    return true;
  }).filter(t => {
    if (filterTag === null) return true;
    if (filterTag === 'untagged') return (t.tags || []).length === 0;
    return (t.tags || []).some(tag => tag.id === filterTag);
  }).filter(t => {
    if (filterProject === null) return true;
    if (filterProject === 'none') return !t.project_id;
    return t.project_id === filterProject;
  }).filter(matchesDueFilter);
  return filtered.sort((a, b) => {
    if (sortBy === 'priority')    return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (sortBy === 'created_at')  return new Date(a.created_at) - new Date(b.created_at);
    return new Date(a.next_reminder) - new Date(b.next_reminder);
  });
}

// ── Tag sidebar ────────────────────────────────────────────────────────────────
function renderTagSidebar() {
  const container = document.getElementById('tag-filters');
  if (!container) return;

  function hourOptions(selected) {
    return Array.from({ length: 24 }, (_, h) => {
      const label = h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`;
      return `<option value="${h}" ${selected === h ? 'selected' : ''}>${label}</option>`;
    }).join('');
  }

  const chips = [
    `<button class="tag-filter-chip ${filterTag === null ? 'active' : ''}" data-tag-id="all">All</button>`,
    `<button class="tag-filter-chip ${filterTag === 'untagged' ? 'active' : ''}" data-tag-id="untagged">Untagged</button>`,
    ...allTags.map(t => {
      const hasQuiet = t.quiet_start !== null && t.quiet_end !== null;
      const popoutOpen = openQuietTagId === t.id;
      return `
      <span class="tag-chip-wrap">
        <button class="tag-filter-chip ${filterTag === t.id ? 'active' : ''}" data-tag-id="${t.id}">${esc(t.name)}</button>
        <label class="weekday-toggle" title="Weekday only (Mon–Fri)">
          <input type="checkbox" class="tag-weekday-cb" data-tag-id="${t.id}" ${t.weekday_only ? 'checked' : ''}>
          <span class="weekday-toggle-icon">📅</span>
        </label>
        <span class="tag-quiet-wrap">
          <button class="tag-quiet-btn${hasQuiet ? ' has-quiet' : ''}" data-tag-id="${t.id}" title="Quiet hours">🌙</button>
          ${popoutOpen ? `
          <div class="tag-quiet-popout">
            <span class="tag-quiet-label">Quiet</span>
            <select class="tag-quiet-start" data-tag-id="${t.id}">${hourOptions(hasQuiet ? t.quiet_start : 9)}</select>
            <span class="tag-quiet-sep">–</span>
            <select class="tag-quiet-end" data-tag-id="${t.id}">${hourOptions(hasQuiet ? t.quiet_end : 17)}</select>
            <button class="tag-quiet-clear" data-tag-id="${t.id}" title="Remove quiet hours">×</button>
          </div>` : ''}
        </span>
      </span>`;
    }),
  ].join('');

  container.innerHTML = chips;

  container.querySelectorAll('.tag-filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.tagId;
      filterTag = val === 'all' ? null : val === 'untagged' ? 'untagged' : parseInt(val, 10);
      selectedTaskIds.clear();
      renderTagSidebar();
      renderTasks();
    });
  });

  container.querySelectorAll('.tag-weekday-cb').forEach(cb => {
    cb.addEventListener('change', async function () {
      const tagId = parseInt(this.dataset.tagId, 10);
      const checked = this.checked;
      try {
        await api('PATCH', `/tags/${tagId}`, { weekday_only: checked ? 1 : 0 });
        const tag = allTags.find(t => t.id === tagId);
        if (tag) tag.weekday_only = checked ? 1 : 0;
      } catch (e) {
        showToast(e.message);
        this.checked = !checked;
      }
    });
  });

  container.querySelectorAll('.tag-quiet-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const tagId = parseInt(btn.dataset.tagId, 10);
      if (openQuietTagId === tagId) {
        openQuietTagId = null;
        renderTagSidebar();
        return;
      }
      // If tag has no quiet hours yet, save defaults before opening
      const tag = allTags.find(t => t.id === tagId);
      if (tag && (tag.quiet_start === null || tag.quiet_end === null)) {
        try {
          await api('PATCH', `/tags/${tagId}`, { quiet_start: 9, quiet_end: 17 });
          tag.quiet_start = 9;
          tag.quiet_end = 17;
        } catch (err) {
          showToast(err.message);
          return;
        }
      }
      openQuietTagId = tagId;
      renderTagSidebar();
    });
  });

  container.querySelectorAll('.tag-quiet-start, .tag-quiet-end').forEach(sel => {
    sel.addEventListener('change', async function (e) {
      e.stopPropagation();
      const tagId = parseInt(this.dataset.tagId, 10);
      const tag = allTags.find(t => t.id === tagId);
      const startEl = container.querySelector(`.tag-quiet-start[data-tag-id="${tagId}"]`);
      const endEl   = container.querySelector(`.tag-quiet-end[data-tag-id="${tagId}"]`);
      const qs = parseInt(startEl.value, 10);
      const qe = parseInt(endEl.value, 10);
      try {
        await api('PATCH', `/tags/${tagId}`, { quiet_start: qs, quiet_end: qe });
        if (tag) { tag.quiet_start = qs; tag.quiet_end = qe; }
      } catch (err) {
        showToast(err.message);
        renderTagSidebar();
      }
    });
  });

  container.querySelectorAll('.tag-quiet-clear').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const tagId = parseInt(btn.dataset.tagId, 10);
      const tag = allTags.find(t => t.id === tagId);
      try {
        await api('PATCH', `/tags/${tagId}`, { quiet_start: null, quiet_end: null });
        if (tag) { tag.quiet_start = null; tag.quiet_end = null; }
        openQuietTagId = null;
        renderTagSidebar();
      } catch (err) {
        showToast(err.message);
      }
    });
  });
}

// Close quiet-hours popout when clicking outside the sidebar
document.addEventListener('click', (e) => {
  if (openQuietTagId !== null && !e.target.closest('.tag-quiet-wrap')) {
    openQuietTagId = null;
    renderTagSidebar();
  }
});

// ── Project sidebar ────────────────────────────────────────────────────────────
function renderProjectSidebar() {
  const container = document.getElementById('project-filters');
  if (!container) return;
  const chips = [
    `<button class="tag-filter-chip ${filterProject === null ? 'active' : ''}" data-project-id="all">All</button>`,
    `<button class="tag-filter-chip ${filterProject === 'none' ? 'active' : ''}" data-project-id="none">No project</button>`,
    ...allProjects.map(p => `
      <span class="tag-chip-wrap">
        <button class="tag-filter-chip ${filterProject === p.id ? 'active' : ''}" data-project-id="${p.id}">${esc(p.name)}</button>
        <button class="btn-delete-project btn-text" data-project-id="${p.id}" title="Delete project">×</button>
      </span>
    `),
  ].join('');
  container.innerHTML = chips;
  container.querySelectorAll('.tag-filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.projectId;
      filterProject = val === 'all' ? null : val === 'none' ? 'none' : parseInt(val, 10);
      selectedTaskIds.clear();
      renderProjectSidebar();
      renderTasks();
    });
  });
  container.querySelectorAll('.btn-delete-project').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const pid = parseInt(btn.dataset.projectId, 10);
      const proj = allProjects.find(p => p.id === pid);
      if (!confirm(`Delete project "${proj?.name}"? Tasks will be unassigned.`)) return;
      try { await deleteProject(pid); } catch (err) { showToast(err.message); }
    });
  });
}

// ── Bulk bar ───────────────────────────────────────────────────────────────────
function renderBulkBar() {
  const bar = document.getElementById('bulk-bar');
  const count = selectedTaskIds.size;
  if (count === 0) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  document.getElementById('bulk-count').textContent = `${count} selected`;
}

function updateSelectAll() {
  const el = document.getElementById('select-all');
  if (!el) return;
  const visible = getSortedFilteredTasks();
  el.checked = visible.length > 0 && visible.every(t => selectedTaskIds.has(t.id));
  el.indeterminate = !el.checked && visible.some(t => selectedTaskIds.has(t.id));
}

// ── HTML escape ────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Task detail modal ──────────────────────────────────────────────────────────

function closeTaskModal() {
  if (modalMDE) { try { modalMDE.toTextArea(); } catch {} modalMDE = null; }
  if (modalDuePicker) { modalDuePicker = null; }
  document.getElementById('task-modal-overlay').classList.add('hidden');
  openModalTaskId = null;
}

function openTaskModal(task) {
  openModalTaskId = task.id;
  const overlay = document.getElementById('task-modal-overlay');
  overlay.classList.remove('hidden');

  // Title
  const titleWrap = document.getElementById('modal-title-wrap');
  titleWrap.innerHTML = `<span class="modal-title-display">${esc(task.title)}</span><button class="btn-icon btn-edit-modal-title" title="Edit title">✎</button>`;
  titleWrap.querySelector('.btn-edit-modal-title').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'text'; input.value = task.title; input.className = 'modal-title-input';
    titleWrap.innerHTML = '';
    titleWrap.appendChild(input);
    input.focus(); input.select();
    const save = async () => {
      const newTitle = input.value.trim();
      if (newTitle && newTitle !== task.title) {
        try { await patchTask(task.id, { action: 'update', title: newTitle, description: task.description }); }
        catch (err) { showToast('Failed: ' + err.message); }
      } else {
        titleWrap.innerHTML = `<span class="modal-title-display">${esc(task.title)}</span><button class="btn-icon btn-edit-modal-title" title="Edit title">✎</button>`;
      }
    };
    input.addEventListener('blur', save);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } if (e.key === 'Escape') closeTaskModal(); });
  });

  // Close button
  document.getElementById('modal-close').onclick = closeTaskModal;

  renderModalMeta(task);
  renderModalDescription(task);
  renderModalTodos(task);
  renderModalCheckin(task);
  renderModalHistory(task.id);
  renderModalDeps(task);
  renderModalActions(task);
}

function renderModalMeta(task) {
  const isActive = task.status === 'active';
  const availableTags = allTags.filter(t => !(task.tags || []).some(tt => tt.id === t.id));
  const tagsHtml = (task.tags || []).map(t =>
    `<span class="tag-chip"><span>${esc(t.name)}</span><button class="tag-remove" data-tag-id="${t.id}" title="Remove tag">×</button></span>`
  ).join('');
  const tagPickerHtml = availableTags.length > 0
    ? `<div class="tag-autocomplete"><input class="tag-ac-input" placeholder="Add tag…" autocomplete="off"><div class="tag-ac-dropdown hidden"></div></div>`
    : '';
  const projectOptions = allProjects.map(p =>
    `<option value="${p.id}" ${task.project_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`
  ).join('');
  const section = document.getElementById('modal-meta-row');
  section.innerHTML = `
    <div class="modal-meta-grid">
      <div class="modal-meta-item">
        <span class="modal-meta-label">Priority</span>
        <div class="priority-lock-group">
          ${isActive ? `<select class="modal-priority-select pp${task.priority.toLowerCase()}">
            ${['P0','P1','P2','P3','P4'].map(p => `<option value="${p}"${p===task.priority?' selected':''}>${p}</option>`).join('')}
          </select>` : `<span class="priority-badge pp${task.priority.toLowerCase()}">${task.priority}</span>`}
          ${task.priority_locked
            ? `<button class="btn-unlock-priority btn-icon" title="Click to re-enable auto-escalation">🔒</button>`
            : `<span class="priority-auto-icon" title="Priority auto-escalates when overdue">🔓</span>`}
        </div>
      </div>
      <div class="modal-meta-item">
        <span class="modal-meta-label">Status</span>
        <span class="task-status-badge">${task.status}</span>
        ${task.is_blocked ? '<span class="frozen-badge" title="Frozen: waiting on a blocking task">❄️ Frozen</span>' : ''}
      </div>
      <div class="modal-meta-item">
        <span class="modal-meta-label">Due date</span>
        ${isActive
          ? `<button class="modal-due-btn dp-trigger">${task.due_date ? `📅 ${task.due_date}` : '📅 Set due date'}</button>`
          : `<span>${task.due_date ? `📅 ${task.due_date}` : '—'}</span>`}
      </div>
      <div class="modal-meta-item">
        <span class="modal-meta-label">Next reminder</span>
        <span class="${countdownClass(task.next_reminder)}" data-countdown="${task.next_reminder}">${formatCountdown(task.next_reminder)}</span>
      </div>
      <div class="modal-meta-item modal-meta-tags">
        <span class="modal-meta-label">Tags</span>
        <div class="card-tags">${tagsHtml}${tagPickerHtml}</div>
      </div>
      <div class="modal-meta-item">
        <span class="modal-meta-label">Project</span>
        <select class="modal-project-select">
          <option value="">— None —</option>
          ${projectOptions}
        </select>
      </div>
    </div>
  `;

  // Priority select
  section.querySelector('.modal-priority-select')?.addEventListener('change', async function () {
    const prev = task.priority;
    this.className = `modal-priority-select pp${this.value.toLowerCase()}`;
    try { await patchTask(task.id, { action: 'update', priority: this.value }); }
    catch (err) { showToast(err.message); this.value = prev; this.className = `modal-priority-select pp${prev.toLowerCase()}`; }
  });

  // Unlock priority
  section.querySelector('.btn-unlock-priority')?.addEventListener('click', async () => {
    try { await patchTask(task.id, { action: 'unlock' }); }
    catch (err) { showToast(err.message); }
  });

  // Due date picker
  const dueBtn = section.querySelector('.modal-due-btn');
  if (dueBtn) {
    modalDuePicker = new DatePicker(dueBtn, async date => {
      dueBtn.textContent = date ? `📅 ${date}` : '📅 Set due date';
      try { await patchTask(task.id, { action: 'update', title: task.title, description: task.description, due_date: date }); }
      catch (err) { showToast('Failed: ' + err.message); }
    }, task.due_date);
  }

  // Tag removal
  section.querySelectorAll('.tag-remove').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const tagId = parseInt(btn.dataset.tagId, 10);
      try {
        await api('DELETE', `/tasks/${task.id}/tags/${tagId}`);
        const t = allTasks.find(t => t.id === task.id);
        if (t) t.tags = (t.tags || []).filter(tt => tt.id !== tagId);
        renderTasks();
        const fresh = allTasks.find(t => t.id === task.id);
        if (fresh) renderModalMeta(fresh);
      } catch (e) { showToast(e.message); }
    });
  });

  // Tag autocomplete
  const acInput    = section.querySelector('.tag-ac-input');
  const acDropdown = section.querySelector('.tag-ac-dropdown');
  if (acInput && acDropdown) {
    let activeIdx = -1;
    const getMatches = () => { const q = acInput.value.toLowerCase().trim(); return q ? availableTags.filter(t => t.name.toLowerCase().includes(q)) : availableTags; };
    const assignTag = async tagId => {
      acInput.value = ''; acDropdown.classList.add('hidden');
      try {
        await api('POST', `/tasks/${task.id}/tags`, { tagId });
        const tag = allTags.find(t => t.id === tagId);
        const t   = allTasks.find(t => t.id === task.id);
        if (tag && t) t.tags = [...(t.tags || []), tag];
        renderTasks();
        const fresh = allTasks.find(t => t.id === task.id);
        if (fresh) renderModalMeta(fresh);
      } catch (e) { showToast(e.message); }
    };
    const renderDropdown = () => {
      const matches = getMatches();
      if (matches.length === 0) { acDropdown.classList.add('hidden'); return; }
      activeIdx = -1;
      acDropdown.innerHTML = matches.map(t => `<div class="tag-ac-item" data-tag-id="${t.id}">${esc(t.name)}</div>`).join('');
      const rect = acInput.getBoundingClientRect();
      acDropdown.style.top  = `${rect.bottom + 3}px`;
      acDropdown.style.left = `${rect.left}px`;
      acDropdown.classList.remove('hidden');
      acDropdown.querySelectorAll('.tag-ac-item').forEach(item => {
        item.addEventListener('mousedown', e => { e.preventDefault(); assignTag(parseInt(item.dataset.tagId, 10)); });
      });
    };
    acInput.addEventListener('focus', renderDropdown);
    acInput.addEventListener('input', renderDropdown);
    acInput.addEventListener('blur', () => setTimeout(() => acDropdown.classList.add('hidden'), 120));
    acInput.addEventListener('keydown', e => {
      const items = [...acDropdown.querySelectorAll('.tag-ac-item')];
      if (e.key === 'Escape') { acDropdown.classList.add('hidden'); acInput.blur(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, items.length - 1); items.forEach((it, i) => it.classList.toggle('active', i === activeIdx)); }
      else if (e.key === 'ArrowUp')   { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); items.forEach((it, i) => it.classList.toggle('active', i === activeIdx)); }
      else if (e.key === 'Enter') { e.preventDefault(); if (activeIdx >= 0 && items[activeIdx]) assignTag(parseInt(items[activeIdx].dataset.tagId, 10)); }
    });
  }

  // Project select
  const projSelect = section.querySelector('.modal-project-select');
  projSelect?.addEventListener('change', async function () {
    const pid = this.value ? parseInt(this.value, 10) : null;
    try {
      await patchTask(task.id, { action: 'update', project_id: pid });
    } catch (err) { showToast(err.message); this.value = task.project_id || ''; }
  });
}

function renderModalDescription(task) {
  const isActive = task.status === 'active';
  const descHtml = task.description ? marked.parse(task.description) : '<span class="no-desc">No description yet.</span>';
  const section = document.getElementById('modal-description-section');
  section.innerHTML = `
    <div class="modal-section-header">Description ${isActive ? '<button class="btn-icon btn-edit-modal-desc" title="Edit">✎</button>' : ''}</div>
    <div class="modal-desc-view">${descHtml}</div>
    <div class="modal-desc-editor hidden">
      <textarea class="modal-desc-textarea"></textarea>
      <div class="modal-desc-actions">
        <button class="btn-primary btn-save-modal-desc">Save</button>
        <button class="btn-text btn-cancel-modal-desc">Cancel</button>
      </div>
    </div>
  `;
  if (!isActive) return;
  const descView    = section.querySelector('.modal-desc-view');
  const descEditor  = section.querySelector('.modal-desc-editor');
  const descTextarea = section.querySelector('.modal-desc-textarea');
  const openEditor = () => {
    descView.classList.add('hidden');
    descEditor.classList.remove('hidden');
    if (!modalMDE) {
      modalMDE = makeMDE(descTextarea, { initialValue: task.description });
    }
    modalMDE.codemirror.focus();
  };
  const closeEditor = () => {
    if (modalMDE) { modalMDE.toTextArea(); modalMDE = null; }
    descEditor.classList.add('hidden');
    descView.classList.remove('hidden');
  };
  section.querySelector('.btn-edit-modal-desc')?.addEventListener('click', openEditor);
  section.querySelector('.btn-save-modal-desc').addEventListener('click', async () => {
    const newDesc = modalMDE ? modalMDE.value() : descTextarea.value;
    closeEditor();
    if (newDesc !== task.description) {
      try { await patchTask(task.id, { action: 'update', title: task.title, description: newDesc }); }
      catch (err) { showToast('Failed: ' + err.message); }
    }
  });
  section.querySelector('.btn-cancel-modal-desc').addEventListener('click', closeEditor);
}

function renderModalTodos(task) {
  const section = document.getElementById('modal-todos-section');
  section.innerHTML = `
    <div class="modal-section-header">Todos</div>
    <div id="modal-todo-list" class="todo-list"><span class="loading-small">Loading…</span></div>
    ${task.status === 'active' ? `
    <div class="todo-add-row">
      <input class="todo-new-input" placeholder="Add a todo…" maxlength="1000">
      <button class="btn-add-todo btn-primary">+</button>
    </div>` : ''}
  `;
  // Load todos
  api('GET', `/tasks/${task.id}/todos`).then(todos => {
    renderTodoList(task.id, todos, task.status === 'active');
  }).catch(() => {
    document.getElementById('modal-todo-list').innerHTML = '<span class="error-msg">Failed to load</span>';
  });
  // Add todo
  if (task.status === 'active') {
    const addTodo = async () => {
      const input = section.querySelector('.todo-new-input');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      try {
        const todo = await api('POST', `/tasks/${task.id}/todos`, { text });
        const listEl = document.getElementById('modal-todo-list');
        const todos = [...listEl.querySelectorAll('.todo-item')].map(el => ({
          id: parseInt(el.dataset.todoId),
          text: el.querySelector('.todo-text').textContent,
          done: el.querySelector('.todo-check').checked ? 1 : 0,
        }));
        todos.push(todo);
        renderTodoList(task.id, todos, true);
      } catch (e) { showToast(e.message); }
    };
    section.querySelector('.btn-add-todo').addEventListener('click', addTodo);
    section.querySelector('.todo-new-input').addEventListener('keydown', e => { if (e.key === 'Enter') addTodo(); });
  }
}

function renderTodoList(taskId, todos, canEdit) {
  const listEl = document.getElementById('modal-todo-list');
  if (!listEl) return;
  if (todos.length === 0) {
    listEl.innerHTML = '<span class="no-history">No todos yet.</span>';
    return;
  }
  listEl.innerHTML = todos.map(todo => `
    <div class="todo-item" data-todo-id="${todo.id}">
      <input type="checkbox" class="todo-check" ${todo.done ? 'checked' : ''} ${canEdit ? '' : 'disabled'}>
      <span class="todo-text ${todo.done ? 'todo-done' : ''}">${esc(todo.text)}</span>
      ${canEdit ? `<button class="btn-todo-delete btn-icon" title="Delete">×</button>` : ''}
    </div>
  `).join('');
  if (!canEdit) return;
  listEl.querySelectorAll('.todo-check').forEach(cb => {
    cb.addEventListener('change', async function () {
      const todoId = parseInt(this.closest('.todo-item').dataset.todoId);
      try {
        await api('PATCH', `/tasks/${taskId}/todos/${todoId}`, { done: this.checked ? 1 : 0 });
        this.closest('.todo-item').querySelector('.todo-text').classList.toggle('todo-done', this.checked);
      } catch (e) { showToast(e.message); this.checked = !this.checked; }
    });
  });
  listEl.querySelectorAll('.btn-todo-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const todoId = parseInt(btn.closest('.todo-item').dataset.todoId);
      try {
        await api('DELETE', `/tasks/${taskId}/todos/${todoId}`);
        const remaining = todos.filter(t => t.id !== todoId);
        renderTodoList(taskId, remaining, canEdit);
      } catch (e) { showToast(e.message); }
    });
  });
}

function renderModalCheckin(task) {
  const section = document.getElementById('modal-checkin-section');
  if (task.status !== 'active') { section.innerHTML = ''; return; }
  section.innerHTML = `
    <div class="modal-section-header">Check in</div>
    <textarea class="modal-checkin-note" placeholder="Status update…" rows="2"></textarea>
    <div class="checkin-controls">
      <select class="modal-checkin-priority pp${task.priority.toLowerCase()}">
        ${['P0','P1','P2','P3','P4'].map(p => `<option value="${p}"${p===task.priority?' selected':''}>${p}</option>`).join('')}
      </select>
      <button class="btn-primary btn-modal-submit-checkin">Submit check-in</button>
    </div>
  `;
  section.querySelector('.modal-checkin-priority').addEventListener('change', function () {
    this.className = `modal-checkin-priority pp${this.value.toLowerCase()}`;
  });
  section.querySelector('.btn-modal-submit-checkin').addEventListener('click', async () => {
    const note = section.querySelector('.modal-checkin-note').value.trim();
    const priority = section.querySelector('.modal-checkin-priority').value;
    try {
      await patchTask(task.id, { action: 'checkin', note, priority });
      section.querySelector('.modal-checkin-note').value = '';
    } catch (e) { showToast(e.message); }
  });
}

function renderModalHistory(taskId) {
  const section = document.getElementById('modal-history-section');
  section.innerHTML = `<div class="modal-section-header">Check-in history</div><div id="modal-history-list"><span class="loading-small">Loading…</span></div>`;
  api('GET', `/tasks/${taskId}/checkins`).then(checkins => {
    const listEl = document.getElementById('modal-history-list');
    if (!listEl) return;
    if (checkins.length === 0) {
      listEl.innerHTML = '<span class="no-history">No check-ins yet.</span>';
    } else {
      listEl.innerHTML = checkins.reverse().map(c => `
        <div class="history-item">
          <span class="history-time">${new Date(c.created_at).toLocaleString()}</span>
          <span class="history-note">${c.note ? esc(c.note) : '<em>No note</em>'}</span>
        </div>
      `).join('');
    }
  }).catch(() => {
    const listEl = document.getElementById('modal-history-list');
    if (listEl) listEl.innerHTML = '<span class="error-msg">Failed to load history</span>';
  });
}

function renderModalDeps(task) {
  const section = document.getElementById('modal-deps-section');
  section.innerHTML = `<div class="modal-section-header">Dependencies</div><div id="modal-deps-content"><span class="loading-small">Loading…</span></div>`;
  api('GET', `/tasks/${task.id}/dependencies`).then(deps => {
    const el = document.getElementById('modal-deps-content');
    if (!el) return;
    const blockedBy = deps.filter(d => d.direction === 'blocked_by');
    const blocking  = deps.filter(d => d.direction === 'blocking');
    const blockedByHtml = blockedBy.length === 0
      ? '<span class="no-history">None</span>'
      : blockedBy.map(d => `
          <div class="dep-item">
            <span class="priority-badge pp${d.priority.toLowerCase()}">${d.priority}</span>
            <span>${esc(d.title)}</span>
            <span class="dep-status">${d.status}</span>
            ${task.status === 'active' ? `<button class="btn-icon btn-remove-dep" data-blocking-id="${d.id}" title="Remove dependency">×</button>` : ''}
          </div>`).join('');
    const blockingHtml = blocking.length === 0
      ? '<span class="no-history">None</span>'
      : blocking.map(d => `
          <div class="dep-item">
            <span class="priority-badge pp${d.priority.toLowerCase()}">${d.priority}</span>
            <span>${esc(d.title)}</span>
            <span class="dep-status">${d.status}</span>
          </div>`).join('');
    el.innerHTML = `
      <div class="deps-group">
        <h4 class="deps-group-label">Blocked by (must finish first)</h4>
        <div class="deps-list">${blockedByHtml}</div>
        ${task.status === 'active' ? `
        <div class="dep-add-row">
          <input class="dep-search-input" placeholder="Search tasks to add blocker…" autocomplete="off">
          <div class="dep-search-dropdown hidden"></div>
        </div>` : ''}
      </div>
      <div class="deps-group">
        <h4 class="deps-group-label">Blocking (this task blocks)</h4>
        <div class="deps-list">${blockingHtml}</div>
      </div>
    `;
    // Remove dependency
    el.querySelectorAll('.btn-remove-dep').forEach(btn => {
      btn.addEventListener('click', async () => {
        const blockingId = parseInt(btn.dataset.blockingId);
        try { await api('DELETE', `/tasks/${task.id}/dependencies/${blockingId}`); renderModalDeps(task); renderTasks(); }
        catch (e) { showToast(e.message); }
      });
    });
    // Add dependency search
    const searchInput = el.querySelector('.dep-search-input');
    const searchDrop  = el.querySelector('.dep-search-dropdown');
    if (searchInput && searchDrop) {
      const renderDepDropdown = () => {
        const q = searchInput.value.toLowerCase().trim();
        const results = allTasks.filter(t =>
          t.id !== task.id && t.status === 'active' &&
          !blockedBy.some(d => d.id === t.id) &&
          (q ? t.title.toLowerCase().includes(q) : true)
        ).slice(0, 8);
        if (results.length === 0) { searchDrop.classList.add('hidden'); return; }
        searchDrop.innerHTML = results.map(t =>
          `<div class="tag-ac-item" data-task-id="${t.id}">[${t.priority}] ${esc(t.title)}</div>`
        ).join('');
        searchDrop.classList.remove('hidden');
        searchDrop.querySelectorAll('.tag-ac-item').forEach(item => {
          item.addEventListener('mousedown', async e => {
            e.preventDefault();
            const blockingId = parseInt(item.dataset.taskId);
            try { await api('POST', `/tasks/${task.id}/dependencies`, { blockingTaskId: blockingId }); renderModalDeps(task); renderTasks(); }
            catch (err) { showToast(err.message); }
            searchInput.value = ''; searchDrop.classList.add('hidden');
          });
        });
      };
      searchInput.addEventListener('input', renderDepDropdown);
      searchInput.addEventListener('focus', renderDepDropdown);
      searchInput.addEventListener('blur', () => setTimeout(() => searchDrop.classList.add('hidden'), 120));
    }
  }).catch(() => {
    const el = document.getElementById('modal-deps-content');
    if (el) el.innerHTML = '<span class="error-msg">Failed to load dependencies</span>';
  });
}

function renderModalActions(task) {
  const section = document.getElementById('modal-actions-row');
  section.innerHTML = `
    ${task.status === 'active' ? `
      <button class="btn-primary btn-modal-complete">✓ Complete</button>
      <button class="btn-secondary btn-modal-snooze">⏰ Snooze 1h</button>
    ` : ''}
    <button class="btn-danger btn-modal-delete">✕ Delete</button>
  `;
  section.querySelector('.btn-modal-complete')?.addEventListener('click', () =>
    patchTask(task.id, { action: 'complete' }).catch(e => showToast(e.message)));
  section.querySelector('.btn-modal-snooze')?.addEventListener('click', () =>
    patchTask(task.id, { action: 'snooze', minutes: 60 }).catch(e => showToast(e.message)));
  section.querySelector('.btn-modal-delete').addEventListener('click', async () => {
    if (confirm(`Delete "${task.title}"?`)) {
      await deleteTask(task.id).catch(e => showToast(e.message));
    }
  });
}

function refreshModalAfterPatch(task, action) {
  // After any patch, refresh meta/actions. After checkin, also refresh history.
  renderModalMeta(task);
  renderModalActions(task);
  if (action === 'checkin') {
    renderModalHistory(task.id);
  }
  if (action === 'complete' || action === 'snooze') {
    renderModalCheckin(task);
  }
}

// ── Card rendering (compact) ───────────────────────────────────────────────────
function renderCard(task) {
  const el = document.createElement('div');
  el.className = `task-card compact status-${task.status}`;
  el.dataset.id = task.id;

  const isActive = task.status === 'active';
  const isSelected = selectedTaskIds.has(task.id);

  // Tags: read-only compact chips
  const tagsHtml = (task.tags || []).map(t =>
    `<span class="tag-chip-compact">${esc(t.name)}</span>`
  ).join('');

  const dueHtml = task.due_date
    ? `<span class="task-due-compact">📅 ${task.due_date}</span>`
    : '';

  const lockedIcon = task.priority_locked ? ' 🔒' : '';
  const frozenBadge = task.is_blocked ? '<span class="frozen-badge" title="Frozen: waiting on blocking task">❄️</span>' : '';

  // Project badge
  const proj = task.project_id ? allProjects.find(p => p.id === task.project_id) : null;
  const projBadge = proj ? `<span class="project-badge">${esc(proj.name)}</span>` : '';

  el.innerHTML = `
    <div class="card-header">
      <input type="checkbox" class="task-checkbox" ${isSelected ? 'checked' : ''}>
      <span class="priority-badge pp${task.priority.toLowerCase()}" title="${task.priority_locked ? 'Priority locked' : 'Priority auto-escalates when overdue'}">${task.priority}${lockedIcon}</span>
      ${frozenBadge}
      <span class="task-title">${esc(task.title)}</span>
      <span class="${countdownClass(task.next_reminder)}" data-countdown="${task.next_reminder}">${formatCountdown(task.next_reminder)}</span>
      ${dueHtml}
      ${task.status !== 'active' ? `<span class="task-status-badge">${task.status}</span>` : ''}
    </div>
    <div class="card-footer">
      <div class="card-tags">${projBadge}${tagsHtml}</div>
      <div class="card-actions">
        ${isActive ? `
          <button class="btn-action btn-complete" title="Complete">✓</button>
          <button class="btn-action btn-snooze" title="Snooze 1h">⏰</button>
        ` : ''}
        <button class="btn-action btn-open-modal" title="Open details">→</button>
      </div>
    </div>
  `;

  el.querySelector('.task-checkbox').addEventListener('change', e => {
    if (e.target.checked) selectedTaskIds.add(task.id);
    else selectedTaskIds.delete(task.id);
    renderBulkBar();
    updateSelectAll();
  });

  el.querySelector('.btn-complete')?.addEventListener('click', e => {
    e.stopPropagation();
    patchTask(task.id, { action: 'complete' }).catch(err => showToast(err.message));
  });

  el.querySelector('.btn-snooze')?.addEventListener('click', e => {
    e.stopPropagation();
    patchTask(task.id, { action: 'snooze', minutes: 60 }).catch(err => showToast(err.message));
  });

  const openModal = () => openTaskModal(task);
  el.querySelector('.btn-open-modal').addEventListener('click', openModal);
  el.addEventListener('click', e => {
    if (e.target.closest('button, input')) return;
    openModal();
  });

  return el;
}

// ── Task list rendering ────────────────────────────────────────────────────────
function renderTasks() {
  const container = document.getElementById('task-list');
  container.innerHTML = '';
  const tasks = getSortedFilteredTasks();
  if (tasks.length === 0) {
    container.innerHTML = '<div class="empty-state">No tasks here. Create one with "+ New Task".</div>';
  } else {
    const frag = document.createDocumentFragment();
    tasks.forEach(t => frag.appendChild(renderCard(t)));
    container.appendChild(frag);
  }
  renderBulkBar();
  updateSelectAll();
}

// ── Views ──────────────────────────────────────────────────────────────────────
function showLogin() {
  document.getElementById('view-login').classList.remove('hidden');
  document.getElementById('view-app').classList.add('hidden');
}

function showApp() {
  document.getElementById('view-login').classList.add('hidden');
  document.getElementById('view-app').classList.remove('hidden');
  document.getElementById('user-email').textContent = userEmail || '';
  // Load tags and projects first so pickers are populated when task cards render
  Promise.all([fetchTags(), fetchProjects()]).then(() => fetchTasks()).catch(e => console.error(e));
  fetchAndRenderHealthGrid();
  fetchTelegramStatus();
  initQuietHoursUI();
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(updateCountdowns, 30_000);
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(() => fetchTasks().catch(() => {}), 30_000);
}

// ── Init ───────────────────────────────────────────────────────────────────────
function init() {
  // Auth tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      document.getElementById('form-login').classList.toggle('hidden', tab !== 'login');
      document.getElementById('form-register').classList.toggle('hidden', tab !== 'register');
    });
  });

  // Login form
  document.getElementById('form-login').addEventListener('submit', async e => {
    e.preventDefault();
    const errEl = document.getElementById('login-error');
    errEl.textContent = '';
    try {
      await login(
        document.getElementById('login-email').value,
        document.getElementById('login-password').value
      );
      showApp();
    } catch (err) { errEl.textContent = err.message; }
  });

  // Register form
  document.getElementById('form-register').addEventListener('submit', async e => {
    e.preventDefault();
    const errEl = document.getElementById('reg-error');
    errEl.textContent = '';
    try {
      await register(
        document.getElementById('reg-email').value,
        document.getElementById('reg-password').value
      );
      showApp();
    } catch (err) { errEl.textContent = err.message; }
  });

  // Theme toggle
  document.getElementById('btn-theme').addEventListener('click', toggleTheme);

  // Logout
  document.getElementById('btn-logout').addEventListener('click', logout);

  // New task form toggle — lazy-init EasyMDE on first open
  document.getElementById('btn-new-task').addEventListener('click', () => {
    const form = document.getElementById('new-task-form');
    form.classList.toggle('hidden');
    if (!form.classList.contains('hidden')) {
      if (!newTaskMDE) {
        newTaskMDE = makeMDE(document.getElementById('new-desc'), { minHeight: '120px' });
      }
      if (!newTaskDP) {
        const todayStr = new Date().toISOString().slice(0, 10);
        const btn = document.getElementById('new-due-date-btn');
        newTaskDP = new DatePicker(btn, date => {
          btn.textContent = date ? `📅 ${date}` : '📅 Set due date';
        }, todayStr);
        btn.textContent = `📅 ${todayStr}`;
      }
      document.getElementById('new-title').focus();
    }
  });
  document.getElementById('btn-cancel-task').addEventListener('click', () => {
    document.getElementById('new-task-form').classList.add('hidden');
  });

  // Create task
  document.getElementById('btn-create-task').addEventListener('click', async () => {
    const title = document.getElementById('new-title').value.trim();
    const priority = document.getElementById('new-priority').value;
    const description = newTaskMDE ? newTaskMDE.value().trim() : '';
    const dueDate = newTaskDP ? newTaskDP.value : null;
    const errEl = document.getElementById('create-error');
    errEl.textContent = '';
    if (!title) { errEl.textContent = 'Title is required.'; return; }
    try {
      await createTask(title, priority, description, dueDate);
      document.getElementById('new-title').value = '';
      document.getElementById('new-priority').value = 'P2';
      if (newTaskDP) {
        const todayStr = new Date().toISOString().slice(0, 10);
        newTaskDP.setValue(todayStr);
        document.getElementById('new-due-date-btn').textContent = `📅 ${todayStr}`;
      }
      if (newTaskMDE) newTaskMDE.value('');
      document.getElementById('new-task-form').classList.add('hidden');
    } catch (err) { errEl.textContent = err.message; }
  });

  // Also submit new task on Enter in title field
  document.getElementById('new-title').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-create-task').click();
  });

  // Due date filter
  document.getElementById('filter-due').addEventListener('change', e => {
    filterDue = e.target.value;
    selectedTaskIds.clear();
    renderTasks();
  });

  // Sort / filter
  document.getElementById('filter-status').addEventListener('change', e => {
    filterStatus = e.target.value;
    selectedTaskIds.clear();
    renderTasks();
  });
  document.getElementById('sort-by').addEventListener('change', e => {
    sortBy = e.target.value;
    renderTasks();
  });

  // Select all
  document.getElementById('select-all').addEventListener('change', e => {
    const visible = getSortedFilteredTasks();
    if (e.target.checked) visible.forEach(t => selectedTaskIds.add(t.id));
    else selectedTaskIds.clear();
    renderTasks();
  });

  // Bulk actions
  document.getElementById('btn-bulk-complete').addEventListener('click', bulkComplete);
  document.getElementById('btn-bulk-snooze').addEventListener('click', bulkSnooze);
  document.getElementById('btn-bulk-delete').addEventListener('click', bulkDelete);
  document.getElementById('btn-bulk-clear').addEventListener('click', () => {
    selectedTaskIds.clear();
    renderTasks();
  });

  // Create tag
  document.getElementById('btn-create-tag').addEventListener('click', async () => {
    const input = document.getElementById('new-tag-name');
    const name = input.value.trim();
    const errEl = document.getElementById('create-tag-error');
    errEl.textContent = '';
    if (!name) return;
    try {
      await createTag(name);
      input.value = '';
    } catch (err) { errEl.textContent = err.message; }
  });
  document.getElementById('new-tag-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-create-tag').click();
  });

  // Create project
  document.getElementById('btn-create-project').addEventListener('click', async () => {
    const input = document.getElementById('new-project-name');
    const name = input.value.trim();
    const errEl = document.getElementById('create-project-error');
    errEl.textContent = '';
    if (!name) return;
    try {
      await createProject(name);
      input.value = '';
    } catch (err) { errEl.textContent = err.message; }
  });
  document.getElementById('new-project-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-create-project').click();
  });

  // Modal: close on overlay click outside panel, and on Escape
  document.getElementById('task-modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('task-modal-overlay')) closeTaskModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && openModalTaskId !== null) closeTaskModal();
  });

  // Boot
  if (token) showApp();
  else showLogin();
}

async function initQuietHoursUI() {
  const startEl   = document.getElementById('quiet-start-web');
  const endEl     = document.getElementById('quiet-end-web');
  const enabledEl = document.getElementById('quiet-enabled-web');
  const rangeEl   = document.getElementById('quiet-range-web');

  for (let h = 0; h < 24; h++) {
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const label = `${h12}:00 ${h < 12 ? 'AM' : 'PM'}`;
    [startEl, endEl].forEach(sel => {
      const opt = document.createElement('option');
      opt.value = h; opt.textContent = label;
      sel.appendChild(opt);
    });
  }

  try {
    const s = await api('GET', '/settings');
    enabledEl.checked = s.quiet_enabled !== 0;
    startEl.value = s.quiet_start;
    endEl.value   = s.quiet_end;
    rangeEl.style.display = enabledEl.checked ? 'block' : 'none';
  } catch { rangeEl.style.display = 'block'; }

  enabledEl.addEventListener('change', function () {
    rangeEl.style.display = this.checked ? 'block' : 'none';
  });

  document.getElementById('quiet-save-web').addEventListener('click', async () => {
    const msgEl = document.getElementById('quiet-msg-web');
    try {
      await api('PATCH', '/settings', {
        quiet_enabled: enabledEl.checked,
        quiet_start:   parseInt(startEl.value, 10),
        quiet_end:     parseInt(endEl.value, 10),
      });
      msgEl.textContent = 'Saved.';
      msgEl.style.color = 'var(--success)';
    } catch (err) {
      msgEl.textContent = err.message;
      msgEl.style.color = 'var(--danger)';
    }
  });
}

init();
