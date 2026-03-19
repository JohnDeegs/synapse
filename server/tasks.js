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

function createTask({ userId, title, description = '', priority, dueDate = null }) {
  const nextReminder = calcNextReminder(priority, 0);
  return stmts.createTask.get({ userId, title, description, priority, nextReminder, dueDate });
}

function getActiveTasks(userId) {
  return stmts.getActiveTasks.all(userId);
}

function getTaskById(id) {
  return stmts.getTaskById.get(id);
}

function checkinTask(task, note = '', priority = null) {
  stmts.addCheckin.run(task.id, note);
  const newCount = task.checkin_count + 1;
  const newPriority = priority || task.priority;
  const nextReminder = calcNextReminder(newPriority, newCount);
  stmts.updateTask.run({
    id: task.id,
    status: task.status,
    priority: newPriority,
    checkinCount: newCount,
    nextReminder,
  });
  return stmts.getTaskById.get(task.id);
}

function completeTask(task) {
  stmts.updateTask.run({
    id: task.id,
    status: 'completed',
    priority: task.priority,
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
    priority: task.priority,
    checkinCount: task.checkin_count,
    nextReminder,
  });
  return stmts.getTaskById.get(task.id);
}

function deleteTask(id, userId) {
  const info = stmts.deleteTask.run(id, userId);
  return info.changes > 0;
}

function changePriority(task, newPriority) {
  const nextReminder = calcNextReminder(newPriority, task.checkin_count);
  stmts.updateTaskPriority.run({ id: task.id, priority: newPriority, nextReminder });
  return stmts.getTaskById.get(task.id);
}

function updateTaskContent(task, { title, description, dueDate }) {
  stmts.updateTaskContent.run({
    id: task.id,
    title: title !== undefined ? title.trim() : task.title,
    description: description !== undefined ? description : task.description,
    dueDate: dueDate !== undefined ? dueDate : task.due_date,
  });
  return stmts.getTaskById.get(task.id);
}

// ── Due-date priority escalation ───────────────────────────────────────────────

const PRIORITY_ORDER = ['P0', 'P1', 'P2', 'P3', 'P4'];

/**
 * Returns the effective priority for a task, potentially escalated based on due_date.
 * Does not mutate anything — pure function.
 */
function getEscalatedPriority(task) {
  if (!task.due_date) return task.priority;

  const hoursUntilDue = (new Date(task.due_date).getTime() - Date.now()) / (60 * 60 * 1000);
  const currentRank = PRIORITY_ORDER.indexOf(task.priority);

  let targetRank = currentRank;
  if (hoursUntilDue < 0) {
    targetRank = 0; // overdue → P0
  } else if (hoursUntilDue < 24) {
    targetRank = Math.min(currentRank, 1); // due today → at most P1
  } else if (hoursUntilDue < 120) {
    targetRank = Math.min(currentRank, 2); // due within 5 days → at most P2
  }

  return PRIORITY_ORDER[targetRank];
}

/**
 * Scans all active tasks that have a due_date and escalates their priority
 * if they're approaching their deadline. Only brings next_reminder forward,
 * never pushes it back. checkin_count is preserved (SRS cadence maintained).
 * Returns count of tasks escalated.
 */
function escalateAllDueTasks() {
  const tasks = stmts.getAllActiveTasksWithDueDates.all();
  let count = 0;
  for (const task of tasks) {
    const newPriority = getEscalatedPriority(task);
    if (newPriority === task.priority) continue;

    // Recalculate next_reminder with escalated priority, but only bring it forward
    const candidate = calcNextReminder(newPriority, task.checkin_count);
    const nextReminder = candidate < task.next_reminder ? candidate : task.next_reminder;
    stmts.updateTaskPriority.run({ id: task.id, priority: newPriority, nextReminder });
    count++;
  }
  return count;
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
  changePriority,
  updateTaskContent,
  getEscalatedPriority,
  escalateAllDueTasks,
};
