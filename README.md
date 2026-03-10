# Synapse

A contextual reminder app using Spaced Repetition (SRS) to fight notification blindness.

**Stack:** Chrome Extension (MV3) + vanilla Node.js backend + SQLite, deployed on Railway.

See `plan.md` for the full PRD and `tasks.md` for the build task list.

## Local Setup

### Backend
```bash
cd server
cp .env.example .env   # fill in JWT_SECRET
npm install
node server.js
```

### Extension
1. Open `chrome://extensions`
2. Enable Developer Mode
3. Load Unpacked → select the `extension/` folder
4. Open Options → enter `http://localhost:3000` and register an account

## Deployment (Railway)

Set env vars on Railway:
- `DATA_FILE=/data/synapse.db` (persistent volume)
- `JWT_SECRET=<random string>`
- Do **not** set `PORT` — Railway sets it automatically
