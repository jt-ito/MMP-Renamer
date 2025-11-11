# MMP-Renamer

**A powerful, local-first media renaming and organizing tool** that scans your media library, enriches metadata from multiple providers (AniDB, AniList, TVDB, TMDb), and creates Jellyfin/Plex-compatible folder structures using hardlinks—keeping your storage efficient without duplicating files.

Built with a Node.js/Express backend and a modern React + Vite frontend, MMP-Renamer is designed for anime enthusiasts and media collectors who want accurate metadata and a safe, preview-before-commit workflow.

---

## 🎯 Core Features

### Metadata Enrichment
- **AniDB ED2K Hash Lookup**: Primary anime provider using file hashing for 99% accurate episode identification—even with bad filenames
- **Multi-Provider Fallback Chain**: AniList → TVDB → TMDb → Wikipedia → Kitsu for comprehensive coverage
- **Configurable Provider Order**: Drag-and-drop provider priority in the UI
- **Wikipedia & Kitsu Fallback**: Optional episode title enrichment when primary providers lack data

### Smart Scanning & Organization
- **Full & Incremental Scans**: Full library walks or fast incremental detection of new/changed files
- **Folder Watching**: Automatic background rescans when files are added or modified
- **Server-Side Search**: Fast regex-based search across large libraries without loading everything client-side
- **Virtualized List Rendering**: Smooth browsing of 10,000+ items using react-window

### Safe Rename Workflow
- **Preview Before Apply**: See exactly what will happen before committing any changes
- **Hardlink-First**: Creates hardlinks by default—no file duplication, instant "renames"
- **Multiple Output Folders**: Choose different destinations per rename (e.g., Anime Library vs. TV Library)
- **Alternative Folder Selection**: UI modal lets you pick the target folder on the fly
- **Unapprove/Undo**: Revert recently applied items back to the queue

### Advanced Selection & Bulk Operations
- **Select Mode**: Click or shift-click to select ranges, then bulk approve/hide/rescan
- **Drag Selection**: Mouse drag to select multiple items at once
- **Persistent Selection Across Rescans**: Selections survive metadata refreshes so you can batch-apply after rescanning
- **Bulk Hide**: Remove clutter by hiding unwanted matches (tracked server-side)

### Modern UI
- **Dark & Light Themes**: Toggle between themes for comfortable viewing
- **Settings Cards Layout**: Organized sections for API Keys, Metadata & Paths, Password Management
- **Live Template Preview**: See how your rename template renders before saving
- **Custom Favicon**: Branded with the printer icon for easy tab identification
- **Responsive Design**: Works on desktop, tablet, and mobile

---

## 📦 Installation

### Prerequisites
- **Node.js 18+** and **npm** (or compatible package manager)
- **Git** (to clone the repository)
- Optional: **Docker** for containerized deployment

