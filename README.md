# Synapse

A contextual reminder app using Spaced Repetition (SRS) to fight notification blindness.

**Stack:** Chrome Extension (MV3) + vanilla Node.js backend + SQLite, deployed on Railway.

See `plan.md` for the full PRD and `tasks.md` for the build task list.

---

## Local Setup

### Backend
```bash
cd server
cp .env.example .env   # edit .env: set JWT_SECRET to any random string
npm install
node server.js
# Server runs on http://localhost:3000
```

### Extension
1. Open `chrome://extensions`
2. Enable Developer Mode
3. Click **Load unpacked** → select the `extension/` folder
4. Click the extension icon → **Options**
5. Enter `http://localhost:3000` as the API base URL
6. Register an account and start adding tasks

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
In Railway → **Variables**, add:

| Variable | Value |
|----------|-------|
| `DATA_FILE` | `/data/synapse.db` |
| `JWT_SECRET` | any long random string |

> Do **not** set `PORT` — Railway injects it automatically.

### 4. Generate a domain and deploy
1. In your Railway service, go to **Settings → Networking** → **Generate Domain**
2. When prompted for a target port, check your **Deploy Logs** for the line `Synapse server listening on port XXXX` and enter that port number (Railway injects its own `PORT` — it is not always 3000)
3. Railway auto-deploys on push to `main`. Once the deploy log shows the server listening, copy the generated URL (e.g. `https://synapse-production.up.railway.app`)

> **Tip:** To confirm the server is up, `GET /tasks` should return `401`. The root URL (`/`) returns 404 — that is expected, there is no index route.

### 5. Point the extension at production
1. Open the extension Options page
2. Replace `http://localhost:3000` with your Railway URL
3. Register/login against the production backend

### 6. Verify
```bash
# Register a user against prod
curl -X POST https://<your-railway-url>/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"secret"}'
# Expected: { "token": "eyJ..." }
```
