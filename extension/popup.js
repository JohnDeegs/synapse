// popup.js — file the current tab (or a link passed in ?url=&title= from the
// context menu) into a folder.

const $ = id => document.getElementById(id);

let target = { url: '', title: '' };
let apiBase = '';
let folders = [];      // [{ id, title, crumb, label }] in tree order
let suggested = [];    // [{ folderId, reasons }]
let visible = [];      // folder ids currently listed, in display order
let selectedId = null;
let userPicked = false; // once the user chooses a folder, suggestions stop moving the selection
let model = null;      // on-device embedding model (synapse-ai.js), if enabled and loaded
let index = null;

// Blend of server rules and on-device similarity: a similarity of 0.3 adds
// nothing, a near-perfect match adds ~2.8, comparable to a strong "same place".
const AI_WEIGHT = 4;
const AI_FLOOR = 0.3;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function show(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('hidden', v.id !== id));
}

async function getTarget() {
  const qs = new URLSearchParams(location.search);
  if (qs.get('url')) return { url: qs.get('url'), title: qs.get('title') || '' };
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return { url: tab?.url || '', title: tab?.title || '' };
}

function buildFolders(items) {
  const byId = new Map(items.map(i => [i.id, i]));
  const kids = new Map();
  for (const i of items) {
    if (i.type !== 'folder' || !i.parentId) continue;
    if (!kids.has(i.parentId)) kids.set(i.parentId, []);
    kids.get(i.parentId).push(i);
  }
  const out = [];
  (function walk(ids) {
    for (const id of ids) {
      const f = byId.get(id);
      if (!f) continue;
      const crumb = f.path.map(p => byId.get(p)?.title).filter(Boolean).join(' / ');
      out.push({ id, title: f.title, crumb, label: crumb ? `${crumb} / ${f.title}` : f.title });
      walk((kids.get(id) || []).sort((a, b) => a.title.localeCompare(b.title)).map(k => k.id));
    }
  })(['root-projects', 'root-areas', 'root-resources', 'root-archive']);
  return out;
}

// ── Folder picker ─────────────────────────────────────────────────────────────

function optionHtml(f, why = '') {
  return `<div class="folder-opt ${f.id === selectedId ? 'selected' : ''}" role="option" data-id="${esc(f.id)}">
    ${f.crumb ? `<span class="crumb">${esc(f.crumb)} /</span>` : ''}<span class="name">${esc(f.title)}</span>
    ${why ? `<span class="why">${esc(why)}</span>` : ''}
  </div>`;
}

function renderFolders() {
  const q = $('folder-search').value.trim().toLowerCase();
  const byId = new Map(folders.map(f => [f.id, f]));
  let html = '';
  visible = [];
  if (q) {
    const terms = q.split(/\s+/);
    for (const f of folders) {
      if (terms.every(t => f.label.toLowerCase().includes(t))) {
        html += optionHtml(f);
        visible.push(f.id);
      }
    }
    if (!visible.length) html = '<div class="folder-group">No matching folder</div>';
  } else {
    const sugg = suggested.filter(s => byId.has(s.folderId)).slice(0, 3);
    if (sugg.length) {
      html += '<div class="folder-group">Suggested</div>';
      for (const s of sugg) {
        html += optionHtml(byId.get(s.folderId), s.reasons.join(', '));
        visible.push(s.folderId);
      }
      html += '<div class="folder-group">All folders</div>';
    }
    for (const f of folders) {
      html += optionHtml(f);
      visible.push(f.id);
    }
  }
  $('folder-list').innerHTML = html;
  $('folder-list').querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
}

function select(id) {
  selectedId = id;
  renderFolders();
}

// ── On-device AI ──────────────────────────────────────────────────────────────

function mergeSuggestions(server, similar) {
  const merged = new Map(server.map(s => [s.folderId, { folderId: s.folderId, score: s.score, reasons: [...s.reasons] }]));
  for (const a of similar) {
    const m = merged.get(a.folderId) || { folderId: a.folderId, score: 0, reasons: [] };
    m.score += AI_WEIGHT * Math.max(0, a.sim - AI_FLOOR);
    m.reasons.push('similar');
    merged.set(a.folderId, m);
  }
  return [...merged.values()].sort((a, b) => b.score - a.score);
}

function currentVector() {
  return embedItem(model, {
    title: $('title').value || target.title,
    note: $('note').value,
    tags: $('tags').value.split(',').map(t => t.trim()).filter(Boolean),
    url: target.url,
  });
}

function renderTagHints() {
  const el = $('tag-hints');
  el.innerHTML = '';
  if (!index) return;
  const current = $('tags').value.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  const tags = SynapseAI.suggestTags(index, currentVector(), { exclude: current });
  el.innerHTML = tags.map(t => `<button type="button" class="tag-chip" data-tag="${esc(t.tag)}">+ #${esc(t.tag)}</button>`).join('');
}

/** Embed items that have no vector for the current model, and upload them in the background. */
function backfill(items) {
  const vectors = {};
  for (const item of SynapseAI.missing(items)) {
    const v = SynapseAI.embed(model, SynapseAI.textFor(item));
    if (!v) continue;
    vectors[item.id] = SynapseAI.encode(v);
    item.embedding = { model: SynapseAI.MODEL_ID, v: vectors[item.id] };
  }
  const ids = Object.keys(vectors);
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = Object.fromEntries(ids.slice(i, i + 200).map(id => [id, vectors[id]]));
    api('POST', '/items/embeddings', { model: SynapseAI.MODEL_ID, vectors: chunk }).catch(() => {});
  }
}

