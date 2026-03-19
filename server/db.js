const Database = require('better-sqlite3');
const path = require('path');

const DATA_FILE = process.env.DATA_FILE || './synapse.db';
const db = new Database(path.resolve(DATA_FILE));

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL CHECK(priority IN ('P0','P1','P2','P3','P4')),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','snoozed')),
    checkin_count INTEGER NOT NULL DEFAULT 0,
    next_reminder TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    embedding TEXT,
    due_date TEXT
  );

  CREATE TABLE IF NOT EXISTS checkin_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, name)
  );

  CREATE TABLE IF NOT EXISTS task_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
    UNIQUE(task_id, tag_id)
  );

  CREATE TABLE IF NOT EXISTS telegram_links (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id    TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS telegram_codes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code       TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS telegram_rate_limits (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id      TEXT NOT NULL UNIQUE,
    minute_count INTEGER NOT NULL DEFAULT 0,
    hour_count   INTEGER NOT NULL DEFAULT 0,
    day_count    INTEGER NOT NULL DEFAULT 0,
    minute_reset TEXT NOT NULL,
    hour_reset   TEXT NOT NULL,
    day_reset    TEXT NOT NULL
  );
`);

// Add columns to existing databases (idempotent)
for (const ddl of [
  'ALTER TABLE tasks ADD COLUMN embedding TEXT',
  'ALTER TABLE tasks ADD COLUMN due_date TEXT',
]) {
  try { db.exec(ddl); } catch (e) {
    if (!e.message.includes('duplicate column name')) throw e;
  }
}

// Prepared statements
const stmts = {
  // Users
  createUser: db.prepare(
    'INSERT INTO users (email, password_hash) VALUES (?, ?) RETURNING id, email, created_at'
  ),
  findUserByEmail: db.prepare(
    'SELECT id, email, password_hash FROM users WHERE email = ?'
  ),

  // Tasks
  createTask: db.prepare(`
    INSERT INTO tasks (user_id, title, description, priority, next_reminder, due_date)
    VALUES (@userId, @title, @description, @priority, @nextReminder, @dueDate)
    RETURNING *
  `),
  getActiveTasks: db.prepare(
    "SELECT * FROM tasks WHERE user_id = ? AND status = 'active' ORDER BY next_reminder ASC"
  ),
  getAllTasks: db.prepare(
    'SELECT * FROM tasks WHERE user_id = ? ORDER BY next_reminder ASC'
  ),
  getTaskById: db.prepare(
    'SELECT * FROM tasks WHERE id = ?'
  ),
  updateTask: db.prepare(`
    UPDATE tasks
    SET status = @status,
        priority = @priority,
        checkin_count = @checkinCount,
        next_reminder = @nextReminder
    WHERE id = @id
  `),
  deleteTask: db.prepare(
    'DELETE FROM tasks WHERE id = ? AND user_id = ?'
  ),
  updateTaskContent: db.prepare(`
    UPDATE tasks SET title = @title, description = @description, due_date = @dueDate WHERE id = @id
  `),
  updateTaskPriority: db.prepare(`
    UPDATE tasks SET priority = @priority, next_reminder = @nextReminder WHERE id = @id
  `),
  getAllActiveTasksWithDueDates: db.prepare(
    "SELECT * FROM tasks WHERE status = 'active' AND due_date IS NOT NULL"
  ),
  getAllTelegramLinks: db.prepare('SELECT * FROM telegram_links'),

  // Checkin log
  addCheckin: db.prepare(
    'INSERT INTO checkin_log (task_id, note) VALUES (?, ?)'
  ),
  getCheckins: db.prepare(
    'SELECT * FROM checkin_log WHERE task_id = ? ORDER BY created_at ASC'
  ),

  // Tags
  createTag: db.prepare(
    'INSERT INTO tags (user_id, name) VALUES (?, ?) RETURNING id, name'
  ),
  getTagsByUser: db.prepare(
    'SELECT id, name FROM tags WHERE user_id = ? ORDER BY name ASC'
  ),
  getTagById: db.prepare(
    'SELECT * FROM tags WHERE id = ?'
  ),
  assignTag: db.prepare(
    'INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)'
  ),
  removeTag: db.prepare(
    'DELETE FROM task_tags WHERE task_id = ? AND tag_id = ?'
  ),
  getTagsForTask: db.prepare(
    'SELECT t.id, t.name FROM tags t JOIN task_tags tt ON tt.tag_id = t.id WHERE tt.task_id = ?'
  ),
  getTagsByUserForTasks: db.prepare(
    'SELECT tt.task_id, t.id, t.name FROM task_tags tt JOIN tags t ON t.id = tt.tag_id JOIN tasks tk ON tk.id = tt.task_id WHERE tk.user_id = ?'
  ),

  // Telegram codes
  createTelegramCode: db.prepare(
    'INSERT INTO telegram_codes (user_id, code, expires_at) VALUES (?, ?, ?) RETURNING id, code, expires_at'
  ),
  deleteCodesForUser: db.prepare(
    'DELETE FROM telegram_codes WHERE user_id = ?'
  ),
  getActiveTelegramCodeForUser: db.prepare(
    "SELECT id, code, expires_at FROM telegram_codes WHERE user_id = ? AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1"
  ),
  getTelegramCodeByCode: db.prepare(
    "SELECT id, user_id, code, expires_at FROM telegram_codes WHERE code = ? AND expires_at > datetime('now')"
  ),
  deleteTelegramCodeById: db.prepare(
    'DELETE FROM telegram_codes WHERE id = ?'
  ),

  // Telegram links
  createTelegramLink: db.prepare(
    'INSERT INTO telegram_links (user_id, chat_id) VALUES (?, ?)'
  ),
  getTelegramLinkByChatId: db.prepare(
    'SELECT * FROM telegram_links WHERE chat_id = ?'
  ),
  getTelegramLinkByUserId: db.prepare(
    'SELECT * FROM telegram_links WHERE user_id = ?'
  ),
  deleteTelegramLinkByUserId: db.prepare(
    'DELETE FROM telegram_links WHERE user_id = ?'
  ),
  deleteTelegramLinkByChatId: db.prepare(
    'DELETE FROM telegram_links WHERE chat_id = ?'
  ),

  // Embeddings
  updateTaskEmbedding: db.prepare(
    'UPDATE tasks SET embedding = ? WHERE id = ?'
  ),
  getTasksWithoutEmbedding: db.prepare(
    'SELECT id, title, description FROM tasks WHERE embedding IS NULL'
  ),

  // Telegram rate limits
  getRateLimit: db.prepare(
    'SELECT * FROM telegram_rate_limits WHERE chat_id = ?'
  ),
  insertRateLimit: db.prepare(
    'INSERT INTO telegram_rate_limits (chat_id, minute_count, hour_count, day_count, minute_reset, hour_reset, day_reset) VALUES (?, 1, 1, 1, ?, ?, ?)'
  ),
  updateRateLimit: db.prepare(
    'UPDATE telegram_rate_limits SET minute_count = ?, hour_count = ?, day_count = ?, minute_reset = ?, hour_reset = ?, day_reset = ? WHERE chat_id = ?'
  ),
};

module.exports = { db, stmts };
