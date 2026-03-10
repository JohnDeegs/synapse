const { stmts } = require('./db');

// ── SRS Formula ───────────────────────────────────────────────────────────────

const BASE_INTERVALS = {
  P0: 30,
  P1: 120,
  P2: 1440,
  P3: 4320,
  P4: 10080,
};

/**
 * Calculate next reminder timestamp (ISO string).
 * nextReminder = fromTime + baseInterval × min(1 + checkinCount × 0.5, 5)
 */
function calcNextReminder(priority, checkinCount, fromTime = Date.now()) {
  const base = BASE_INTERVALS[priority];
  const multiplier = Math.min(1 + checkinCount * 0.5, 5);
  const ms = base * multiplier * 60 * 1000;
  return new Date(fromTime + ms).toISOString();
}

// ── Task CRUD Helpers ─────────────────────────────────────────────────────────

function createTask({ userId, title, description = '', priority }) {
  const nextReminder = calcNextReminder(priority, 0);
  return stmts.createTask.get({ userId, title, description, priority, nextReminder });
}

function getActiveTasks(userId) {
  return stmts.getActiveTasks.all(userId);
}

function getTaskById(id) {
  return stmts.getTaskById.get(id);
}

function checkinTask(task, note = '') {
  stmts.addCheckin.run(task.id, note);
  const newCount = task.checkin_count + 1;
  const nextReminder = calcNextReminder(task.priority, newCount);
  stmts.updateTask.run({
    id: task.id,
    status: task.status,
    checkinCount: newCount,
    nextReminder,
  });
  return stmts.getTaskById.get(task.id);
}

function completeTask(task) {
  stmts.updateTask.run({
    id: task.id,
    status: 'completed',
    checkinCount: task.checkin_count,
    nextReminder: task.next_reminder,
  });
  return stmts.getTaskById.get(task.id);
}

function snoozeTask(task, minutes) {
  const nextReminder = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  stmts.updateTask.run({
    id: task.id,
    status: 'active',
    checkinCount: task.checkin_count,
    nextReminder,
  });
  return stmts.getTaskById.get(task.id);
}

function deleteTask(id, userId) {
  const info = stmts.deleteTask.run(id, userId);
  return info.changes > 0;
}

module.exports = {
  BASE_INTERVALS,
  calcNextReminder,
  createTask,
  getActiveTasks,
  getTaskById,
  checkinTask,
  completeTask,
  snoozeTask,
  deleteTask,
};
