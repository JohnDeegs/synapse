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
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
`);

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
    INSERT INTO tasks (user_id, title, description, priority, next_reminder)
    VALUES (@userId, @title, @description, @priority, @nextReminder)
    RETURNING *
  `),
  getActiveTasks: db.prepare(
    "SELECT * FROM tasks WHERE user_id = ? AND status = 'active' ORDER BY next_reminder ASC"
  ),
  getTaskById: db.prepare(
    'SELECT * FROM tasks WHERE id = ?'
  ),
  updateTask: db.prepare(`
    UPDATE tasks
    SET status = @status,
        checkin_count = @checkinCount,
        next_reminder = @nextReminder
    WHERE id = @id
  `),
  deleteTask: db.prepare(
    'DELETE FROM tasks WHERE id = ? AND user_id = ?'
  ),

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
};

module.exports = { db, stmts };
