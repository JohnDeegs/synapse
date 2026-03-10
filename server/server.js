require('dotenv').config();
const http = require('http');
const { stmts } = require('./db');
const { hashPassword, verifyPassword, signToken, verifyToken } = require('./auth');
const {
  createTask, getActiveTasks, getTaskById,
  checkinTask, completeTask, snoozeTask, deleteTask,
} = require('./tasks');

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

// ── Task route handlers ───────────────────────────────────────────────────────

async function handleGetTasks(req, res, user) {
  const tasks = getActiveTasks(user.userId);
  send(res, 200, tasks);
}

async function handleCreateTask(req, res, user) {
  let body;
  try { body = await readBody(req); } catch { return send(res, 400, { error: 'Invalid JSON' }); }

  const { title, priority, description } = body;
  if (!title || !priority) return send(res, 400, { error: 'title and priority required' });
  if (!['P0','P1','P2','P3','P4'].includes(priority)) return send(res, 400, { error: 'priority must be P0–P4' });

  const task = createTask({ userId: user.userId, title, priority, description });
  send(res, 201, task);
}

async function handlePatchTask(req, res, user, id) {
  let body;
  try { body = await readBody(req); } catch { return send(res, 400, { error: 'Invalid JSON' }); }

  const task = getTaskById(id);
  if (!task) return send(res, 404, { error: 'Task not found' });
  if (task.user_id !== user.userId) return send(res, 403, { error: 'Forbidden' });

  const { action, note, minutes } = body;

  if (action === 'checkin') {
    const updated = checkinTask(task, note || '');
    return send(res, 200, updated);
  }
  if (action === 'complete') {
    const updated = completeTask(task);
    return send(res, 200, updated);
  }
  if (action === 'snooze') {
    if (typeof minutes !== 'number') return send(res, 400, { error: 'minutes required for snooze' });
    const updated = snoozeTask(task, minutes);
    return send(res, 200, updated);
  }
  send(res, 400, { error: 'action must be checkin, complete, or snooze' });
}

async function handleDeleteTask(req, res, user, id) {
  const task = getTaskById(id);
  if (!task) return send(res, 404, { error: 'Task not found' });
  if (task.user_id !== user.userId) return send(res, 403, { error: 'Forbidden' });

  deleteTask(id, user.userId);
  send(res, 200, { deleted: true });
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

    // Task routes — require auth
    const taskMatch = url.match(/^\/tasks\/(\d+)$/);
    const taskId = taskMatch ? parseInt(taskMatch[1], 10) : null;

    if (req.method === 'GET'    && url === '/tasks')    { const u = authenticate(req); if (!u) return send(res, 401, { error: 'Unauthorized' }); return await handleGetTasks(req, res, u); }
    if (req.method === 'POST'   && url === '/tasks')    { const u = authenticate(req); if (!u) return send(res, 401, { error: 'Unauthorized' }); return await handleCreateTask(req, res, u); }
    if (req.method === 'PATCH'  && taskId !== null)     { const u = authenticate(req); if (!u) return send(res, 401, { error: 'Unauthorized' }); return await handlePatchTask(req, res, u, taskId); }
    if (req.method === 'DELETE' && taskId !== null)     { const u = authenticate(req); if (!u) return send(res, 401, { error: 'Unauthorized' }); return await handleDeleteTask(req, res, u, taskId); }

    send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Synapse server listening on port ${PORT}`);
});
