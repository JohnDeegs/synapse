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
 * Advance fromMs by durationMs worth of weekday-only time,
 * skipping Saturday (day 6) and Sunday (day 0).
 */
function skipWeekendMinutes(fromMs, durationMs) {
  let remaining = durationMs;
  let cursor = fromMs;
  while (remaining > 0) {
    const dow = new Date(cursor).getUTCDay(); // 0=Sun, 6=Sat
    if (dow === 0 || dow === 6) {
      // Skip to next Monday 00:00 UTC
      const next = new Date(cursor);
      next.setUTCDate(next.getUTCDate() + (dow === 0 ? 1 : 2));
      next.setUTCHours(0, 0, 0, 0);
      cursor = next.getTime();
      continue;
    }
    // How many ms remain until end of this weekday (UTC midnight)?
    const endOfDay = new Date(cursor);
    endOfDay.setUTCDate(endOfDay.getUTCDate() + 1);
    endOfDay.setUTCHours(0, 0, 0, 0);
    const msLeftToday = endOfDay.getTime() - cursor;
    if (remaining <= msLeftToday) {
      cursor += remaining;
      remaining = 0;
    } else {
      remaining -= msLeftToday;
      cursor = endOfDay.getTime();
    }
  }
  return cursor;
}

/**
 * Calculate next reminder timestamp (ISO string).
 * nextReminder = fromTime + baseInterval × min(1 + checkinCount × 0.5, 5)
 * When weekdayOnly=true, weekend hours are skipped in the interval.
 */
function calcNextReminder(priority, checkinCount, fromTime = Date.now(), weekdayOnly = false) {
  const base = BASE_INTERVALS[priority];
  const multiplier = Math.min(1 + checkinCount * 0.5, 5);
  const ms = base * multiplier * 60 * 1000;
  if (weekdayOnly) {
    return new Date(skipWeekendMinutes(fromTime, ms)).toISOString();
  }
  return new Date(fromTime + ms).toISOString();
}

/**
 * Returns true if any tag on this task has weekday_only = 1.
 */
function taskHasWeekdayOnlyTag(taskId) {
  const tags = stmts.getTagsForTask.all(taskId);
  return tags.some(t => t.weekday_only === 1);
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
  const weekdayOnly = taskHasWeekdayOnlyTag(task.id);
  const nextReminder = calcNextReminder(newPriority, newCount, Date.now(), weekdayOnly);
  stmts.updateTask.run({
    id: task.id,
    status: task.status,
    priority: newPriority,
    checkinCount: newCount,
    nextReminder,
    priorityLocked: task.priority_locked || 0,
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
    priorityLocked: task.priority_locked || 0,
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
    priorityLocked: task.priority_locked || 0,
  });
  return stmts.getTaskById.get(task.id);
}

function deleteTask(id, userId) {
  const info = stmts.deleteTask.run(id, userId);
  return info.changes > 0;
}

function changePriority(task, newPriority, lock = false) {
  const weekdayOnly = taskHasWeekdayOnlyTag(task.id);
  const nextReminder = calcNextReminder(newPriority, task.checkin_count, Date.now(), weekdayOnly);
  if (lock) {
    stmts.lockTaskPriority.run({ id: task.id, priority: newPriority, nextReminder });
  } else {
    stmts.updateTaskPriority.run({ id: task.id, priority: newPriority, nextReminder });
  }
  return stmts.getTaskById.get(task.id);
}

function unlockTaskPriority(task) {
  stmts.unlockTaskPriority.run(task.id);
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
  if (task.priority_locked) return task.priority;
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
  const blockedIds = new Set(stmts.getBlockedTaskIds.all().map(r => r.blocked_task_id));
  let count = 0;
  for (const task of tasks) {
    if (blockedIds.has(task.id)) continue; // frozen by dependency
    const newPriority = getEscalatedPriority(task);
    if (newPriority === task.priority) continue;

    // Recalculate next_reminder with escalated priority, but only bring it forward
    const weekdayOnly = taskHasWeekdayOnlyTag(task.id);
    const candidate = calcNextReminder(newPriority, task.checkin_count, Date.now(), weekdayOnly);
    const nextReminder = candidate < task.next_reminder ? candidate : task.next_reminder;
    stmts.updateTaskPriority.run({ id: task.id, priority: newPriority, nextReminder });
    count++;
  }
  return count;
}


/**
 * On weekends, push overdue weekday-only tasks forward to Monday 00:00 UTC
 * so they don't show as overdue on the web dashboard or fire Telegram alerts.
 * No-op on weekdays. Returns count of tasks deferred.
 */
function deferWeekdayOnlyTasksForWeekend() {
  const dow = new Date().getUTCDay(); // 0=Sun, 6=Sat
  if (dow !== 0 && dow !== 6) return 0;

  const mon = new Date();
  mon.setUTCDate(mon.getUTCDate() + (dow === 0 ? 1 : 2));
  mon.setUTCHours(0, 0, 0, 0);
  const nextMonday = mon.toISOString();

  const overdue = stmts.getAllOverdueActiveTasks.all(new Date().toISOString());
  let count = 0;
  for (const task of overdue) {
    if (!taskHasWeekdayOnlyTag(task.id)) continue;
    stmts.updateTask.run({
      id: task.id,
      status: task.status,
      priority: task.priority,
      checkinCount: task.checkin_count,
      nextReminder: nextMonday,
      priorityLocked: task.priority_locked || 0,
    });
    count++;
  }
  return count;
}

function getBlockedTaskIds() {
  return new Set(stmts.getBlockedTaskIds.all().map(r => r.blocked_task_id));
}

/**
 * Snapshot today's health for a user: 'green' if no active task is overdue,
 * 'red' if any active task is past its next_reminder. Upserts daily_health.
 */
function snapshotDailyHealth(userId) {
  const now = Date.now();
  const tasks = stmts.getActiveTasks.all(userId);
  const anyOverdue = tasks.some(t => new Date(t.next_reminder).getTime() < now);
  const status = anyOverdue ? 'red' : 'green';
  const date = new Date().toISOString().slice(0, 10);
  stmts.upsertDailyHealth.run({ userId, date, status });
  return status;
}

module.exports = {
  BASE_INTERVALS,
  skipWeekendMinutes,
  calcNextReminder,
  taskHasWeekdayOnlyTag,
  snapshotDailyHealth,
  deferWeekdayOnlyTasksForWeekend,
  createTask,
  getActiveTasks,
  getTaskById,
  checkinTask,
  completeTask,
  snoozeTask,
  deleteTask,
  changePriority,
  unlockTaskPriority,
  updateTaskContent,
  getEscalatedPriority,
  escalateAllDueTasks,
  getBlockedTaskIds,
};