/** Once the model is ready, re-rank folders with similarity and offer tags. */
async function applyAI(modelPromise, items, serverSuggestions) {
  model = await modelPromise;
  if (!model) return;
  backfill(items);
  index = SynapseAI.buildIndex(items);
  suggested = mergeSuggestions(serverSuggestions, SynapseAI.suggestFolders(index, currentVector(), { limit: 5 }));
  if (!userPicked) selectedId = suggested[0]?.folderId || selectedId;
  renderFolders();
  renderTagHints();
}

function moveSelection(delta) {
  if (!visible.length) return;
  const at = visible.indexOf(selectedId);
  const next = at === -1 ? 0 : Math.max(0, Math.min(visible.length - 1, at + delta));
  select(visible[next]);
}

// ── Saving ────────────────────────────────────────────────────────────────────

async function save() {
  $('error').textContent = '';
  if (!selectedId) {
    $('error').textContent = 'Pick a folder first.';
    return $('folder-search').focus();
  }
  $('btn-save').disabled = true;
  try {
    const v = currentVector();
    await api('POST', '/items', {
      type: 'link',
      parentId: selectedId,
      url: target.url,
      title: $('title').value.trim() || undefined,
      note: $('note').value,
      priority: $('priority').value || null,
      dueDate: $('due').value || null,
      tags: $('tags').value.split(',').map(t => t.trim()).filter(Boolean),
      embedding: v ? { model: SynapseAI.MODEL_ID, v: SynapseAI.encode(v) } : undefined,
    });
    chrome.runtime.sendMessage({ type: 'filed', url: target.url }).catch(() => {});
    $('done-path').textContent = folders.find(f => f.id === selectedId)?.label || '';
    show('view-done');
    setTimeout(() => window.close(), 900);
  } catch (e) {
    $('btn-save').disabled = false;
    if (e.status === 409 && e.data?.existing) {
      $('error').textContent = 'This link is already filed.';
    } else if (e.status === 401) {
      show('view-signed-out');
    } else {
      $('error').textContent = e.message;
    }
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

function showFiled({ item, breadcrumb }) {
  $('filed-path').textContent = breadcrumb.join(' / ');
  $('filed-title').textContent = item.title;
  $('filed-note').textContent = item.note;
  $('filed-open').href = webAppUrl(apiBase, `#/f/${encodeURIComponent(item.parentId)}`);
  show('view-filed');
}

function wireEvents() {
  $('btn-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

  $('folder-list').addEventListener('mousedown', e => {
    const opt = e.target.closest('.folder-opt');
    if (!opt) return;
    e.preventDefault();
    userPicked = true;
    select(opt.dataset.id);
    $('note').focus();
  });

  $('tag-hints').addEventListener('click', e => {
    const chip = e.target.closest('[data-tag]');
    if (!chip) return;
    const tags = $('tags').value.split(',').map(t => t.trim()).filter(Boolean);
    $('tags').value = [...tags, chip.dataset.tag].join(', ');
    $('more').open = true;
    renderTagHints();
    $('note').focus();
  });
  let hintTimer;
  for (const id of ['title', 'note', 'tags']) {
    $(id).addEventListener('input', () => { clearTimeout(hintTimer); hintTimer = setTimeout(renderTagHints, 250); });
  }

  $('folder-search').addEventListener('input', () => {
    userPicked = true;
    renderFolders();
    if (visible.length) select(visible[0]);
  });
  $('folder-search').addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); }
    if (e.key === 'Enter') { e.preventDefault(); $('note').focus(); }
  });

  $('note').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
  });
  $('view-file').addEventListener('submit', e => { e.preventDefault(); save(); });
}

async function init() {
  wireEvents();
  const cfg = await getConfig();
  if (!cfg.token || !cfg.apiBase) return show('view-signed-out');
  apiBase = cfg.apiBase;

  target = await getTarget();
  if (!isWebUrl(target.url) && !target.url.startsWith('file:')) {
    $('view-loading').innerHTML = '<p class="muted">Only web pages and local files can be filed.</p>';
    return;
  }

  // Start loading the model now; it is merged in when ready and never blocks filing.
  const modelPromise = cfg.aiEnabled ? SynapseAI.load().catch(() => null) : Promise.resolve(null);
  let items;

  try {
    const qs = new URLSearchParams({ url: target.url, title: target.title });
    let lookup, sugg, tags;
    [lookup, items, sugg, tags] = await Promise.all([
      api('GET', `/items/lookup?${new URLSearchParams({ url: target.url })}`),
      api('GET', '/items'),
      api('GET', `/items/suggest?${qs}`),
      api('GET', '/tags'),
    ]);
    if (lookup.item) return showFiled(lookup);

    folders = buildFolders(items);
    suggested = sugg;
    selectedId = suggested[0]?.folderId || null;
    $('tag-options').innerHTML = tags.map(t => `<option value="${esc(t.name)}">`).join('');
  } catch (e) {
    if (e.status === 401) return show('view-signed-out');
    $('view-loading').innerHTML = `<p class="error">${esc(e.message)}</p>`;
    return;
  }

  $('title').value = cleanTitle(target.title) || target.url;
  $('url').textContent = target.url;
  $('url').title = target.url;
  renderFolders();
  show('view-file');
  (selectedId ? $('note') : $('folder-search')).focus();
  applyAI(modelPromise, items, suggested);
}

init();
