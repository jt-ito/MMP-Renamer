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
MMP-Renamer
===========

A lightweight media renamer and organizer with provider-based enrichment (TMDb/Kitsu).

This README describes how to run the server and web UI, configure metadata providers, and how to run in Docker or Docker Compose. It also explains an important mount rule when running inside containers: hardlinks cannot cross filesystems, so mount the parent mount point (or entire device) into the container instead of mounting multiple individual subpaths from the same device.

Quick features
- Filename parsing and parsed vs provider naming separation (parsed results never include episodeTitle)
- TMDb primary provider with Kitsu fallback
- Per-user and server settings (API keys, scan input/output, rename template)
- Hardlink-only "apply" semantics by default (no copy fallback) — keeps storage efficient and avoids duplicates
- Background first-N enrichment to populate provider-rendered names
- Sweep helper to purge stale enrichment entries

Getting started (local)
1. Install Node.js 18+ and npm
2. Clone repo and install deps

   npm install

3. Start server (development)

   node server.js

4. Open the web UI at http://localhost:5173 (or the port you configured)

Configuration
- Server settings (global admin): `data/settings.json` or via Admin UI -> Settings (requires an admin account)
  - `tmdb_api_key`, `tvdb_api_key` — provider keys used when user keys are not supplied
  - `scan_output_path` — server default output path for hardlinking
  - `rename_template` — default rename template
- Per-user settings stored in `data/users.json` under each user -> `settings`:
  - `scan_input_path` — user default input path for scans
  - `scan_output_path` — user default output path for renames
  - `tmdb_api_key` — optional user key that overrides server key
  - `rename_template` — user template to override server default

Important: hardlinks and mounts (Docker/containers)
-----------------------------------------------
Hardlinks are implemented with `fs.linkSync` and therefore cannot be created across different filesystems or mount points. When the server runs inside a container, the kernel sees container mount points as distinct filesystems if you mount multiple host directories separately — even if they live on the same physical device. That causes EXDEV (cross-device link) errors when the server attempts to hardlink from the input path to the output path.

To avoid this problem, mount the entire parent mount (or the device root) into the container and reference subfolders inside the container. Do NOT mount separate subfolders individually when you need to hardlink between them.

Example: Bad (DON'T do this)
- Mount `/mnt/disk/media/input` -> `/input`
- Mount `/mnt/disk/media/output` -> `/media`

Even though both host paths live on the same physical device, the container will often treat `/input` and `/media` as separate mount points and hardlinks will fail with EXDEV.

Example: Good (DO this)
- Mount `/mnt/disk/media` -> `/media`
  - Use `/media/input` and `/media/output` inside the container for scanning and output.

This ensures the kernel sees the source and the destination as the same filesystem and hardlinks succeed.

Docker / Docker Compose
-----------------------
A recommended Docker setup is to mount the parent media directory into the container and map a host data directory for the server state.

Minimal docker-compose example:

version: '3.8'
services:
  renamer:
    image: node:18-alpine
    working_dir: /app
    volumes:
      - ./data:/app/data
      - /mnt/disk/media:/media   # mount the entire media mountpoint
      - ./web:/app/web
      - ./lib:/app/lib
    command: sh -c "npm install --production && node server.js"
    ports:
      - "5173:5173"
    environment:
      - NODE_ENV=production
      # optionally set global TMDb key
      # - TMDB_API_KEY=your_tmdb_key_here

Notes:
- Replace `/mnt/disk/media` with your host mountpoint that contains both the input and output folders.
- If you run the container on Windows, use the host path appropriate for Windows (e.g., `//c/Users/you/media` or `C:\\media` depending on Docker setup). The same principle applies: mount the parent device/mountpoint once.

Running without Docker
----------------------
If you run directly on a host OS, hardlinks will succeed as long as the input and output paths are on the same filesystem. If your input and output are on different drives, hardlinks will not be possible.

Behavior choices
- Default: hardlink-only. If the server cannot hardlink due to EXDEV, the operation fails and is logged. This avoids accidental duplication.
- Alternative: you may enable a copy-on-cross-device fallback by setting a server option (not enabled by default) — this will copy the file when hardlinks are impossible. Use with care.

Admin & Troubleshooting
- Check `data/logs.txt` for helpful short tokens (SCAN_START, ENRICH_REQUEST, ENRICH_SUCCESS, PREVIEW_EFFECTIVE_OUTPUT, HARDLINK_OK, HARDLINK_FAIL, HARDLINK_CROSS_DEVICE, HARDLINK_REFUSE_INPUT)
- If you see `HARDLINK_CROSS_DEVICE` or EXDEV errors, verify mounts as described above.
- Use the `/api/path/exists` endpoint to confirm the server can see configured paths.

Security & Permissions
- The server must have read access to scan input folders and write access to the configured output path.
- When running in Docker, ensure the container user has correct permissions or use a bind-mounted data directory with compatible permissions.

Contributing
- Tests and scripts live under `scripts/` — please run `npm test` or inspect `scripts/test-hardlink.js` when changing hardlink logic.

Credits
- Built with Node.js and a minimal React UI in `web/`.

License
- MIT


If you'd like, I can also add a small troubleshooting checklist to the Admin UI that detects EXDEV situations and warns users before they apply renames. Let me know if you want that added and where you'd like the guidance displayed.
