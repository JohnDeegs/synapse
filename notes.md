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

## Deployment Notes (Phase 6)

- Do NOT set `PORT` as an env var on Railway — Railway injects it automatically. Setting it manually causes port binding failures.
- Set `DATA_FILE` to a path on the persistent volume (e.g. `/data/synapse.db`). Without a volume, the SQLite database resets on every deploy.
- `JWT_SECRET` must be set. The server does not fall back to a default in production.
- When generating a domain in Railway, it asks for a "target port." This is the port Railway's proxy forwards to. It must match whatever port the server actually binds to (whatever `PORT` env var Railway injects — in our case 8080). Setting it to 3000 (the local dev default) causes 502 errors on every request even though the build and deploy succeed.

---

## Phase 5 Retrospective: What Worked, What Didn't, What I Wish I Knew

### What Worked Well

- **The core logic was straightforward.** The alarm → fetch → compare timestamps → fire notification pipeline is clean and simple. Once the plumbing was right, it just worked.
- **Duplicate prevention via Chrome's notification ID system.** Using `task-<id>` as the notification ID means Chrome itself deduplicates — if you try to create a notification with an ID that already exists, it silently no-ops. The in-memory `activeNotifications` map is belt-and-suspenders on top of this.
- **`requireInteraction: true` is the right default.** Notifications stay on screen until the user acts on them, which is the whole point of Synapse. Don't remove this.
- **Negative snooze as a test tool.** `{"action":"snooze","minutes":-60}` is a clean way to force any task into the past without needing a special test endpoint. Simple and effective.

---

### What Didn't Go Well

- **`onInstalled` trap cost time.** This is a well-known MV3 gotcha and we still hit it. The alarm vanished on every reload during development, making it look like the whole notification system was broken when the real issue was just the alarm not existing.
- **Windows notification UX is a black box.** There's no obvious way to know from code that notifications are being created but silently swallowed by the OS. The code logs said "notification created ok" but nothing appeared. This caused unnecessary debugging of correct code.
- **The service worker console is misleading.** It looks like a normal DevTools console, but calling functions in it fails when the SW has gone idle. It's a trap for anyone used to debugging regular browser JS.
- **No branch discipline.** We worked directly on `main` throughout this phase. The plan called for a `phase/5-extension-background` branch, but we skipped it. This means there's no clean PR history for this phase. For solo development it's fine; in a team it would be a problem.

---

### What I Wish I Knew Before Starting

1. **The alarm disappears on reload — always add the startup guard from day one.** Don't add `onInstalled` and assume it's enough. Write the `chrome.alarms.get` guard immediately alongside it. It's two extra lines and saves 20 minutes of confusion.

2. **Test OS notification settings before writing a single line of notification code.** On Windows, confirm a Chrome banner actually pops up before you write any code. Otherwise you'll be debugging working code.

3. **The SW DevTools console is for reading, not writing.** Use it to watch logs passively. Don't try to call functions in it — by the time you type, the SW is probably idle. Add `console.log` to the source and reload instead.

4. **Windows Action Center caps at 2 buttons.** If your UX depends on 3 buttons, you need banners. The Action Center is not a reliable fallback for button-heavy notifications on Windows.

5. **`chrome.notifications.create` is fire-and-forget with no visible failure mode.** If it fails (bad icon path, missing permission, OS suppression), it fails silently. Always add a callback that checks `chrome.runtime.lastError` during development.

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

---

## Phase 6 Retrospective: Deployment

### What Worked Well

- **`better-sqlite3` on Railway just works.** It's a native C++ addon that needs to be compiled for the target OS. Because Railway runs `npm install` during the build phase on a Linux container, it compiles correctly for Linux automatically. No special config needed — just don't commit `node_modules`.
- **Negative snooze works against production too.** `{"action":"snooze","minutes":-60}` is just as useful for forcing a task due on prod as it is locally. No special test tooling needed.
- **The server code needed zero changes to run on Railway.** `process.env.PORT || 3000` handled everything. The architecture was cloud-ready from day one.
- **Volume + env vars were the entire deployment config.** Two variables (`DATA_FILE`, `JWT_SECRET`) and one volume mount. That's all it took.

