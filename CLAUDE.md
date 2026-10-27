# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Synapse** — a personal PARA organiser for links. You keep one virtual folder tree (Projects, Areas, Resources, Archive) whose leaves are links to wherever work actually lives: Google Docs, SharePoint files, other URLs or local file paths. Each link carries a "why this matters" note, plus optional priority, deadline and tags. The app never stores document content and has no reminder engine.

The app was rescoped in Oct 2026 from an SRS reminder app. The plan lives in `C:\Users\johnd\.claude\plans\binary-jingling-church.md`. Legacy tasks are not migrated; `server/scripts/export-legacy-tasks.js` dumps them from an old SQLite file to Markdown for review.

---

## Stack & Constraints

- **No build step, no TypeScript, no framework.** All code must run as-is (unpacked extension, raw `node server.js`).
- **Backend:** `http.createServer` (no Express). Firestore in production, a JSON file locally. Deployed to Cloud Run in an EU region.
- **Auth:** JWT (`jsonwebtoken` + `bcryptjs`), passed as `Authorization: Bearer <token>` header. Tokens expire in 14 days. Multi-user capable, single-user in practice.
- **EU hosting is a requirement.** Every GCP resource (Cloud Run, Firestore, buckets) must be in an EU region.

---

## Running Locally

```bash
cd server
npm install
JWT_SECRET=dev node server.js   # or put JWT_SECRET in server/.env
npm test                         # node:test API suite against a temp JSON store
```
Env: `PORT` (default 3000), `JWT_SECRET` (required), `STORE` (`firestore` in production, otherwise the JSON file store), `DATA_FILE` (JSON store path, default `./synapse-data.json`), `TRUST_PROXY=1` (only behind Cloud Run, for client IPs in the auth rate limiter).

---

## Architecture

### Backend (`server/`)

- `store.js` — **the only module that touches persistence.** Never call Firestore or read the data file anywhere else; add a function to `store.js` instead. Each user's items are cached in memory and written through, which is only correct with a single server instance (Cloud Run `max-instances=1`).
- `items.js` — folder/link rules: PARA root seeding, validation, URL parsing (`parseLink`), moves, search, tags. Throws `HttpError(status, message, extra)`, which `server.js` turns into JSON responses.
- `auth.js` — bcrypt/JWT wrappers with no side effects.
- `server.js` — manual URL matching, no router. Everything after the auth and static routes requires a valid JWT.

### Data model

Firestore: `users/{id}` (id = sha256 of lowercased email, so duplicate registration is atomic) and `users/{id}/items/{itemId}`.

An item is a folder or a link: `{ id, type, parentId, path, para, title, note, priority, dueDate, tags, createdAt, updatedAt, lastTouched }`, plus `url, kind, urlKey, site` on links.
- The four PARA roots have fixed ids `root-projects`, `root-areas`, `root-resources` and `root-archive`, are created on first access, and cannot be edited or deleted.
- `path` is the list of ancestor ids from root to parent; `para` is the root the item sits under. Moving a folder rewrites both on all descendants.
- Every item has exactly one parent. Cross-cutting grouping uses tags.
- `urlKey` is the normalised identity of a link (Google doc id, SharePoint `sourcedoc`, etc.). One link per `urlKey` per user; duplicates get a 409 with the existing item.
- `site` groups links from the same place (SharePoint site, web host) for folder suggestions.

### API

| Route | Purpose |
|---|---|
| `POST /auth/register`, `POST /auth/login` | Returns `{ token }` |
| `GET /items` | All items; filters `q, type, para, under, tag, priority, dueBefore` |
| `POST /items` | Create `{ type, parentId, title, url?, note?, priority?, dueDate?, tags? }` |
| `GET/PATCH/DELETE /items/:id` | PATCH with `parentId` moves; DELETE removes the subtree |
| `POST /items/:id/touch` | Mark as opened (updates `lastTouched`) |
| `GET /items/lookup?url=` | `{ item, breadcrumb }` if the URL is filed |
| `GET /tags` | Tags in use with counts |

### Web app (`server/web/`) and Chrome extension (`extension/`)

Being rebuilt for the PARA model (plan phases 2 and 3). The current files still target the old task API and do not work against the new server.

---

## Deployment

Target: Cloud Run + Firestore in `europe-west1`, secrets in Secret Manager. Set up in plan phase 6; until then Railway still serves the old app from `main`.

---

## Workflow

Rule: After completing every sub-task or fixing a specific file, you must run `git commit -m "claude: <description>"` before moving to the next step.
