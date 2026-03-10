// background.js — Phase 5: alarm-driven notifications

const ALARM_NAME = 'reminderCheck';

// Track which task IDs have active notifications to avoid duplicates
const activeNotifications = {}; // notificationId -> taskId

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.1 }); // TEMP: testing only, restore to 1 before merge
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  checkAndNotify();
});

async function checkAndNotify() {
  const { token, apiBase } = await chrome.storage.local.get(['token', 'apiBase']);
  if (!token || !apiBase) return;

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
  for (const task of tasks) {
    const due = new Date(task.next_reminder).getTime();
    if (due > now) continue;

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
