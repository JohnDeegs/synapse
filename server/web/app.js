'use strict';

// ── State ──────────────────────────────────────────────────────────────────────
let token     = localStorage.getItem('synapse_token');
let userEmail = localStorage.getItem('synapse_email');
let allTasks  = [];
let allTags   = [];
let sortBy       = 'next_reminder';
let filterStatus = 'active';
let filterTag    = null; // null = all tags, number = specific tag id
let filterDue    = 'all'; // 'all' | 'today' | 'week' | 'month'
let selectedTaskIds = new Set();
let countdownTimer = null;
let autoRefreshTimer = null;
let newTaskMDE = null; // EasyMDE instance for the new-task form (lazy-init)
let newTaskDP  = null; // DatePicker instance for the new-task form (lazy-init)

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
  token = null; userEmail = null; allTasks = []; allTags = []; filterTag = null;
  selectedTaskIds.clear();
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
      } catch (e) { alert('Failed to disconnect: ' + e.message); }
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
  } catch (e) { alert('Failed to generate code: ' + e.message); }
}

// ── Task API ───────────────────────────────────────────────────────────────────
async function fetchTasks() {
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
  const updated = await api('PATCH', `/tasks/${id}`, body);
  const idx = allTasks.findIndex(t => t.id === id);
  if (idx !== -1) { updated.tags = allTasks[idx].tags || []; allTasks[idx] = updated; }
  renderTasks();
  updateStats();
}

