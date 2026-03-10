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
* **Storage:** Single `tasks.json` flat file on a Railway persistent volume.
* **Auth:** Static API key passed as a request header (`X-API-Key`).
* **Endpoints:**

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/tasks` | Return all active tasks |
| `POST` | `/tasks` | Create a new task |
| `PATCH` | `/tasks/:id` | Update task (check-in, complete, snooze) |
| `DELETE` | `/tasks/:id` | Delete a task |

### 7.3 Data Model
Each task stored in `tasks.json` follows this schema:
```json
{
  "id": "uuid",
  "title": "string",
  "description": "string (GFM markdown)",
  "priority": "P0|P1|P2|P3|P4",
  "createdAt": "ISO 8601 timestamp",
  "nextReminder": "ISO 8601 timestamp",
  "checkinCount": 0,
  "status": "active|completed|snoozed",
  "checkinLog": [
    { "timestamp": "ISO 8601 timestamp", "note": "string" }
  ]
}
```

---

## 8. Scope Boundaries

### v1.0 (This Document)
* Chrome Extension + Railway backend only.
* OS notifications via `chrome.notifications` on desktop.
* Single-user, API-key auth.

### v2.0 (Future)
* Android app with native push notifications, notification shade shortcut, and home screen widgets.
* Multi-device sync with conflict resolution.
* Escalation integrations: Telegram, WhatsApp, and Email for P0/P1 tasks that remain unread.

---