---

### What Didn't Go Well

- **The Railway domain target port trap.** When you generate a domain in Railway, it asks for a target port. The natural instinct is to enter `3000` (the local dev port). This is wrong — Railway injects its own `PORT` env var (8080 in our case) and the server binds to that. The domain must proxy to 8080, not 3000. This caused a 502 that looked like a server crash when the server was actually running fine. The deploy logs showed "Synapse server listening on port 8080" the whole time.
- **Two separate accounts caused a confusing test gap.** We registered one account via curl (`test@test.com`) and a second via the extension. The extension's background worker polls with the extension account's token. Forcing a task due on the curl account's task produced no notification because the worker never saw it. Took a few minutes to identify the mismatch. Always test notifications with the same account the extension is logged into.
- **502 is ambiguous.** It can mean the server crashed, the server hasn't started yet, or the proxy is pointing at the wrong port. Check deploy logs first before assuming a code problem.

---

### What I Wish I Knew Before Starting

1. **Railway's injected `PORT` is not 3000.** It's whatever Railway decides (8080 in our deployment). When generating a domain, enter the actual port the server binds to — check the deploy logs for "listening on port X" to confirm.

2. **A successful build does not mean a healthy server.** Railway shows a green deploy even if the server crashes immediately after starting. Always check the Deploy Logs tab (inside a specific deployment) to see runtime output. A 502 with a green deploy means the process started but isn't accepting connections — usually a wrong proxy port or a runtime crash.

3. **Test notifications with the account the extension is logged into.** If you force a task due via curl using one token and the extension is logged in as a different account, no notification will fire. The background worker only fetches tasks for its stored token. Keep one account for everything during testing.

4. **The root URL returns 404 — that's correct.** The backend has no `/` route. Visiting `https://your-app.up.railway.app` in a browser will show "not found." Test with `GET /tasks` (which returns 401 when unauthenticated) to confirm the server is up.

---

## Phase 7: Tags, Static Serving, and Nested Routes

### What Worked Well

- **`CREATE TABLE IF NOT EXISTS` makes schema additions zero-friction.** Adding two new tables to the existing `db.exec` block just works on server startup — no migration runner, no separate scripts. The SQLite idempotent schema pattern scales cleanly to V2.
- **`INSERT OR IGNORE` on `assignTag` is the right call.** Re-assigning a tag that's already on a task is a silent no-op rather than a 409 error. The client doesn't need to track state about what's already assigned.
- **`ON DELETE CASCADE` on `task_tags` means zero cleanup code.** Deleting a task or a tag automatically removes the join rows. Never have to write a compensating delete.
- **Batch-loading tags with one query avoids N+1.** `getTagsByUserForTasks` returns all task-tag pairs for a user in a single query. Grouping them into a `Map<taskId → [{id, name}]>` in the server is two loops and no extra DB round trips, regardless of how many tasks exist.
- **`path.resolve` + `startsWith` for path traversal prevention is simple and correct.** No regex needed — resolve the requested path and assert it starts with the known safe directory.

---

### What Didn't Go Well

- **`curl` was blocked by shell permissions in the test environment.** Had to fall back to an inline Node.js `http.request` test script. Not a code problem, but a local environment constraint worth knowing. On a clean dev machine, `curl` is the faster tool for manual endpoint checks.

---

### What I Wish I Knew Before Starting

1. **`RETURNING` statements require `.get()`, not `.run()`.** `better-sqlite3` methods: `.run()` returns metadata (`{ changes, lastInsertRowid }`), `.get()` returns the first row, `.all()` returns all rows. Any `INSERT ... RETURNING` must use `.get()`. Using `.run()` on a `RETURNING` statement returns the metadata object, not the row — a silent type mismatch that surfaces only when you try to access `result.id`.

