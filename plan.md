# Product Requirements Document: Synapse (v1.0)
**Project Title:** Synapse – Contextual & Cognitive Reminder Ecosystem  
**Author:** Senior Product Manager  
**Status:** Draft / For Review

---

## 1. Product Vision & Strategy
**Synapse** is designed to eliminate the "notification blindness" common in traditional task managers. By leveraging the **Forgetting Curve** and **Spaced Repetition Systems (SRS)**, Synapse ensures that high-priority tasks are reinforced at scientifically optimal intervals. The goal is to move the user from passive dismissal to active task engagement.

---

## 2. Target Audience & Problem Statement
* **The Problem:** Users receive too many static notifications, leading to "dismissal muscle memory." High-priority tasks get lost in the noise of low-priority ones.
* **The Audience:** Knowledge workers, developers, and power users who operate across multiple devices (PC and Android) and require a friction-free way to log and track critical "to-dos."

---

## 3. Core Functional Requirements

### 3.1 Quick-Capture Interface
* **Omnipresent Input:**
    * **PC:** A lightweight Chrome Extension with a global keyboard shortcut. The extension popup serves as the quick-capture UI.
* **Markdown Support:** The description field must support GitHub Flavored Markdown (GFM) for checklists, code snippets, and rich-text context.

### 3.2 Dynamic Priority System (P0–P4)
Priority levels define the **frequency decay** of reminders.

| Priority | Level | Baseline Frequency | Strategic Intent |
| :--- | :--- | :--- | :--- |
| **P0** | Critical | Every 30 Minutes | "Do it now or lose it." |
| **P1** | High | Every 2 Hours | Essential for today's workflow. |
| **P2** | Medium | Every 24 Hours | Needs attention this week. |
| **P3** | Low | Every 72 Hours | Backburner; maintain awareness. |
| **P4** | Future | Once Weekly | "Nice to have" / Someday. |

### 3.3 The "Scientific" Alert Algorithm
Synapse calculates the next reminder ($T_{next}$) using a capped linear growth formula. The frequency is reduced as the user performs "Check-ins," reflecting reduced urgency, but is capped to prevent a high-priority task from silently falling off the radar.

$$T_{next} = T_{last} + (\text{BaseInterval}_P \times \min(1 + C \times 0.5,\ 5))$$

* $T_{last}$: Timestamp of the last reminder.
* $\text{BaseInterval}_P$: The default interval based on Priority (P0–P4).
* $C$: The number of successful "Status Check-ins" performed by the user.
* The multiplier grows by 0.5× per check-in, capped at 5× the baseline interval.
* **Example (P0):** Baseline = 30 min. After 5 check-ins: `30 min × min(3.5, 5) = 105 min ≈ 1h 45m`. The interval never exceeds 2.5 hours for a P0 task, regardless of check-in count.

### 3.4 Contextual Reminders
* **PC (Chrome):** System-level OS notifications via `chrome.notifications.create()`. The extension's background service worker uses `chrome.alarms` to wake on schedule, fetch due tasks from the backend, and fire notifications with three action buttons: **[Complete]**, **[Check-in]**, and **[Snooze 1hr]**.

---

## 4. User Interaction: The "Check-in"
Unlike a standard "Snooze," a **Check-in** requires the user to provide a brief status update (e.g., "In progress, waiting for feedback"). 
1.  User clicks **"Check-in"** on the notification.
2.  Input field expands for a quick text update.
3.  The task's Markdown description is updated with a timestamped log.
4.  The reminder interval resets and widens based on the SRS formula.

---

## 5. Success Metrics
* **Task Completion Velocity:** Reduction in time from creation to completion for P0/P1 tasks.
* **Retention Rate:** Percentage of users who utilize the "Check-in" feature vs. standard "Snooze."
* **Notification Efficiency:** A decrease in total notifications dismissed without action.

---

## 6. Reference Material & Scientific Basis
* **Ebbinghaus Forgetting Curve:** Research demonstrating that memory retention drops exponentially unless information is reinforced at specific intervals.
* **Spaced Repetition (SRS):** A learning technique that improves memory by increasing the time intervals between reviews of information.
* **Zeigarnik Effect:** The psychological state where people remember uncompleted tasks more vividly than completed ones, which Synapse leverages through its "top-of-mind" P0 alerts.
* **Cognitive Load Theory:** The framework for the "Contextual Alert" requirement, ensuring notifications appear where the user is already working to minimize switching costs.

---

## 7. Technical Architecture (v1.0)

### 7.1 Chrome Extension
* **Manifest Version:** MV3
* **No build step** — loadable as an unpacked folder, vanilla JS only.
* **Key APIs:**
    * `chrome.alarms` — background service worker schedules reminder checks.
    * `chrome.notifications` — fires OS-level notifications with action buttons.
    * `chrome.storage.local` — caches the API key and last-fetched task list.
* **Extension Popup:** Quick-capture UI for creating new tasks.

### 7.2 Backend
* **Runtime:** Vanilla Node.js (`http.createServer`, no framework).
* **Storage:** SQLite via `better-sqlite3` on a Railway persistent volume.
* **Auth:** JWT (`jsonwebtoken` + `bcryptjs`), passed as `Authorization: Bearer <token>` header. Multi-user.
* **Endpoints:**

