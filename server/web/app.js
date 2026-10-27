// Synapse web app — PARA folder tree of links. Vanilla JS, no build step.

// ── State ─────────────────────────────────────────────────────────────────────

let token = localStorage.getItem('synapse_token');
let allItems = [];
let byId = new Map();
let children = new Map();   // parentId -> [item]
let activity = new Map();   // itemId -> latest lastTouched in its subtree
let search = { q: '', tag: '', para: '', priority: '' };
let editing = null;         // { mode: 'create'|'edit', type, item? }
const ai = { status: 'off', model: null, index: null };
const aiEnabled = () => localStorage.getItem('synapse_ai') !== 'off';
const dismissedHints = new Set(readJson('synapse_dismissed_hints', []));

const expanded = new Set(readJson('synapse_expanded', ['root-projects', 'root-areas']));
const ROOT_IDS = ['root-projects', 'root-areas', 'root-resources', 'root-archive'];
const KIND_ICONS = { gdoc: '📄', sharepoint: '📘', local: '💾', other: '🔗' };
const DUE_SOON_DAYS = 14;

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
}

const $ = id => document.getElementById(id);

// ── Utilities ─────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const isWebUrl = u => /^https?:\/\//i.test(u || '');

function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysBetween(fromDateStr, toDateStr) {
  return Math.round((Date.parse(toDateStr + 'T00:00:00Z') - Date.parse(fromDateStr + 'T00:00:00Z')) / 86400000);
}