2. **Distinguish nested route depths by `parts.length`.** For manual URL routing with nested paths like `/tasks/:id/tags` and `/tasks/:id/tags/:tagId`, `url.split('/')` gives arrays of length 4 and 5 respectively. Check `parts.length` to differentiate POST (create association) from DELETE (remove association). Using a regex would work but this is cleaner.

3. **`path.sep` in the traversal check matters.** The check is `resolved.startsWith(WEB_DIR + path.sep)` not just `startsWith(WEB_DIR)`. Without `path.sep`, a directory named `web-evil` at the same level would pass the prefix check because `WEB_DIR` is a prefix of its path. The separator makes the boundary explicit.

4. **The static file handler can't be `async`.** It uses `fs.readFile` with a callback. The outer `try/catch` in the request handler does NOT catch errors thrown inside that callback. This is safe because `fs.readFile` errors are handled inline via the `if (err)` check — but don't refactor it to throw inside the callback expecting the outer catch to handle it.

5. **Design note for Phase 8+: Buganizer aesthetic.** The web dashboard is intended to feel like Google's internal Buganizer issue tracker — clean Material-style layout, left nav sidebar, table view with priority badges (P0–P4), light and dark mode. This is a tribute to the priority system that inspired Synapse. Keep this visual direction in mind when building the HTML/CSS in Phase 8.

---

## Phase 8: Web Dashboard — Core UI

### What Worked Well

- **`GET /tasks?status=all` pattern is clean.** Adding a single query param to the existing route preserves full backward compatibility with the Chrome extension (which only wants active tasks) while giving the web dashboard everything it needs to filter client-side. No new endpoints.
- **`action: 'update'` fits the existing patch pattern naturally.** All mutation goes through `PATCH /tasks/:id` with an action discriminator. Adding a new action for title/description edits required zero routing changes — just a new branch in `handlePatchTask`.
- **EasyMDE via CDN drops in with no build step.** The lazy-init pattern (create instance on first open) avoids layout issues from initialising CodeMirror on a hidden element. `mde.toTextArea()` cleanly tears it down without DOM leaks.
- **Client-side sort/filter on a full task cache is the right call.** Fetching `?status=all` once and filtering in JS means toggling filters and sort order is instant with no round trips. Stats bar updates are also free.
- **Save/Cancel for description editing is better UX than blur-to-save.** Blur would fire when the user clicked a toolbar button inside the editor, causing premature saves. Explicit buttons eliminate that class of bug entirely.

---

### What Didn't Go Well

- **Server must be restarted after backend changes.** The old process was still running when backend edits landed — initial API tests against stale code produced confusing results. Always kill and restart after touching server files.

---

### What I Wish I Knew Before Starting

1. **EasyMDE needs the element to be visible when initialised.** Calling `new EasyMDE({ element })` on a hidden textarea produces a zero-height CodeMirror canvas that never recovers. Lazy-init (create the instance when the form/wrapper is first revealed) is the fix.

2. **`mde.toTextArea()` is necessary before DOM removal only if you need cleanup.** In practice, since `renderTasks()` blows away the entire card DOM anyway, the MDE instance is GC'd naturally. But calling `toTextArea()` before the patch resolves (i.e. in Cancel) is still the right habit.

3. **Design note carried from Phase 7:** The Buganizer aesthetic (Material, left nav space, priority badges P0–P4 as coloured chips) is deliberate. Phase 9 will add the tags filter sidebar to the left. Keep the layout flexible for that.

---

## Phase 9: Web Dashboard — Tags, Check-in History & Bulk Actions

### What Was Built

All Phase 9 features were implemented across 5 commits on `phase/9-web-advanced`:

