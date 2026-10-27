# Synapse

A personal PARA organiser for links. Keep one folder tree (Projects, Areas, Resources, Archive) whose entries point to wherever your work actually lives: Google Docs, SharePoint files, any web page or a local file path. Each link carries a short note on why it matters, plus optional priority, deadline and tags.

Synapse never stores document content and never sends you alerts. It's a map, not an inbox.

**Stack:** vanilla Node.js server (no framework, no build step) · Firestore in production, a JSON file locally · web app (installable on Android) · Chrome extension (MV3) · on-device AI with a 15 MB static embedding model.

---

## Features

- **Folder tree that spans every tool.** A Google Doc, a SharePoint Word file and a local PDF can sit side by side in one project folder. Archiving a project moves the whole folder under Archive.
- **"Why this matters" notes** on every link, so you can find things by what they're for, not just by name.
- **Search** across titles, notes, tags and URLs, with filters by PARA area, tag and priority.
- **Due-soon strip and "last touched"** indicators instead of reminders. Nothing piles up while you're away.
- **Weekly review** page: projects and areas ordered by how stale they are, with one-click "still active" or "archive".
- **Chrome extension:**
  - **Alt+S** files the current tab, with the title cleaned up and a folder suggested
  - **Right-click** any page or link → *File in Synapse*
  - a green **✓** on pages you've already filed
  - **`s` + search** in the address bar opens filed links directly
- **Android:** install the web app, then share from the Google Docs or SharePoint apps straight into a folder.
- **On-device AI** (optional, on by default):
  - folder and tag suggestions
  - "related by meaning" search results
  - tidy-up hints (misfiled links, likely duplicates)

  It runs entirely in your browser. See [On-device AI](#on-device-ai).

---

## Local setup

### Server
```bash
cd server
npm install
JWT_SECRET=change-me node server.js     # or put JWT_SECRET in server/.env
# http://localhost:3000/web
npm test                                # API + AI unit tests
```
Locally, data lives in `server/synapse-data.json` (gitignored).

### Chrome extension
1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder.
3. Open the extension's **Options**, enter `http://localhost:3000` as the backend URL, and sign in or register.

### Android
Open the web app in Chrome on your phone, sign in, then use the menu → **Install app**. Synapse then appears in the share sheet. This needs the server on HTTPS, so it only works once deployed.

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | Yes | Random secret for signing login tokens |
| `PORT` | No | Default `3000`. Cloud Run sets it automatically |
| `STORE` | Production | `firestore` to use Firestore; anything else uses the JSON file |
| `DATA_FILE` | No | JSON store path, default `./synapse-data.json` |
| `TRUST_PROXY` | Production | `1` behind Cloud Run, so the login rate limiter sees real client IPs |

---

## On-device AI

- **Model:** [minishlab/potion-base-4M](https://huggingface.co/minishlab/potion-base-4M) (MIT), a "static embedding" model. A text's meaning is the average of its word pieces' vectors, so it's a table lookup with no neural network or WebAssembly. It's implemented in plain JS in `server/web/synapse-ai.js`, and `extension/synapse-ai.js` is an identical copy (a test enforces this).
- **Download:** about 15 MB, once per browser, from a pinned revision. Files are checked against Hugging Face's published hashes before use and kept in the browser cache. A file that doesn't match is rejected and the AI stays off.
- **Privacy:** your titles and notes are turned into vectors in your browser. The vectors (128 small numbers per item) are stored with your items so every device can use them. Nothing is sent to an AI service.
- **Switching it off:** the toggle in the web app sidebar, or in the extension options. Everything else works the same without it.

---

## API

All routes except auth and `/web/*` need `Authorization: Bearer <token>`.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/auth/register`, `/auth/login` | Returns `{ token }` |
| `GET` | `/items` | All items; filters `q, type, para, under, tag, priority, dueBefore` |
| `POST` | `/items` | Create a folder or link |
| `GET/PATCH/DELETE` | `/items/:id` | PATCH with `parentId` moves; DELETE removes the subtree |
| `POST` | `/items/:id/touch` | Mark as opened |
| `GET` | `/items/lookup?url=` | Where a URL is filed, if anywhere |
| `GET` | `/items/suggest?url=&title=` | Rule-based folder suggestions |
| `POST` | `/items/embeddings` | Store client-computed vectors `{ model, vectors: { id: base64 } }` |
| `GET` | `/tags` | Tags in use with counts |
| `GET` | `/web/*` | Web app |

---

## Deployment

Planned: Cloud Run + Firestore in `europe-west1` (EU), with secrets in Secret Manager and `max-instances=1`. The server caches each user's items in memory, which is only correct with a single instance. Not deployed yet.
