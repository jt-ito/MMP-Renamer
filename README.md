# MMP-Renamer

A small, local-first media renamer: a Node/Express backend with a Vite+React frontend that
scans a local library, parses filenames, enriches metadata (TMDb when configured), and provides
a safe preview / approve workflow that hardlinks files into a Jellyfin-friendly layout.

Important: the `data/` directory contains runtime state and secrets. Do not commit it.

## Features

- Full library scanning and per-path enrichment with server-side caching (persisted to `data/`).
- TMDb enrichment when you provide an API key (settings page).
- Preview renames and apply non-destructively by creating hardlinks under the configured output path
  (falls back to copying if hardlinking across devices fails).
- Applied renames are recorded (applied, hidden, appliedAt, appliedTo, renderedName, metadataFilename)
  and can be unapproved.
- Virtualized list rendering (react-window) for smooth large-library browsing.

## Quick start (development)

1. Install dependencies

```powershell
npm install
cd web
npm install
cd ..
```

2. Run in dev mode

```powershell
npm run dev
```

The backend listens on port 5173. The web dev server (Vite) runs on 5174 and proxies `/api` to the backend.

## Environment variables

- `SESSION_KEY` (required): cookie/session signing key. Provide a secure random string.
- `ADMIN_PASSWORD` (optional): when present at first startup an admin user will be created with this
  password; remove it from the environment after initialization.

## Docker

Build the image locally:

```powershell
docker build -t mmp-renamer:latest .
```

Run it and mount `data/` from the host:

```powershell
docker run -p 5173:5173 -v ${PWD}\\data:/usr/src/app/data -e SESSION_KEY="<secure-session-key>" -e ADMIN_PASSWORD="<temporary-admin-pwd>" mmp-renamer:latest
```

Build with custom repo/ref (the Dockerfile supports `REPO_URL` and `REPO_REF` build args):

```powershell
docker build --build-arg REPO_URL=https://github.com/jt-ito/MMP-Renamer.git --build-arg REPO_REF=main -t mmp-renamer:latest .
```

Example `docker-compose.yml` snippet:

```yaml
version: "3.8"
services:
  renamer:
    image: mmp-renamer:latest
    build:
      context: .
      args:
        REPO_URL: "https://github.com/jt-ito/MMP-Renamer.git"
        REPO_REF: "main"
    ports:
      - "5173:5173"
    environment:
      - SESSION_KEY=${SESSION_KEY}
      # Provide ADMIN_PASSWORD only to initialize admin, then remove it.
      - ADMIN_PASSWORD=${ADMIN_PASSWORD}
    volumes:
      - ./data:/usr/src/app/data
    restart: unless-stopped
```

## Security & initialization

- Do NOT commit the `data/` directory. It holds runtime state and secrets (API keys, password hashes).
- The repo includes `.gitignore` to exclude `data/` and common build artifacts.
- To create an admin without storing plaintext passwords in the repo:
  - Start the server once with `ADMIN_PASSWORD` set (it will create the admin on first run), then
    remove `ADMIN_PASSWORD` from the environment.
  - Or use the helper scripts in `scripts/` to generate a bcrypt hash and populate `data/users.json`.

## What's changed in this fork

- TMDb enrichment is used when a TMDb API key is configured (old Kitsu provider removed).
- Preview/apply now prefers creating hardlinks under the configured output path and does not
  mutate the original files.
- Applied renames are persisted with metadata and can be unapproved from the UI.
- Default rename template: `{title} ({year}) - {epLabel} - {episodeTitle}`.
- Select-mode and batch approve UI added.

## Development notes & next steps

- The backend is a single `server.js` Express app; frontend lives in `web/` (Vite + React).
- If you want CI or automated image publishing, I can add a GitHub Actions workflow that builds
  the web assets and images using repository secrets (recommended approach for private tokens).

## How I validated changes (local checks you can reproduce)

- Confirm data persistence: `data/enrich.json` and `data/rendered-index.json` are written when
  items are applied.
- Sanity check: run server and use the UI to scan a small folder, preview a rename, and apply it.

## Help me push this

I updated and sanitized files in the workspace locally. To push the sanitized repo to GitHub from
your machine run the usual git commands (set user.name / user.email, commit, and push). I could not
complete the push here because this environment doesn't have your Git credentials.

If you want, I can add a short `CONTRIBUTING.md`, a GitHub Actions workflow for CI, or a `docker-compose.override.yml` for development.

---

Licensed under MIT (example)