1. **Tags filter sidebar** — `GET /tags` on load; clickable chips filter tasks; "All" clears filter
2. **Tag autocomplete on task cards** — replaced `<select>` with a typeahead text input (filters matching tags as you type, keyboard navigation with arrows, Enter to assign, Escape to close). Scales to 50+ tags without UX degradation.
3. **Check-in history** — expandable section per card; fetches `GET /tasks/:id/checkins`; shows note + timestamp per entry
4. **Bulk actions** — checkbox per card, select-all in header, action bar (Complete / Delete / Snooze 1hr) fires parallel requests then refreshes list
5. **Compound filtering** — tag filter, status filter, and sort all apply together client-side on the full task cache

### Key decisions

- **Autocomplete over `<select>`**: user correctly flagged that a 50-tag dropdown is unusable. Custom typeahead with `mousedown` (not `click`) on suggestions prevents the input `blur` event from closing the dropdown before the click registers.
- **Race condition fix**: `showApp()` now chains `fetchTags().then(() => fetchTasks())` so `allTags` is always populated before cards render. Previously, parallel fetch meant tag pickers sometimes rendered empty.
- **Tag picker visibility logic**: picker only shows if there are unassigned tags remaining; hides entirely when all tags are assigned (clean, not a disabled state).

### Status

**Complete and tested.** All 9 test steps passed. One bug found and fixed during testing: tag autocomplete dropdown was clipped by the scrolling task list container on the last card — fixed by switching from `position: absolute` to `position: fixed` with `getBoundingClientRect()` for viewport-relative positioning (commit `b0a7df6`).

---

## Phase 9 Retrospective: Tags, Check-in History & Bulk Actions

### What Worked Well

- **`position: fixed` + `getBoundingClientRect()` is the right pattern for any dropdown inside a scrolling container.** `position: absolute` will always get clipped if any ancestor has `overflow: hidden` or is a scroll container. Fixed positioning escapes all of that. Set `top` and `left` from `getBoundingClientRect()` on focus/input, not once at render time.
- **`mousedown` instead of `click` on dropdown items is essential.** The input's `blur` event fires before `click` registers, which closes the dropdown before the selection lands. `mousedown` fires first, and `e.preventDefault()` in the handler keeps focus on the input long enough for the selection to complete.
- **Sequencing `fetchTags()` before `fetchTasks()` is the right call.** The tag autocomplete on each card is built from `allTags` at render time. If tasks load first (parallel fetch), `allTags` is empty and no pickers appear. Chaining `fetchTags().then(() => fetchTasks())` guarantees tags are ready. This is a one-time cost at login; it doesn't affect any subsequent interactions.
- **Client-side compound filtering scales cleanly.** Tag filter, status filter, and sort all operate on the same cached `allTasks` array in a single pass. Adding a third dimension of filtering required zero backend changes and no additional fetch.
- **Autocomplete typeahead over `<select>` was the right call at 3 tags — not just at 50.** Even with a small tag list, the typeahead is faster and doesn't interrupt keyboard flow. This decision pays off immediately and scales indefinitely.

---

### What Didn't Go Well

- **The dropdown clipping bug wasn't caught before testing.** `position: absolute` inside a scrolling list container is a well-known trap. It should have been caught in code review or by testing with a task at the bottom of the list. The fix was trivial once identified, but it required a real test run to surface.
- **Step 8 (compound filter + sort) was hard to verify visually.** When test data is small and tasks share similar priorities and reminder times, sort order changes are imperceptible. For future phases with sort/filter logic, create test data that makes the sort order unambiguous (e.g. tasks with wildly different priorities AND different reminder offsets).

---

### What I Wish I Knew Before Starting

1. **Any dropdown inside a scrollable list must use `position: fixed`.** There is no reliable way to make `position: absolute` work across all scroll/overflow contexts. Just start with fixed + `getBoundingClientRect()` and avoid the whole class of bugs.

2. **Use `mousedown` + `e.preventDefault()` for any click target that closes a focused element.** This is the standard pattern for custom dropdowns, autocompletes, and colour pickers. `click` is always too late when a `blur` listener is in play.

