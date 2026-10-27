// Shared by the popup, options page and background service worker
// (loaded with <script> in pages and importScripts() in the worker).

async function getConfig() {
  const { token, apiBase, email } = await chrome.storage.local.get(['token', 'apiBase', 'email']);
  return { token, apiBase: apiBase ? apiBase.replace(/\/+$/, '') : '', email };
}

async function api(method, path, body) {
  const { token, apiBase } = await getConfig();
  if (!token || !apiBase) throw Object.assign(new Error('Not signed in'), { status: 401 });
  const res = await fetch(apiBase + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}

function webAppUrl(apiBase, hash = '') {
  return `${apiBase}/web/${hash}`;
}

// Tab titles carry app suffixes and notification counts: "(3) Budget - Google Sheets".
function cleanTitle(title) {
  return (title || '')
    .replace(/^\(\d+\)\s*/, '')
    .replace(/\s+[-–|]\s+(Google (Docs|Sheets|Slides|Drive|Forms)|Microsoft (Word|Excel|PowerPoint)( Online)?|(Word|Excel|PowerPoint)( Online)?|SharePoint|OneDrive)$/i, '')
    .trim();
}

function isWebUrl(url) {
  return /^https?:\/\//i.test(url || '');
}
