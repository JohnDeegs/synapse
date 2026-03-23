# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Synapse** — a contextual reminder app using Spaced Repetition (SRS) to fight notification blindness. See `plan.md` for the full PRD. V2 feature scope (web dashboard + Telegram/LLM bot) is in `plan.md` §9 and broken into phases in `tasksV2.md`.

**v1.0 scope:** Chrome Extension (MV3) + vanilla Node.js backend on Railway. No Android, no build step.

---

## Stack & Constraints

- **No build step, no TypeScript, no framework.** All code must run as-is (unpacked extension, raw `node server.js`).
- **Chrome Extension:** Manifest V3, vanilla JS. Key APIs: `chrome.alarms`, `chrome.notifications`, `chrome.storage.local`.
- **Backend:** `http.createServer` (no Express), SQLite via `better-sqlite3`, Railway deployment.
- **Auth:** JWT (`jsonwebtoken` + `bcryptjs`), passed as `Authorization: Bearer <token>` header. Tokens expire in 30 days. Multi-user.

---

## Running Locally

**Backend:**
```bash
cd server
cp .env.example .env   # edit JWT_SECRET at minimum
npm install
node server.js
```
Reads `PORT`, `DATA_FILE`, `JWT_SECRET` from `.env` (defaults: port 3000, `./synapse.db`).

**Extension:**
1. Open `chrome://extensions`
2. Enable Developer Mode
3. Load Unpacked → select the `extension/` folder

The web dashboard is served by the backend at `http://localhost:3000/web`.

---

## Architecture

### Backend coding patterns

All DB access flows through prepared statements defined in `db.js` and imported via `const { stmts } = require('./db')`. **Never write inline SQL in other files** — add a new prepared statement to `stmts` in `db.js` instead.

**Adding columns to existing tables:** Do NOT modify the `CREATE TABLE IF NOT EXISTS` block. Add an `ALTER TABLE` to the idempotent migration loop near line 101 of `db.js`:
```js
'ALTER TABLE tags ADD COLUMN my_col INTEGER DEFAULT 0',
```
The loop catches `duplicate column name` errors so it's safe to run on every startup.

`server.js` does manual URL matching — no router library. Pattern for adding a route:
```js
if (req.method === 'GET' && url === '/new-path') {
  const u = authenticate(req);  // returns decoded JWT payload { userId, email } or null
  if (!u) return send(res, 401, { error: 'Unauthorized' });
  return await handleNewRoute(req, res, u);
}
```
`send(res, status, body)` handles all JSON responses. `readBody(req)` parses request JSON.

`tasks.js` owns the SRS formula and all task mutation helpers. `auth.js` wraps bcrypt/JWT with no side effects.

SQLite runs in WAL mode. Schema is created via `CREATE TABLE IF NOT EXISTS` on every startup — no migration files.

### Scheduled jobs (server.js)

Three jobs run on the server:
- **Daily briefing** — fires at `BRIEFING_HOUR` UTC (default 7). Escalates due-date tasks first, then sends a Telegram summary to connected users.
- **Overdue alerts** — every 5 minutes, sends Telegram messages for any overdue active tasks.
- **Hourly escalation** — escalates priority for tasks approaching their `due_date` and snapshots daily health for all users.

### Due-date escalation (tasks.js)

When a task has a `due_date`, `escalateTaskPriority()` auto-raises priority:
- overdue → P0, within 24 h → at most P1, within 5 days → at most P2.
It only moves `next_reminder` forward, never back.

### Tags

Tags are per-user labels stored in `tags` with a many-to-many join `task_tags`. Each tag has three optional constraints on when its tasks fire:
- `weekday_only` (0/1) — skips weekends when calculating `next_reminder` (via `skipWeekendMinutes` in `tasks.js`).
- `quiet_start` / `quiet_end` (0–23, nullable) — per-tag quiet hours. The extension snoozes overdue tasks to `quiet_end` when the tag's window is active, mirroring the global quiet-hours logic.

### Chrome Extension

```
extension/
  manifest.json       # MV3 manifest
  background.js       # Service worker: alarms → fetch due tasks → fire notifications
  popup.html/js       # Quick-capture UI (create tasks + task list)
  options.html/js     # Login/register form + backend URL config
```

`background.js` maintains an in-memory `activeNotifications` map (`notificationId → taskId`) to deduplicate notifications. **This map is lost when the service worker is terminated** — MV3 service workers are short-lived. The alarm is re-created on startup via `chrome.alarms.get` + create if missing.

`chrome.storage.local` holds `{ token, apiBase, quietEnabled, quietStart, quietEnd }`. Both `token` and `apiBase` must be present for any API calls to fire.

Notification button indices: 0 = Complete, 1 = Check-in, 2 = Snooze 1hr.

### Web dashboard (`server/web/`)

Single-page app served as static files by the backend. No framework — vanilla JS in `app.js` (~1100 lines). Key globals: `allTasks`, `allTags`, `filterTag`, `openQuietTagId`. Rendering is manual DOM via `innerHTML`; `renderTasks()` and `renderTagSidebar()` are the main entry points. Auto-refreshes every 30 s by diffing task signatures.

The dashboard uses `EasyMDE` for markdown editing and a custom `DatePicker` (`datepicker.js`) for due dates.

### Telegram integration (`telegram.js`, `llm.js`)

- Bot receives updates via webhook at `POST /telegram/webhook` (verified with `TELEGRAM_SECRET`).
- `telegram.js` handles connection codes, rate limiting, and message dispatch.
- `llm.js` calls Gemini 2.5 Flash to generate natural-language briefings and replies.
- Required env vars: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_SECRET`, `GEMINI_API_KEY`.

### SRS Reminder Formula
```
nextReminder = now + (baseInterval_P × min(1 + checkinCount × 0.5, 5))
```
Base intervals: P0=30min, P1=120min, P2=1440min, P3=4320min, P4=10080min. Cap at 5× baseline.

**Forcing a task past-due for testing** (negative snooze):
```bash
curl -X PATCH http://localhost:3000/tasks/<id> \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"snooze","minutes":-60}'
```

---

## Deployment

Backend deploys to Railway. Required env vars:
- `PORT` — set by Railway automatically, **do NOT set manually**
- `DATA_FILE` — path to persistent volume mount (e.g. `/data/synapse.db`)
- `JWT_SECRET` — random secret for signing tokens
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_SECRET`, `GEMINI_API_KEY` — for Telegram/LLM features

Production URL: `https://synapse-production-3ae7.up.railway.app`

---

## Workflow

Rule: After completing every sub-task or fixing a specific file, you must run `git commit -m "claude: <description>"` before moving to the next step.