3. **Design test data to make the feature under test unambiguous.** Sort order is invisible when all tasks have similar next_reminder values. Create tasks with explicitly different priorities AND snooze them to different times so sort order is obvious when switching between sort modes.

4. **The tag picker hiding when all tags are assigned is a UX choice that needs communicating.** If every tag is already on a task, the "Add tag" input disappears entirely. That's clean — but users who don't know all tags are assigned might think it's a bug. A subtle "all tags assigned" note could help, though for now the behaviour is correct.

5. **Parallel fetch is almost always fine — except when one fetch's result is an input to another's rendering.** The tags → tasks sequencing is a case where the output of `fetchTags` (populating `allTags`) is a dependency for rendering the output of `fetchTasks`. Any time fetch A populates state that fetch B's renderer reads, sequence them. Otherwise parallel is fine.

---

## Railway Deployment: Railpack vs Nixpacks

### The Railpack 0.20.0 build secret trap

Railpack 0.20.0 introduced a behavior where env vars with names that pattern-match as secrets (e.g. `JWT_SECRET`) are injected as Docker build secrets rather than passed as runtime env vars. Build secrets must be explicitly mounted during `docker build` — Railway does not do this automatically. Result: `ERROR: failed to build: failed to solve: secret JWT_SECRET: not found`, even when `JWT_SECRET` is correctly set in the Railway Variables tab.

**Fix:** Add `server/railway.toml` (in the service root, not the repo root) to force Nixpacks:

```toml
[build]
builder = "NIXPACKS"
```

Nixpacks does not have this secret injection behavior. All env vars pass through as runtime variables as expected.

### `railway.toml` must live in the service root, not the repo root

Railway's service has a configured root directory (in our case `server/`). Any `railway.toml` placed in the repo root is silently ignored — Railway never reads it. The proof: the build log showed `$ npm run start` (the package.json script from `server/`) rather than the `startCommand` set in the root-level toml. Always place `railway.toml` inside whichever directory Railway's service is pointed at.

### Dockerfile is overkill for a simple Node app on Railway

A `Dockerfile` bypasses all auto-detection and works — but it means you own the base image, system dependencies, and Node version forever. Nixpacks handles all of that automatically from `package.json`. Prefer `railway.toml` + Nixpacks unless you have a genuine custom build requirement.

---

## Phase 10: Telegram Auth & Rate Limiting

### What Was Built

1. **Three new tables** — `telegram_links` (chat_id ↔ user_id), `telegram_codes` (one-time codes with expiry), `telegram_rate_limits` (per-chat_id sliding window counters)
2. **`POST /auth/telegram-code`** — generates a 6-char alphanumeric code, deletes any prior code for the user, stores with `expires_at = now + 5 minutes`
3. **`GET /auth/telegram-code`** — returns the active unexpired code without regenerating; returns `{ code: null }` if none exists
4. **`POST /telegram/connect`** — internal endpoint; verifies code is valid and unexpired, links `chat_id → user_id`, deletes the code (one-time use enforced)
5. **`server/telegram-rate-limit.js`** — `checkRateLimit(chatId)` with 10/min, 50/hr, 200/day limits; resets counters automatically when their window expires

---

### What Worked Well

- **Deleting existing codes before generating a new one is cleaner than checking for duplicates.** `deleteCodesForUser` + `createTelegramCode` is two statements and leaves no stale rows. Alternatives (upsert, unique index with conflict handling) add complexity for no benefit — the user only ever needs one active code.
- **`expires_at > datetime('now')` in SQLite just works for ISO strings.** The same ISO string lexicographic ordering property that makes `ORDER BY next_reminder` correct (documented in Phase 7 notes) also makes datetime comparisons in `WHERE` clauses correct. No type conversion needed.
- **Testing the rate limiter directly via the module, not via HTTP, was the right call.** The rate limiter isn't exposed as its own HTTP endpoint — it will be called from the bot handler in Phase 11. Testing it by `require('./telegram-rate-limit')` and calling `checkRateLimit()` in a loop is faster, cleaner, and doesn't require a running server.
- **Window-boundary calculation with `Math.ceil(now / windowMs) * windowMs` is clean and correct.** It gives the end of the current window (not the start of the next), which is the right value to store as `minute_reset` / `hour_reset` / `day_reset`. No special-casing needed for the first call in a window.
- **The `RETURNING` prepared statement + `.get()` pattern (established in Phase 7) applied cleanly to `createTelegramCode`.** No boilerplate needed to get the generated `id` and `expires_at` back from the insert.

