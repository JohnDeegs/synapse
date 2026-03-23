require('dotenv').config();
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { stmts } = require('./db');
const { hashPassword, verifyPassword, signToken, verifyToken } = require('./auth');
const {
  createTask, getActiveTasks, getTaskById,
  checkinTask, completeTask, snoozeTask, deleteTask, updateTaskContent,
  changePriority, escalateAllDueTasks,
} = require('./tasks');
const telegram = require('./telegram');
const { sendDailyBriefings } = telegram;
const { updateTaskEmbedding, backfillEmbeddings } = require('./embeddings');

const PORT = process.env.PORT || 3000;

const WEB_DIR = path.resolve(__dirname, 'web');
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
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
  if (!checkAuthRateLimit(req.socket.remoteAddress)) {
    return send(res, 429, { error: 'Too many attempts. Try again later.' });
  }

  let body;
  try { body = await readBody(req); } catch { return send(res, 400, { error: 'Invalid JSON' }); }

  const { email, password } = body;
  if (!email || !password) return send(res, 400, { error: 'email and password required' });
  if (typeof email !== 'string' || email.length > 254) return send(res, 400, { error: 'invalid email' });
  if (typeof password !== 'string' || password.length < 8) return send(res, 400, { error: 'password must be at least 8 characters' });
  if (password.length > 72) return send(res, 400, { error: 'password too long' });

  const existing = stmts.findUserByEmail.get(email);
  if (existing) return send(res, 409, { error: 'Email already registered' });

  const hash = hashPassword(password);
  const user = stmts.createUser.get(email, hash);
  const token = signToken({ userId: user.id, email: user.email });
  send(res, 201, { token });
}

async function handleLogin(req, res) {
  if (!checkAuthRateLimit(req.socket.remoteAddress)) {
    return send(res, 429, { error: 'Too many attempts. Try again later.' });
  }

  let body;
  try { body = await readBody(req); } catch { return send(res, 400, { error: 'Invalid JSON' }); }

  const { email, password } = body;
  if (!email || !password) return send(res, 400, { error: 'email and password required' });
  if (typeof email !== 'string' || email.length > 254) return send(res, 400, { error: 'invalid email' });
  if (typeof password !== 'string' || password.length > 72) return send(res, 400, { error: 'Invalid credentials' });

  const user = stmts.findUserByEmail.get(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return send(res, 401, { error: 'Invalid credentials' });
  }

  const token = signToken({ userId: user.id, email: user.email });
  send(res, 200, { token });
}

// ── Task route handlers ───────────────────────────────────────────────────────

async function handleGetTasks(req, res, user) {
  const qs = req.url.includes('?') ? new URLSearchParams(req.url.split('?')[1]) : null;
  const statusFilter = qs ? qs.get('status') : null;
  const tasks = statusFilter === 'all' ? stmts.getAllTasks.all(user.userId) : getActiveTasks(user.userId);
  const tagRows = stmts.getTagsByUserForTasks.all(user.userId);
  const tagMap = new Map();
  for (const row of tagRows) {
    if (!tagMap.has(row.task_id)) tagMap.set(row.task_id, []);
    tagMap.get(row.task_id).push({ id: row.id, name: row.name });
  }
  for (const task of tasks) task.tags = tagMap.get(task.id) || [];
  send(res, 200, tasks);
}

async function handleCreateTask(req, res, user) {
  let body;
  try { body = await readBody(req); } catch { return send(res, 400, { error: 'Invalid JSON' }); }

  const { title, priority, description, due_date } = body;
  if (!title || !priority) return send(res, 400, { error: 'title and priority required' });
  if (!['P0','P1','P2','P3','P4'].includes(priority)) return send(res, 400, { error: 'priority must be P0–P4' });
  if (typeof title !== 'string' || title.length > 500) return send(res, 400, { error: 'title too long (max 500 chars)' });
  if (description !== undefined && (typeof description !== 'string' || description.length > 10000)) return send(res, 400, { error: 'description too long (max 10000 chars)' });
  if (due_date !== undefined && due_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) return send(res, 400, { error: 'due_date must be YYYY-MM-DD' });

  const task = createTask({ userId: user.userId, title, priority, description, dueDate: due_date || null });
  updateTaskEmbedding(task).catch(() => {}); // fire-and-forget
  send(res, 201, task);
}