| Method | Path | Description |
| :--- | :--- | :--- |
| `POST` | `/auth/register` | Create account, return JWT |
| `POST` | `/auth/login` | Verify credentials, return JWT |
| `GET` | `/tasks` | Return active tasks for authenticated user |
| `POST` | `/tasks` | Create a new task |
| `PATCH` | `/tasks/:id` | Update task (check-in, complete, snooze) |
| `DELETE` | `/tasks/:id` | Delete a task (must own it) |

### 7.3 Data Model
SQLite database with three tables:

**`users`**: `id`, `email`, `password_hash`, `created_at`

**`tasks`**: `id`, `user_id`, `title`, `description`, `priority`, `status`, `checkin_count`, `next_reminder`, `created_at`

**`checkin_log`**: `id`, `task_id`, `note`, `created_at`

---

## 8. Scope Boundaries

### v1.0 (This Document)
* Chrome Extension + Railway backend only.
* OS notifications via `chrome.notifications` on desktop.
* Single-user, API-key auth.

### v2.0 (Future)
See **Section 9** for full V2 feature scope. High-level:
* Web dashboard with rich task management (tags, markdown, sort/filter, bulk actions).
* Telegram bot with natural language interface powered by Gemini 2.5 Flash + RAG.
* Android app (deprioritised — Telegram bot serves as mobile interface in the interim).

---

## 9. V2.0 Feature Scope

### 9.1 Web Dashboard

A full task management UI served as static files from the same Railway backend (`web/` folder). Reuses existing JWT auth — no new auth infrastructure needed.

**Features:**
* Full CRUD with inline editing (click title/description to edit in-place)
* **Tags system** — `task_tags` join table supporting multiple tags per task. Inspired by the PARA method (Projects, Areas, Resources, Archives) and Obsidian's second-brain philosophy: flat tag namespace, filter sidebar by tag, cross-task knowledge graph over time
* Markdown rendering for descriptions via `marked.js` (no build step, CDN import)
* Sort/filter by priority, due date, status, tag, creation date
* Check-in history expandable per task (from `checkin_log`)
* Bulk actions: select multiple tasks to complete / delete / snooze
* Live countdown timers to next reminder
* Stats bar: total active, due today, completed this week

**Backend additions required:**
* `GET /web/*` static file serving
* `GET /tags`, `POST /tags`, tag assignment endpoints
* `task_tags` table in SQLite schema

---

### 9.2 Telegram Bot + LLM Interface

**Goal:** Natural language task creation and status queries from mobile via Telegram.

#### LLM: Gemini 2.5 Flash
Selected after comparing Gemini 2.0 Flash (deprecated June 2026), Gemini 2.5 Flash, Gemini 2.5 Pro, Claude Haiku 4.5, Sonnet 4.6, and Opus 4.6.

| Model | Input $/MTok | Monthly est. (heavy use) |
| :--- | :--- | :--- |
| Gemini 2.5 Flash | $0.30 | ~$0.72 |
| Claude Haiku 4.5 | $1.00 | ~$2.52 |
| Claude Sonnet 4.6 | $3.00 | ~$7.56 |

**Rationale:** Gemini 2.5 Flash has a free tier for development, lowest production cost, and is completely separate from Claude Code API limits. The model sits behind an abstraction layer — swapping it is a one-line change.

#### RAG Architecture
Sending all historical tasks on every request is expensive at scale (1,000 tasks ≈ 150k tokens/request = ~$108/month on Haiku). Instead:
* Tasks are stored as vector embeddings
* Each LLM request retrieves the top 10–15 semantically relevant tasks (~3,000 tokens total)
* Cost stays flat regardless of how many completed tasks accumulate
* System prompt + static content eligible for prompt caching (90% discount on cached tokens)
* Estimated cost at 20 messages/day: **~$0.72/month**

#### Interaction Model (Function/Tool Calling)
The LLM picks from a defined set of actions — it never executes free-form code or SQL:
* *"What's on my plate today?"* → `list_tasks(filter: due_today)`
* *"Remind me to review the contract, it's critical"* → `create_task(title, priority: P0)`
* *"Mark the budget report done"* → `complete_task(id)`
* *"Summarise my week"* → `get_stats(period: week)`

#### Security
* **Prompt injection mitigation:** User input is never interpolated into system instructions. LLM output is validated against a schema before any action executes.
* **No free-form execution path:** The defined tool schema is the only surface — a malicious message can only trigger a valid action.

#### Telegram Authentication
1. User generates a short-lived one-time code (5-minute expiry) from the web dashboard
2. User sends `/connect <code>` to the Telegram bot
3. Server verifies the code, links Telegram `chat_id` → `user_id` in SQLite, discards code
4. All subsequent messages authenticated by `chat_id` — no tokens in Telegram history

#### Rate Limiting (Two Independent Layers)
**Application layer** (SQLite counters per `chat_id`):
* 10 messages/minute
* 50 messages/hour
* 200 messages/day
* Bot replies with a friendly error and retry time; request never reaches the LLM API

**Provider layer** (Google AI Studio):
* Hard monthly spend cap (e.g. $10/month)
* Email alerts at 50% and 80% of budget

---

### 9.3 Android App (Deprioritised)

The Telegram bot serves as the mobile interface until native Android is warranted.

When picked up, no backend changes are required — the REST + JWT API is already mobile-ready. The only addition is FCM (Firebase Cloud Messaging) as a new notification delivery channel alongside `chrome.notifications`.

Revisit after web dashboard + Telegram bot are live and validated through real usage.

---