/* popup.js — Synapse quick-capture & task list */

let apiBase = '';
let token = '';
let filterDue = 'all';
let allTasks = [];

function applyDueFilter(tasks) {
  if (filterDue === 'all') return tasks;
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  return tasks.filter(task => {
    if (!task.due_date) return false;
    if (filterDue === 'today') return task.due_date === todayStr;
    if (filterDue === 'week') {
      const due = new Date(task.due_date + 'T00:00:00');
      const weekEnd = new Date(today); weekEnd.setDate(weekEnd.getDate() + 7);
      return due >= new Date(todayStr + 'T00:00:00') && due <= weekEnd;
    }
    if (filterDue === 'month') {
      const due = new Date(task.due_date + 'T00:00:00');
      return due.getMonth() === today.getMonth() && due.getFullYear() === today.getFullYear();
    }
    return true;
  });
}

function formatCountdown(nextReminderMs) {
  const diffMs = nextReminderMs - Date.now();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 0) return { text: `overdue by ${Math.abs(diffMin)} min`, overdue: true };
  if (diffMin === 0) return { text: 'due now', overdue: true };
  if (diffMin < 60) return { text: `in ${diffMin} min`, overdue: false };
  const h = Math.floor(diffMin / 60);
  const m = diffMin % 60;
  if (h < 24) return { text: m > 0 ? `in ${h}h ${m}m` : `in ${h}h`, overdue: false };
  const d = Math.floor(h / 24);
  return { text: `in ${d}d`, overdue: false };
}

function priorityClass(p) {
  return p.toLowerCase();
}

