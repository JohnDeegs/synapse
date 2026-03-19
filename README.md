# Synapse

A contextual reminder app using Spaced Repetition (SRS) to fight notification blindness.

**Stack:** Chrome Extension (MV3) + vanilla Node.js backend + SQLite, deployed on Railway.
**V2 features:** Web dashboard · Telegram bot (Gemini 2.5 Flash + RAG) · Tags · Daily briefings.

See `plan.md` for the full PRD and `tasksV2.md` for the V2 build task list.

---

## Features

- **SRS reminders** — P0–P4 priorities with capped linear interval growth; intervals widen on each check-in
- **Chrome Extension** — quick-capture popup + OS notifications with Complete / Check-in / Snooze buttons
- **Web dashboard** — full CRUD, inline editing, tags, markdown rendering, dark mode, live countdown timers, check-in history, bulk actions, stats bar
- **Telegram bot** — natural language task management via Gemini 2.5 Flash + vector RAG; daily 7 am briefing
- **Due-date escalation** — tasks with approaching due dates automatically bump priority

---

## Local Setup

### Backend
```bash
cd server
cp .env.example .env   # edit .env — set JWT_SECRET at minimum
npm install
node server.js
# Server runs on http://localhost:3000
# Web dashboard: http://localhost:3000/web
```

### Extension
1. Open `chrome://extensions`
2. Enable Developer Mode
3. Click **Load unpacked** → select the `extension/` folder
4. Click the extension icon → **Options**
5. Enter `http://localhost:3000` as the API base URL
6. Register an account and start adding tasks

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | Yes | Random secret for signing tokens |
| `DATA_FILE` | Yes (prod) | Path to SQLite file (e.g. `/data/synapse.db`) |
| `PORT` | Railway only | Injected automatically — **do not set manually** |
| `TELEGRAM_BOT_TOKEN` | Optional | BotFather token — enables Telegram bot |
| `APP_BASE_URL` | Optional | Public HTTPS URL — required for Telegram webhook registration |
| `GEMINI_API_KEY` | Optional | Google AI Studio key — required for LLM features |
| `BRIEFING_HOUR` | Optional | Hour (0–23) for daily briefing, default `7` |

---

## Deployment (Railway)

### 1. Create the Railway project
1. Go to [railway.app](https://railway.app) and create a new project
2. Choose **Deploy from GitHub repo** → select this repository
3. Set the **Root Directory** to `server`

### 2. Add a persistent volume
1. In your Railway service, click **Add Volume**
2. Set the mount path to `/data`

### 3. Set environment variables
In Railway → **Variables**, add at minimum:

| Variable | Value |
|----------|-------|
| `DATA_FILE` | `/data/synapse.db` |
| `JWT_SECRET` | any long random string |

Add `TELEGRAM_BOT_TOKEN`, `APP_BASE_URL`, and `GEMINI_API_KEY` to enable the Telegram bot.

> Do **not** set `PORT` — Railway injects it automatically.

### 4. Generate a domain and deploy
1. Go to **Settings → Networking** → **Generate Domain**
2. Check your **Deploy Logs** for `Synapse server listening on port XXXX` and enter that port
3. Railway auto-deploys on push to `main`

> **Tip:** `GET /tasks` should return `401` when the server is up. The root URL (`/`) returns 404 — expected, there is no index route.

### 5. Point the extension at production
1. Open the extension Options page
2. Replace `http://localhost:3000` with your Railway URL
3. Register/login against the production backend

### 6. Verify
```bash
curl -X POST https://<your-railway-url>/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"secret"}'
# Expected: { "token": "eyJ..." }
```

---

## Telegram Bot Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy the token
2. Add `TELEGRAM_BOT_TOKEN` and `APP_BASE_URL` to Railway env vars — the webhook registers automatically on startup
3. Add `GEMINI_API_KEY` for LLM-powered natural language commands
4. In the web dashboard, go to **Settings → Telegram** and generate a one-time code
5. Send `/connect <code>` to your bot in Telegram

The bot supports natural language: *"What's due today?"*, *"Remind me to review the contract, it's critical"*, *"Mark the budget report done"*, etc.

---

## API Reference

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/auth/register` | — | Create account, return JWT |
| `POST` | `/auth/login` | — | Verify credentials, return JWT |
| `GET` | `/tasks` | Bearer | List active tasks (includes tags) |
| `POST` | `/tasks` | Bearer | Create a task |
| `PATCH` | `/tasks/:id` | Bearer | Check-in, complete, or snooze |
| `DELETE` | `/tasks/:id` | Bearer | Delete a task |
| `GET` | `/tags` | Bearer | List all tags for user |
| `POST` | `/tags` | Bearer | Create a tag |
| `GET/POST/DELETE` | `/tasks/:id/tags` | Bearer | Manage tags on a task |
| `POST` | `/auth/telegram-code` | Bearer | Generate one-time Telegram link code |
| `GET/DELETE` | `/telegram/connect` | Bearer | Check / unlink Telegram connection |
| `POST` | `/telegram/webhook` | Secret | Telegram webhook receiver |
| `GET` | `/web/*` | — | Web dashboard static files |
