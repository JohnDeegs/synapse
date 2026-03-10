# LocalGo — Project Reflection

## What we built
A personal Chrome extension + cloud dashboard for managing `go/` keyword URL shortcuts. Inspired by tools like **trot.to** and internal Google-style "go links," but fully owned—no accounts, no third-party dependency, and deployable for **~$5/month**.

---

## Stack Choices and Why

### Node.js (No Framework)
We started with a simple `http.createServer` setup and never needed to change it. The app has one data file, one auth layer, and ~15 routes. Express would have added a dependency and cognitive overhead with no real gain. Vanilla Node kept it readable and easy to deploy anywhere without a `node_modules` footprint that could break.

### JSON Flat-file Storage
The use case is one user (or a small team) with a few hundred links at most. SQLite or Postgres would have been overkill. The JSON file approach meant:
* **Zero setup** and zero migration complexity.
* **Trivial import/export**—you can simply open the file to read or edit it.
* *Tradeoff:* No atomic writes or complex queries, which didn't matter at this scale.

### Railway over Vercel
Vercel's serverless model is stateless by design; each function invocation has no persistent filesystem. Since our data lives in a JSON file, we needed a **persistent volume**. Railway runs a real process with mounted storage, which was a direct match for our local environment. No rewrite required.

### Tailwind CSS via CDN
A "no build step" constraint was set early on—the extension needed to be loadable as an unpacked folder without a compile step. Tailwind's CDN "play mode" fit perfectly. While it meant a larger payload and no tree-shaking, that is irrelevant for a personal dashboard loaded once.

### Manifest V3 with `declarativeNetRequest`
The `http://go/*` interception approach is the "right" way in MV3. It is declarative, fast, and doesn't require a background script to inspect every navigation. The omnibox fallback (`go` + `[Tab]` + `keyword`) covers users who haven't edited their `hosts` file, which was vital for frictionless onboarding.

### No Build Step, No TypeScript
This was a deliberate choice to keep the project accessible and instantly modifiable. The codebase is small enough that types wouldn't have caught meaningful bugs. What it loses in safety, it gains in **zero friction**—any change is a simple "reload and test."

---

## What Went Well

* **The Server "Just Worked":** The original local `server.js` ran on Railway with almost no changes—just `PORT` and `DATA_FILE` from env vars. The architecture being stateless (read file -> write file -> respond) translated directly to the cloud.
* **Clean Incremental Features:** Features like aliases, expiry dates, tags, template links (e.g., `jira/{id}`), and AI "peek" were added without touching existing code paths.
* **Dual Interception Approach:** Having both `declarativeNetRequest` and Omnibox support meant the extension worked immediately regardless of the user's technical setup.
* **Simple Profile Design:** Profiles were implemented as a straightforward foreign key relationship in a flat file. No joins or migrations—just a `profile` field on links and a separate `profiles.json`.

---

## What Didn't Go Well

* **PUBLIC_URL Confusion:** Setting `PUBLIC_URL` before knowing the actual Railway deploy URL caused a debugging detour. Environment variables set speculatively before a system is running are a common source of subtle CORS bugs.
* **`readBody()` encoding issues:** The login form sent `application/x-www-form-urlencoded` (standard browser behavior), but our `readBody()` only parsed JSON. Login failed silently because the server returned a redirect regardless of success.
* **

---

# Synapse — Phase 3 Post-Mortem (Extension Bootstrap)

## Issues Encountered & Fixes

### 1. Chrome refused to load the extension: "Could not load manifest"

**What happened:** Chrome silently failed to load `manifest.json` because the manifest declared a `"service_worker": "background.js"` that didn't exist on disk yet (it was a later phase). Chrome validates all referenced files at load time and fails the entire manifest if any are missing.

**Fix:** Create a minimal placeholder file for every file referenced in the manifest before loading the extension, even if the file is just a one-line comment.

**Advice for future builders:** Before loading an extension in Chrome for the first time, audit every filename referenced in `manifest.json` — `service_worker`, `default_popup`, icons — and ensure all of them exist on disk. A placeholder is fine; a missing file is a hard failure.

---

### 2. Clicking the extension icon gave ERR_FILE_NOT_FOUND

**What happened:** Same root cause as above — `popup.html` was declared as `"default_popup"` in the manifest but hadn't been created yet. Chrome tried to open the file and got a 404.

**Fix:** Create a placeholder `popup.html` that displays a holding message. Commit it alongside the manifest.

**Advice for future builders:** Treat the manifest like a contract. Every path in it must resolve to a real file. Build your placeholders first, then fill them in phase by phase.

---

### 3. `chrome.runtime.openOptionsPage()` silently failed from the popup

**What happened:** The placeholder popup had a link that called `chrome.runtime.openOptionsPage()`. This API can fail silently in MV3 when the service worker is a stub with no listeners registered. Clicking the link did nothing.

**Fix:** Use `chrome.tabs.create({ url: chrome.runtime.getURL('options.html') })` instead, and add the `"tabs"` permission to the manifest. This is more explicit and reliable — it does not depend on the service worker being active.

**Advice for future builders:** `chrome.runtime.openOptionsPage()` is convenient but fragile during early development when the background service worker is a stub. Prefer `chrome.tabs.create` with an explicit URL for popup → options navigation. Add the `"tabs"` permission upfront — you will almost certainly need it anyway.