function renderTasks(tasks) {
  const list = document.getElementById('task-list');
  list.innerHTML = '';

  const visible = applyDueFilter(tasks);

  if (visible.length === 0) {
    list.innerHTML = `<div class="empty">${filterDue === 'all' ? 'No active tasks. Add one above!' : 'No tasks match this due date filter.'}</div>`;
    return;
  }

  // Sort by nextReminder ascending
  visible.sort((a, b) => new Date(a.next_reminder) - new Date(b.next_reminder));

  visible.forEach(task => {
    const card = document.createElement('div');
    card.className = 'task-card';
    card.dataset.id = task.id;

    const countdown = formatCountdown(new Date(task.next_reminder).getTime());

    card.innerHTML = `
      <div class="task-header">
        <select class="priority-select ${priorityClass(task.priority)}">${['P0','P1','P2','P3','P4'].map(p => `<option value="${p}"${p === task.priority ? ' selected' : ''}>${p}</option>`).join('')}</select>
        <span class="task-title">${escHtml(task.title)}</span>
      </div>
      <div class="task-countdown${countdown.overdue ? ' overdue' : ''}">${countdown.text}</div>
      <button type="button" class="task-due-btn">${task.due_date ? `📅 ${task.due_date}` : '📅 Set due date'}</button>
      <div class="task-actions">
        <button class="btn-checkin">Check-in</button>
        <button class="btn-complete">Complete</button>
        <button class="btn-snooze">Snooze 1hr</button>
      </div>
      <div class="checkin-row" style="display:none">
        <select class="checkin-priority">
          <option value="P0">P0</option>
          <option value="P1">P1</option>
          <option value="P2">P2</option>
          <option value="P3">P3</option>
          <option value="P4">P4</option>
        </select>
        <input type="text" class="checkin-note" placeholder="Note (optional)" />
        <button class="btn-checkin-submit">OK</button>
      </div>
    `;

    // Priority select
    const prioritySel = card.querySelector('.priority-select');
    prioritySel.addEventListener('change', function () {
      prioritySel.className = `priority-select ${priorityClass(this.value)}`;
      patchTask(task.id, { action: 'update', priority: this.value });
    });

    // Due date picker
    const dueBtn = card.querySelector('.task-due-btn');
    new DatePicker(dueBtn, date => {
      dueBtn.textContent = date ? `📅 ${date}` : '📅 Set due date';
      patchTask(task.id, { action: 'update', title: task.title, description: task.description, due_date: date });
    }, task.due_date);

    // Check-in: toggle note input
    card.querySelector('.btn-checkin').addEventListener('click', () => {
      const row = card.querySelector('.checkin-row');
      const visible = row.style.display !== 'none';
      row.style.display = visible ? 'none' : 'flex';
      if (!visible) {
        card.querySelector('.checkin-priority').value = task.priority;
        card.querySelector('.checkin-note').focus();
      }
    });

    // Submit check-in
    card.querySelector('.btn-checkin-submit').addEventListener('click', () => {
      const note = card.querySelector('.checkin-note').value.trim();
      const priority = card.querySelector('.checkin-priority').value;
      patchTask(task.id, { action: 'checkin', note, priority });
    });

    // Allow Enter in checkin note to submit
    card.querySelector('.checkin-note').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const note = card.querySelector('.checkin-note').value.trim();
        const priority = card.querySelector('.checkin-priority').value;
        patchTask(task.id, { action: 'checkin', note, priority });
      }
    });

    // Complete
    card.querySelector('.btn-complete').addEventListener('click', () => {
      patchTask(task.id, { action: 'complete' });
    });

    // Snooze 1hr
    card.querySelector('.btn-snooze').addEventListener('click', () => {
      patchTask(task.id, { action: 'snooze', minutes: 60 });
    });

    list.appendChild(card);
  });
}

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loadTasks() {
  const loading = document.getElementById('loading');
  const list = document.getElementById('task-list');
  loading.style.display = 'block';
  list.style.display = 'none';

  try {
    const res = await fetch(`${apiBase}/tasks`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    allTasks = await res.json();
    loading.style.display = 'none';
    list.style.display = 'flex';
    renderTasks(allTasks);
  } catch (err) {
    loading.textContent = 'Failed to load tasks.';
  }
}

async function patchTask(id, body) {
  try {
    const res = await fetch(`${apiBase}/tasks/${id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadTasks();
  } catch (err) {
    // Silently reload to reflect current state
    await loadTasks();
  }
}

async function addTask(title, priority, description, dueDate) {
  const errEl = document.getElementById('add-error');
  errEl.textContent = '';
  try {
    const body = { title, priority, description };
    if (dueDate) body.due_date = dueDate;
    const res = await fetch(`${apiBase}/tasks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      errEl.textContent = data.error || `Error ${res.status}`;
      return;
    }
    // Clear form and refresh
    document.getElementById('new-title').value = '';
    document.getElementById('new-desc').value = '';
    document.getElementById('new-priority').value = 'P2';
    await loadTasks();
  } catch (err) {
    errEl.textContent = 'Network error. Is the server running?';
  }
}

// Init
chrome.storage.local.get(['token', 'apiBase'], data => {
  if (!data.token || !data.apiBase) {
    document.getElementById('auth-notice').style.display = 'block';
    document.getElementById('opts-link').addEventListener('click', e => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
    });
    return;
  }

  token = data.token;
  apiBase = data.apiBase.replace(/\/$/, '');

  document.getElementById('main').style.display = 'block';

  // Init due date picker for add form, defaulting to today
  const todayStr = new Date().toISOString().slice(0, 10);
  const addDueBtn = document.getElementById('new-due-date-btn');
  const addTaskDP = new DatePicker(addDueBtn, date => {
    addDueBtn.textContent = date ? `📅 ${date}` : '📅 Set due date';
  }, todayStr);
  addDueBtn.textContent = `📅 ${todayStr}`;

  // Quick-add form submit
  document.getElementById('add-form').addEventListener('submit', e => {
    e.preventDefault();
    const title = document.getElementById('new-title').value.trim();
    const priority = document.getElementById('new-priority').value;
    const description = document.getElementById('new-desc').value.trim();
    const dueDate = addTaskDP.value;
    if (title) addTask(title, priority, description, dueDate);
  });

  // Due date filter buttons
  document.getElementById('due-filters').addEventListener('click', e => {
    const btn = e.target.closest('.due-filter');
    if (!btn) return;
    filterDue = btn.dataset.filter;
    document.querySelectorAll('.due-filter').forEach(b => b.classList.toggle('active', b === btn));
    renderTasks(allTasks);
  });

  loadTasks();
});
