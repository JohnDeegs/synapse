require('dotenv').config();
const http = require('http');
const { stmts } = require('./db');
const { hashPassword, verifyPassword, signToken, verifyToken } = require('./auth');

const PORT = process.env.PORT || 3000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON'));
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

// ── Route handlers ────────────────────────────────────────────────────────────

async function handleRegister(req, res) {
  let body;
  try { body = await readBody(req); } catch { return send(res, 400, { error: 'Invalid JSON' }); }

  const { email, password } = body;
  if (!email || !password) return send(res, 400, { error: 'email and password required' });

  const existing = stmts.findUserByEmail.get(email);
  if (existing) return send(res, 409, { error: 'Email already registered' });

  const hash = hashPassword(password);
  const user = stmts.createUser.get(email, hash);
  const token = signToken({ userId: user.id, email: user.email });
  send(res, 201, { token });
}

async function handleLogin(req, res) {
  let body;
  try { body = await readBody(req); } catch { return send(res, 400, { error: 'Invalid JSON' }); }

  const { email, password } = body;
  if (!email || !password) return send(res, 400, { error: 'email and password required' });

  const user = stmts.findUserByEmail.get(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return send(res, 401, { error: 'Invalid credentials' });
  }

  const token = signToken({ userId: user.id, email: user.email });
  send(res, 200, { token });
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

  const url = req.url.split('?')[0];

  try {
    if (req.method === 'POST' && url === '/auth/register') return await handleRegister(req, res);
    if (req.method === 'POST' && url === '/auth/login')    return await handleLogin(req, res);

    send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Synapse server listening on port ${PORT}`);
});