async function handlePatchTask(req, res, user, id) {
  let body;
  try { body = await readBody(req); } catch { return send(res, 400, { error: 'Invalid JSON' }); }

  const task = getTaskById(id);
  if (!task) return send(res, 404, { error: 'Task not found' });
  if (task.user_id !== user.userId) return send(res, 403, { error: 'Forbidden' });

  const { action, note, minutes } = body;

  if (action === 'update') {
    if (body.title === undefined && body.description === undefined && body.due_date === undefined && body.priority === undefined)
      return send(res, 400, { error: 'At least one field required' });
    if (body.title !== undefined && (typeof body.title !== 'string' || body.title.length > 500)) return send(res, 400, { error: 'title too long (max 500 chars)' });
    if (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 10000)) return send(res, 400, { error: 'description too long (max 10000 chars)' });
    if (body.due_date !== undefined && body.due_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(body.due_date)) return send(res, 400, { error: 'due_date must be YYYY-MM-DD' });
    if (body.priority !== undefined && !['P0','P1','P2','P3','P4'].includes(body.priority)) return send(res, 400, { error: 'priority must be P0–P4' });
    // Priority-only change: recalculate next_reminder from new priority
    if (body.priority !== undefined && body.title === undefined && body.description === undefined && body.due_date === undefined) {
      return send(res, 200, changePriority(task, body.priority));
    }
    const updated = updateTaskContent(task, { title: body.title, description: body.description, dueDate: body.due_date });
    const final = body.priority ? changePriority(updated, body.priority) : updated;
    updateTaskEmbedding(final).catch(() => {}); // fire-and-forget
    return send(res, 200, final);
  }
  if (action === 'checkin') {
    if (body.priority !== undefined && !['P0','P1','P2','P3','P4'].includes(body.priority)) {
      return send(res, 400, { error: 'priority must be P0, P1, P2, P3, or P4' });
    }
    const updated = checkinTask(task, note || '', body.priority || null);
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

// ── Tag route handlers ────────────────────────────────────────────────────────

async function handleGetTags(req, res, user) {
  send(res, 200, stmts.getTagsByUser.all(user.userId));
}

async function handleCreateTag(req, res, user) {
  let body;
  try { body = await readBody(req); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
  const name = (body.name || '').trim();
  if (!name) return send(res, 400, { error: 'name required' });
  try {
    const tag = stmts.createTag.get(user.userId, name);
    send(res, 201, tag);
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE constraint failed'))
      return send(res, 409, { error: 'Tag name already exists' });
    throw e;
  }
}

async function handlePatchTag(req, res, user, tagId) {
  let body;
  try { body = await readBody(req); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
  const tag = stmts.getTagById.get(tagId);
  if (!tag) return send(res, 404, { error: 'Tag not found' });
  if (tag.user_id !== user.userId) return send(res, 403, { error: 'Forbidden' });
  if (body.weekday_only !== undefined) {
    stmts.updateTagWeekdayOnly.run(body.weekday_only ? 1 : 0, tagId, user.userId);
  }
  return send(res, 200, stmts.getTagById.get(tagId));
}

async function handleAssignTag(req, res, user, taskId) {
  let body;
  try { body = await readBody(req); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
  const { tagId } = body;
  if (!tagId || typeof tagId !== 'number') return send(res, 400, { error: 'tagId required' });

  const task = getTaskById(taskId);
  if (!task) return send(res, 404, { error: 'Task not found' });
  if (task.user_id !== user.userId) return send(res, 403, { error: 'Forbidden' });

  const tag = stmts.getTagById.get(tagId);
  if (!tag) return send(res, 404, { error: 'Tag not found' });
  if (tag.user_id !== user.userId) return send(res, 403, { error: 'Forbidden' });

  stmts.assignTag.run(taskId, tagId);
  send(res, 200, { ok: true });
}

async function handleGetCheckins(req, res, user, taskId) {
  const task = getTaskById(taskId);
  if (!task) return send(res, 404, { error: 'Task not found' });
  if (task.user_id !== user.userId) return send(res, 403, { error: 'Forbidden' });
  send(res, 200, stmts.getCheckins.all(taskId));
}

async function handleRemoveTag(req, res, user, taskId, tagId) {
  const task = getTaskById(taskId);
  if (!task) return send(res, 404, { error: 'Task not found' });
  if (task.user_id !== user.userId) return send(res, 403, { error: 'Forbidden' });

  const tag = stmts.getTagById.get(tagId);
  if (!tag) return send(res, 404, { error: 'Tag not found' });
  if (tag.user_id !== user.userId) return send(res, 403, { error: 'Forbidden' });

  stmts.removeTag.run(taskId, tagId);
  send(res, 200, { ok: true });
}

// ── Telegram route handlers ───────────────────────────────────────────────────

const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function generateCode() {
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes).map(b => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

async function handlePostTelegramCode(req, res, user) {
  // Delete any existing codes for this user, then create a fresh one
  stmts.deleteCodesForUser.run(user.userId);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const code = stmts.createTelegramCode.get(user.userId, generateCode(), expiresAt);
  send(res, 200, { code: code.code, expiresAt: code.expires_at });
}

async function handleGetTelegramCode(req, res, user) {
  const code = stmts.getActiveTelegramCodeForUser.get(user.userId);
  if (!code) return send(res, 200, { code: null });
  send(res, 200, { code: code.code, expiresAt: code.expires_at });
}

async function handleTelegramConnect(req, res) {
  let body;
  try { body = await readBody(req); } catch { return send(res, 400, { error: 'Invalid JSON' }); }

  const { chatId, code } = body;
  if (!chatId || !code) return send(res, 400, { error: 'chatId and code required' });

  const codeRow = stmts.getTelegramCodeByCode.get(code);
  if (!codeRow) return send(res, 400, { error: 'Invalid or expired code' });

  // Delete the code — one-time use
  stmts.deleteTelegramCodeById.run(codeRow.id);

  // Upsert the link: clear any existing link for this user OR this chat_id, then insert
  stmts.deleteTelegramLinkByUserId.run(codeRow.user_id);
  stmts.deleteTelegramLinkByChatId.run(String(chatId));
  stmts.createTelegramLink.run(codeRow.user_id, String(chatId));

  send(res, 200, { userId: codeRow.user_id });
}

async function handleGetTelegramConnect(req, res, user) {
  const link = stmts.getTelegramLinkByUserId.get(user.userId);
  send(res, 200, { connected: !!link });
}

async function handleDeleteTelegramConnect(req, res, user) {
  stmts.deleteTelegramLinkByUserId.run(user.userId);
  send(res, 200, { ok: true });
}

async function handleTelegramWebhook(req, res) {
  const secretHeader = req.headers['x-telegram-bot-api-secret-token'];
  if (!telegram.WEBHOOK_SECRET || secretHeader !== telegram.WEBHOOK_SECRET) {
    return send(res, 403, { error: 'Forbidden' });
  }

  let body;
  try { body = await readBody(req); } catch { return send(res, 400, { error: 'Invalid JSON' }); }

  // Respond immediately — Telegram requires a fast 200 response
  send(res, 200, { ok: true });

  // Process the update asynchronously after responding
  telegram.handleUpdate(body).catch(err => console.error('Telegram handleUpdate error:', err));
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

    // Telegram auth endpoints — JWT-authenticated
    if (req.method === 'POST' && url === '/auth/telegram-code') { const u = authenticate(req); if (!u) return send(res, 401, { error: 'Unauthorized' }); return await handlePostTelegramCode(req, res, u); }
    if (req.method === 'GET'  && url === '/auth/telegram-code') { const u = authenticate(req); if (!u) return send(res, 401, { error: 'Unauthorized' }); return await handleGetTelegramCode(req, res, u); }

    // Telegram connect — internal (no JWT, validated by one-time code)
    if (req.method === 'POST'   && url === '/telegram/connect') return await handleTelegramConnect(req, res);
    // Telegram connect status / disconnect — JWT-authenticated
    if (req.method === 'GET'    && url === '/telegram/connect') { const u = authenticate(req); if (!u) return send(res, 401, { error: 'Unauthorized' }); return await handleGetTelegramConnect(req, res, u); }
    if (req.method === 'DELETE' && url === '/telegram/connect') { const u = authenticate(req); if (!u) return send(res, 401, { error: 'Unauthorized' }); return await handleDeleteTelegramConnect(req, res, u); }

    // Telegram webhook — called by Telegram servers
    if (req.method === 'POST' && url === '/telegram/webhook') return await handleTelegramWebhook(req, res);

    // Static file serving — unauthenticated
    if (url === '/web' || url.startsWith('/web/')) return handleStaticFile(req, res);

    // Settings — require auth
    if (req.method === 'GET' && url === '/settings') {
      const u = authenticate(req);
      if (!u) return send(res, 401, { error: 'Unauthorized' });
      const row = stmts.getSettings.get(u.userId);
      return send(res, 200, row || { quiet_enabled: 1, quiet_start: 23, quiet_end: 7 });
    }
    if (req.method === 'PATCH' && url === '/settings') {
      const u = authenticate(req);
      if (!u) return send(res, 401, { error: 'Unauthorized' });
      let body;
      try { body = await readBody(req); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
      const { quiet_enabled, quiet_start, quiet_end } = body;
      if (typeof quiet_start !== 'number' || quiet_start < 0 || quiet_start > 23 ||
          typeof quiet_end   !== 'number' || quiet_end   < 0 || quiet_end   > 23)
        return send(res, 400, { error: 'quiet_start and quiet_end must be 0–23' });
      stmts.upsertSettings.run({ userId: u.userId, quietEnabled: quiet_enabled ? 1 : 0, quietStart: quiet_start, quietEnd: quiet_end });
      return send(res, 200, stmts.getSettings.get(u.userId));
    }

    // Tag routes — require auth
    if (req.method === 'GET'   && url === '/tags') { const u = authenticate(req); if (!u) return send(res, 401, { error: 'Unauthorized' }); return await handleGetTags(req, res, u); }
    if (req.method === 'POST'  && url === '/tags') { const u = authenticate(req); if (!u) return send(res, 401, { error: 'Unauthorized' }); return await handleCreateTag(req, res, u); }
    const tagMatch = url.match(/^\/tags\/(\d+)$/);
    if (req.method === 'PATCH' && tagMatch) { const u = authenticate(req); if (!u) return send(res, 401, { error: 'Unauthorized' }); return await handlePatchTag(req, res, u, parseInt(tagMatch[1], 10)); }

    // Nested task-tag routes: /tasks/:id/tags and /tasks/:id/tags/:tagId
    // Split: ['', 'tasks', '<id>', 'tags', '<tagId?>']
    const parts = url.split('/');
    const isTaskTagsRoute     = parts[1] === 'tasks' && parts[3] === 'tags'     && /^\d+$/.test(parts[2]);
    const isTaskCheckinsRoute = parts[1] === 'tasks' && parts[3] === 'checkins' && /^\d+$/.test(parts[2]);
    if (isTaskTagsRoute && req.method === 'POST'   && parts.length === 4) { const u = authenticate(req); if (!u) return send(res, 401, { error: 'Unauthorized' }); return await handleAssignTag(req, res, u, parseInt(parts[2], 10)); }
    if (isTaskTagsRoute && req.method === 'DELETE' && parts.length === 5 && /^\d+$/.test(parts[4])) { const u = authenticate(req); if (!u) return send(res, 401, { error: 'Unauthorized' }); return await handleRemoveTag(req, res, u, parseInt(parts[2], 10), parseInt(parts[4], 10)); }
    if (isTaskCheckinsRoute && req.method === 'GET' && parts.length === 4) { const u = authenticate(req); if (!u) return send(res, 401, { error: 'Unauthorized' }); return await handleGetCheckins(req, res, u, parseInt(parts[2], 10)); }

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

// ── Schedulers ────────────────────────────────────────────────────────────────

/**
 * Schedule the daily morning briefing.
 * Fires at BRIEFING_HOUR (UTC, default 7) every day.
 * Also runs due-date priority escalation before each briefing.
 */
function scheduleDailyBriefing() {
  const BRIEFING_HOUR = parseInt(process.env.BRIEFING_HOUR || '7', 10);

  function msUntilNextRun() {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(BRIEFING_HOUR, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  }

  function runAndSchedule() {
    const escalated = escalateAllDueTasks();
    if (escalated > 0) console.log(`Daily escalation: ${escalated} task(s) priority-bumped.`);
    sendDailyBriefings()
      .catch(err => console.error('Daily briefing error:', err));
    setTimeout(runAndSchedule, msUntilNextRun());
  }

  const delay = msUntilNextRun();
  console.log(`Daily briefing scheduled in ${Math.round(delay / 60000)} min (${new Date(Date.now() + delay).toISOString()})`);
  setTimeout(runAndSchedule, delay);
}

/** Run due-date escalation every hour so priority bumps apply between briefings. */
function scheduleHourlyEscalation() {
  setInterval(() => {
    try {
      const n = escalateAllDueTasks();
      if (n > 0) console.log(`Hourly escalation: ${n} task(s) priority-bumped.`);
    } catch (e) {
      console.error('Escalation error:', e.message);
    }
  }, 60 * 60 * 1000);
}

server.listen(PORT, () => {
  console.log(`Synapse server listening on port ${PORT}`);
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.APP_BASE_URL) {
    telegram.registerWebhook(process.env.APP_BASE_URL)
      .catch(err => console.error('Failed to register Telegram webhook:', err));
  }
  backfillEmbeddings()
    .catch(err => console.error('Embedding backfill error:', err));
  if (process.env.TELEGRAM_BOT_TOKEN) {
    scheduleDailyBriefing();
    scheduleHourlyEscalation();
  }
});