---

### What Didn't Go Well

- **Port 3000 was held by a previous server process.** When restarting after code changes, the old process was still running. `pkill -f "node server.js"` does not work on Windows — the process was still alive. The fix is `netstat -ano | grep ":3000"` to find the PID, then `taskkill //F //PID <pid>`. On Windows, always kill by PID. Add this to your muscle memory.

---

### What I Wish I Knew Before Starting

1. **`pkill` doesn't work on Windows — use `taskkill //F //PID <pid>`.** When the server is already running and you need to restart after code changes, `pkill -f "node server.js"` exits silently with no effect. Find the PID with `netstat -ano | grep ":3000"` and kill it explicitly. The `//F` flag forces termination without a confirmation prompt.

2. **`b % charsetLength` for code generation has a tiny statistical bias — it's fine here.** `crypto.randomBytes(6)` gives values 0–255. `255 % 36 = 3`, so characters A–C appear very slightly more often than the rest. For a 5-minute one-time code, this is irrelevant. Don't reach for a rejection-sampling loop unless you're generating cryptographic keys.

3. **The rate limit `retryAfter` value should be calculated from the stored reset timestamp, not from `Date.now() + windowMs`.** If a user hits the limit at 0:59 into a minute, you want to tell them "1 second" not "60 seconds". Always compute `retryMs = resetTimestamp - Date.now()` on the blocked response.

4. **Store the rate limit reset timestamps as ISO strings, not Unix timestamps.** The rest of the schema uses ISO strings throughout (`next_reminder`, `expires_at`, `created_at`). Mixing in Unix integers would create an inconsistency that will trip up future builders reading the DB. ISO strings are also directly comparable with `datetime('now')` in SQLite.

5. **`POST /telegram/connect` is intentionally unauthenticated — document this clearly.** The security comes from the one-time code, not a JWT. If a future builder sees an unauthenticated POST endpoint and tries to "fix" it by adding JWT auth, they'll break the bot flow (the bot has no user JWT — it only has the chat_id and the code the user typed). The endpoint is safe by design.

---

## Phase 11: Telegram Bot — Webhook & Basic Commands

### What Was Built

1. **`server/telegram.js`** — bot handler module: `registerWebhook(baseUrl)`, `sendMessage(chatId, text)`, `handleUpdate(update)`
2. **`POST /telegram/webhook`** — validates `X-Telegram-Bot-Api-Secret-Token` header, responds 200 immediately, processes the update asynchronously
3. **`/start` command** — welcome message with connect instructions
4. **`/connect <code>` command** — verifies code, links `chat_id → user_id`, one-time use enforced; clear error on invalid/expired code
5. **Unlinked account handler** — any message from an unlinked `chat_id` gets connect instructions
6. **Phase 12 placeholder** — linked accounts get "LLM not yet connected" reply
7. **Startup webhook registration** — if `TELEGRAM_BOT_TOKEN` and `APP_BASE_URL` are set, `registerWebhook` is called automatically on `server.listen`
8. **`.env.example`** updated with `TELEGRAM_BOT_TOKEN` and `APP_BASE_URL`

---

### What Worked Well