function ago(iso) {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.floor(days / 7)}w ago`;
  if (days < 730) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function dueLabel(dueDate) {
  const d = daysBetween(localDate(), dueDate);
  if (d < 0) return { text: `overdue ${-d}d`, cls: 'due-over' };
  if (d === 0) return { text: 'due today', cls: 'due-soon' };
  if (d <= 3) return { text: `due in ${d}d`, cls: 'due-soon' };
  return { text: `due ${dueDate}`, cls: '' };
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), 2500);
}

// ── API ───────────────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) { logout(); throw new Error('Session expired'); }
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}

async function loadItems() {
  allItems = await api('GET', '/items');
  indexItems();
  render();
  if (ai.model) backfill();
}

function indexItems() {
  byId = new Map(allItems.map(i => [i.id, i]));
  children = new Map();
  activity = new Map();
  for (const i of allItems) {
    if (i.parentId) {
      if (!children.has(i.parentId)) children.set(i.parentId, []);
      children.get(i.parentId).push(i);
    }
    for (const id of [i.id, ...i.path]) {
      if (!activity.has(id) || activity.get(id) < i.lastTouched) activity.set(id, i.lastTouched);
    }
  }
  const prio = i => i.priority ? Number(i.priority[1]) : 9;
  for (const list of children.values()) {
    list.sort((a, b) =>
      (a.type === b.type ? 0 : a.type === 'folder' ? -1 : 1) ||
      prio(a) - prio(b) ||
      a.title.localeCompare(b.title));
  }
  ai.index = ai.model ? SynapseAI.buildIndex(allItems) : null;
}

function descendantsOf(id) {
  return allItems.filter(i => i.path.includes(id));
}

function pathTitles(item) {
  return item.path.map(id => byId.get(id)?.title).filter(Boolean);
}

function folderLabel(id) {
  const f = byId.get(id);
  return f ? [...pathTitles(f), f.title].join(' / ') : '';
}

// ── On-device AI ──────────────────────────────────────────────────────────────
// See synapse-ai.js. Vectors are computed here and stored on the server so
// every device can use them; the model itself never leaves the browser.

function setAiStatus(status, detail) {
  ai.status = status;
  $('ai-status').textContent = detail || { off: '(off)', loading: '(loading…)', ready: '(ready)', error: '(unavailable)' }[status];
}

async function startAI() {
  if (!aiEnabled()) return setAiStatus('off');
  if (ai.model || ai.status === 'loading') return;
  if (navigator.connection?.saveData) return setAiStatus('off', '(paused: data saver is on)');
  setAiStatus('loading');
  try {
    const model = await SynapseAI.load();
    if (!aiEnabled()) return setAiStatus('off');
    ai.model = model;
    setAiStatus('ready');
    indexItems();
    renderMain();
    await backfill();
  } catch (e) {
    console.warn('On-device AI unavailable:', e);
    setAiStatus('error', `(unavailable: ${e.message})`);
  }
}

function stopAI() {
  ai.model = null;
  ai.index = null;
  setAiStatus('off');
  renderMain();
}

let backfilling = false;

/** Compute and upload vectors for items that have none for the current model. */
async function backfill() {
  if (!ai.model || backfilling) return;
  backfilling = true;
  try {
    const need = SynapseAI.missing(allItems);
    for (let i = 0; i < need.length; i += 200) {
      const vectors = {};
      for (const item of need.slice(i, i + 200)) {
        const v = SynapseAI.embed(ai.model, SynapseAI.textFor(item));
        if (!v) continue;
        vectors[item.id] = SynapseAI.encode(v);
        item.embedding = { model: SynapseAI.MODEL_ID, v: vectors[item.id] };
      }
      if (Object.keys(vectors).length) await api('POST', '/items/embeddings', { model: SynapseAI.MODEL_ID, vectors });
    }
    if (need.length) { indexItems(); renderMain(); }
  } catch (e) {
    console.warn('Embedding backfill failed:', e);
  } finally {
    backfilling = false;
  }
}

const hintKey = h => h.type === 'move' ? `move:${h.itemId}:${h.toFolderId}` : `dup:${[h.itemId, h.otherId].sort().join(':')}`;

function hintsHtml() {
  if (!ai.index) return ai.status === 'loading' ? '<p class="muted small">Looking for tidy-up hints…</p>' : '';
  const hs = SynapseAI.hints(ai.index).filter(h => !dismissedHints.has(hintKey(h)));
  if (!hs.length) return '';
  const linkTo = item => `<a href="#/f/${esc(item.parentId)}">${esc(item.title)}</a>`;
  return `
    <section class="section">
      <h2 class="section-heading">Tidy-up hints</h2>
      ${hs.map(h => {
        const item = byId.get(h.itemId);
        const dismiss = `<button class="btn-small" data-dismiss="${esc(hintKey(h))}">Dismiss</button>`;
        if (h.type === 'move') {
          return `<div class="hint-row">
            <div class="row-body">“${linkTo(item)}” in ${esc(folderLabel(item.parentId))} looks like it belongs in <b>${esc(folderLabel(h.toFolderId))}</b></div>
            <button class="btn-small" data-move="${esc(item.id)}" data-to="${esc(h.toFolderId)}">Move</button>${dismiss}
          </div>`;
        }
        const other = byId.get(h.otherId);
        return `<div class="hint-row">
          <div class="row-body">“${linkTo(item)}” (${esc(folderLabel(item.parentId))}) and “${linkTo(other)}” (${esc(folderLabel(other.parentId))}) look like the same thing</div>
          ${dismiss}
        </div>`;
      }).join('')}
    </section>`;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function showLogin() {
  $('view-app').classList.add('hidden');
  $('view-login').classList.remove('hidden');
}

async function showApp() {
  $('view-login').classList.add('hidden');
  $('view-app').classList.remove('hidden');
  await loadItems();
  handleShare();
  startAI();
}

function logout() {
  token = null;
  localStorage.removeItem('synapse_token');
  showLogin();
}

async function authSubmit(path, email, password, errorEl) {
  errorEl.textContent = '';
  try {
    const data = await api('POST', path, { email, password });
    token = data.token;
    localStorage.setItem('synapse_token', token);
    await showApp();
  } catch (e) {
    errorEl.textContent = e.message;
  }
}

// ── Rendering: sidebar ────────────────────────────────────────────────────────

function render() {
  renderTree();
  renderTags();
  renderMain();
}

function renderTree() {
  const current = currentFolderId();
  function branch(id, depth) {
    const item = byId.get(id);
    if (!item) return '';
    const kids = (children.get(id) || []).filter(c => c.type === 'folder');
    const open = expanded.has(id);
    const twisty = kids.length
      ? `<button class="twisty" data-toggle="${esc(id)}" aria-label="${open ? 'Collapse' : 'Expand'}">${open ? '▾' : '▸'}</button>`
      : '<span class="twisty"></span>';
    return `
      <div class="tree-row ${id === current ? 'active' : ''}" style="padding-left:${depth * 14 + 4}px">
        ${twisty}<a href="#/f/${esc(id)}" class="tree-link">${esc(item.title)}</a>
      </div>
      ${open ? kids.map(k => branch(k.id, depth + 1)).join('') : ''}`;
  }
  $('tree').innerHTML = ROOT_IDS.map(id => branch(id, 0)).join('');
}

function renderTags() {
  const counts = new Map();
  for (const i of allItems) for (const t of i.tags) counts.set(t, (counts.get(t) || 0) + 1);
  const tags = [...counts].sort((a, b) => a[0].localeCompare(b[0]));
  $('tag-list').innerHTML = tags.length
    ? tags.map(([t, n]) => `<button class="chip ${search.tag === t ? 'chip-active' : ''}" data-tag="${esc(t)}">#${esc(t)} <span class="chip-count">${n}</span></button>`).join('')
    : '<p class="muted small">No tags yet</p>';
  $('tag-options').innerHTML = tags.map(([t]) => `<option value="${esc(t)}">`).join('');
}

