// background.js — service worker: context menu, "already filed" badge,
// and address-bar search (keyword "s").

importScripts('api.js', 'synapse-ai.js');

// ── Context menu ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'file-page', title: 'File this page in Synapse', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'file-link', title: 'File link in Synapse', contexts: ['link'] });
  });
});

// The popup can't be opened from a menu click, so open it in a small window
// with the target passed in the query string.
chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.menuItemId === 'file-link' ? info.linkUrl : (info.pageUrl || tab?.url);
  const title = info.menuItemId === 'file-link' ? (info.selectionText || '') : (tab?.title || '');
  if (!url) return;
  chrome.windows.create({
    url: `popup.html?${new URLSearchParams({ url, title })}`,
    type: 'popup',
    width: 400,
    height: 560,
  });
});

// ── "Already filed" badge ─────────────────────────────────────────────────────
// Lookups are cached briefly per URL so switching tabs doesn't hit the server
// every time. The worker can be stopped at any moment, which just empties the cache.

const LOOKUP_TTL_MS = 60 * 1000;
const lookupCache = new Map(); // url -> { filed, at }

async function isFiled(url) {
  const hit = lookupCache.get(url);
  if (hit && Date.now() - hit.at < LOOKUP_TTL_MS) return hit.filed;
  const { item } = await api('GET', `/items/lookup?${new URLSearchParams({ url })}`);
  lookupCache.set(url, { filed: !!item, at: Date.now() });
  return !!item;
}

async function updateBadge(tabId, url) {
  if (!isWebUrl(url)) return chrome.action.setBadgeText({ tabId, text: '' });
  try {
    const filed = await isFiled(url);
    await chrome.action.setBadgeText({ tabId, text: filed ? '✓' : '' });
    if (filed) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#188038' });
  } catch {
    // Signed out or server unreachable: no badge.
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab) updateBadge(tabId, tab.url);
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url || change.status === 'complete') updateBadge(tabId, tab.url);
});

chrome.runtime.onMessage.addListener(async msg => {
  if (msg?.type !== 'filed') return;
  lookupCache.delete(msg.url);
  aiIndex = null;
  const tabs = await chrome.tabs.query({ url: msg.url }).catch(() => []);
  for (const t of tabs) updateBadge(t.id, t.url);
});

chrome.storage.onChanged.addListener(changes => {
  if (changes.token || changes.apiBase) { lookupCache.clear(); aiIndex = null; }
  if (changes.aiEnabled) { aiModel = null; aiIndex = null; }
});

// ── On-device AI for search ───────────────────────────────────────────────────
// Model and index are loaded on first use and kept while the worker lives.

const INDEX_TTL_MS = 60 * 1000;
let aiModel = null;   // Promise<model|null>
let aiIndex = null;   // { at, index }

async function getModel() {
  if (!(await getConfig()).aiEnabled) return null;
  if (!aiModel) aiModel = SynapseAI.load().catch(() => { aiModel = null; return null; });
  return aiModel;
}

async function getIndex() {
  if (!aiIndex || Date.now() - aiIndex.at > INDEX_TTL_MS) {
    aiIndex = { at: Date.now(), index: SynapseAI.buildIndex(await api('GET', '/items')) };
  }
  return aiIndex.index;
}

async function relatedItems(q) {
  if (q.length < 3) return [];
  const model = await getModel();
  if (!model) return [];
  const index = await getIndex();
  return SynapseAI.search(index, SynapseAI.embed(model, q), { limit: 6 }).map(r => index.byId.get(r.id));
}

// ── Address-bar search: "s <query>" ───────────────────────────────────────────

chrome.omnibox.setDefaultSuggestion({ description: 'Search Synapse' });

const xmlEsc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

let lastResults = new Map(); // suggestion content (url) -> item id
let searchTimer = null;

chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  clearTimeout(searchTimer);
  const q = text.trim();
  if (!q) return suggest([]);
  searchTimer = setTimeout(async () => {
    try {
      const { apiBase } = await getConfig();
      const [matches, related] = await Promise.all([
        api('GET', `/items?${new URLSearchParams({ q })}`),
        relatedItems(q).catch(() => []),
      ]);
      lastResults = new Map();
      const out = [];
      const add = (i, isRelated) => {
        if (!i || i.parentId === null || out.length >= 8) return;
        const content = i.type === 'folder' || !isWebUrl(i.url)
          ? webAppUrl(apiBase, `#/f/${encodeURIComponent(i.type === 'folder' ? i.id : i.parentId)}`)
          : i.url;
        if (lastResults.has(content)) return;
        lastResults.set(content, i.id);
        const where = i.type === 'folder' ? 'folder' : (i.note ? i.note.slice(0, 60) : i.url);
        const title = isRelated ? xmlEsc(i.title) : `<match>${xmlEsc(i.title)}</match>`;
        out.push({ content, description: `${title} <dim>— ${isRelated ? 'related · ' : ''}${xmlEsc(where)}</dim>` });
      };
      matches.forEach(i => add(i, false));
      related.forEach(i => add(i, true));
      suggest(out);
    } catch {
      suggest([]);
    }
  }, 150);
});

chrome.omnibox.onInputEntered.addListener(async (text, disposition) => {
  const { apiBase } = await getConfig();
  let url = text;
  // Typed text without picking a suggestion: open the best match, else the web app.
  if (!lastResults.has(text)) url = lastResults.keys().next().value || webAppUrl(apiBase);
  const id = lastResults.get(url);
  if (id) api('POST', `/items/${encodeURIComponent(id)}/touch`).catch(() => {});
  if (disposition === 'currentTab') chrome.tabs.update({ url });
  else chrome.tabs.create({ url, active: disposition === 'newForegroundTab' });
});
