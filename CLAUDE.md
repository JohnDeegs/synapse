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

---

## Architecture

### Backend coding patterns

All DB access flows through prepared statements defined in `db.js` and imported via `const { stmts } = require('./db')`. **Never write inline SQL in other files** — add a new prepared statement to `stmts` in `db.js` instead.

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

### Chrome Extension

```
extension/
  manifest.json       # MV3 manifest
  background.js       # Service worker: alarms → fetch due tasks → fire notifications
  popup.html/js       # Quick-capture UI (create tasks + task list)
  options.html/js     # Login/register form + backend URL config
```

`background.js` maintains an in-memory `activeNotifications` map (`notificationId → taskId`) to deduplicate notifications. **This map is lost when the service worker is terminated** — MV3 service workers are short-lived. The alarm is re-created on startup via `chrome.alarms.get` + create if missing.

`chrome.storage.local` holds `{ token, apiBase }`. Both must be present for any API calls to fire.

Notification button indices: 0 = Complete, 1 = Check-in, 2 = Snooze 1hr.

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

Production URL: `https://synapse-production-3ae7.up.railway.app`

---

## Workflow

Rule: After completing every sub-task or fixing a specific file, you must run `git commit -m "claude: <description>"` before moving to the next step.
