// background.js — Phase 5: alarm-driven notifications

const ALARM_NAME = 'reminderCheck';

// Track which task IDs have active notifications to avoid duplicates
const activeNotifications = {}; // notificationId -> taskId

// Create alarm on install and on every service worker startup
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
});

chrome.alarms.get(ALARM_NAME, (alarm) => {
  if (!alarm) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  checkAndNotify();
});

function isDuringQuietHours(start, end) {
  const hour = new Date().getHours(); // 0–23 local time
  if (start < end) return hour >= start && hour < end; // normal window e.g. 9→17
  return hour >= start || hour < end;                  // midnight-crossing e.g. 23→7
}

function msUntilQuietEnd(endHour) {
  const target = new Date();
  target.setHours(endHour, 0, 0, 0);
  if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
  return target.getTime() - Date.now();
}

async function checkAndNotify() {
  const { token, apiBase, quietEnabled, quietStart, quietEnd } =
    await chrome.storage.local.get(['token', 'apiBase', 'quietEnabled', 'quietStart', 'quietEnd']);
  if (!token || !apiBase) return;

  const qEnabled = quietEnabled !== false;
  const qStart   = quietStart  !== undefined ? quietStart  : 23;
  const qEnd     = quietEnd    !== undefined ? quietEnd    : 7;
  const inQuiet  = qEnabled && isDuringQuietHours(qStart, qEnd);

  let tasks;
  try {
    const res = await fetch(`${apiBase}/tasks`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) return;
    tasks = await res.json();
  } catch {
    return;
  }

  const now = Date.now();

  if (inQuiet) {
    // Freeze timer: snooze overdue tasks forward to quiet-end, staggered 2 min apart
    const overdue = tasks.filter(t => t.status === 'active' && new Date(t.next_reminder).getTime() <= now);
    const minsUntilEnd = Math.ceil(msUntilQuietEnd(qEnd) / 60000);
    for (let i = 0; i < overdue.length; i++) {
      await fetch(`${apiBase}/tasks/${overdue[i].id}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'snooze', minutes: minsUntilEnd + i * 2 })
      }).catch(() => {});
    }
    return;
  }

  for (const task of tasks) {
    const due = new Date(task.next_reminder).getTime();
    if (due > now) continue;

    // Check per-tag quiet hours — snooze task if any tag is in its quiet window
    if (task.tags) {
      const quietTag = task.tags.find(tag =>
        tag.quiet_start !== null && tag.quiet_end !== null &&
        isDuringQuietHours(tag.quiet_start, tag.quiet_end)
      );
      if (quietTag) {
        const minsUntilEnd = Math.ceil(msUntilQuietEnd(quietTag.quiet_end) / 60000);
        await fetch(`${apiBase}/tasks/${task.id}`, {
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'snooze', minutes: minsUntilEnd })
        }).catch(() => {});
        continue;
      }
    }

    // Skip if we already have an active notification for this task
    const alreadyNotified = Object.values(activeNotifications).includes(task.id);
    if (alreadyNotified) continue;

    const notifId = `task-${task.id}`;
    activeNotifications[notifId] = task.id;

    chrome.notifications.create(notifId, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: `[${task.priority}] ${task.title}`,
      message: task.description || 'Task is due for review.',
      buttons: [
        { title: 'Complete' },
        { title: 'Check-in' },
        { title: 'Snooze 1hr' }
      ],
      requireInteraction: true
    });
  }
}

chrome.notifications.onButtonClicked.addListener(async (notifId, buttonIndex) => {
  const taskId = activeNotifications[notifId];
  if (!taskId) return;

  const { token, apiBase } = await chrome.storage.local.get(['token', 'apiBase']);
  if (!token || !apiBase) return;

  let body;
  if (buttonIndex === 0) {
    body = { action: 'complete' };
  } else if (buttonIndex === 1) {
    body = { action: 'checkin', note: 'Checked in via notification' };
  } else if (buttonIndex === 2) {
    body = { action: 'snooze', minutes: 60 };
  }

  try {
    await fetch(`${apiBase}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
  } catch {
    // best-effort; notification still clears
  }

  chrome.notifications.clear(notifId);
  delete activeNotifications[notifId];
});

chrome.notifications.onClosed.addListener((notifId) => {
  delete activeNotifications[notifId];
});
