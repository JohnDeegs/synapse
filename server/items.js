// Folder/link domain logic: PARA roots, validation, URL normalisation, moves,
// search. All persistence goes through store.js.

const store = require('./store');

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const PARA_ROOTS = [
  { para: 'projects',  title: 'Projects' },
  { para: 'areas',     title: 'Areas' },
  { para: 'resources', title: 'Resources' },
  { para: 'archive',   title: 'Archive' },
];
const rootId = para => `root-${para}`;
const PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'P4'];

// ── Links ─────────────────────────────────────────────────────────────────────

const TRACKING_PARAM = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid)$/i;

function localKey(p) {
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  // Windows drive and UNC paths are case-insensitive.
  return 'local:' + (/^([a-zA-Z]:|\/\/)/.test(norm) ? norm.toLowerCase() : norm);
}

/**
 * Validate a link and derive:
 *   kind    — gdoc | sharepoint | local | other
 *   urlKey  — normalised identity, so the same doc shared with different
 *             query strings or /edit suffixes counts as one link
 *   site    — grouping key for "same place" suggestions (SharePoint site, web host)
 */
function parseLink(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) throw new HttpError(400, 'url required');
  if (s.length > 2048) throw new HttpError(400, 'url too long (max 2048 chars)');

  // Local paths: C:\..., \\server\share\..., /abs/path, ~/...
  if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\') || s.startsWith('/') || s.startsWith('~/')) {
    return { url: s, kind: 'local', urlKey: localKey(s), site: null };
  }

  let u;
  try { u = new URL(s); } catch { throw new HttpError(400, 'url must be an http(s) link or a local file path'); }

  if (u.protocol === 'file:') {
    const p = (u.host ? `//${u.host}` : '') + decodeURIComponent(u.pathname).replace(/^\/([a-zA-Z]:)/, '$1');
    return { url: s, kind: 'local', urlKey: localKey(p), site: null };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new HttpError(400, 'url must be an http(s) link or a local file path');
  }

  const host = u.hostname.toLowerCase().replace(/^www\./, '');

  if (host === 'docs.google.com' || host === 'drive.google.com') {
    const id = (u.pathname.match(/\/(?:d|folders)\/(?:e\/)?([\w-]{10,})/) || [])[1] || u.searchParams.get('id');
    return { url: s, kind: 'gdoc', urlKey: id ? `google:${id}` : genericKey(host, u), site: null };
  }

  if (host.endsWith('.sharepoint.com') || host === 'onedrive.live.com' || host === '1drv.ms') {
    const sourcedoc = (u.searchParams.get('sourcedoc') || '').replace(/[{}]/g, '').toLowerCase();
    const siteMatch = decodeURIComponent(u.pathname).match(/\/(sites|teams|personal)\/([^/]+)/i);
    return {
      url: s,
      kind: 'sharepoint',
      urlKey: sourcedoc ? `sp:${host}:${sourcedoc}` : `sp:${host}${decodeURIComponent(u.pathname).toLowerCase().replace(/\/+$/, '')}`,
      site: siteMatch ? `${host}/${siteMatch[1]}/${siteMatch[2]}`.toLowerCase() : host,
    };
  }

  return { url: s, kind: 'other', urlKey: genericKey(host, u), site: host };
}

