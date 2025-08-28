MMP Renamer - Minimal Media Processor

Overview

This repository contains a lightweight Node/Express backend and a Vite+React frontend that implement a minimal MMP (media metadata processor) with the following features:

- Full library scan (server performs full inventory; UI only shows results after scan completes)
- Initial reveal of a small window of enriched items and progressive append as the user scrolls
- Per-path enrichment using a mock external provider and server-side caching keyed by canonical path
- Virtualized, fixed-height list rendering (react-window)
- Preview and apply rename flow with safe defaults and per-item results
- Simple logging endpoints and local UI persistence for visible window and enrichment cache

Quick start (Windows PowerShell)

1) Install dependencies

# in repo root
npm install

# web app deps
cd web; npm install

2) Run server and web dev server

# from repo root
npm run dev

The backend listens on port 5173 and the web dev server runs on 5174. The web app proxies /api to the backend when loaded from the same origin.

Notes & next steps

- The external metadata provider is mocked. Swap `externalEnrich` in `server.js` with a real provider and add API key handling in settings.
- Enrichment caching is persisted in `data/enrich.json`.
- Rename execution uses fs.renameSync and is guarded to allow dryRun; for atomic transactions across multiple moves consider two-phase commit or temporary staging.
- Add authentication and sandboxing before running this against sensitive paths.

Acceptance mapping

- Scanning: server performs full synchronous scan and returns scanId only after done. (Done)
- Initial reveal: UI only shows items after scan completes and loads initial batch. (Done)
- Enrichment & caching: server caches per canonicalPath; client checks cache before requesting enrichment. (Done)
- Progressive loading: client appends fixed-size batches when scrolling near end. (Done)
- Virtualized list: implemented with react-window fixed row size. (Done)
- Preview/apply: preview endpoint and apply endpoint exist; UI prompts before apply. (Done)
- Persistence: localStorage used for visible window and enrichment cache. (Done)
- Logging: logs saved to data/logs.txt and exposed via /api/logs/recent. (Done)

License: MIT (example)

Security & publishing notes

- Do NOT commit runtime `data/` directory. It contains sensitive items like API keys and user password hashes. A `.gitignore` is included which excludes `data/` and common build artifacts.
- To initialize an admin user without embedding secrets in the repo, set the `ADMIN_PASSWORD` environment variable before starting the server. Example:

```powershell
# Windows PowerShell
$env:ADMIN_PASSWORD = "your-secure-password-here" ; npm start
```

- Alternatively, copy `data/users.json.template` to `data/users.json` and populate the `passwordHash` field with a bcrypt hash (use `bcrypt` or an online tool that you trust).

Creating a GitHub repo safely

1. Make sure `data/` contains no secrets (or is empty) and `.gitignore` is present.
2. Create the repository with `git init`, commit source files, and push to GitHub.
3. After pushing, create the `data/users.json` locally on the deployment host and set the `ADMIN_PASSWORD` env var when starting the container/service.

If you'd like, I can prepare a simple `docker-compose.yml` and a GitHub Actions workflow to build and publish the image without exposing secrets.

Repository and deployment quick-start

Repository: https://github.com/jt-ito/MMP-Renamer.git

Docker (build & run)

```powershell
# Build the image locally
docker build -t mmp-renamer:latest .

# Run with data persisted to ./data and ports exposed
docker run -p 5173:5173 -v ${PWD}\\data:/usr/src/app/data -e SESSION_KEY="<secure-session-key>" -e ADMIN_PASSWORD="<temporary-admin-pwd>" mmp-renamer:latest
```

Push to GitHub (example)

```powershell
git init
git add .
git commit -m "Initial sanitized import"
git remote add origin https://github.com/jt-ito/MMP-Renamer.git
git branch -M main
git push -u origin main
```

Replace the `ADMIN_PASSWORD` and `SESSION_KEY` with secure values on your host or CI when starting the service. After initial admin setup, remove `ADMIN_PASSWORD` from env for runtime.

Credits

This project was prepared as a compact renamer demo. If you want, I can add CI, a docker-compose, or a GitHub Actions workflow next.