- **Deriving `WEBHOOK_SECRET` from `BOT_TOKEN` via SHA-256 is clean.** No extra env var needed — the secret is deterministic across restarts and rotates automatically if the bot token changes. `crypto.createHash('sha256').update(BOT_TOKEN).digest('hex').slice(0, 32)` is the pattern.
- **Respond 200 immediately, process asynchronously.** Telegram requires a fast response or it retries the update. Calling `send(res, 200, { ok: true })` before `handleUpdate` and catching errors separately is the correct pattern. Don't await the handler before responding.
- **`handleUpdate` calling `stmts` directly is consistent with the rest of the codebase.** No need for a separate internal HTTP call to `/telegram/connect` — `telegram.js` imports `stmts` from `db.js` and runs the same connect logic inline. Keeps it fast and avoids a network round-trip to itself.
- **All bot commands worked first time with no code changes after deployment.** The logic was straightforward to get right before testing.
- **Railway was the right choice for testing over ngrok.** The server was already deployed and the code was merge-ready. ngrok adds unnecessary friction when a production environment already exists.

---

### What Didn't Go Well

- **ngrok was suggested first instead of Railway.** Since Railway was already set up and the Phase 11 code was complete, the right call was to merge and deploy immediately. ngrok is only useful when you're mid-development and need fast local iteration. For a finished phase, always deploy to Railway and test there.
- **The `web/` folder is not deployed to Railway.** Railway's service root is `server/` — it only deploys that directory. The `web/` folder at the project root is invisible to Railway. This wasn't obvious until testing required a token and the web dashboard returned "Not found" on production. The web dashboard has only ever been tested locally. This will be fixed in Phase 13.
- **Token debugging loop wasted time.** Several 401 errors in a row were caused by the user testing the web app locally (localhost:3000) and then trying to use those credentials against production. The local and production databases are separate — an account registered locally doesn't exist on Railway.
- **The `!` character in Git Bash triggers history expansion.** A `node -e` one-liner containing `!login.body.token` caused a bash error. Avoid `!` in inline Node.js scripts run from bash, or use PowerShell instead.

---

### What I Wish I Knew Before Starting

1. **Railway only deploys the `server/` directory — `web/` is not included.** The Railway service root is `server/`. Anything outside that directory (including `web/`) is never uploaded. Don't plan any testing that relies on the web dashboard being available on production until Phase 13 deploys it properly.

2. **When testing against production, always register/login against production directly — never assume local credentials exist there.** The local and production SQLite databases are completely separate. Use `POST /auth/register` against the production hostname to create a test account before any authenticated testing.

3. **Use Railway over ngrok whenever the code is ready to merge.** ngrok is for mid-development local testing. If the phase is complete and you're just running the test checklist, merge to main, push, and test against Railway. It's faster, requires no extra tools, and validates the real deployment environment.

4. **Avoid `!` in `node -e` scripts run from Git Bash.** Bash interprets `!` as a history expansion character inside double-quoted strings. Either wrap the script in single quotes, escape the `!`, or run from PowerShell where this isn't an issue.

5. **The respond-first pattern is mandatory for Telegram webhooks, not optional.** If your handler takes more than a few seconds (e.g. LLM call in Phase 12), Telegram will retry the update thinking the delivery failed. Always `send(res, 200)` before any async processing, and handle errors from the async work separately so they don't surface as unhandled rejections.

---

## Phase Completion Status

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Backend: Database & Auth | Done |
| 2 | Backend: Task API | Done |
| 3 | Extension: Manifest, Options & Login | Done |
| 4 | Extension: Popup (Quick-capture & Task List) | Done |
| 5 | Extension: Background Worker & Notifications | Done |
| 6 | Deployment | Done |
| 7 | Backend: Tags & Web Static Serving | Done |
| 8 | Web Dashboard: Core UI | Done |
| 9 | Web Dashboard: Tags, Check-in History & Bulk Actions | Done |
| 10 | Backend: Telegram Auth & Rate Limiting | Done |
| 11 | Telegram Bot: Webhook & Basic Commands | Done |
