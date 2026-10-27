// Export tasks from the legacy SQLite database to a Markdown file for review.
//
// Usage: node scripts/export-legacy-tasks.js <path/to/synapse.db> [out.md] [--email you@example.com]
//
// Read-only: opens the database in readonly mode and never modifies it.

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const emailIdx = args.indexOf('--email');
const emailFilter = emailIdx >= 0 ? args.splice(emailIdx, 2)[1] : null;
const [dbFile, outFile = 'legacy-tasks-export.md'] = args;

if (!dbFile) {
  console.error('Usage: node scripts/export-legacy-tasks.js <path/to/synapse.db> [out.md] [--email you@example.com]');
  process.exit(1);
}

const db = new Database(path.resolve(dbFile), { readonly: true, fileMustExist: true });

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}
function columnExists(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}

const hasProjects = tableExists('projects') && columnExists('tasks', 'project_id');
const hasTodos = tableExists('task_todos');

const users = emailFilter
  ? db.prepare('SELECT id, email FROM users WHERE email = ?').all(emailFilter)
  : db.prepare('SELECT id, email FROM users ORDER BY id').all();

if (users.length === 0) {
  console.error(emailFilter ? `No user with email ${emailFilter}` : 'No users found');
  process.exit(1);
}

const tasksFor = db.prepare(`
  SELECT t.*${hasProjects ? ', p.name AS project_name' : ''}
  FROM tasks t
  ${hasProjects ? 'LEFT JOIN projects p ON p.id = t.project_id' : ''}
  WHERE t.user_id = ?
  ORDER BY CASE t.status WHEN 'active' THEN 0 WHEN 'snoozed' THEN 1 ELSE 2 END, t.priority, t.created_at
`);
const tagsFor = db.prepare('SELECT g.name FROM tags g JOIN task_tags tt ON tt.tag_id = g.id WHERE tt.task_id = ? ORDER BY g.name');
const checkinsFor = db.prepare('SELECT note, created_at FROM checkin_log WHERE task_id = ? ORDER BY created_at');
const todosFor = hasTodos ? db.prepare('SELECT text, done FROM task_todos WHERE task_id = ? ORDER BY position, id') : null;

const out = [
  '# Synapse legacy tasks export',
  '',
  `Exported ${new Date().toISOString()} from \`${path.basename(dbFile)}\`.`,
  '',
];
let total = 0;

for (const user of users) {
  const tasks = tasksFor.all(user.id);
  if (tasks.length === 0) continue;
  out.push(`## ${user.email} (${tasks.length} tasks)`, '');

  for (const t of tasks) {
    total++;
    out.push(`### ${t.title}`, '');
    const meta = [`**Status:** ${t.status}`, `**Priority:** ${t.priority}`];
    if (t.due_date) meta.push(`**Due:** ${t.due_date}`);
    if (t.project_name) meta.push(`**Project:** ${t.project_name}`);
    const tags = tagsFor.all(t.id).map(r => r.name);
    if (tags.length) meta.push(`**Tags:** ${tags.join(', ')}`);
    meta.push(`**Created:** ${t.created_at}`);
    out.push(meta.join(' · '), '');

    if (t.description && t.description.trim()) out.push(t.description.trim(), '');

    const todos = todosFor ? todosFor.all(t.id) : [];
    if (todos.length) {
      for (const td of todos) out.push(`- [${td.done ? 'x' : ' '}] ${td.text}`);
      out.push('');
    }

    const checkins = checkinsFor.all(t.id).filter(c => c.note && c.note.trim());
    if (checkins.length) {
      out.push('Check-ins:');
      for (const c of checkins) out.push(`- ${c.created_at}: ${c.note.trim()}`);
      out.push('');
    }
  }
}

fs.writeFileSync(outFile, out.join('\n'));
console.log(`Wrote ${total} tasks for ${users.length} user(s) to ${path.resolve(outFile)}`);
