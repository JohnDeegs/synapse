# Synapse — Builder Notes

Observations and lessons learned phase by phase. Intended to help the next person pick up where we left off without hitting the same walls.

---

## Data Format Gotcha: `next_reminder` is an ISO string, not a Unix timestamp

The backend stores and returns `next_reminder` as an ISO 8601 string (e.g. `"2026-03-10T14:30:00.000Z"`), not a numeric Unix timestamp. This trips up any frontend code that treats it as a number.

**In popup.js**, sorting tasks works accidentally because JS coerces ISO strings to numbers as `NaN`, which makes `.sort()` order undefined. A safe sort must parse first:
```js
tasks.sort((a, b) => new Date(a.next_reminder) - new Date(b.next_reminder));
```

**Countdown calculation** must parse through `new Date()`:
```js
const ms = new Date(task.next_reminder).getTime(); // correct
const ms = task.next_reminder * 1000;              // WRONG — produces NaN
```

This caused the "NaNd" countdown bug in Phase 4. Fixed in commit `b85a1df`.

---

## Backend: `next_reminder` is stored as SQLite TEXT (ISO string)

SQLite has no native datetime type. The schema uses `TEXT NOT NULL` for `next_reminder`. The `calcNextReminder()` function in `tasks.js` returns `new Date(...).toISOString()`. String-based ISO sorting works correctly in SQLite (`ORDER BY next_reminder ASC`) because ISO 8601 strings are lexicographically ordered.

---

## Chrome Extension: Opening Options from popup requires `chrome.tabs.create`

MV3 popups cannot navigate themselves to other extension pages. To send the user to `options.html`, you must use:
```js
chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
```
This requires the `"tabs"` permission in `manifest.json`. It was missing initially and added in Phase 3 (commit `e97b17c`).

---

## MV3 Service Worker Lifecycle

The background service worker (`background.js`) is not a persistent background page — Chrome can terminate it at any time. Key implications for Phase 5:

- Do not rely on in-memory state across alarm firings. Always re-read from `chrome.storage.local` on each alarm event.
- `chrome.alarms` is the right mechanism to wake the worker periodically; don't use `setInterval`.
- To test with a short interval, set `periodInMinutes: 0.1` (every 6 seconds). Restore to `1` before merging.

---

## Auth flow: `email` is stored alongside `token` in `chrome.storage.local`

`options.js` saves `{ token, apiBase, email }` on login/register. The `email` key is used only for the display label on the logged-in state. `popup.js` only reads `token` and `apiBase` — it does not need `email`.

---

## Backend: `readBody()` only handles JSON

The current `readBody()` in `server.js` parses only `application/json`. If any HTML form ever submits directly to the backend (not via JS `fetch`), it will fail silently because `application/x-www-form-urlencoded` bodies are not handled. All current callers use `fetch` with `Content-Type: application/json`, so this is fine for now.

---

## SRS Formula Cap

```
nextReminder = now + baseInterval_P × min(1 + checkinCount × 0.5, 5)
```

The multiplier caps at **5×** (reached after 8 check-ins). After that, additional check-ins do not widen the interval further. The cap applies per priority level, so a P0 task maxes out at 150 min (30 × 5), not a flat number.

---

## Deployment Notes (Phase 6 — not yet done)

- Do NOT set `PORT` as an env var on Railway — Railway injects it automatically. Setting it manually causes port binding failures.
- Set `DATA_FILE` to a path on the persistent volume (e.g. `/data/synapse.db`). Without a volume, the SQLite database resets on every deploy.
- `JWT_SECRET` must be set. The server does not fall back to a default in production.

---

## Phase 5 Post-Mortem: Background Worker & Notifications

### 1. `onInstalled` does not fire on extension reload

**What happened:** `chrome.runtime.onInstalled` only fires on first install or version update — not when you click "Reload" on `chrome://extensions`. After every reload during development, the alarm was cleared and never recreated, so no notifications fired.

**Fix:** Add a startup check at the top level of the service worker:
```js
chrome.alarms.get(ALARM_NAME, (alarm) => {
  if (!alarm) chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
});
```
This runs every time the SW starts and ensures the alarm always exists.

**Advice for future builders:** Always pair `onInstalled` alarm creation with a top-level `chrome.alarms.get` guard. During development you will reload constantly, and without this the alarm silently disappears every time.

---

### 2. Service worker goes idle between alarm firings — don't call SW functions from DevTools console

**What happened:** After the SW went idle and was woken by an alarm, calling `checkAndNotify()` directly in the DevTools console gave `ReferenceError: checkAndNotify is not defined`. The console was connected to a stale SW context.

**Fix:** Don't try to manually invoke SW functions from the console. Instead, wait for the alarm to fire naturally (every 6 seconds with `periodInMinutes: 0.1`), or add temporary `console.log` statements to observe execution.

**Advice for future builders:** The SW DevTools console is unreliable for manual function calls. Use logging inside the SW itself and watch the console passively.

---

### 3. Windows suppresses Chrome notification banners by default

**What happened:** Notifications were being created successfully (`chrome.notifications.create` returned ok) but no banners appeared on screen. They were silently collected in the Windows Action Center (Win+N).

**Fix:** Windows Settings → System → Notifications → Google Chrome → turn on "Show notification banners."

**Advice for future builders:** On Windows, `chrome.notifications.create` succeeding does NOT mean a banner will appear. Always verify OS-level notification settings for Chrome. The Action Center (Win+N) is useful for confirming notifications are being received even when banners are suppressed.

---

### 4. Windows Action Center only shows 2 notification buttons

**What happened:** Our notification has 3 buttons (Complete, Check-in, Snooze 1hr), but the Action Center only displays the first 2. The Snooze button was invisible there.

**Impact:** Low — buttons work correctly on banner toasts, which is the primary UX. The Action Center is a fallback. This is a Windows platform limitation, not a bug.

**Advice for future builders:** If you need all 3 buttons accessible, consider making the 3rd action (Snooze) the default click action on the notification body instead of a button.

---

### 5. `activeNotifications` is in-memory — resets on every SW restart

**What happened:** The `activeNotifications` map tracks which tasks already have a notification showing, to prevent duplicates. Because it's a plain JS object in the SW, it resets every time the SW restarts (which happens on every alarm firing after idle).

**Why this is acceptable:** Each alarm cycle the SW restarts fresh, `activeNotifications` is empty, and Chrome's own notification system deduplicates by notification ID (`task-<id>`). If a notification with that ID already exists, `chrome.notifications.create` silently no-ops. So duplicate prevention works at the Chrome level even when the in-memory map is cleared.

**Advice for future builders:** Don't rely on in-memory state for anything critical across alarm cycles. Use `chrome.storage.local` for persistent state, or rely on Chrome's own deduplication by notification ID.

---

## Phase Completion Status

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Backend: Database & Auth | Done |
| 2 | Backend: Task API | Done |
| 3 | Extension: Manifest, Options & Login | Done |
| 4 | Extension: Popup (Quick-capture & Task List) | Done |
| 5 | Extension: Background Worker & Notifications | Done |
| 6 | Deployment | Pending |
