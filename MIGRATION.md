Migration steps: JSON -> SQLite
=================================

This document explains how to safely migrate the legacy JSON persistence files (notably `data/scans.json` and the various caches) into a new SQLite-backed store using the included migration script and Docker builder (recommended). The steps are PowerShell-friendly.

Important safety notes
- Stop the running server before migrating or ensure the server is quiesced (no writes). Concurrent writes during migration can cause data loss.
- Back up the entire `data/` directory before running the migration.
- The migration script uses the native `better-sqlite3` Node module. That module needs to be compiled for your environment. The easiest way is to build and run the migration inside the repository Docker image (builder stage compiles native modules).

Quick checklist
- [ ] Stop the server
- [ ] Backup `data/` (or entire project)
- [ ] Build Docker image (recommended) or install native build tools locally
- [ ] Run migration (in container or locally)
- [ ] Verify `data/scans.db` and caches
- [ ] Start server and validate endpoints

Back up data (PowerShell)

```powershell
# make a timestamped backup of the data directory
$ts = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item -Recurse -Force .\data .\data-backup-$ts
```

Build the Docker image (recommended)

The Dockerfile has been updated to compile native modules in the builder stage and copy built `node_modules` to the runtime. Building the image will compile `better-sqlite3` for the container environment.

```powershell
# from repository root
docker build -t renamer:sqlite .
```

Run the migration inside a container (mount your data dir)

This runs the included migration script (safe-guarded by `--yes`) inside the image and writes `data/scans.db` into your project `data/` directory.

```powershell
# Adjust the host path to the project directory if not in working dir
$hostData = (Resolve-Path .\data).Path
docker run --rm -v "$hostData:/usr/src/app/data" renamer:sqlite node ./scripts/migrate-scans-to-sqlite.js --yes
```

If you prefer to run the migration locally (not in Docker)

- Ensure you have a C compiler and the SQLite dev headers installed (on Windows, install windows-build-tools or Visual Studio Build Tools; on Debian/Ubuntu install build-essential and libsqlite3-dev)
- Run `npm ci` to install dependencies (so better-sqlite3 will compile)
- Then run:

```powershell
node .\scripts\migrate-scans-to-sqlite.js --yes
```

Verify results

- After migration, `data/scans.db` should exist and be a SQLite file.
 - Note: the server now requires the SQLite native module (`better-sqlite3`). If you run the server locally without building the Docker image (which compiles native modules) you will get an error like "better-sqlite3 not installed" and the process will exit. Build the Docker image using the updated `Dockerfile` or install/compile `better-sqlite3` locally before running the server.
- You can inspect it with the `sqlite3` CLI or a GUI tool. Example with sqlite3 (if available):

```powershell
sqlite3 .\data\scans.db "SELECT count(*) FROM scans;"
```

- Verify that the web/server points to the DB (the updated `server.js` will prefer the DB if available). Start the server and check endpoints:

  - GET /api/scan/latest
  - GET /api/enrich (or the new bulk endpoints)

If something goes wrong

- Restore the backup you made earlier by copying `data-backup-<ts>\*` back to `data\`.

Optional: run the migration inside a temporary container and drop into a shell for interactive inspection

```powershell
docker run --rm -it -v "$hostData:/usr/src/app/data" renamer:sqlite pwsh
# inside the container you can run the migration and use sqlite3 if installed
node ./scripts/migrate-scans-to-sqlite.js --yes
```

Follow-ups / Next steps

- After verifying migration, consider removing or archiving the old `data/scans.json` file.
- Consider running the server from the same image (or in a container) to ensure `better-sqlite3` binary matches the runtime environment.
- Add CI steps to run the DB-backed tests in a container where native modules are compiled.

Contact

If you'd like, I can build the image and run the migration for you (I will need confirmation to stop/quiesce the server and to proceed with writing into `data/`).
