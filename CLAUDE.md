# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Synapse** — a contextual reminder app using Spaced Repetition (SRS) to fight notification blindness. See `plan.md` for the full PRD.

**v1.0 scope:** Chrome Extension (MV3) + vanilla Node.js backend on Railway. No Android, no build step.

---

## Stack & Constraints

- **No build step, no TypeScript, no framework.** All code must run as-is (unpacked extension, raw `node server.js`).
- **Chrome Extension:** Manifest V3, vanilla JS. Key APIs: `chrome.alarms`, `chrome.notifications`, `chrome.storage.local`.
- **Backend:** `http.createServer` (no Express), SQLite via `better-sqlite3`, Railway deployment.
- **Auth:** JWT (`jsonwebtoken` + `bcryptjs`), passed as `Authorization: Bearer <token>` header. Multi-user.

---

## Architecture

### Chrome Extension
```
extension/
  manifest.json       # MV3 manifest
  background.js       # Service worker: chrome.alarms → fetch due tasks → fire notifications
  popup.html/js       # Quick-capture UI (create tasks)
  options.html/js     # Login/register form + backend URL config
```

- The background service worker wakes on `chrome.alarms`, calls `GET /tasks` on the backend, compares `nextReminder` timestamps, and fires `chrome.notifications.create()` for due tasks.
- Notification action buttons: **Complete**, **Check-in**, **Snooze 1hr** — handled in `background.js` via `chrome.notifications.onButtonClicked`.
- API base URL and JWT token stored in `chrome.storage.local`.

### Backend
```
server/
  server.js     # http.createServer, all route handling
  db.js         # SQLite init, schema, prepared statement helpers
  auth.js       # hashPassword, verifyPassword, signToken, verifyToken
  tasks.js      # SRS formula, task CRUD helpers
  .env.example  # PORT, DATA_FILE, JWT_SECRET
```

REST endpoints:
| Method | Path | Action |
|--------|------|--------|
| POST | `/auth/register` | Create account, return JWT |
| POST | `/auth/login` | Verify credentials, return JWT |
| GET | `/tasks` | Return active tasks for authenticated user |
| POST | `/tasks` | Create task |
| PATCH | `/tasks/:id` | checkin / complete / snooze |
| DELETE | `/tasks/:id` | Delete task (must own it) |

### Database Schema (SQLite)
- `users`: `id`, `email`, `password_hash`, `created_at`
- `tasks`: `id`, `user_id`, `title`, `description`, `priority`, `status`, `checkin_count`, `next_reminder`, `created_at`
- `checkin_log`: `id`, `task_id`, `note`, `created_at`

### SRS Reminder Formula
```
nextReminder = now + (baseInterval_P × min(1 + checkinCount × 0.5, 5))
```
Base intervals: P0=30min, P1=120min, P2=1440min, P3=4320min, P4=10080min. Cap at 5× baseline.

---

## Running Locally

**Backend:**
```bash
cd server && npm install && node server.js
```
Reads `PORT`, `DATA_FILE`, `JWT_SECRET` from env (defaults: port 3000, `./synapse.db`).

**Extension:**
1. Open `chrome://extensions`
2. Enable Developer Mode
3. Load Unpacked → select the `extension/` folder

---

## Deployment

Backend deploys to Railway. Required env vars:
- `PORT` (set by Railway automatically — do NOT set manually)
- `DATA_FILE` — path to persistent volume mount (e.g. `/data/synapse.db`)
- `JWT_SECRET` — random secret for signing tokens

---

## Key Lessons from Previous Project (LocalGo)

- Set `PUBLIC_URL` / `API_BASE_URL` env vars **after** the Railway URL is known, not speculatively — avoids CORS issues.
- `readBody()` must handle both `application/json` and `application/x-www-form-urlencoded` if any HTML forms are involved.
- Test the extension's `declarativeNetRequest` / alarm permissions in a real Chrome profile, not just unit tests — MV3 service worker lifecycle is tricky.