function genericKey(host, u) {
  const params = [...u.searchParams]
    .filter(([k]) => !TRACKING_PARAM.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  const qs = params.length ? '?' + new URLSearchParams(params).toString() : '';
  return `web:${host}${u.pathname.replace(/\/+$/, '')}${qs}`;
}

// ── Validation ────────────────────────────────────────────────────────────────

function cleanTags(tags) {
  if (!Array.isArray(tags)) throw new HttpError(400, 'tags must be an array of strings');
  const out = [];
  for (const t of tags) {
    if (typeof t !== 'string') throw new HttpError(400, 'tags must be an array of strings');
    const name = t.trim().toLowerCase().replace(/^#/, '');
    if (!name) continue;
    if (name.length > 40) throw new HttpError(400, 'tag too long (max 40 chars)');
    if (!out.includes(name)) out.push(name);
  }
  if (out.length > 20) throw new HttpError(400, 'too many tags (max 20)');
  return out;
}

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

/** Copy editable fields from a request body onto an item, validating each. */
function applyFields(item, body) {
  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || !body.title.trim()) throw new HttpError(400, 'title must be non-empty');
    if (body.title.length > 300) throw new HttpError(400, 'title too long (max 300 chars)');
    item.title = body.title.trim();
  }
  if (body.note !== undefined) {
    if (typeof body.note !== 'string') throw new HttpError(400, 'note must be a string');
    if (body.note.length > 2000) throw new HttpError(400, 'note too long (max 2000 chars)');
    item.note = body.note.trim();
  }
  if (body.priority !== undefined) {
    if (body.priority !== null && !PRIORITIES.includes(body.priority)) throw new HttpError(400, 'priority must be P0–P4 or null');
    item.priority = body.priority;
  }
  if (body.dueDate !== undefined) {
    if (body.dueDate !== null && !isValidDate(body.dueDate)) throw new HttpError(400, 'dueDate must be YYYY-MM-DD or null');
    item.dueDate = body.dueDate;
  }
  if (body.tags !== undefined) item.tags = cleanTags(body.tags);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function ensureRoots(userId) {
  const missing = [];
  for (const { para, title } of PARA_ROOTS) {
    if (await store.getItem(userId, rootId(para))) continue;
    const now = new Date().toISOString();
    missing.push({
      id: rootId(para), type: 'folder', parentId: null, path: [], para, title,
      note: '', priority: null, dueDate: null, tags: [],
      createdAt: now, updatedAt: now, lastTouched: now,
    });
  }
  if (missing.length) await store.writeItems(userId, missing);
}

async function requireItem(userId, id) {
  const item = await store.getItem(userId, id);
  if (!item) throw new HttpError(404, 'Item not found');
  return item;
}

async function requireFolder(userId, id) {
  const folder = typeof id === 'string' ? await store.getItem(userId, id) : null;
  if (!folder || folder.type !== 'folder') throw new HttpError(400, 'parentId must be an existing folder');
  return folder;
}

async function findDuplicate(userId, urlKey, exceptId) {
  const items = await store.listItems(userId);
  return items.find(i => i.type === 'link' && i.urlKey === urlKey && i.id !== exceptId) || null;
}

function breadcrumb(items, item) {
  const byId = new Map(items.map(i => [i.id, i]));
  return item.path.map(id => (byId.get(id) || {}).title).filter(Boolean);
}

// ── Operations ────────────────────────────────────────────────────────────────

/**
 * List items, optionally filtered. With no filters, returns every item so the
 * client can build the whole tree.
 *   q         — all words must appear in title, note, tags or url
 *   type      — folder | link
 *   para      — projects | areas | resources | archive
 *   under     — folder id; items anywhere beneath it
 *   tag, priority, dueBefore (YYYY-MM-DD, inclusive)
 */
async function listItems(userId, f = {}) {
  await ensureRoots(userId);
  let items = await store.listItems(userId);
  const filtered = ['q', 'type', 'para', 'under', 'tag', 'priority', 'dueBefore'].some(k => f[k]);

  if (f.type)      items = items.filter(i => i.type === f.type);
  if (f.para)      items = items.filter(i => i.para === f.para);
  if (f.under)     items = items.filter(i => i.path.includes(f.under));
  if (f.tag)       items = items.filter(i => i.tags.includes(f.tag.toLowerCase()));
  if (f.priority)  items = items.filter(i => i.priority === f.priority);
  if (f.dueBefore) items = items.filter(i => i.dueDate && i.dueDate <= f.dueBefore);
  if (f.q) {
    const terms = f.q.toLowerCase().split(/\s+/).filter(Boolean);
    items = items.filter(i => {
      const hay = [i.title, i.note, i.url || '', ...i.tags].join(' ').toLowerCase();
      return terms.every(t => hay.includes(t));
    });
  }
  if (filtered) items.sort((a, b) => b.lastTouched.localeCompare(a.lastTouched));
  return items;
}

async function getItem(userId, id) {
  await ensureRoots(userId);
  return requireItem(userId, id);
}

async function createItem(userId, body) {
  await ensureRoots(userId);
  if (body.type !== 'folder' && body.type !== 'link') throw new HttpError(400, 'type must be folder or link');
  const parent = await requireFolder(userId, body.parentId);

  const now = new Date().toISOString();
  const item = {
    id: store.newId(), type: body.type, parentId: parent.id,
    path: [...parent.path, parent.id], para: parent.para,
    title: '', note: '', priority: null, dueDate: null, tags: [],
    createdAt: now, updatedAt: now, lastTouched: now,
  };

  if (body.type === 'link') {
    Object.assign(item, parseLink(body.url));
    const dup = await findDuplicate(userId, item.urlKey);
    if (dup) throw new HttpError(409, 'This link is already filed', { existing: dup });
    item.title = item.url; // default when no title is given
  } else if (body.url !== undefined) {
    throw new HttpError(400, 'folders cannot have a url');
  }
  if (body.type === 'folder' && body.title === undefined) throw new HttpError(400, 'title required');

  applyFields(item, body);
  await store.writeItems(userId, [item]);
  return item;
}

async function updateItem(userId, id, body) {
  await ensureRoots(userId);
  const item = await requireItem(userId, id);
  if (item.parentId === null) throw new HttpError(400, 'PARA root folders cannot be changed');

  applyFields(item, body);

  if (body.url !== undefined) {
    if (item.type !== 'link') throw new HttpError(400, 'folders cannot have a url');
    Object.assign(item, parseLink(body.url));
    const dup = await findDuplicate(userId, item.urlKey, item.id);
    if (dup) throw new HttpError(409, 'This link is already filed', { existing: dup });
  }

  const puts = [item];
  if (body.parentId !== undefined && body.parentId !== item.parentId) {
    const parent = await requireFolder(userId, body.parentId);
    if (parent.id === item.id || parent.path.includes(item.id)) {
      throw new HttpError(400, 'Cannot move a folder into itself');
    }
    item.parentId = parent.id;
    item.path = [...parent.path, parent.id];
    item.para = parent.para;
    // Re-root every descendant under the item's new path.
    for (const d of await store.listItems(userId)) {
      const at = d.path.indexOf(item.id);
      if (at === -1) continue;
      d.path = [...item.path, ...d.path.slice(at)];
      d.para = item.para;
      puts.push(d);
    }
  }

  item.updatedAt = item.lastTouched = new Date().toISOString();
  await store.writeItems(userId, puts);
  return item;
}

/** Delete an item and, for a folder, everything beneath it. */
async function deleteItem(userId, id) {
  await ensureRoots(userId);
  const item = await requireItem(userId, id);
  if (item.parentId === null) throw new HttpError(400, 'PARA root folders cannot be deleted');
  const ids = [item.id, ...(await store.listItems(userId)).filter(i => i.path.includes(item.id)).map(i => i.id)];
  await store.writeItems(userId, [], ids);
  return ids.length;
}

/** Record that an item was opened, without changing it. */
async function touchItem(userId, id) {
  const item = await requireItem(userId, id);
  item.lastTouched = new Date().toISOString();
  await store.writeItems(userId, [item]);
  return item;
}

/** Find where a URL is filed, if anywhere. Returns { item, breadcrumb } or null. */
async function lookupUrl(userId, url) {
  await ensureRoots(userId);
  const { urlKey } = parseLink(url);
  const items = await store.listItems(userId);
  const item = items.find(i => i.type === 'link' && i.urlKey === urlKey);
  return item ? { item, breadcrumb: breadcrumb(items, item) } : null;
}

/** Every tag in use, with how many items carry it. */
async function listTags(userId) {
  const counts = new Map();
  for (const i of await store.listItems(userId)) {
    for (const t of i.tags) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = {
  HttpError, PARA_ROOTS, rootId, parseLink,
  listItems, getItem, createItem, updateItem, deleteItem, touchItem, lookupUrl, listTags,
};
