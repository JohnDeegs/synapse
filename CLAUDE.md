# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Synapse** — a personal PARA organiser for links. You keep one virtual folder tree (Projects, Areas, Resources, Archive) whose leaves are links to wherever work actually lives: Google Docs, SharePoint files, other URLs or local file paths. Each link carries a "why this matters" note, plus optional priority, deadline and tags. The app never stores document content and has no reminder engine.

The app was rescoped in Oct 2026 from an SRS reminder app. The plan lives in `C:\Users\johnd\.claude\plans\binary-jingling-church.md`. Legacy data was discarded along with the Railway deployment.

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
| `GET /items/suggest?url=&title=` | Up to 5 `{ folderId, breadcrumb, score, reasons }`: same site, recent folders, matching words |
| `POST /items/embeddings` | Batch-store client-computed vectors `{ model, vectors: { id: base64 } }` (not a touch) |
| `GET /tags` | Tags in use with counts |

### On-device AI (`synapse-ai.js`)

- `server/web/synapse-ai.js` is canonical; `extension/synapse-ai.js` must be an identical copy (`server/test/ai.test.js` fails otherwise). After editing, run `cp server/web/synapse-ai.js extension/synapse-ai.js`.
- Model: potion-base-4M static embeddings (mean of word-piece vectors, BERT uncased tokenizer), pinned to one Hugging Face revision. Files are hash-verified before going into the Cache API. Changing the revision means updating `REVISION`, `FILES` hashes and sizes; `MODEL_ID` changes with it, so every client re-embeds.
- Vectors are computed only on clients and stored on items as `embedding: { model, v }` (int8, base64). The server never computes them. It clears `embedding` whenever title, note, tags or url change, and clients backfill anything `SynapseAI.missing()` returns.
- A folder's "fingerprint" is the sum of its own vector and its direct child links' vectors. Similarity thresholds are the constants at the top of `synapse-ai.js`.
- Web app: toggle in sidebar (`localStorage.synapse_ai`), skipped on data saver. Extension: `aiEnabled` in `chrome.storage.local` (default on); the popup blends similarity into server suggestions (`AI_WEIGHT`, `AI_FLOOR` in `popup.js`) and backfills missing vectors.
- AI is always optional: every feature must work, minus suggestions, when the model fails to load.

### Web app (`server/web/`)

Served at `/web/`. Vanilla JS in `app.js`, no dependencies. Loads all items once (`GET /items`) and does tree building, search and filtering client-side; reloads after every change.
- Hash routes: `#/` home (due-soon strip, PARA cards, recently touched), `#/f/<id>` folder, `#/review` weekly review. Typing in the search box (or clicking a tag) shows results instead of the route.
- One `<dialog id="editor">` creates and edits both folders and links.
- All user content goes through `esc()` before `innerHTML`; only `http(s)` URLs become `href`s, local paths get a copy button.
- Installable PWA (`manifest.webmanifest`, network-only `sw.js`). The manifest's `share_target` opens `index.html?title=&text=&url=`; `handleShare()` opens the editor and preselects the top `/items/suggest` folder.
- localStorage: `synapse_token`, `synapse_theme`, `synapse_expanded` (open tree nodes), `synapse_last_folder`.

### Chrome extension (`extension/`)

Load unpacked from `chrome://extensions` (Developer Mode). Sign in from the options page with the backend URL (e.g. `http://localhost:3000`).

```
extension/
  api.js         # shared: getConfig(), api(), cleanTitle(), webAppUrl(); <script> in pages, importScripts() in the worker
  popup.html/js  # "file this tab": lookup → already-filed view, or form with folder picker + suggestions
  background.js  # context menu, ✓ badge on filed tabs, omnibox search (keyword "s")
  options.html/js
```
- `chrome.storage.local` holds `{ token, apiBase, email }`. Both `token` and `apiBase` must be present for any API call.
- Popup opens with Alt+S (`_execute_action`). Enter in the note saves, Enter in the folder search jumps to the note.
- Context-menu filing can't open the popup, so it opens `popup.html?url=&title=` in a small window; `popup.js` prefers those params over the active tab.
- The badge lookup cache lives in worker memory and is lost when the worker stops; that only costs an extra `/items/lookup` call.
- After filing, the popup sends `{ type: 'filed', url }` so the worker refreshes the badge.

---

## Deployment

Target: Cloud Run + Firestore in `europe-west1`, secrets in Secret Manager, `max-instances=1`, `STORE=firestore`, `TRUST_PROXY=1`. Not deployed yet; there is currently no production server.

---

## Workflow

Rule: After completing every sub-task or fixing a specific file, you must run `git commit -m "claude: <description>"` before moving to the next step.