// ── Rendering: rows ───────────────────────────────────────────────────────────

function metaHtml(item) {
  const parts = [];
  if (item.priority) parts.push(`<span class="badge badge-${item.priority.toLowerCase()}">${item.priority}</span>`);
  if (item.dueDate) {
    const d = dueLabel(item.dueDate);
    parts.push(`<span class="due ${d.cls}" title="${esc(item.dueDate)}">${esc(d.text)}</span>`);
  }
  for (const t of item.tags) parts.push(`<button class="chip chip-small" data-tag="${esc(t)}">#${esc(t)}</button>`);
  const touched = item.type === 'folder' ? activity.get(item.id) : item.lastTouched;
  if (touched) parts.push(`<span class="muted">${item.type === 'folder' ? 'active' : 'touched'} ${ago(touched)}</span>`);
  return parts.join('');
}

function rowHtml(item, { showPath = false } = {}) {
  let titleHtml, icon, action = '';
  if (item.type === 'folder') {
    icon = '📁';
    const count = descendantsOf(item.id).filter(i => i.type === 'link').length;
    titleHtml = `<a href="#/f/${esc(item.id)}" class="row-title">${esc(item.title)}</a> <span class="muted small">${count} link${count === 1 ? '' : 's'}</span>`;
  } else {
    icon = KIND_ICONS[item.kind] || '🔗';
    if (isWebUrl(item.url)) {
      titleHtml = `<a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer" class="row-title" data-open="${esc(item.id)}">${esc(item.title)}</a>`;
    } else {
      titleHtml = `<span class="row-title">${esc(item.title)}</span>`;
      action = `<button class="btn-small" data-copy="${esc(item.id)}" title="${esc(item.url)}">Copy path</button>`;
    }
  }
  return `
    <div class="row" data-id="${esc(item.id)}">
      <span class="row-icon" aria-hidden="true">${icon}</span>
      <div class="row-body">
        <div class="row-head">${titleHtml}</div>
        ${showPath ? `<div class="row-path muted small">${esc(pathTitles(item).join(' / '))}</div>` : ''}
        ${item.note ? `<div class="row-note">${esc(item.note)}</div>` : ''}
        <div class="row-meta">${metaHtml(item)}</div>
      </div>
      <div class="row-actions">
        ${action}
        <button class="btn-icon" data-edit="${esc(item.id)}" aria-label="Edit">✎</button>
      </div>
    </div>`;
}

// ── Rendering: main views ─────────────────────────────────────────────────────

