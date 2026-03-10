# Synapse — Build Tasks

Each phase is completed on its own git branch and merged to `main` after testing passes.

**Branch naming:** `phase/<n>-<short-name>`
**Initial commit:** `main` — project scaffolding (this file, `plan.md`, `CLAUDE.md`, `.gitignore`, `README.md`)

---

## Phase 1 — Backend: Database & Auth
**Branch:** `phase/1-backend-auth`

### Tasks
- [x] Create `server/package.json` with dependencies: `better-sqlite3`, `bcryptjs`, `jsonwebtoken`
- [x] Create `server/.env.example` with `PORT`, `DATA_FILE`, `JWT_SECRET`
- [x] Create `server/db.js` — SQLite init, schema creation (`users`, `tasks`, `checkin_log` tables), prepared statement helpers
- [x] Create `server/auth.js` — `hashPassword`, `verifyPassword`, `signToken`, `verifyToken`
- [x] Create `server/server.js` with:
  - `readBody()` helper
  - Auth middleware (reads `Authorization: Bearer` header)
  - `POST /auth/register` and `POST /auth/login` routes only

### Testing
```bash
cd server && npm install && node server.js

# Register a user
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"secret"}'
# Expected: { "token": "eyJ..." }

# Login with same credentials
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"secret"}'
# Expected: { "token": "eyJ..." }

# Login with wrong password
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"wrong"}'
# Expected: 401 { "error": "Invalid credentials" }
```
**Pass criteria:** Both auth routes respond correctly; `synapse.db` is created with the correct schema.

---

## Phase 2 — Backend: Task API
**Branch:** `phase/2-backend-tasks`

### Tasks
- [x] Create `server/tasks.js`:
  - `BASE_INTERVALS` map (P0=30, P1=120, P2=1440, P3=4320, P4=10080 minutes)
  - `calcNextReminder(priority, checkinCount, fromTime)` pure function
  - Task CRUD helpers using db prepared statements
- [x] Add task routes to `server/server.js`:
  - `GET /tasks` — return active tasks for authenticated user
  - `POST /tasks` — create task, set `nextReminder` via `calcNextReminder`
  - `PATCH /tasks/:id` — actions: `checkin` (increment count, append log, recalculate), `complete` (set status), `snooze` (set next_reminder = now + minutes)
  - `DELETE /tasks/:id` — delete task (must belong to authenticated user)

### Testing
```bash
# (server already running, use token from Phase 1)
export TOKEN="<token from phase 1>"

# Create a P0 task
curl -X POST http://localhost:3000/tasks \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Fix prod bug","priority":"P0","description":"Server is down"}'
# Expected: task object with nextReminder = ~30 min from now

# List tasks
curl http://localhost:3000/tasks -H "Authorization: Bearer $TOKEN"
# Expected: array containing the task above

# Check in on the task
curl -X PATCH http://localhost:3000/tasks/<id> \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"checkin","note":"Investigating now"}'
# Expected: nextReminder widens to ~45 min from now (1 check-in: multiplier = 1.5)

# Check-in 7 more times (total 8), verify cap
# Expected: nextReminder = 150 min from now (cap at 5× = 150 min for P0)

# Snooze
curl -X PATCH http://localhost:3000/tasks/<id> \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"snooze","minutes":60}'
# Expected: nextReminder = ~60 min from now

# Complete
curl -X PATCH http://localhost:3000/tasks/<id> \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"complete"}'
# Expected: task status = "completed"

# Verify completed task no longer appears in GET /tasks
curl http://localhost:3000/tasks -H "Authorization: Bearer $TOKEN"
# Expected: empty array (or list without the completed task)

# Attempt to access another user's task (register second user, try to PATCH first user's task)
# Expected: 403 or 404
```
**Pass criteria:** All CRUD operations work; SRS formula caps correctly at 5×; completed tasks hidden from list; cross-user access blocked.

---

## Phase 3 — Extension: Manifest, Options & Login
**Branch:** `phase/3-extension-auth`

### Tasks
- [ ] Create `extension/manifest.json` (MV3, permissions: `alarms`, `notifications`, `storage`, host_permissions for backend URL)
- [ ] Create placeholder `extension/icons/` (16px, 48px, 128px PNGs — can use simple placeholders initially)
- [ ] Create `extension/options.html` — tabbed Login / Register form with API base URL field
- [ ] Create `extension/options.js`:
  - On submit: call `/auth/login` or `/auth/register`
  - On success: save `{ token, apiBase }` to `chrome.storage.local`
  - Show logged-in state (display email, logout button)
  - Logout clears `chrome.storage.local`