async function deleteTask(id) {
  await api('DELETE', `/tasks/${id}`);
  allTasks = allTasks.filter(t => t.id !== id);
  selectedTaskIds.delete(id);
  renderTasks();
  updateStats();
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

  const chips = [
    `<button class="tag-filter-chip ${filterTag === null ? 'active' : ''}" data-tag-id="all">All</button>`,
    `<button class="tag-filter-chip ${filterTag === 'untagged' ? 'active' : ''}" data-tag-id="untagged">Untagged</button>`,
    ...allTags.map(t =>
      `<button class="tag-filter-chip ${filterTag === t.id ? 'active' : ''}" data-tag-id="${t.id}">${esc(t.name)}</button>`
    ),
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

// ── Card rendering ─────────────────────────────────────────────────────────────
function renderCard(task) {
  const el = document.createElement('div');
  el.className = `task-card status-${task.status}`;
  el.dataset.id = task.id;

  const isActive = task.status === 'active';
  const isSelected = selectedTaskIds.has(task.id);

  const descHtml = task.description
    ? marked.parse(task.description)
    : `<span class="no-desc">No description — click to add</span>`;

  // Tags: chips with remove button
  const tagsHtml = (task.tags || []).map(t =>
    `<span class="tag-chip"><span>${esc(t.name)}</span><button class="tag-remove" data-tag-id="${t.id}" title="Remove tag">×</button></span>`
  ).join('');

  // Tag autocomplete input
  const availableTags = allTags.filter(t => !(task.tags || []).some(tt => tt.id === t.id));
  const tagPickerHtml = allTags.length === 0
    ? `<span class="tag-hint">← Create a tag</span>`
    : availableTags.length > 0
      ? `<div class="tag-autocomplete"><input class="tag-ac-input" placeholder="Add tag…" autocomplete="off"><div class="tag-ac-dropdown hidden"></div></div>`
      : '';

  const actionsHtml = isActive ? `
    <button class="btn-action btn-complete">✓ Complete</button>
    <button class="btn-action btn-checkin">↻ Check-in</button>
    <button class="btn-action btn-snooze">⏰ Snooze 1h</button>
  ` : '';

  const dueHtml = isActive
    ? `<button type="button" class="task-due-btn">${task.due_date ? `📅 ${task.due_date}` : '📅 Set due date'}</button>`
    : task.due_date
      ? `<span class="task-due">📅 ${task.due_date}</span>`
      : '';

  el.innerHTML = `
    <div class="card-header">
      <input type="checkbox" class="task-checkbox" ${isSelected ? 'checked' : ''}>
      ${isActive
        ? `<select class="priority-select pp${task.priority.toLowerCase()}" title="Change priority">
             ${['P0','P1','P2','P3','P4'].map(p => `<option value="${p}"${p === task.priority ? ' selected' : ''}>${p}</option>`).join('')}
           </select>`
        : `<span class="priority-badge pp${task.priority.toLowerCase()}">${task.priority}</span>`
      }
      <span class="task-title">${esc(task.title)}</span>
      <span class="${countdownClass(task.next_reminder)}" data-countdown="${task.next_reminder}">
        ${formatCountdown(task.next_reminder)}
      </span>
      ${dueHtml}
      <span class="task-status-badge">${task.status}</span>
    </div>
    <div class="card-desc">
      <div class="desc-view">${descHtml}</div>
      <div class="desc-editor-wrapper hidden">
        <textarea class="desc-edit-input"></textarea>
        <div class="desc-editor-actions">
          <button class="btn-save-desc btn-primary">Save</button>
          <button class="btn-cancel-desc btn-text">Cancel</button>
        </div>
      </div>
    </div>
    <div class="card-footer">
      <div class="card-tags">
        ${tagsHtml}
        ${tagPickerHtml}
      </div>
      <div class="card-actions">
        ${actionsHtml}
        <button class="btn-action btn-history">⟳ History</button>
        <button class="btn-action btn-delete">✕ Delete</button>
      </div>
    </div>
    <div class="checkin-area hidden">
      <textarea class="checkin-note" placeholder="Status update…" rows="2"></textarea>
      <button class="btn-primary btn-submit-checkin">Submit check-in</button>
    </div>
    <div class="checkin-history hidden"></div>
  `;

  // ── Checkbox ──────────────────────────────────────────────────────────────
  el.querySelector('.task-checkbox').addEventListener('change', e => {
    if (e.target.checked) selectedTaskIds.add(task.id);
    else selectedTaskIds.delete(task.id);
    renderBulkBar();
    updateSelectAll();
  });

  // ── Inline editing: title ─────────────────────────────────────────────────
  if (isActive) {
    const titleEl = el.querySelector('.task-title');
    titleEl.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = task.title;
      input.className = 'title-edit-input';
      titleEl.replaceWith(input);
      input.focus();
      input.select();

      const save = async () => {
        const newTitle = input.value.trim();
        if (newTitle && newTitle !== task.title) {
          try {
            await patchTask(task.id, { action: 'update', title: newTitle, description: task.description });
          } catch (err) {
            alert('Failed to save: ' + err.message);
            renderTasks();
          }
        } else {
          renderTasks();
        }
      };
      input.addEventListener('blur', save);
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') renderTasks();
      });
    });
  }

  // ── Priority select ───────────────────────────────────────────────────
  el.querySelector('.priority-select')?.addEventListener('change', async function () {
    const sel = this;
    const prev = task.priority;
    sel.className = `priority-select pp${this.value.toLowerCase()}`;
    try {
      await patchTask(task.id, { action: 'update', priority: this.value });
    } catch (err) { alert(err.message); sel.value = prev; sel.className = `priority-select pp${prev.toLowerCase()}`; }
  });

  // ── Due date picker ───────────────────────────────────────────────────
  if (isActive) {
    const dueBtn = el.querySelector('.task-due-btn');
    if (dueBtn) {
      new DatePicker(dueBtn, async date => {
        dueBtn.textContent = date ? `📅 ${date}` : '📅 Set due date';
        try {
          await patchTask(task.id, { action: 'update', title: task.title, description: task.description, due_date: date });
        } catch (err) { alert('Failed: ' + err.message); renderTasks(); }
      }, task.due_date);
    }
  }

  // ── Inline editing: description (EasyMDE) ────────────────────────────────
  if (isActive) {
    const descView    = el.querySelector('.desc-view');
    const descWrapper = el.querySelector('.desc-editor-wrapper');
    const descTextarea = el.querySelector('.desc-edit-input');
    let mde = null;

    const openEditor = () => {
      descView.classList.add('hidden');
      descWrapper.classList.remove('hidden');
      if (!mde) {
        mde = makeMDE(descTextarea, { initialValue: task.description });
      }
      mde.codemirror.focus();
    };

    const closeEditor = () => {
      if (mde) { mde.toTextArea(); mde = null; }
      descWrapper.classList.add('hidden');
      descView.classList.remove('hidden');
    };

    descView.addEventListener('click', openEditor);

    el.querySelector('.btn-save-desc').addEventListener('click', async () => {
      const newDesc = mde ? mde.value() : descTextarea.value;
      if (newDesc !== task.description) {
        try {
          await patchTask(task.id, { action: 'update', title: task.title, description: newDesc });
        } catch (err) { alert('Failed to save: ' + err.message); closeEditor(); }
      } else {
        closeEditor();
      }
    });

    el.querySelector('.btn-cancel-desc').addEventListener('click', closeEditor);
  }

  // ── Card actions ──────────────────────────────────────────────────────────
  el.querySelector('.btn-complete')?.addEventListener('click', () =>
    patchTask(task.id, { action: 'complete' }).catch(e => alert(e.message)));

  el.querySelector('.btn-snooze')?.addEventListener('click', () =>
    patchTask(task.id, { action: 'snooze', minutes: 60 }).catch(e => alert(e.message)));

  el.querySelector('.btn-delete').addEventListener('click', async () => {
    if (confirm(`Delete "${task.title}"?`)) {
      await deleteTask(task.id).catch(e => alert(e.message));
    }
  });

  // ── Check-in ──────────────────────────────────────────────────────────────
  const checkinArea = el.querySelector('.checkin-area');
  const checkinNote = el.querySelector('.checkin-note');
  el.querySelector('.btn-checkin')?.addEventListener('click', () => {
    checkinArea.classList.toggle('hidden');
    if (!checkinArea.classList.contains('hidden')) checkinNote.focus();
  });
  el.querySelector('.btn-submit-checkin')?.addEventListener('click', async () => {
    const note = checkinNote.value.trim();
    await patchTask(task.id, { action: 'checkin', note }).catch(e => alert(e.message));
  });

  // ── Check-in history ──────────────────────────────────────────────────────
  const historySection = el.querySelector('.checkin-history');
  let historyLoaded = false;

  el.querySelector('.btn-history').addEventListener('click', async () => {
    if (!historySection.classList.contains('hidden')) {
      historySection.classList.add('hidden');
      return;
    }
    historySection.classList.remove('hidden');
    if (historyLoaded) return;

    historySection.innerHTML = '<span class="loading-small">Loading…</span>';
    try {
      const checkins = await api('GET', `/tasks/${task.id}/checkins`);
      historyLoaded = true;
      if (checkins.length === 0) {
        historySection.innerHTML = '<span class="no-history">No check-in history yet.</span>';
      } else {
        historySection.innerHTML = checkins.map(c => `
          <div class="history-item">
            <span class="history-time">${new Date(c.created_at).toLocaleString()}</span>
            <span class="history-note">${c.note ? esc(c.note) : '<em>No note</em>'}</span>
          </div>
        `).join('');
      }
    } catch (e) {
      historySection.innerHTML = `<span class="error-msg">Failed to load history</span>`;
    }
  });

  // ── Tag removal ───────────────────────────────────────────────────────────
  el.querySelectorAll('.tag-remove').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const tagId = parseInt(btn.dataset.tagId, 10);
      try {
        await api('DELETE', `/tasks/${task.id}/tags/${tagId}`);
        const t = allTasks.find(t => t.id === task.id);
        if (t) t.tags = (t.tags || []).filter(tt => tt.id !== tagId);
        renderTasks();
      } catch (e) { alert(e.message); }
    });
  });

  // ── Tag autocomplete ──────────────────────────────────────────────────────
  const acInput    = el.querySelector('.tag-ac-input');
  const acDropdown = el.querySelector('.tag-ac-dropdown');
  if (acInput && acDropdown) {
    let activeIdx = -1;

    const getMatches = () => {
      const q = acInput.value.toLowerCase().trim();
      return q ? availableTags.filter(t => t.name.toLowerCase().includes(q)) : availableTags;
    };

    const assignTag = async tagId => {
      acInput.value = '';
      acDropdown.classList.add('hidden');
      try {
        await api('POST', `/tasks/${task.id}/tags`, { tagId });
        const tag = allTags.find(t => t.id === tagId);
        const t   = allTasks.find(t => t.id === task.id);
        if (tag && t) t.tags = [...(t.tags || []), tag];
        renderTasks();
      } catch (e) { alert(e.message); }
    };

    const renderDropdown = () => {
      const matches = getMatches();
      if (matches.length === 0) { acDropdown.classList.add('hidden'); return; }
      activeIdx = -1;
      acDropdown.innerHTML = matches.map(t =>
        `<div class="tag-ac-item" data-tag-id="${t.id}">${esc(t.name)}</div>`
      ).join('');
      const rect = acInput.getBoundingClientRect();
      acDropdown.style.top  = `${rect.bottom + 3}px`;
      acDropdown.style.left = `${rect.left}px`;
      acDropdown.classList.remove('hidden');
      acDropdown.querySelectorAll('.tag-ac-item').forEach(item => {
        item.addEventListener('mousedown', e => {
          e.preventDefault(); // keep focus on input until we're done
          assignTag(parseInt(item.dataset.tagId, 10));
        });
      });
    };

    acInput.addEventListener('focus', renderDropdown);
    acInput.addEventListener('input', renderDropdown);
    acInput.addEventListener('blur', () => setTimeout(() => acDropdown.classList.add('hidden'), 120));
    acInput.addEventListener('keydown', e => {
      const items = [...acDropdown.querySelectorAll('.tag-ac-item')];
      if (e.key === 'Escape') { acDropdown.classList.add('hidden'); acInput.blur(); }
      else if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIdx = Math.min(activeIdx + 1, items.length - 1);
        items.forEach((it, i) => it.classList.toggle('active', i === activeIdx));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIdx = Math.max(activeIdx - 1, 0);
        items.forEach((it, i) => it.classList.toggle('active', i === activeIdx));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeIdx >= 0 && items[activeIdx]) {
          assignTag(parseInt(items[activeIdx].dataset.tagId, 10));
        }
      }
    });
  }

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
  // Load tags first so tag pickers are populated when task cards render
  fetchTags().then(() => fetchTasks()).catch(e => console.error(e));
  fetchTelegramStatus();
  initQuietHoursUI();
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(updateCountdowns, 30_000);
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(async () => {
    try {
      const fresh = await api('GET', '/tasks?status=all');
      const sig = t => `${t.id}:${t.next_reminder}:${t.status}`;
      if (allTasks.map(sig).join('|') !== fresh.map(sig).join('|')) {
        allTasks = fresh;
        renderTasks();
        updateStats();
      }
    } catch { /* network unavailable — skip silently */ }
  }, 30_000);
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
