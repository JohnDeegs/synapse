# Synapse V2.5 — QOL & Feature Tasks

Continues from `tasksV2.md`. Same branch/merge conventions apply.

**Branch naming:** `phase/<n>-<short-name>`

---

## Phase 14 — QOL: Check-in UX, Weekend Mode, Auto-Refresh & Gamification
**Branch:** `phase/14-qol-checkin-weekend-gamification`

### Tasks
- [ ] **Untagged filter:** Add "Untagged" chip to tag sidebar; filter tasks with no tags assigned
- [ ] **Auto-refresh:** Poll `GET /tasks` every 30s; re-render if task data has changed (enables cross-window sync)
- [ ] **Check-in UX — default open + priority fix:**
  - Clicking a task title opens check-in area by default (add separate ✎ button for title editing)
  - Add priority `<select>` inside the check-in area
  - Disable header priority select while check-in area is open to prevent timer advancing before check-in completes
  - Submit check-in with selected priority via `PATCH /tasks/:id { action:'checkin', note, priority }`
- [ ] **Weekend mode (weekday-only tags):**
  - `ALTER TABLE tags ADD COLUMN weekday_only INTEGER NOT NULL DEFAULT 0`
  - `CREATE TABLE daily_health (id, user_id, date, status)` — also used by gamification
  - Add `PATCH /tags/:id` endpoint to toggle `weekday_only`
  - SRS: `skipWeekendMinutes(fromMs, durationMs)` helper in `tasks.js`; `calcNextReminder()` gains `weekdayOnly` param; `checkinTask()` and `changePriority()` check task tags before calling it
  - UI: weekday-only toggle (⏰) per tag chip in sidebar
- [ ] **Gamification — health bar + streak grid:**
  - `snapshotDailyHealth(userId)` in `tasks.js`: writes `'green'`/`'red'` to `daily_health` based on whether any active task is currently overdue
  - Called after every check-in and complete mutation, and in the hourly scheduler for all users
  - `GET /health/history` endpoint: returns last 365 days of `{ date, status }` rows
  - Stats bar: live health indicator (green/red) computed client-side from `allTasks`
  - Health grid: 52-week GitHub-style heatmap rendered from `/health/history`; consecutive green days shown as streak count

### Testing
1. Create tasks with and without tags → click "Untagged" chip → only untagged tasks visible
2. Open two browser windows; check in on a task in window A → window B updates within 30s without a manual refresh
3. Click a task title → check-in area opens immediately; change priority in the header while check-in is open → timer does **not** advance; submit check-in with new priority → task reschedules correctly
4. Mark a "Work" tag as weekday-only; on a Friday afternoon check in on a "Work" task → `next_reminder` lands Monday morning (not Saturday); verify via `GET /tasks`
5. Check in all tasks → stats bar shows green; let a task go overdue → stats bar turns red; verify `/health/history` has today's record; confirm streak counter increments after a full green day

**Pass criteria:** Untagged filter works; cross-window sync works within 30s; priority cannot advance the timer mid-check-in; weekday-only tasks skip Sat/Sun in SRS calculation; health grid populates and streak count is accurate.