### Testing
1. Load extension unpacked in Chrome (`chrome://extensions` → Load unpacked → select `extension/`)
2. Open Options page (click extension icon → Options, or right-click → Options)
3. Enter backend URL (`http://localhost:3000`) and register a new account → verify success state shown
4. Logout and log back in with the same credentials → verify token saved
5. Open DevTools → Application → Extension Storage → confirm `token` and `apiBase` keys are present
6. Enter wrong password → verify error message displayed (no token saved)

**Pass criteria:** Login/register flow works end-to-end; token persists across browser restarts; logout clears storage cleanly.

---

## Phase 4 — Extension: Popup (Quick-capture & Task List)
**Branch:** `phase/4-extension-popup`

### Tasks
- [ ] Create `extension/popup.html` — quick-add form (title, priority dropdown, description) + task list section
- [ ] Create `extension/popup.js`:
  - On open: read `{ token, apiBase }` from storage; if missing, show "Please log in via Options"
  - Fetch active tasks on open; render sorted by `nextReminder` ASC
  - Each task row: title, priority badge, human-readable countdown (e.g. "in 23 min"), [Complete] [Check-in] [Snooze] buttons
  - Check-in button: expand inline text input for note before submitting
  - Quick-add form: `POST /tasks` on submit, refresh list on success

### Testing
1. With extension loaded and logged in, open the popup
2. Create a P1 task → verify it appears in the list with correct countdown
3. Create a P0 task → verify it appears above the P1 task (sorted sooner)
4. Click Check-in → enter note → submit → verify `nextReminder` updates in the list
5. Click Complete → verify task disappears from list
6. Click Snooze → verify `nextReminder` updates to ~60 min from now
7. Log out via Options, re-open popup → verify "please log in" message shown

**Pass criteria:** All task actions work from popup; list sorts correctly; unauthenticated state handled gracefully.

---

## Phase 5 — Extension: Background Worker & Notifications
**Branch:** `phase/5-extension-background`

### Tasks
- [ ] Create `extension/background.js`:
  - On `chrome.runtime.onInstalled`: create repeating alarm `reminderCheck` with `periodInMinutes: 1`
  - On alarm: fetch tasks, compare `nextReminder` to `Date.now()`, fire `chrome.notifications.create()` for due tasks
  - Notification buttons: Complete (0), Check-in (1), Snooze 1hr (2)
  - `chrome.notifications.onButtonClicked`: call `PATCH /tasks/:id` with appropriate action; clear notification

### Testing
1. Temporarily change alarm interval to `periodInMinutes: 0.1` (every 6 seconds) for testing
2. Create a P0 task via popup; manually set `nextReminder` to a past timestamp via curl:
   ```bash
   curl -X PATCH http://localhost:3000/tasks/<id> \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"action":"snooze","minutes":-60}'
   ```
   *(negative snooze forces it into the past)*
   — or add a temporary test endpoint `POST /tasks/:id/force-due` for this
3. Wait for alarm to fire → verify OS notification appears with task title and 3 buttons
4. Click **Complete** → verify notification clears, task marked complete in `GET /tasks`
5. Click **Check-in** → verify notification clears, `checkin_count` incremented, `nextReminder` widens
6. Click **Snooze 1hr** → verify notification clears, `nextReminder` = ~60 min from now
7. Restore `periodInMinutes: 1` before merge

**Pass criteria:** Notifications fire for due tasks; all three button actions update the backend correctly; no duplicate notifications for the same task.

---

## Phase 6 — Deployment
**Branch:** `phase/6-deployment`

### Tasks
- [ ] Add `server/Procfile` or verify `package.json` start script: `"start": "node server.js"`
- [ ] Create `README.md` with local setup and Railway deploy instructions
- [ ] Deploy backend to Railway:
  - Add persistent volume, mount at `/data`
  - Set env vars: `DATA_FILE=/data/synapse.db`, `JWT_SECRET=<random>` (do NOT set `PORT` — Railway sets it)
- [ ] Update extension `options.html` default API base URL to the live Railway URL
- [ ] Test full flow against production backend

### Testing
1. Register a new account on the production backend via the extension Options page
2. Create tasks of each priority (P0–P4) via the popup
3. Verify `GET /tasks` returns correct data from Railway
4. Trigger a notification (use curl to force `nextReminder` into the past on prod)
5. Confirm notification fires and actions update the production database

**Pass criteria:** App works end-to-end against the Railway deployment; local dev still works against `localhost:3000`.

---

## Completed Phases

### Phase 1 — Backend: Database & Auth ✓
Merged to `main` from `phase/1-backend-auth`. All pass criteria met.

### Phase 2 — Backend: Task API ✓
All pass criteria met: SRS formula caps at 5×, completed tasks hidden from list, cross-user access blocked.