function route() {
  const h = location.hash.replace(/^#/, '') || '/';
  if (h.startsWith('/f/')) return { view: 'folder', id: decodeURIComponent(h.slice(3)) };
  if (h === '/review') return { view: 'review' };
  return { view: 'home' };
}

function currentFolderId() {
  const r = route();
  return r.view === 'folder' ? r.id : null;
}

function searching() {
  return !!(search.q || search.tag || search.para || search.priority);
}

function renderMain() {
  const main = $('main');
  if (searching()) return (main.innerHTML = searchView());
  const r = route();
  if (r.view === 'folder' && byId.has(r.id)) return (main.innerHTML = folderView(byId.get(r.id)));
  if (r.view === 'review') return (main.innerHTML = reviewView());
  main.innerHTML = homeView();
}

function dueSoonItems() {
  const limit = localDate(new Date(Date.now() + DUE_SOON_DAYS * 86400000));
  return allItems
    .filter(i => i.dueDate && i.dueDate <= limit && i.para !== 'archive')
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

function homeView() {
  const due = dueSoonItems();
  const recent = allItems.filter(i => i.type === 'link')
    .sort((a, b) => b.lastTouched.localeCompare(a.lastTouched)).slice(0, 8);

  const cards = ROOT_IDS.map(id => {
    const root = byId.get(id);
    if (!root) return '';
    const folders = (children.get(id) || []).filter(c => c.type === 'folder').length;
    const links = descendantsOf(id).filter(i => i.type === 'link').length;
    return `
      <a href="#/f/${id}" class="para-card">
        <span class="para-title">${esc(root.title)}</span>
        <span class="muted small">${folders} folder${folders === 1 ? '' : 's'} · ${links} link${links === 1 ? '' : 's'}</span>
      </a>`;
  }).join('');

  return `
    ${due.length ? `<section class="section"><h2 class="section-heading">Due soon</h2>${due.map(i => rowHtml(i, { showPath: true })).join('')}</section>` : ''}
    <section class="section"><div class="para-grid">${cards}</div></section>
    <section class="section">
      <h2 class="section-heading">Recently touched</h2>
      ${recent.length ? recent.map(i => rowHtml(i, { showPath: true })).join('') : emptyHint()}
    </section>`;
}

function emptyHint() {
  return `<p class="muted empty">Nothing filed yet. Open a folder and add a link, or use the Chrome extension to file the tab you're on.</p>`;
}

function folderView(folder) {
  const crumbs = folder.path.map(id => byId.get(id)).filter(Boolean)
    .map(f => `<a href="#/f/${esc(f.id)}">${esc(f.title)}</a>`).join(' / ');
  const kids = children.get(folder.id) || [];
  const isRoot = folder.parentId === null;
  return `
    <div class="folder-header">
      ${crumbs ? `<div class="crumbs small">${crumbs} /</div>` : ''}
      <div class="folder-title-row">
        <h1 class="folder-title">${esc(folder.title)}</h1>
        <div class="folder-actions">
          <button class="btn-primary" data-new="link">+ Link</button>
          <button class="btn-secondary" data-new="folder">+ Folder</button>
          ${isRoot ? '' : `<button class="btn-icon" data-edit="${esc(folder.id)}" aria-label="Edit folder">✎</button>`}
        </div>
      </div>
      ${folder.note ? `<p class="folder-note">${esc(folder.note)}</p>` : ''}
      ${isRoot ? '' : `<div class="row-meta">${metaHtml(folder)}</div>`}
    </div>
    ${kids.length ? kids.map(i => rowHtml(i)).join('') : `<p class="muted empty">Empty folder. Add a link or a sub-folder.</p>`}`;
}

function passesFilters(i) {
  if (i.parentId === null) return false;
  if (search.tag && !i.tags.includes(search.tag)) return false;
  if (search.para && i.para !== search.para) return false;
  if (search.priority && i.priority !== search.priority) return false;
  return true;
}

function searchMatches() {
  const terms = search.q.toLowerCase().split(/\s+/).filter(Boolean);
  return allItems.filter(i => {
    if (!passesFilters(i)) return false;
    if (!terms.length) return true;
    const hay = [i.title, i.note, i.url || '', ...i.tags].join(' ').toLowerCase();
    return terms.every(t => hay.includes(t));
  }).sort((a, b) => b.lastTouched.localeCompare(a.lastTouched));
}

/** Items close in meaning to the query that keyword search didn't find. */
function relatedResults(exclude) {
  if (!ai.index || search.q.length < 3) return [];
  return SynapseAI.search(ai.index, SynapseAI.embed(ai.model, search.q))
    .map(r => byId.get(r.id))
    .filter(i => i && !exclude.has(i.id) && passesFilters(i));
}

function searchView() {
  const results = searchMatches();
  const related = relatedResults(new Set(results.map(i => i.id)));
  const opt = (value, label, current) => `<option value="${value}" ${value === current ? 'selected' : ''}>${label}</option>`;
  return `
    <div class="filter-bar">
      <select id="filter-para" aria-label="PARA area">
        ${opt('', 'Everywhere', search.para)}${opt('projects', 'Projects', search.para)}${opt('areas', 'Areas', search.para)}${opt('resources', 'Resources', search.para)}${opt('archive', 'Archive', search.para)}
      </select>
      <select id="filter-priority" aria-label="Priority">
        ${opt('', 'Any priority', search.priority)}${['P0', 'P1', 'P2', 'P3', 'P4'].map(p => opt(p, p, search.priority)).join('')}
      </select>
      ${search.tag ? `<button class="chip chip-active" data-clear-tag>#${esc(search.tag)} ✕</button>` : ''}
      <button class="btn-text" data-clear-search>Clear</button>
    </div>
    <p class="muted small">${results.length} result${results.length === 1 ? '' : 's'}</p>
    ${results.map(i => rowHtml(i, { showPath: true })).join('')}
    ${related.length ? `<h2 class="section-heading related-heading">Related by meaning</h2>${related.map(i => rowHtml(i, { showPath: true })).join('')}` : ''}`;
}

function reviewView() {
  const now = Date.now();
  const staleDays = id => Math.floor((now - Date.parse(activity.get(id))) / 86400000);
  const section = (rootId, heading, canArchive) => {
    const folders = (children.get(rootId) || []).filter(c => c.type === 'folder')
      .sort((a, b) => activity.get(a.id).localeCompare(activity.get(b.id)));
    if (!folders.length) return '';
    return `
      <section class="section">
        <h2 class="section-heading">${heading}</h2>
        ${folders.map(f => `
          <div class="review-row ${staleDays(f.id) >= 14 ? 'stale' : ''}">
            <div class="row-body">
              <a href="#/f/${esc(f.id)}" class="row-title">${esc(f.title)}</a>
              ${f.note ? `<div class="row-note">${esc(f.note)}</div>` : ''}
              <div class="row-meta">${metaHtml(f)}</div>
            </div>
            <div class="row-actions">
              <button class="btn-small" data-touch="${esc(f.id)}">Still active</button>
              ${canArchive ? `<button class="btn-small" data-archive="${esc(f.id)}">Archive</button>` : ''}
            </div>
          </div>`).join('')}
      </section>`;
  };
  const body = section('root-projects', 'Projects', true) + section('root-areas', 'Areas', false);
  return `
    <div class="folder-header">
      <h1 class="folder-title">Weekly review</h1>
      <p class="folder-note">Stalest first. Mark what's still going, archive what's done.</p>
    </div>
    ${hintsHtml()}
    ${body || '<p class="muted empty">No project or area folders yet.</p>'}`;
}

// ── Editor ────────────────────────────────────────────────────────────────────

function folderOptions(selectedId, excludeId) {
  const excluded = excludeId ? new Set([excludeId, ...descendantsOf(excludeId).map(i => i.id)]) : new Set();
  const out = [];
  for (const id of ROOT_IDS) (function walk(id, depth) {
    const f = byId.get(id);
    if (!f || excluded.has(id)) return;
    out.push(`<option value="${esc(id)}" ${id === selectedId ? 'selected' : ''}>${'   '.repeat(depth)}${esc(f.title)}</option>`);
    for (const c of children.get(id) || []) if (c.type === 'folder') walk(c.id, depth + 1);
  })(id, 0);
  return out.join('');
}

function openEditor({ mode, type, item, parentId, url = '', title = '' }) {
  editing = { mode, type: item ? item.type : type, item };
  const isLink = editing.type === 'link';
  $('editor-heading').textContent = `${mode === 'create' ? 'New' : 'Edit'} ${isLink ? 'link' : 'folder'}`;
  $('editor-url-wrap').classList.toggle('hidden', !isLink);
  $('editor-url').value = item ? item.url || '' : url;
  $('editor-title').value = item ? item.title : title;
  $('editor-title').placeholder = isLink ? 'Defaults to the link' : 'Folder name';
  $('editor-note').value = item ? item.note : '';
  $('editor-parent').innerHTML = folderOptions(item ? item.parentId : parentId, item && item.type === 'folder' ? item.id : null);
  $('editor-priority').value = item?.priority || '';
  $('editor-due').value = item?.dueDate || '';
  $('editor-tags').value = item ? item.tags.join(', ') : '';
  $('editor-delete').classList.toggle('hidden', mode === 'create');
  $('editor-error').textContent = '';
  renderEditorHints();
  $('editor').showModal();
  (isLink && !$('editor-url').value ? $('editor-url') : mode === 'create' && isLink ? $('editor-note') : $('editor-title')).focus();
}

const editorTags = () => $('editor-tags').value.split(',').map(t => t.trim().toLowerCase().replace(/^#/, '')).filter(Boolean);

/** AI chips under the folder picker (new items only) and the tags field. */
function renderEditorHints() {
  const fh = $('editor-folder-hints'), th = $('editor-tag-hints');
  fh.innerHTML = th.innerHTML = '';
  if (!ai.index || !editing) return;
  const url = editing.type === 'link' ? $('editor-url').value.trim() : '';
  const v = SynapseAI.embed(ai.model, SynapseAI.textFor({
    type: editing.type, url, kind: /google\.com/i.test(url) ? 'gdoc' : 'other',
    title: $('editor-title').value, note: $('editor-note').value, tags: editorTags(),
  }));
  if (!v) return;
  if (editing.mode === 'create') {
    const folders = SynapseAI.suggestFolders(ai.index, v).filter(f => f.folderId !== $('editor-parent').value);
    if (folders.length) {
      fh.innerHTML = '<span class="label">Maybe:</span>' + folders.map(f =>
        `<button type="button" class="chip" data-pick-folder="${esc(f.folderId)}">${esc(folderLabel(f.folderId))}</button>`).join('');
    }
  }
  const tags = SynapseAI.suggestTags(ai.index, v, { exclude: editorTags() });
  if (tags.length) {
    th.innerHTML = '<span class="label">Suggested:</span>' + tags.map(t =>
      `<button type="button" class="chip" data-add-tag="${esc(t.tag)}">#${esc(t.tag)}</button>`).join('');
  }
}

async function saveEditor() {
  const body = {
    title: $('editor-title').value.trim() || undefined,
    note: $('editor-note').value,
    parentId: $('editor-parent').value,
    priority: $('editor-priority').value || null,
    dueDate: $('editor-due').value || null,
    tags: editorTags(),
  };
  if (editing.type === 'link') body.url = $('editor-url').value.trim();
  $('editor-error').textContent = '';
  try {
    if (editing.mode === 'create') {
      await api('POST', '/items', { type: editing.type, ...body });
      localStorage.setItem('synapse_last_folder', body.parentId);
      toast(`Filed in ${[...pathTitles(byId.get(body.parentId)), byId.get(body.parentId).title].join(' / ')}`);
    } else {
      await api('PATCH', `/items/${editing.item.id}`, body);
    }
    $('editor').close();
    await loadItems();
  } catch (e) {
    if (e.status === 409 && e.data.existing) {
      const ex = e.data.existing;
      $('editor-error').innerHTML = `Already filed in <a href="#/f/${esc(ex.parentId)}">${esc([...pathTitles(ex)].join(' / '))}</a> as “${esc(ex.title)}”.`;
    } else {
      $('editor-error').textContent = e.message;
    }
  }
}

async function deleteFromEditor() {
  const item = editing.item;
  const inside = item.type === 'folder' ? descendantsOf(item.id).length : 0;
  const msg = inside ? `Delete “${item.title}” and the ${inside} item${inside === 1 ? '' : 's'} inside it?` : `Delete “${item.title}”?`;
  if (!confirm(msg)) return;
  try {
    await api('DELETE', `/items/${item.id}`);
    $('editor').close();
    if (currentFolderId() === item.id) location.hash = `#/f/${item.parentId}`;
    await loadItems();
  } catch (e) {
    $('editor-error').textContent = e.message;
  }
}

// ── Android share target ──────────────────────────────────────────────────────
// The manifest's share_target opens /web/index.html?title=…&text=…&url=…
// Many Android apps put the link inside `text` rather than `url`.

function handleShare() {
  const qs = new URLSearchParams(location.search);
  if (!qs.has('url') && !qs.has('text') && !qs.has('title')) return;
  const text = qs.get('text') || '';
  const url = qs.get('url') || (text.match(/https?:\/\/\S+/) || [])[0] || '';
  const title = (qs.get('title') || text.replace(url, '')).trim();
  history.replaceState(null, '', location.pathname + location.hash);
  const last = localStorage.getItem('synapse_last_folder');
  openEditor({ mode: 'create', type: 'link', parentId: byId.has(last) ? last : 'root-resources', url, title });
  suggestInto(url, title);
}

/** Pre-select the best suggested folder for a shared link, if any. */
async function suggestInto(url, title) {
  if (!url) return;
  try {
    const qs = new URLSearchParams({ url, title });
    const [best] = await api('GET', `/items/suggest?${qs}`);
    if (best && $('editor').open) $('editor-parent').value = best.folderId;
  } catch { /* suggestions are optional */ }
}

// ── Events ────────────────────────────────────────────────────────────────────

function setTheme(mode) {
  document.documentElement.classList.remove('dark', 'light');
  if (mode) document.documentElement.classList.add(mode);
  $('btn-theme').textContent = mode === 'dark' || (!mode && matchMedia('(prefers-color-scheme: dark)').matches) ? '☀️' : '🌙';
}

function closeDrawer() {
  $('sidebar').classList.remove('open');
  $('drawer-backdrop').classList.add('hidden');
}

document.addEventListener('click', async e => {
  const t = e.target.closest('button, a');
  if (!t) return;
  const d = t.dataset;

  if (d.toggle) {
    expanded.has(d.toggle) ? expanded.delete(d.toggle) : expanded.add(d.toggle);
    localStorage.setItem('synapse_expanded', JSON.stringify([...expanded]));
    return renderTree();
  }
  if (d.tag) {
    search.tag = search.tag === d.tag ? '' : d.tag;
    closeDrawer();
    return render();
  }
  if (d.clearTag !== undefined) { search.tag = ''; return render(); }
  if (d.clearSearch !== undefined) {
    search = { q: '', tag: '', para: '', priority: '' };
    $('search').value = '';
    return render();
  }
  if (d.edit) return openEditor({ mode: 'edit', item: byId.get(d.edit) });
  if (d.new) return openEditor({ mode: 'create', type: d.new, parentId: currentFolderId() || 'root-projects' });
  if (d.open) {
    api('POST', `/items/${d.open}/touch`).then(updated => {
      allItems = allItems.map(i => i.id === updated.id ? updated : i);
      indexItems();
    }).catch(() => {});
    return; // let the link open normally
  }
  if (d.copy) {
    const item = byId.get(d.copy);
    try { await navigator.clipboard.writeText(item.url); toast('Path copied'); } catch { prompt('Copy this path:', item.url); }
    return;
  }
  if (d.touch) {
    await api('POST', `/items/${d.touch}/touch`);
    toast('Marked as active');
    return loadItems();
  }
  if (d.archive) {
    await api('PATCH', `/items/${d.archive}`, { parentId: 'root-archive' });
    toast('Moved to Archive');
    return loadItems();
  }
  if (d.move) {
    await api('PATCH', `/items/${d.move}`, { parentId: d.to });
    toast(`Moved to ${folderLabel(d.to)}`);
    return loadItems();
  }
  if (d.dismiss) {
    dismissedHints.add(d.dismiss);
    localStorage.setItem('synapse_dismissed_hints', JSON.stringify([...dismissedHints]));
    return renderMain();
  }
  if (d.pickFolder) {
    $('editor-parent').value = d.pickFolder;
    return renderEditorHints();
  }
  if (d.addTag) {
    $('editor-tags').value = [...editorTags(), d.addTag].join(', ');
    return renderEditorHints();
  }
  if (t.classList.contains('tree-link')) closeDrawer();
});

document.addEventListener('change', e => {
  if (e.target.id === 'filter-para') { search.para = e.target.value; renderMain(); }
  if (e.target.id === 'filter-priority') { search.priority = e.target.value; renderMain(); }
});

function init() {
  setTheme(localStorage.getItem('synapse_theme'));
  $('btn-theme').addEventListener('click', () => {
    const dark = document.documentElement.classList.contains('dark') ||
      (!document.documentElement.classList.contains('light') && matchMedia('(prefers-color-scheme: dark)').matches);
    const mode = dark ? 'light' : 'dark';
    localStorage.setItem('synapse_theme', mode);
    setTheme(mode);
  });

  document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    $('form-login').classList.toggle('hidden', btn.dataset.tab !== 'login');
    $('form-register').classList.toggle('hidden', btn.dataset.tab !== 'register');
  }));
  $('form-login').addEventListener('submit', e => {
    e.preventDefault();
    authSubmit('/auth/login', $('login-email').value, $('login-password').value, $('login-error'));
  });
  $('form-register').addEventListener('submit', e => {
    e.preventDefault();
    authSubmit('/auth/register', $('reg-email').value, $('reg-password').value, $('reg-error'));
  });
  $('btn-logout').addEventListener('click', logout);

  $('search').addEventListener('input', e => { search.q = e.target.value.trim(); renderMain(); });
  $('search').addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.target.value = ''; search.q = ''; renderMain(); }
  });
  document.addEventListener('keydown', e => {
    if (e.key === '/' && !e.target.closest('input, textarea, select') && !$('editor').open) {
      e.preventDefault();
      $('search').focus();
    }
  });

  $('btn-drawer').addEventListener('click', () => {
    $('sidebar').classList.add('open');
    $('drawer-backdrop').classList.remove('hidden');
  });
  $('drawer-backdrop').addEventListener('click', closeDrawer);

  $('editor-form').addEventListener('submit', e => { e.preventDefault(); saveEditor(); });
  let hintTimer;
  for (const id of ['editor-url', 'editor-title', 'editor-note', 'editor-tags']) {
    $(id).addEventListener('input', () => { clearTimeout(hintTimer); hintTimer = setTimeout(renderEditorHints, 250); });
  }
  $('editor-parent').addEventListener('change', renderEditorHints);

  $('ai-enabled').checked = aiEnabled();
  $('ai-enabled').addEventListener('change', e => {
    localStorage.setItem('synapse_ai', e.target.checked ? 'on' : 'off');
    if (e.target.checked) startAI(); else stopAI();
  });
  $('editor-cancel').addEventListener('click', () => $('editor').close());
  $('editor-delete').addEventListener('click', deleteFromEditor);

  window.addEventListener('hashchange', () => {
    const id = currentFolderId();
    if (id) {
      // Reveal the current folder in the tree.
      for (const a of byId.get(id)?.path || []) expanded.add(a);
    }
    if (searching()) {
      search = { q: '', tag: '', para: '', priority: '' };
      $('search').value = '';
    }
    render();
    window.scrollTo(0, 0);
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/web/sw.js').catch(() => {});

  if (token) showApp().catch(() => showLogin());
  else showLogin();
}

init();