### Local Development Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/jt-ito/MMP-Renamer.git
   cd MMP-Renamer
   ```

2. **Install server dependencies**
   ```bash
   npm install
   ```

3. **Install web UI dependencies**
   ```bash
   cd web
   npm install
   cd ..
   ```

4. **Set environment variables** (optional but recommended)
   ```bash
   # Windows PowerShell
   $env:SESSION_KEY = "your-secure-random-string-here"
   $env:ADMIN_PASSWORD = "temporary-admin-password"

   # Linux/macOS
   export SESSION_KEY="your-secure-random-string-here"
   export ADMIN_PASSWORD="temporary-admin-password"
   ```

   - `SESSION_KEY`: Required for secure cookie signing (generate a random 32+ character string)
   - `ADMIN_PASSWORD`: Used on first run to create the admin user; remove after initialization

5. **Run in development mode**
   ```bash
   npm run dev
   ```

   This starts:
   - Backend server on port **5173**
   - Vite dev server on port **5174** (proxies `/api` to backend)

6. **Build for production** (optional)
   ```bash
   cd web
   npm run build
   cd ..
   node server.js
   ```

   Production build serves static assets from `web/dist/` on port **5173**.

### First-Time Setup

1. Navigate to `http://localhost:5173` in your browser
2. Register the first user (becomes admin automatically)
3. Go to **Settings** and configure:
   - **API Keys**: TMDb, TVDB v4, AniList, AniDB credentials
   - **Input Path**: Directory to scan for media files
   - **Output Path**: Directory where hardlinks will be created
   - **Rename Template**: Customize filename format (see [Template Tokens](#rename-template-tokens))

---

## 🐳 Docker Deployment

### Build the Image

```bash
docker build -t mmp-renamer:latest .
```

### Run the Container

```bash
docker run -d \
  --name mmp-renamer \
  -p 5173:5173 \
  -v /path/to/data:/usr/src/app/data \
  -v /path/to/media:/media \
  -e SESSION_KEY="your-secure-session-key" \
  -e ADMIN_PASSWORD="temporary-admin-password" \
  --restart unless-stopped \
  mmp-renamer:latest
```

**Important for Hardlinks**: Mount the **parent directory** that contains both your input and output folders. Hardlinks cannot cross filesystem boundaries—if you mount `/input` and `/output` separately, even on the same physical disk, Docker treats them as separate filesystems and hardlinks will fail with `EXDEV` errors.

✅ **Correct**: Mount `/mnt/media` and use `/mnt/media/input` and `/mnt/media/output` inside the container  
❌ **Wrong**: Mount `/mnt/media/input` to `/input` and `/mnt/media/output` to `/output` separately

### Docker Compose

Create `docker-compose.yml`:

```yaml
version: '3.8'
services:
  mmp-renamer:
    image: mmp-renamer:latest
    container_name: mmp-renamer
    ports:
      - "5173:5173"
    volumes:
      - ./data:/usr/src/app/data          # Persistent runtime data
      - /mnt/media:/media:rw              # Mount entire parent media directory
    environment:
      - PUID=1000                         # User ID (default: 1000)
      - PGID=1000                         # Group ID (default: 1000)
      - SESSION_KEY=${SESSION_KEY}        # Secure random string for cookie signing (32+ chars)
      - ADMIN_PASSWORD=${ADMIN_PASSWORD}  # Remove after first run
    restart: unless-stopped
```

**Set correct permissions before first run:**
```bash
# Ensure the container user has R/W privileges (adjust path to match your data volume)
sudo chown -R 1000:1000 ./data
```

Run with:
```bash
docker-compose up -d
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SESSION_KEY` | Yes | Secure random string for cookie signing (32+ chars) |
| `ADMIN_PASSWORD` | No | Sets admin password on first run; remove after setup |
| `PORT` | No | Override default port 5173 |

---
## ⚙️ Configuration

### Settings Overview

MMP-Renamer supports both **server-wide** (admin-configured) and **per-user** settings. User settings override server defaults where applicable.

Configuration is managed via:
- **Web UI**: Settings page (requires login)
- **Direct file edit**: `data/settings.json` (server), `data/users.json` (per-user)
- **API**: `/api/settings` endpoint (POST to update, GET to retrieve)

### API Keys & Provider Configuration

#### AniDB (Anime Database)
**Primary anime provider using ED2K file hashing for 99% accurate identification**

1. Create a free account at [anidb.net/user/register](https://anidb.net/user/register)
2. Register your client at [anidb.net/software/add](https://anidb.net/software/add):
   - **Client Name**: `mmprename` (or custom)
   - **Version**: `1`
   - **Purpose**: "Anime file renaming and metadata lookup"
3. Wait for moderator approval (1-2 days)
4. Add credentials in Settings:
   ```json
   {
     "anidb_username": "your_anidb_username",
     "anidb_password": "your_anidb_password",
     "anidb_client_name": "mmprename",
     "anidb_client_version": "1"
   }
   ```

**How it works**: AniDB computes an ED2K hash of your file and looks it up in their database. This works even with terrible filenames because it identifies the exact file by content, not name. Rate-limited to 2.5s between requests to respect AniDB guidelines.

#### AniList (Anime Catalog)
**Provides series metadata for anime (no episode titles)**

1. Optional: Get an API key at [anilist.co/settings/developer](https://anilist.co/settings/developer)
2. Add to Settings:
   ```json
   {
     "anilist_api_key": "your_optional_anilist_key"
   }
   ```

**Note**: AniList does not provide episode titles. Use TVDB or TMDb alongside it for episode names.

#### TVDB v4 (TheTVDB)
**Series and episode metadata with localized titles**

1. Create an account at [thetvdb.com](https://thetvdb.com)
2. Get a v4 Project API Key from your [dashboard](https://thetvdb.com/dashboard)
3. Optional: Add User PIN if your project requires account-scoped access
4. Add to Settings:
   ```json
   {
     "tvdb_v4_api_key": "your_project_api_key",
     "tvdb_v4_user_pin": "optional_user_pin"
   }
   ```

**Automatic token refresh**: Tokens are managed server-side and refresh automatically.

#### TMDb (The Movie Database)
**General TV/Movie metadata provider**

1. Create an account at [themoviedb.org](https://www.themoviedb.org/signup)
2. Request an API key at [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api)
3. Add to Settings:
   ```json
   {
     "tmdb_api_key": "your_tmdb_api_key"
   }
   ```

#### Wikipedia & Kitsu
**Optional fallback providers for episode titles**

- **Wikipedia**: Automatically searches MediaWiki for episode lists when primary providers lack episode names
- **Kitsu**: Anime-focused API providing episode metadata for series not in AniDB/AniList
- **No API key required**: Both providers work out-of-the-box as fallbacks

These providers activate automatically when enabled in the provider order and primary lookups return incomplete data.

### Provider Priority Order

Drag-and-drop providers in the **Settings → Metadata & File Paths** section to set lookup order. Default order:

1. **AniDB** (ED2K hash, anime only)
2. **AniList** (anime catalog, no episode titles)
3. **TVDB** (series/episode metadata)
4. **TMDb** (general fallback)
5. **Wikipedia** (episode title fallback)
6. **Kitsu** (anime episode metadata)

The system tries each provider in order until a match is found. You can disable providers by removing them from the active slots.

### Input/Output Paths

| Setting | Description |
|---------|-------------|
| **Input Path** | Directory to scan for media files (e.g., `C:\Media\TV` or `/mnt/media/input`) |
| **Output Path** | Default destination for hardlinks (e.g., `D:\JellyfinMedia\TV` or `/mnt/media/output`) |
| **Alternative Output Folders** | Additional destinations selectable per-rename via UI modal |

**Critical for Docker users**: Mount the **parent directory** containing both input and output folders. See [Docker Hardlink Requirements](#-docker-deployment) for details.

### Rename Template Tokens

Customize filename format in **Settings → Metadata & File Paths**. Available tokens:

| Token | Description | Example |
|-------|-------------|---------|
| `{title}` | Series/movie title | `Attack on Titan` |
| `{basename}` | Original filename (no extension) | `aot_s01e01_720p` |
| `{year}` | Release year | `2013` |
| `{season}` | Season number (zero-padded) | `01` |
| `{episode}` | Episode number (zero-padded) | `05` |
| `{epLabel}` | Season/episode label | `S01E05` |
| `{episodeTitle}` | Episode name | `First Battle` |
| `{episodeRange}` | Multi-episode range | `01-03` |
| `{tmdbId}` | TMDb ID (if available) | `1429` |

**Default template**:  
```
{title} ({year}) - {epLabel} - {episodeTitle}
```

**Example output**:  
```
Attack on Titan (2013)/Season 01/Attack on Titan (2013) - S01E05 - First Battle.mkv
```

**Live preview** in Settings shows real-time rendering as you type.

---

## 🚀 Usage Guide

### Scanning Your Library

1. **Configure Input Path** in Settings (e.g., `C:\Media\Anime`)
2. Click **Scan** in the header to run a full library walk
3. Or click **Incremental Scan** to detect only new/changed files since last scan

**Folder Watching**: Optionally enable automatic background scans when files are added/modified (configured per-user in `data/users.json` → `scan_input_path`).

### Enriching Metadata

After scanning, the app automatically:
1. Parses filenames to extract series name, season, episode
2. Computes ED2K hash for anime files (if AniDB credentials configured)
3. Looks up metadata from configured providers in priority order
4. Caches results to `data/` for fast subsequent access

**Manual refresh**: Click the refresh icon on individual items or use **Refresh metadata** button to force provider re-lookup.

### Previewing & Applying Renames

1. **Review parsed items** in the main list—each shows:
   - Original path
   - Parsed/provider metadata
   - Source provider (e.g., "anidb-ed2k", "tmdb")
   - Season/episode info

2. **Select items**:
   - Click **Select** button to enter selection mode
   - Click items to toggle selection
   - **Shift+click** to select ranges
   - **Drag** across items to multi-select

3. **Approve selected**:
   - Click **Approve selected** (appears when items are selected)
   - Choose output folder from modal (if alternative folders configured)
   - Hardlinks are created instantly (no file copying)

4. **Hide unwanted items**: Click **Hide** on individual items or **Hide selected** to remove clutter

### Bulk Operations

| Action | Description |
|--------|-------------|
| **Approve selected** | Hardlink selected items to output folder |
| **Hide selected** | Mark items as hidden (won't appear in future scans) |
| **Rescan selected** | Force metadata refresh for selected items |

**Selection persistence**: Selections survive rescans—useful workflow is to select items, rescan them with fresh metadata, then immediately approve the updated results.

### Unapproving Items

If you need to undo a rename:

1. Go to **Settings → Metadata & File Paths**
2. Under **Unapprove recent applied items**, choose count (Last 1, 5, 10, 20, or All)
3. Click **Unapprove**

Unapproved items reappear in the main list for re-approval or editing.

### Hidden Items Management

Admins can review/unhide items:

1. Click **Hidden items** in header (admin only)
2. Browse hidden paths
3. Click **Unhide** to restore items to visible queue

---

## 📚 Advanced Features

### Server-Side Search

Search across large libraries without loading everything into memory:

1. Enter query in header search box
2. Click **Search** (supports regex patterns server-side)
3. Results stream efficiently even for 10,000+ item libraries

**Clear search**: Click **Clear** or click the app title to reset view.

### Alternative Output Folder Selection

Configure multiple destinations (e.g., separate anime and TV libraries):

1. **Settings → Metadata & File Paths → Alternative Output Folders**
2. Click **+ Add Output Folder**
3. Set name (e.g., "Anime Library") and path (e.g., `D:\Media\Anime`)
4. Click **Save**

When applying renames, a modal appears prompting you to choose the destination folder. Hardlinks are created to the selected path.

### Shift-Click Range Selection

1. Click **Select** to enter selection mode
2. Click first item
3. **Shift+click** last item in range
4. All items between are selected

Combine with **Rescan selected** to batch-refresh metadata, then **Approve selected** to apply in one go.

### Drag Selection

1. Enter select mode
2. Click and hold on an item
3. Drag mouse over additional items
4. Release to finalize selection

Useful for quickly selecting non-contiguous items or large blocks.

### Provider Order Customization

Drag providers in **Settings → Metadata providers** to control lookup order. For example, prioritize TMDb over TVDB for better movie metadata, or put AniDB first for anime-heavy libraries.

Inactive providers appear below active slotsâ€”click to re-add them to the chain.

### Logs & Diagnostics

**Server logs**: `data/logs.txt` contains timestamped events:
- `SCAN_START`, `SCAN_COMPLETE`: Library walk activity
- `ENRICH_REQUEST`, `ENRICH_SUCCESS`: Metadata lookups
- `HARDLINK_OK`, `HARDLINK_FAIL`: Rename operation outcomes
- `HARDLINK_CROSS_DEVICE`: Hardlink failed due to filesystem boundary

**Web UI logs panel**: Real-time log tail displayed in sidebar (click **Refresh** to update).

**Troubleshooting**:
- `HARDLINK_CROSS_DEVICE`: Input and output paths are on different filesystems—see [Docker Hardlink Requirements](#-docker-deployment)
- `ENRICH_ANIDB_RATE_LIMIT`: AniDB request throttled (normal behavior)
- `ENRICH_PROVIDER_FAIL`: Provider unreachable or API key invalid

### Data Directory Structure

```
data/
├── enrich-store.json       # Cached enrichment metadata
├── logs.txt                # Server event log
├── parsed-cache.json       # Filename parse results
├── rendered-index.json     # Rendered name index
├── scan-cache.json         # File scan cache (mtimes, sizes)
├── scans.db                # SQLite database (scans, enrichment)
├── scans.json              # Legacy scan storage (migrated to DB)
├── session.key             # Session signing key (auto-generated)
├── settings.json           # Server-wide settings
├── users.json              # User accounts and per-user settings
└── wiki-episode-cache.json # Wikipedia episode cache
```

**Important**: Do not commit `data/` to version control—it contains API keys and session secrets.

---

## 🧪 Testing & Development

### Run Tests

```bash
# All tests
npm test

# Specific test suites
npm run test:unit          # Core unit tests
npm run test:ed2k          # ED2K hash tests
npm run test:anidb         # AniDB provider tests
```

### Test Coverage

- ✅ ED2K hash computation (single/multi-chunk, boundary cases)
- ✅ AniDB UDP/HTTP responses, rate limiting
- ✅ TVDB episode title translation priority (english → romaji → native)
- ✅ Filename parsing edge cases
- ✅ Hardlink creation logic
- ✅ Enrichment cache normalization

### Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Run tests (`npm test`) and ensure they pass
4. Commit changes (`git commit -m 'Add amazing feature'`)
5. Push to branch (`git push origin feature/amazing-feature`)
6. Open a Pull Request

**Code style**: Follow existing patterns. ESLint/Prettier configs coming soon.

---

## 🔧 Troubleshooting

### Common Issues

#### "Hardlink failed: EXDEV (cross-device link not permitted)"

**Cause**: Input and output paths are on different filesystems. In Docker, this happens when you mount input and output folders separately—even if they're on the same physical disk, the kernel sees them as distinct mounts.

**Solution**:
- **Docker**: Mount the **parent directory** once (e.g., `/mnt/media` → `/media`) and use subpaths inside the container (`/media/input`, `/media/output`)
- **Host OS**: Ensure input and output are on the same drive/partition

See [Docker Hardlink Requirements](#-docker-deployment) for detailed examples.

#### "Authentication failed" (AniDB)

**Cause**: Invalid credentials or rate limit exceeded.

**Solution**:
- Verify username/password in Settings
- Check AniDB account is active
- Wait 24 hours if banned (should not happen with proper rate limiting—report as bug)

#### Items disappear after scanning

**Cause**: Items were previously hidden or applied.

**Solution**:
- Check **Hidden items** page (admin only) to unhide
- Or **Unapprove** recently applied items in Settings

#### Metadata not enriching

**Cause**: Missing API keys or network issues.

**Solution**:
- Verify API keys in Settings (click **Show** to reveal)
- Check `data/logs.txt` for `ENRICH_PROVIDER_FAIL` errors
- Test provider endpoints manually (see [API Documentation](#-api-reference))

#### Search returns no results

**Cause**: Query doesn't match any canonical paths.

**Solution**:
- Try broader search terms (e.g., part of series name)
- Use regex patterns if needed (e.g., `.*anime.*`)
- Click **Clear** to reset view

---

## 📖 API Reference

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/scan` | POST | Trigger full or incremental scan |
| `/api/scan/:id/items` | GET | Fetch scan results (paginated) |
| `/api/scan/:id/search` | GET | Search scan items by query |
| `/api/enrich` | POST/GET | Enrich metadata for a path |
| `/api/enrich/bulk` | POST | Bulk enrich multiple paths |
| `/api/rename/preview` | POST | Preview rename plan |
| `/api/rename/apply` | POST | Apply renames (create hardlinks) |
| `/api/rename/unapprove` | POST | Unapprove recent applied items |
| `/api/settings` | GET/POST | Retrieve/update settings |
| `/api/users` | GET/POST | User management (admin) |
| `/api/path/exists` | GET | Check if path exists on server |

### Example: Trigger Incremental Scan

```bash
curl -X POST http://localhost:5173/api/scan \
  -H "Content-Type: application/json" \
  -d '{
    "libraryId": "default",
    "mode": "incremental"
  }'
```

### Example: Search Scan Items

```bash
curl "http://localhost:5173/api/scan/<scan-id>/search?q=attack&offset=0&limit=50"
```

---

## 📄 Additional Documentation

- **[AniDB Integration Guide](ANIDB_INTEGRATION.md)**: Detailed AniDB setup, rate limiting, ED2K hashing
- **[AniDB Migration Guide](ANIDB_MIGRATION_GUIDE.md)**: Migrating from other systems to AniDB-based enrichment
- **[Implementation Summary](IMPLEMENTATION_SUMMARY.md)**: Technical deep-dive into AniDB integration
- **[Docker Guide](README-docker.md)**: Extended Docker deployment instructions

---

## 🙏 Credits

- **Built with**: Node.js, Express, React, Vite, react-window
- **Metadata Providers**: AniDB, AniList, TVDB, TMDb, Wikipedia
- **Contributors**: See [GitHub contributors](https://github.com/jt-ito/MMP-Renamer/graphs/contributors)

---

## 📜 License

MIT License - see [LICENSE](LICENSE) for details.

---

## 🆘 Support

- **Issues**: [GitHub Issues](https://github.com/jt-ito/MMP-Renamer/issues)
- **Discussions**: [GitHub Discussions](https://github.com/jt-ito/MMP-Renamer/discussions)
- **Logs**: Check `data/logs.txt` for diagnostic information

**Before opening an issue**, please:
1. Check existing issues/discussions
2. Include relevant log excerpts from `data/logs.txt`
3. Describe steps to reproduce
4. Mention your environment (OS, Docker version, Node version)

---

**Happy renaming! 🎬✨**
