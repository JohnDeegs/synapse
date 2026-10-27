require('dotenv').config();
const http = require('http');
const fs   = require('fs');
const path = require('path');
const store = require('./store');
const { hashPassword, verifyPassword, signToken, verifyToken } = require('./auth');
const items = require('./items');
const { HttpError } = items;

const PORT = process.env.PORT || 3000;
const MAX_BODY_BYTES = 100 * 1024;

const WEB_DIR = path.resolve(__dirname, 'web');
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
};

// ── Auth rate limiter ─────────────────────────────────────────────────────────
// Simple in-memory sliding window: max 10 attempts per IP per 15 minutes.

const authAttempts = new Map();
const AUTH_WINDOW_MS   = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 10;

function checkAuthRateLimit(ip) {
  const now  = Date.now();
  const prev = (authAttempts.get(ip) || []).filter(t => now - t < AUTH_WINDOW_MS);
  if (prev.length >= AUTH_MAX_ATTEMPTS) return false;
  authAttempts.set(ip, [...prev, now]);
  return true;
}

// Behind Cloud Run's front end (TRUST_PROXY=1) the real client IP is the last
// X-Forwarded-For entry; earlier entries are client-supplied and spoofable.
// Locally there is no proxy, so the header is ignored.
function clientIp(req) {
  const fwd = process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for'];
  return fwd ? fwd.split(',').pop().trim() : req.socket.remoteAddress;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

// ── Auth middleware ───────────────────────────────────────────────────────────

function authenticate(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  try {
    return verifyToken(token);
  } catch {
    return null;
  }
}

// ── Auth route handlers ───────────────────────────────────────────────────────

function validateCredentials(body) {
  const { email, password } = body;
  if (!email || !password) throw new HttpError(400, 'email and password required');
  if (typeof email !== 'string' || email.length > 254 || !email.includes('@')) throw new HttpError(400, 'invalid email');
  if (typeof password !== 'string') throw new HttpError(400, 'invalid password');
  if (password.length > 72) throw new HttpError(400, 'password too long');
  return { email: email.trim().toLowerCase(), password };
}

async function handleRegister(req, res) {
  if (!checkAuthRateLimit(clientIp(req))) {
    return send(res, 429, { error: 'Too many attempts. Try again later.' });
  }
  const { email, password } = validateCredentials(await readBody(req));
  if (password.length < 8) return send(res, 400, { error: 'password must be at least 8 characters' });

  const user = await store.createUser(email, hashPassword(password));
  if (!user) return send(res, 409, { error: 'Email already registered' });
  send(res, 201, { token: signToken({ userId: user.id, email: user.email }) });
}

async function handleLogin(req, res) {
  if (!checkAuthRateLimit(clientIp(req))) {
    return send(res, 429, { error: 'Too many attempts. Try again later.' });
  }
  const { email, password } = validateCredentials(await readBody(req));

  const user = await store.findUserByEmail(email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return send(res, 401, { error: 'Invalid credentials' });
  }
  send(res, 200, { token: signToken({ userId: user.id, email: user.email }) });
}

// ── Item route handlers ───────────────────────────────────────────────────────

async function handleListItems(req, res, user, qs) {
  const filters = {};
  for (const k of ['q', 'type', 'para', 'under', 'tag', 'priority', 'dueBefore']) {
    if (qs.get(k)) filters[k] = qs.get(k);
  }
  send(res, 200, await items.listItems(user.userId, filters));
}

async function handleLookup(req, res, user, qs) {
  const url = qs.get('url');
  if (!url) return send(res, 400, { error: 'url required' });
  send(res, 200, (await items.lookupUrl(user.userId, url)) || { item: null });
}

// ── Static file serving ───────────────────────────────────────────────────────

function handleStaticFile(req, res) {
  let filePath = req.url.split('?')[0].slice('/web'.length) || '/index.html';
  if (filePath === '/') filePath = '/index.html';

  const resolved = path.resolve(WEB_DIR, filePath.replace(/^\//, ''));
  if (!resolved.startsWith(WEB_DIR + path.sep) && resolved !== WEB_DIR) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  const ext = path.extname(resolved);
  const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';

  fs.readFile(resolved, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS headers (for extension / local dev)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const [url, query = ''] = req.url.split('?');
  const qs = new URLSearchParams(query);

  try {
    if (req.method === 'POST' && url === '/auth/register') return await handleRegister(req, res);
    if (req.method === 'POST' && url === '/auth/login')    return await handleLogin(req, res);

    // Static file serving — unauthenticated
    if (req.method === 'GET' && url === '/') {
      res.writeHead(302, { Location: '/web/' });
      return res.end();
    }
    if (url === '/web' || url.startsWith('/web/')) return handleStaticFile(req, res);

    // Everything below requires auth
    const u = authenticate(req);
    if (!u) return send(res, 401, { error: 'Unauthorized' });

    if (req.method === 'GET'  && url === '/items')        return await handleListItems(req, res, u, qs);
    if (req.method === 'POST' && url === '/items')        return send(res, 201, await items.createItem(u.userId, await readBody(req)));
    if (req.method === 'GET'  && url === '/items/lookup') return await handleLookup(req, res, u, qs);
    if (req.method === 'GET'  && url === '/tags')         return send(res, 200, await items.listTags(u.userId));

    const touchMatch = url.match(/^\/items\/([\w-]+)\/touch$/);
    if (req.method === 'POST' && touchMatch) return send(res, 200, await items.touchItem(u.userId, touchMatch[1]));

    const itemMatch = url.match(/^\/items\/([\w-]+)$/);
    if (itemMatch) {
      const id = itemMatch[1];
      if (req.method === 'GET')    return send(res, 200, await items.getItem(u.userId, id));
      if (req.method === 'PATCH')  return send(res, 200, await items.updateItem(u.userId, id, await readBody(req)));
      if (req.method === 'DELETE') return send(res, 200, { deleted: await items.deleteItem(u.userId, id) });
    }

    send(res, 404, { error: 'Not found' });
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...err.extra });
    console.error(err);
    send(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Synapse server listening on port ${PORT} (store: ${process.env.STORE === 'firestore' ? 'firestore' : 'file'})`);
});

module.exports = server;
