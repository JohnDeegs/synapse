/* popup.js — Synapse quick-capture & task list */

let apiBase = '';
let token = '';

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

  if (tasks.length === 0) {
    list.innerHTML = '<div class="empty">No active tasks. Add one above!</div>';
    return;
  }

  // Sort by nextReminder ascending
  tasks.sort((a, b) => a.next_reminder - b.next_reminder);

  tasks.forEach(task => {
    const card = document.createElement('div');
    card.className = 'task-card';
    card.dataset.id = task.id;

    const countdown = formatCountdown(new Date(task.next_reminder).getTime());

    card.innerHTML = `
      <div class="task-header">
        <span class="priority-badge ${priorityClass(task.priority)}">${task.priority}</span>
        <span class="task-title">${escHtml(task.title)}</span>
      </div>
      <div class="task-countdown${countdown.overdue ? ' overdue' : ''}">${countdown.text}</div>
      <div class="task-actions">
        <button class="btn-checkin">Check-in</button>
        <button class="btn-complete">Complete</button>
        <button class="btn-snooze">Snooze 1hr</button>
      </div>
      <div class="checkin-row" style="display:none">
        <input type="text" class="checkin-note" placeholder="Note (optional)" />
        <button class="btn-checkin-submit">OK</button>
      </div>
    `;

    // Check-in: toggle note input
    card.querySelector('.btn-checkin').addEventListener('click', () => {
      const row = card.querySelector('.checkin-row');
      const visible = row.style.display !== 'none';
      row.style.display = visible ? 'none' : 'flex';
      if (!visible) card.querySelector('.checkin-note').focus();
    });

    // Submit check-in
    card.querySelector('.btn-checkin-submit').addEventListener('click', () => {
      const note = card.querySelector('.checkin-note').value.trim();
      patchTask(task.id, { action: 'checkin', note });
    });

    // Allow Enter in checkin note to submit
    card.querySelector('.checkin-note').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const note = card.querySelector('.checkin-note').value.trim();
        patchTask(task.id, { action: 'checkin', note });
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
    const tasks = await res.json();
    loading.style.display = 'none';
    list.style.display = 'flex';
    renderTasks(tasks);
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

async function addTask(title, priority, description) {
  const errEl = document.getElementById('add-error');
  errEl.textContent = '';
  try {
    const res = await fetch(`${apiBase}/tasks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ title, priority, description })
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

  // Quick-add form submit
  document.getElementById('add-form').addEventListener('submit', e => {
    e.preventDefault();
    const title = document.getElementById('new-title').value.trim();
    const priority = document.getElementById('new-priority').value;
    const description = document.getElementById('new-desc').value.trim();
    if (title) addTask(title, priority, description);
  });

  loadTasks();
});
