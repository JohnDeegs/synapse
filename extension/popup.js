/* popup.js — Synapse quick-capture & task list */

let apiBase = '';
let token = '';
let filterDue = 'all';
let allTasks = [];
let allTags = []; // powers quick-add tag name resolution and the manual tag select
let allProjects = []; // powers quick-add project name resolution and the manual project select
let pendingQuickAdd = null; // last parseQuickAdd() result for the new-task title input
let manualTagIds = new Set(); // tag ids picked via #new-tag-select
let manualProjectId = null; // project id picked via #new-project-select

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
      return null;
    }
    const task = await res.json();
    // Clear form and refresh
    document.getElementById('new-title').value = '';
    document.getElementById('new-desc').value = '';
    document.getElementById('new-priority').value = 'P2';
    await loadTasks();
    return task;
  } catch (err) {
    errEl.textContent = 'Network error. Is the server running?';
    return null;
  }
}

// ── Quick-add tag/project resolution ────────────────────────────────────────────
// The popup has no tag/project management UI of its own — allTags/allProjects
// here exist only so quick-add can resolve #tag / @project names to ids.
async function fetchAuthed(path) {
  const res = await fetch(`${apiBase}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function postAuthed(path, body) {
  const res = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function loadTagsAndProjects() {
  try {
    [allTags, allProjects] = await Promise.all([fetchAuthed('/tags'), fetchAuthed('/projects')]);
  } catch (err) {
    // Quick-add degrades gracefully if this fails: #tag/@project tokens just won't resolve.
  }
}

async function resolveTagId(name) {
  const existing = allTags.find(t => t.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing.id;
  const tag = await postAuthed('/tags', { name });
  allTags.push(tag);
  return tag.id;
}

async function resolveProjectId(name) {
  const existing = allProjects.find(p => p.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing.id;
  const project = await postAuthed('/projects', { name });
  allProjects.push(project);
  return project.id;
}

// Applies the tag/project/time-of-day parts of a parseQuickAdd() result, plus any
// manually-picked project/tags, to an already-created task. Runs after POST /tasks
// since none of these fields are accepted at creation time.
async function applyQuickAddExtras(taskId, parsed, manual = { tagIds: new Set(), projectId: null }) {
  const tagIdSet = new Set(manual.tagIds);
  if (parsed) {
    for (const tagName of parsed.tags) {
      tagIdSet.add(await resolveTagId(tagName));
    }
  }
  for (const tagId of tagIdSet) {
    await postAuthed(`/tasks/${taskId}/tags`, { tagId });
  }
  let projectId = manual.projectId;
  if (projectId == null && parsed && parsed.project) {
    projectId = await resolveProjectId(parsed.project);
  }
  if (projectId != null) {
    await patchTask(taskId, { action: 'update', project_id: projectId });
  }
  if (parsed && parsed.dueTimeMs) {
    const minutes = Math.round((parsed.dueTimeMs - Date.now()) / 60000);
    await patchTask(taskId, { action: 'snooze', minutes });
  }
}

function renderNewTaskPickers() {
  const projectSelect = document.getElementById('new-project-select');
  const tagSelect = document.getElementById('new-tag-select');
  if (projectSelect) {
    const options = allProjects.map(p => `<option value="${p.id}">${escHtml(p.name)}</option>`).join('');
    projectSelect.innerHTML = `<option value="">— No project —</option>${options}`;
    projectSelect.value = manualProjectId != null && allProjects.some(p => p.id === manualProjectId) ? manualProjectId : '';
  }
  if (tagSelect) {
    const options = allTags.map(t => `<option value="${t.id}">${escHtml(t.name)}</option>`).join('');
    tagSelect.innerHTML = `<option value="">+ Add tag…</option>${options}`;
    tagSelect.value = '';
  }
}

function renderQuickAddPreview() {
  const el = document.getElementById('new-quickadd-preview');
  if (!el) return;
  const chips = [];
  if (pendingQuickAdd) {
    for (const name of pendingQuickAdd.tags) {
      chips.push(`<span class="quickadd-chip quickadd-chip-tag" data-kind="tag" data-source="parsed" data-name="${escHtml(name)}">#${escHtml(name)}<button type="button" title="Remove">×</button></span>`);
    }
    if (pendingQuickAdd.project) {
      chips.push(`<span class="quickadd-chip quickadd-chip-project" data-kind="project" data-source="parsed">@${escHtml(pendingQuickAdd.project)}<button type="button" title="Remove">×</button></span>`);
    }
    if (pendingQuickAdd.dueTimeMs) {
      const timeStr = new Date(pendingQuickAdd.dueTimeMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      chips.push(`<span class="quickadd-chip quickadd-chip-time" data-kind="time" data-source="parsed">⏰ ${escHtml(timeStr)}<button type="button" title="Remove">×</button></span>`);
    }
  }
  for (const tagId of manualTagIds) {
    const tag = allTags.find(t => t.id === tagId);
    const name = tag ? tag.name : tagId;
    chips.push(`<span class="quickadd-chip quickadd-chip-tag" data-kind="tag" data-source="manual" data-id="${tagId}">#${escHtml(name)}<button type="button" title="Remove">×</button></span>`);
  }
  el.innerHTML = chips.join('');
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

  loadTagsAndProjects().then(renderNewTaskPickers);

  // Init due date picker for add form, defaulting to today
  const todayStr = new Date().toISOString().slice(0, 10);
  const addDueBtn = document.getElementById('new-due-date-btn');
  const addTaskDP = new DatePicker(addDueBtn, date => {
    addDueBtn.textContent = date ? `📅 ${date}` : '📅 Set due date';
  }, todayStr);
  addDueBtn.textContent = `📅 ${todayStr}`;

  // Quick-add: live-parse the title field into priority/due-date/tags/project
  document.getElementById('new-title').addEventListener('input', e => {
    pendingQuickAdd = parseQuickAdd(e.target.value, {
      tagNames: allTags.map(t => t.name),
      projectNames: allProjects.map(p => p.name),
    });
    if (pendingQuickAdd.priority) document.getElementById('new-priority').value = pendingQuickAdd.priority;
    if (pendingQuickAdd.dueDate) {
      addTaskDP.setValue(pendingQuickAdd.dueDate);
      addDueBtn.textContent = `📅 ${pendingQuickAdd.dueDate}`;
    }
    renderQuickAddPreview();
  });

  // Quick-add preview chip removal (delegated — chips are re-rendered on every keystroke)
  document.getElementById('new-quickadd-preview').addEventListener('click', e => {
    const chip = e.target.closest('.quickadd-chip');
    if (!chip) return;
    if (chip.dataset.source === 'manual') {
      manualTagIds.delete(parseInt(chip.dataset.id, 10));
      renderQuickAddPreview();
      return;
    }
    if (!pendingQuickAdd) return;
    const kind = chip.dataset.kind;
    if (kind === 'tag') pendingQuickAdd.tags = pendingQuickAdd.tags.filter(n => n !== chip.dataset.name);
    else if (kind === 'project') pendingQuickAdd.project = null;
    else if (kind === 'time') pendingQuickAdd.dueTimeMs = null;
    renderQuickAddPreview();
  });

  // Manual project/tag pickers
  document.getElementById('new-project-select').addEventListener('change', e => {
    manualProjectId = e.target.value ? parseInt(e.target.value, 10) : null;
  });
  document.getElementById('new-tag-select').addEventListener('change', e => {
    if (!e.target.value) return;
    manualTagIds.add(parseInt(e.target.value, 10));
    e.target.value = '';
    renderQuickAddPreview();
  });

  // Quick-add form submit
  document.getElementById('add-form').addEventListener('submit', async e => {
    e.preventDefault();
    const rawTitle = document.getElementById('new-title').value.trim();
    const parsed = pendingQuickAdd;
    const title = parsed ? parsed.title : rawTitle;
    const priority = document.getElementById('new-priority').value;
    const description = document.getElementById('new-desc').value.trim();
    const dueDate = addTaskDP.value;
    if (!title) return;
    const task = await addTask(title, priority, description, dueDate);
    if (task) {
      try {
        await applyQuickAddExtras(task.id, parsed, { tagIds: manualTagIds, projectId: manualProjectId });
      } catch (err) { /* extras are best-effort */ }
      await loadTasks();
      renderNewTaskPickers();
    }
    pendingQuickAdd = null;
    manualTagIds = new Set();
    manualProjectId = null;
    document.getElementById('new-project-select').value = '';
    renderQuickAddPreview();
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
