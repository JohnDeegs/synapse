'use strict';

// ── State ──────────────────────────────────────────────────────────────────────
let token     = localStorage.getItem('synapse_token');
let userEmail = localStorage.getItem('synapse_email');
let allTasks  = [];
let sortBy       = 'next_reminder';
let filterStatus = 'active';
let countdownTimer = null;
let newTaskMDE = null; // EasyMDE instance for the new-task form (lazy-init)

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
  token = null; userEmail = null; allTasks = [];
  localStorage.removeItem('synapse_token');
  localStorage.removeItem('synapse_email');
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  showLogin();
}

// ── Task API ───────────────────────────────────────────────────────────────────
async function fetchTasks() {
  allTasks = await api('GET', '/tasks?status=all');
  renderTasks();
  updateStats();
}

async function createTask(title, priority, description) {
  const task = await api('POST', '/tasks', { title, priority, description });
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
  renderTasks();
  updateStats();
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

function getSortedFilteredTasks() {
  const filtered = allTasks.filter(t => {
    if (filterStatus === 'active')    return t.status === 'active';
    if (filterStatus === 'completed') return t.status === 'completed';
    return true;
  });
  return filtered.sort((a, b) => {
    if (sortBy === 'priority')    return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (sortBy === 'created_at')  return new Date(a.created_at) - new Date(b.created_at);
    return new Date(a.next_reminder) - new Date(b.next_reminder); // next_reminder (default)
  });
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
  const descHtml = task.description
    ? marked.parse(task.description)
    : `<span class="no-desc">No description — click to add</span>`;
  const tagsHtml = (task.tags || []).map(t => `<span class="tag-chip">${esc(t.name)}</span>`).join('');
  const actionsHtml = isActive ? `
    <button class="btn-action btn-complete">✓ Complete</button>
    <button class="btn-action btn-checkin">↻ Check-in</button>
    <button class="btn-action btn-snooze">⏰ Snooze 1h</button>
  ` : '';

  el.innerHTML = `
    <div class="card-header">
      <span class="priority-badge pp${task.priority.toLowerCase()}">${task.priority}</span>
      <span class="task-title">${esc(task.title)}</span>
      <span class="${countdownClass(task.next_reminder)}" data-countdown="${task.next_reminder}">
        ${formatCountdown(task.next_reminder)}
      </span>
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
      <div class="card-tags">${tagsHtml}</div>
      <div class="card-actions">
        ${actionsHtml}
        <button class="btn-action btn-delete">✕ Delete</button>
      </div>
    </div>
    <div class="checkin-area hidden">
      <textarea class="checkin-note" placeholder="Status update…" rows="2"></textarea>
      <button class="btn-primary btn-submit-checkin">Submit check-in</button>
    </div>
  `;

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
  const checkinArea  = el.querySelector('.checkin-area');
  const checkinNote  = el.querySelector('.checkin-note');
  el.querySelector('.btn-checkin')?.addEventListener('click', () => {
    checkinArea.classList.toggle('hidden');
    if (!checkinArea.classList.contains('hidden')) checkinNote.focus();
  });
  el.querySelector('.btn-submit-checkin')?.addEventListener('click', async () => {
    const note = checkinNote.value.trim();
    await patchTask(task.id, { action: 'checkin', note }).catch(e => alert(e.message));
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
    return;
  }
  const frag = document.createDocumentFragment();
  tasks.forEach(t => frag.appendChild(renderCard(t)));
  container.appendChild(frag);
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
  fetchTasks();
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(updateCountdowns, 30_000);
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
    const errEl = document.getElementById('create-error');
    errEl.textContent = '';
    if (!title) { errEl.textContent = 'Title is required.'; return; }
    try {
      await createTask(title, priority, description);
      document.getElementById('new-title').value = '';
      document.getElementById('new-priority').value = 'P2';
      if (newTaskMDE) newTaskMDE.value('');
      document.getElementById('new-task-form').classList.add('hidden');
    } catch (err) { errEl.textContent = err.message; }
  });

  // Also submit new task on Enter in title field
  document.getElementById('new-title').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-create-task').click();
  });

  // Sort / filter
  document.getElementById('filter-status').addEventListener('change', e => {
    filterStatus = e.target.value;
    renderTasks();
  });
  document.getElementById('sort-by').addEventListener('change', e => {
    sortBy = e.target.value;
    renderTasks();
  });

  // Boot
  if (token) showApp();
  else showLogin();
}

init();
