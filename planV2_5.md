# Synapse V2.5 — QOL & Feature Tasks

Continues from `tasksV2.md`. Same branch/merge conventions apply.

**Branch naming:** `phase/<n>-<short-name>`

---

## Phase 14 — QOL: Check-in UX, Weekend Mode, Auto-Refresh & Gamification
**Branch:** `phase/14-qol-checkin-weekend-gamification`

### Tasks
- [x] **Untagged filter:** Add "Untagged" chip to tag sidebar; filter tasks with no tags assigned
- [x] **Auto-refresh:** Poll `GET /tasks` every 30s; re-render if task data has changed (enables cross-window sync)
- [x] **Check-in UX — default open + priority fix:**
  - Clicking anywhere on a task card (non-interactive area) toggles the check-in area
  - ✎ button handles title editing; ✎ button on description handles description editing
  - Priority `<select>` inside check-in area; header priority select disabled while check-in is open
  - Submit check-in with selected priority via `PATCH /tasks/:id { action:'checkin', note, priority }`
- [x] **Weekend mode (weekday-only tags):**
  - `ALTER TABLE tags ADD COLUMN weekday_only INTEGER NOT NULL DEFAULT 0`
  - `CREATE TABLE daily_health (id, user_id, date, status)` — also used by gamification
  - `PATCH /tags/:id` endpoint to toggle `weekday_only`
  - SRS: `skipWeekendMinutes(fromMs, durationMs)` helper; `calcNextReminder()` gains `weekdayOnly` param
  - 📅 toggle per tag chip in sidebar
- [x] **Gamification — health bar + streak grid:**
  - Health progress bar: fills green (100% tasks on time) → amber (≥60%) → red (<60%)
  - Three-state stat badge: Green / At risk (due within 1h) / Red
  - `snapshotDailyHealth(userId)` writes to `daily_health` after check-in/complete + hourly
  - `GET /health/history` returns last 365 days
  - 52-week GitHub-style heatmap with streak counter

### Testing
1. Create tasks with and without tags → click "Untagged" chip → only untagged tasks visible
2. Open two browser windows; check in on a task in window A → window B updates within 30s without a manual refresh
3. Click a task title → check-in area opens immediately; change priority in the header while check-in is open → timer does **not** advance; submit check-in with new priority → task reschedules correctly
4. Mark a "Work" tag as weekday-only; on a Friday afternoon check in on a "Work" task → `next_reminder` lands Monday morning (not Saturday); verify via `GET /tasks`
5. Check in all tasks → stats bar shows green; let a task go overdue → stats bar turns red; verify `/health/history` has today's record; confirm streak counter increments after a full green day

**Pass criteria:** Untagged filter works; cross-window sync works within 30s; priority cannot advance the timer mid-check-in; weekday-only tasks skip Sat/Sun in SRS calculation; health grid populates and streak count is accurate.
