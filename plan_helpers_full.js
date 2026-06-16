function getMaxFilenameLengthForOS(osKey) {
  const key = String(osKey || 'linux').toLowerCase();
  // Common max filename length per filesystem (component length in bytes)
  // Most filesystems have a 255-byte limit for the basename component.
  // Use conservative limits to account for UTF-8 multi-byte characters and filesystem overhead.
  // Windows/NTFS: 255 byte limit for basename. Use 200 to be safe with Unicode and path depth.
  if (key === 'windows') return 200;
  // macOS (APFS/HFS+): 255 UTF-8 bytes for basename
  if (key === 'mac' || key === 'macos' || key === 'darwin') return 240;
  // Linux (ext4/xfs/btrfs): 255 byte limit for basename
  return 240; // default for linux and unknown - conservative for UTF-8
}

function truncateFilenameComponent(name, maxLen) {
  if (!name) return name;
  const s = String(name);
  if (!maxLen || s.length <= maxLen) return s;
  
  // Try to intelligently truncate long episode titles while preserving key metadata
  // Pattern: "Series Title (Year) - S01E01 - Very Long Episode Title"
  // Goal: Keep "Series Title (Year) - S01E01" intact, truncate episode title
  const episodeLabelMatch = s.match(/^(.*?\s-\s(?:S\d{2})?E\d{1,3}(?:[SCTPO]\d+)?)\s-\s(.+)$/i);
  if (episodeLabelMatch) {
    const prefix = episodeLabelMatch[1]; // "Series Title (Year) - S01E01"
    const episodeTitle = episodeLabelMatch[2]; // "Very Long Episode Title"
    
    // If the prefix alone is under the limit, truncate only the episode title
    if (prefix.length < maxLen - 5) { // -5 for " - " + ellipsis
      const remainingLen = maxLen - prefix.length - 3; // -3 for " - "
      if (remainingLen > 10) { // Only if we have meaningful space for episode title
        const truncatedEpTitle = episodeTitle.slice(0, remainingLen - 1) + '…';
        return `${prefix} - ${truncatedEpTitle}`;
      }
    }
  }
  
  // Fallback: simple truncation with ellipsis
  const ell = '…';
  const keep = Math.max(1, maxLen - ell.length);
  return s.slice(0, keep) + ell;
}

// Centralized parsed item processing used by scans: parse filename, update parsedCache & enrichCache
function sanitizeMetadataProviderOrder(value) {
  try {
    if (value == null) return [...DEFAULT_METADATA_PROVIDER_ORDER];
    let arr = [];
    if (Array.isArray(value)) {
      arr = value;
    } else if (typeof value === 'string') {
      let parsed = null;
      try {
        parsed = JSON.parse(value);
      } catch (e) {
        parsed = null;
      }
      if (Array.isArray(parsed)) arr = parsed;
      else if (typeof parsed === 'string') arr = parsed.split(',');
      else arr = String(value).split(',');
    } else {
      arr = [];
    }
    const seen = new Set();
    const out = [];
    for (const raw of arr) {
      const id = String(raw || '').trim().toLowerCase();
      if (!id || !METADATA_PROVIDER_IDS.includes(id)) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out.length ? out : [...DEFAULT_METADATA_PROVIDER_ORDER];
  } catch (e) {
    return [...DEFAULT_METADATA_PROVIDER_ORDER];
  }
}

function resolveMetadataProviderOrder(username) {
  const tryLoad = (source) => {
    if (!source) return null;
    if (source.metadata_provider_order != null) return sanitizeMetadataProviderOrder(source.metadata_provider_order);
    if (source.default_meta_provider != null) return sanitizeMetadataProviderOrder([source.default_meta_provider]);
    return null;
  };
  try {
    if (username && users[username] && users[username].settings) {
      const userOrder = tryLoad(users[username].settings);
      if (userOrder && userOrder.length) return userOrder;
    }
    const serverOrder = tryLoad(serverSettings);
    if (serverOrder && serverOrder.length) return serverOrder;
  } catch (e) { /* ignore */ }
  return [...DEFAULT_METADATA_PROVIDER_ORDER];
}

function resolveTvdbCredentials(username, override) {
  const hasValue = (value) => value !== undefined && value !== null && String(value).trim().length > 0;
  const normalize = (value) => String(value || '').trim();

  const extract = (source) => {
    if (!source) return null;
    const apiKey = source.tvdb_v4_api_key ?? source.tvdbV4ApiKey ?? source.v4ApiKey;
    if (!hasValue(apiKey)) return null;
    const userPinRaw = source.tvdb_v4_user_pin ?? source.tvdbV4UserPin ?? source.v4UserPin ?? null;
    return {
      mode: 'v4',
      apiKey: normalize(apiKey),
      userPin: hasValue(userPinRaw) ? normalize(userPinRaw) : null
    };
  };

  try {
    const fromOverride = extract(override);
    if (fromOverride) return fromOverride;

    if (username && users[username] && users[username].settings) {
      const fromUser = extract(users[username].settings);
      if (fromUser) return fromUser;
    }

    const fromServer = extract(serverSettings);
    if (fromServer) return fromServer;
  } catch (e) { /* ignore */ }
  return null;
}

function doProcessParsedItem(it, session) {
  try {
    const parseFilename = require('./lib/filename-parser');
    const base = path.basename(it.canonicalPath, path.extname(it.canonicalPath));
    const key = canonicalize(it.canonicalPath);
    const prior = parsedCache[key] || null;
    let parsed = null;
    try {
      const guess = parseFilename(base);
      parsed = { title: guess.title, parsedName: guess.parsedName, season: guess.season, episode: guess.episode, episodeRange: guess.episodeRange || null, timestamp: Date.now() };
    } catch (parseErr) {
      if (prior) {
        parsed = Object.assign({}, prior, { timestamp: Date.now() });
      } else {
        throw parseErr;
      }
    }
    if (parsed) {
      const now = Date.now();
      parsed.timestamp = now;
      try {
        // Always render using latest parser output so rescans pick up improvements.
        const userTemplate = (session && session.username && users[session.username] && users[session.username].settings && users[session.username].settings.rename_template) ? users[session.username].settings.rename_template : null;
        const baseNameTemplate = userTemplate || serverSettings.rename_template || '{title} ({year}) - {epLabel} - {episodeTitle}';
        function pad(n){ return String(n).padStart(2,'0') }
        let parsedEpLabel = '';
        if (parsed.episodeRange) parsedEpLabel = parsed.season != null ? `S${pad(parsed.season)}E${parsed.episodeRange}` : `E${parsed.episodeRange}`
        else if (parsed.episode != null) parsedEpLabel = parsed.season != null ? `S${pad(parsed.season)}E${pad(parsed.episode)}` : `E${pad(parsed.episode)}`
        const titleToken = cleanTitleForRender(parsed.title || '', parsedEpLabel, '');
        const nameWithoutExtRaw = String(baseNameTemplate)
          .replace('{title}', sanitize(titleToken))
          .replace('{basename}', sanitize(path.basename(key, path.extname(key))))
          .replace('{year}', parsed.year || '')
          .replace('{epLabel}', sanitize(parsedEpLabel))
          .replace('{episodeTitle}', '')
          .replace('{season}', parsed.season != null ? String(parsed.season) : '')
          .replace('{episode}', parsed.episode != null ? String(parsed.episode) : '')
          .replace('{episodeRange}', parsed.episodeRange || '')
          .replace('{tmdbId}', '')
        let parsedRendered = String(nameWithoutExtRaw).replace(/\s{2,}/g, ' ').trim();
        try { parsedRendered = parsedRendered.replace(/\s*\(\s*\)\s*/g, '').replace(/\s*[-–—]\s*$/g, '').replace(/\s{2,}/g, ' ').trim(); } catch (e) {}
        const parsedBlock = { title: parsed.title, parsedName: parsedRendered, season: parsed.season, episode: parsed.episode, episodeRange: parsed.episodeRange || null, timestamp: now };
        parsedCache[key] = Object.assign({}, parsedCache[key] || {}, parsedBlock);
        // Preserve existing provider block if it exists (don't overwrite provider data during rescans)
        const existingProvider = (enrichCache[key] && enrichCache[key].provider) ? enrichCache[key].provider : null;
        const updatePayload = { parsed: parsedBlock, sourceId: 'parsed-cache', cachedAt: now };
        if (existingProvider) updatePayload.provider = existingProvider;
        updateEnrichCache(key, Object.assign({}, enrichCache[key] || {}, updatePayload));
      } catch (e) {
        // Preserve existing provider block even in error path
        const existingProvider = (enrichCache[key] && enrichCache[key].provider) ? enrichCache[key].provider : null;
        const fallbackPayload = { sourceId: 'local-parser', title: parsed.title, parsedName: parsed.parsedName, season: parsed.season, episode: parsed.episode, episodeRange: parsed.episodeRange || null, episodeTitle: '', language: 'en', timestamp: now };
        if (existingProvider) fallbackPayload.provider = existingProvider;
        updateEnrichCache(key, Object.assign({}, enrichCache[key] || {}, fallbackPayload));
      }
    }
  } catch (e) { appendLog(`PARSE_ITEM_FAIL path=${it && it.canonicalPath} err=${e && e.message ? e.message : String(e)}`) }
}

// Background enricher: enrich up to first N candidates, update caches and write progress
async function backgroundEnrichFirstN(scanId, enrichCandidates, session, libPath, lockKey, N = 12) {
  try {
    const first = (enrichCandidates && Array.isArray(enrichCandidates) ? enrichCandidates : (scans[scanId] && scans[scanId].items) || []).slice(0, N);
    const username = session && session.username;
    let tmdbKey = null;
    try { if (username && users[username] && users[username].settings && users[username].settings.tmdb_api_key) tmdbKey = users[username].settings.tmdb_api_key; else if (serverSettings && serverSettings.tmdb_api_key) tmdbKey = serverSettings.tmdb_api_key; } catch (e) { tmdbKey = null }
    const refreshProgressKey = `refreshScan:${scanId}`;
    try { refreshProgress[refreshProgressKey] = { processed: 0, total: first.length, lastUpdated: Date.now(), status: 'running' }; } catch (e) {}
    for (const it of first) {
      try {
        const key = canonicalize(it.canonicalPath);
        const existing = enrichCache[key] || null;
        const prov = existing && existing.provider ? existing.provider : null;
        if (isProviderComplete(prov)) { continue; }
        if (existing && existing.providerFailure) {
          try { appendLog(`BACKGROUND_ENRICH_SKIP_FAILURE path=${key}`); } catch (e) {}
          continue;
        }
        // If the user's provider order prefers AniDB first, force computing ED2K hash
        const _providerOrder = resolveMetadataProviderOrder(username);
        const _forceHashForAniDB = (_providerOrder && _providerOrder.length && _providerOrder[0] === 'anidb');
        const _opts = Object.assign({}, { username });
        if (_forceHashForAniDB) _opts.forceHash = true;
        const data = await externalEnrich(key, tmdbKey, _opts);
        if (!data) { continue; }
        try {
          const providerRendered = renderProviderName(data, key, session);
          const providerRaw = cloneProviderRaw(extractProviderRaw(data));
          const providerBlock = { 
            title: data.title, 
            year: data.year, 
            season: data.season, 
            episode: data.episode, 
            episodeTitle: data.episodeTitle || '', 
            raw: providerRaw, 
            renderedName: providerRendered, 
            matched: !!data.title,
            source: data.source || (data.provider && data.provider.source) || null,
            seriesTitleEnglish: data.seriesTitleEnglish || null,
            seriesTitleRomaji: data.seriesTitleRomaji || null,
            seriesTitleExact: data.seriesTitleExact || null,
            originalSeriesTitle: data.originalSeriesTitle || null
          };
          try { logMissingEpisodeTitleIfNeeded(key, providerBlock) } catch (e) {}
          // Merge entire data object to preserve seriesTitleEnglish, seriesTitleRomaji, etc.
          updateEnrichCache(key, Object.assign({}, enrichCache[key] || {}, data, { provider: providerBlock, sourceId: 'provider', cachedAt: Date.now() }));
        } catch (e) {
          updateEnrichCache(key, Object.assign({}, enrichCache[key] || {}, data, { sourceId: 'provider', cachedAt: Date.now() }));
        }
        try { if (db) db.setKV('enrichCache', enrichCache); else writeJson(enrichStoreFile, enrichCache); } catch (e) {}
        try { if (refreshProgress[refreshProgressKey]) { refreshProgress[refreshProgressKey].processed += 1; refreshProgress[refreshProgressKey].lastUpdated = Date.now(); } } catch (e) {}
      } catch (e) { appendLog(`BACKGROUND_ENRICH_FAIL path=${it && it.canonicalPath} err=${e && e.message ? e.message : String(e)}`); }
    }
    try { if (refreshProgress[refreshProgressKey]) { refreshProgress[refreshProgressKey].status = 'complete'; refreshProgress[refreshProgressKey].lastUpdated = Date.now(); } setTimeout(() => { try { delete refreshProgress[refreshProgressKey]; } catch (e) {} }, 30*1000) } catch (e) {}
    // release lock and persist scans after enrichment
    try { activeScans.delete(lockKey); appendLog(`SCAN_LOCK_RELEASED path=${libPath}`); } catch (e) {}
    try {
      const modified = [];
      const sids = Object.keys(scans || {});
      const _appliedSourcesBg = buildAppliedSourcesSet();
      for (const sid of sids) {
        try {
          const s = scans[sid];
          if (!s || !Array.isArray(s.items)) continue;
          const before = s.items.length;
          s.items = s.items.map(it => (it && it.canonicalPath) ? Object.assign({}, it) : it).filter(it => {
            try {
              const k = canonicalize(it.canonicalPath);
              if (isHiddenOrAppliedPath(k) || _appliedSourcesBg.has(k)) return false;
              try { it.enrichment = enrichCache[k] || null } catch (ee) { it.enrichment = null }
              return true;
            } catch (e) { return true }
          });
          if (s.items.length !== before) { s.totalCount = s.items.length; modified.push(sid); } else {
            let anySnapshot = false; for (const it of s.items) { try { if (it && it.enrichment) { anySnapshot = true; break } } catch (e) {} }
            if (anySnapshot) modified.push(sid);
          }
        } catch (e) {}
      }
  if (modified.length) { try { if (db) db.saveScansObject(scans); else writeJson(scanStoreFile, scans); appendLog(`POST_BACKGROUND_ENRICH_SCANS_UPDATED ids=${modified.join(',')}`) } catch (e) {} }
    // Notify clients that scans were updated so UI can reconcile without manual refresh
    try {
      if (modified && modified.length && Array.isArray(hideEvents)) {
        const evt = { ts: Date.now(), path: libPath || null, originalPath: libPath || null, modifiedScanIds: modified.map(String) };
        hideEvents.push(evt);
        try { if (db) db.setHideEvents(hideEvents); } catch (e) {}
        // keep recent events bounded
        if (hideEvents.length > 200) hideEvents.splice(0, hideEvents.length - 200);
        appendLog(`HIDE_EVENTS_PUSH_BY_BACKGROUND_ENRICH ids=${modified.join(',')}`);
      }
    } catch (e) {}
    } catch (e) {}
  } catch (e) { appendLog(`BACKGROUND_FIRSTN_ENRICH_FAIL scan=${scanId} err=${e && e.message ? e.message : String(e)}`); }
}

// Endpoint: list libraries (just a sample folder picker)
app.get('/api/libraries', requireAuth, (req, res) => {
  // Let user choose an existing folder under cwd or provide custom path via config later
  res.json([{ id: 'local', name: 'Local folder', canonicalPath: path.resolve('.') }]);
});

// New diagnostic endpoint: provider/meta status (TMDb/Kitsu)
app.get('/api/meta/status', requireAuth, (req, res) => {
  try {
    // check server and user keys (mask)
    const serverKey = serverSettings && serverSettings.tmdb_api_key ? String(serverSettings.tmdb_api_key) : null
    const serverAnilistKey = serverSettings && serverSettings.anilist_api_key ? String(serverSettings.anilist_api_key) : null
    const serverMask = serverKey ? (serverKey.slice(0,6) + '...' + serverKey.slice(-4)) : null
    let userKey = null
    let userAnilistKey = null
    let userTvdbV4 = false
    try {
      const u = req.session && req.session.username && users[req.session.username]
      if (u && u.settings && u.settings.tmdb_api_key) userKey = String(u.settings.tmdb_api_key)
      if (u && u.settings && u.settings.anilist_api_key) userAnilistKey = String(u.settings.anilist_api_key)
      if (u && u.settings) {
        userTvdbV4 = !!u.settings.tvdb_v4_api_key
      }
    } catch (e) {}
    const userMask = userKey ? (userKey.slice(0,6) + '...' + userKey.slice(-4)) : null
    const userAnilistMask = userAnilistKey ? (userAnilistKey.slice(0,6) + '...' + userAnilistKey.slice(-4)) : null
    const serverTvdbV4 = !!(serverSettings && serverSettings.tvdb_v4_api_key)
    const serverTvdbV4Mask = serverSettings && serverSettings.tvdb_v4_api_key ? (String(serverSettings.tvdb_v4_api_key).slice(0,6) + '...' + String(serverSettings.tvdb_v4_api_key).slice(-4)) : null
    let userTvdbV4MaskVal = null
    if (userTvdbV4) {
      try {
        const u = req.session && req.session.username && users[req.session.username]
        if (u && u.settings && u.settings.tvdb_v4_api_key) {
          const raw = String(u.settings.tvdb_v4_api_key)
          userTvdbV4MaskVal = raw.slice(0,6) + '...' + raw.slice(-4)
        }
      } catch (e) { userTvdbV4MaskVal = null }
    }
  // recent META_LOOKUP logs (TMDb attempts and lookup requests)
  let recent = ''
    const relevantTokens = ['META_LOOKUP_REQUEST', 'META_TMDB_SEARCH', 'META_TMDB_ATTEMPT', 'META_ANILIST_SEARCH', 'TVDB_']
    try {
      recent = fs.readFileSync(logsFile, 'utf8').split('\n').filter(l => {
        if (!l) return false
        for (const token of relevantTokens) if (l.indexOf(token) !== -1) return true
        return false
      }).slice(-200).join('\n')
    } catch (e) { recent = '' }
    res.json({
      serverKeyPresent: !!serverKey,
      userKeyPresent: !!userKey,
      serverKeyMask: serverMask,
      userKeyMask: userMask,
      serverAnilistPresent: !!serverAnilistKey,
      userAnilistPresent: !!userAnilistKey,
      serverAnilistMask: serverAnilistKey ? (serverAnilistKey.slice(0,6) + '...' + serverAnilistKey.slice(-4)) : null,
      userAnilistMask,
      serverTvdbV4Present: serverTvdbV4,
  userTvdbV4Present: userTvdbV4,
  serverTvdbV4Mask,
  userTvdbV4Mask: userTvdbV4MaskVal,
      logs: recent
    })
  } catch (e) { res.json({ error: e.message }) }
})

// Backwards compatible endpoint for older clients
app.get('/api/tmdb/status', (req, res) => {
  return app._router.handle(req, res, () => {}, 'GET', '/api/meta/status')
})

// Helper: returns true if a canonical path should be suppressed (hidden or applied).
// Checks enrichCache first; falls back to renderedIndex so items are hidden even
// when their enrichCache entry was lost by a previous sweep bug.
// Build a Set of source paths that appear in renderedIndex (i.e. have been applied/hardlinked).
// Called once per scan to avoid O(items * renderedIndex) iteration inside filter loops.
function buildAppliedSourcesSet() {
  const s = new Set();
  try {
    const rKeys = Object.keys(renderedIndex || {});
    for (const rk of rKeys) {
      const entry = renderedIndex[rk];
      if (entry && entry.source) s.add(canonicalize(entry.source));
    }
  } catch (e) {}
  return s;
}

// Fast single-item check using enrichCache only. For batch loops, call
// buildAppliedSourcesSet() first and check the Set inline for best performance.
function isHiddenOrAppliedPath(k) {
  try {
    const e = enrichCache[k] || null;
    return !!(e && (e.hidden || e.applied));
  } catch (e) { return false; }
}

// Trigger scan - performs full inventory then stores artifact
app.post('/api/scan', requireAuth, async (req, res) => {
  const { libraryId, path: libraryPath } = req.body || {};
  // Resolve chosen path in order: explicit request -> requesting user's per-user setting
  // Do NOT fallback to a global server setting here; admins are regular users with extra privileges
  let libPath = null;
  if (libraryPath) {
    libPath = path.resolve(libraryPath);
  } else if (req.session && req.session.username && users[req.session.username] && users[req.session.username].settings && users[req.session.username].settings.scan_input_path) {
    libPath = path.resolve(users[req.session.username].settings.scan_input_path);
  } else {
    return res.status(400).json({ error: 'library path required' });
  }
  // Validate chosen path: must exist, be a directory, and be readable.
  try {
    if (!fs.existsSync(libPath)) return res.status(400).json({ error: 'path does not exist', path: libPath });
    const st = fs.statSync(libPath);
    if (!st.isDirectory()) return res.status(400).json({ error: 'path is not a directory', path: libPath });
    try { fs.accessSync(libPath, fs.constants.R_OK); } catch (accErr) { return res.status(400).json({ error: 'path is not readable', path: libPath, detail: accErr.message }); }
  } catch (err) {
    appendLog(`SCAN_VALIDATION_ERROR path=${libPath} err=${err.message}`);
    return res.status(400).json({ error: 'invalid path', detail: err.message });
  }
  appendLog(`SCAN_START library=${libraryId || 'local'} path=${libPath}`);
  // perform filesystem walk synchronously but non-blocking via promises

  // directories to skip during scan to avoid crawling node_modules and VCS folders
  const IGNORED_DIRS = new Set(['node_modules', '.git', '.svn', '__pycache__']);
  const VIDEO_EXTS = ['mkv','mp4','avi','mov','m4v','mpg','mpeg','webm','wmv','flv','ts','ogg','ogv','3gp','3g2'];
  const extRe = new RegExp('\\.(' + VIDEO_EXTS.join('|') + ')$', 'i');

  function walkDir(dir) {
    let ent;
    try {
      ent = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      appendLog(`SCAN_DIR_SKIP dir=${dir} err=${e.message}`);
      return;
    }
    for (const e of ent) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        walkDir(full);
      } else {
        if (extRe.test(e.name)) {
          items.push({ id: uuidv4(), canonicalPath: canonicalize(full), scannedAt: Date.now() });
        }
      }
    }
  }

  // Delegate scan helpers to lib/scan.js
  const scanLib = require('./lib/scan');
  function loadScanCache() { return scanLib.loadScanCache(scanCacheFile); }
  function saveScanCache(obj) { return scanLib.saveScanCache(scanCacheFile, obj); }

  // Reusable per-item parsing + enrich-cache update logic (extracted from full scan flow)
  // Use central parsed-item processor (doProcessParsedItem)

  // Use scan library implementations
  function fullScanLibrary(libPath) { return scanLib.fullScanLibrary(libPath, { ignoredDirs: IGNORED_DIRS, videoExts: VIDEO_EXTS, canonicalize: canonicalize, uuidv4 }); }
  function incrementalScanLibrary(libPath) { return scanLib.incrementalScanLibrary(libPath, { scanCacheFile, ignoredDirs: IGNORED_DIRS, videoExts: VIDEO_EXTS, canonicalize: canonicalize, uuidv4 }); }

  let items = [];
  try {
    // Load prior scan cache to decide between full vs incremental scan
    const priorCache = loadScanCache();
    if (!priorCache || !priorCache.files || Object.keys(priorCache.files).length === 0) {
      // No prior cache - perform full scan to collect candidates
      try {
        items = fullScanLibrary(libPath);
      } catch (err) {
        appendLog(`SCAN_ERROR ${err.message}`);
        return res.status(500).json({ error: err.message });
      }
    } else {
      // We'll call incrementalScanLibrary later after acquiring lock; for now leave items empty
      items = [];
    }
  } catch (err) {
    appendLog(`SCAN_ERROR ${err && err.message ? err.message : String(err)}`);
    return res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
  // Prevent concurrent scans for the same resolved path
  const lockKey = `scanPath:${libPath}`;
  if (activeScans.has(lockKey)) {
    appendLog(`SCAN_CONFLICT path=${libPath}`);
    return res.status(409).json({ error: 'scan already in progress for this path' });
  }
  activeScans.add(lockKey);
  appendLog(`SCAN_LOCK_ACQUIRED path=${libPath}`);

  const scanId = uuidv4();
  // Run quick local parsing for each discovered item so the UI shows cleaned parsed names immediately
  let backgroundStarted = false;
  let incrementalNewItems = [];
  try {
    const session = req.session || {};
    const priorCache2 = loadScanCache();
    if (!priorCache2 || !priorCache2.files || Object.keys(priorCache2.files).length === 0) {
      // first full run - process everything
      for (const it of items) doProcessParsedItem(it, session);
      // build current cache map (files + dirs) and save
      const curFiles = {};
      const curDirs = {};
      for (const it of items) {
        try { const st = fs.statSync(it.canonicalPath); curFiles[it.canonicalPath] = st.mtimeMs; } catch (e) { curFiles[it.canonicalPath] = Date.now(); }
        try { const d = path.dirname(it.canonicalPath); const stD = fs.statSync(d); if (stD && stD.mtimeMs != null) curDirs[canonicalize(d)] = stD.mtimeMs; } catch (e) {}
      }
      // mark initial scan completion so subsequent runs can prefer incremental
      const cacheObj = { files: curFiles, dirs: curDirs, initialScanAt: Date.now() };
      saveScanCache(cacheObj);
      // ensure items includes canonicalPath/id entries for artifact
      // Filter out entries that are marked hidden or already applied (enrichCache + renderedIndex fallback)
      const _appliedSources1 = buildAppliedSourcesSet();
      items = items.map(it => ({ id: it.id || uuidv4(), canonicalPath: it.canonicalPath, scannedAt: it.scannedAt || Date.now() }))
        .filter(it => {
          try {
            const k = canonicalize(it.canonicalPath);
            return !isHiddenOrAppliedPath(k) && !_appliedSources1.has(k);
          } catch (e) { return true; }
        });
    } else {
      // incremental scan: optimized walk to detect new/changed files and removals
      const { toProcess, currentCache, removed } = incrementalScanLibrary(libPath);
      incrementalNewItems = Array.isArray(toProcess) ? toProcess.slice(0) : [];
      // If incremental scan returned currentCache but lacks initialScanAt, preserve prior marker if present
      try {
        const prior = loadScanCache();
        if (prior && prior.initialScanAt && currentCache && !currentCache.initialScanAt) currentCache.initialScanAt = prior.initialScanAt;
      } catch (e) {}
      // remove stale entries (but preserve enrichCache for applied/hidden items so they don't reappear)
      for (const r of (removed || [])) {
        try {
          const e = enrichCache[r] || null;
          // Keep enrichCache entry if item was applied or hidden (prevents reappearance)
          if (!e || (!e.applied && !e.hidden)) {
            delete enrichCache[r];
          }
          delete parsedCache[r];
        } catch (e) {}
      }
      // process new/changed items
      for (const it of (toProcess || [])) doProcessParsedItem(it, session);
      // persist current cache map (currentCache is { files, dirs })
      if (currentCache) saveScanCache(currentCache);
      // build items array for artifact from currentCache.files
      // Exclude items that are marked hidden or applied (enrichCache + renderedIndex fallback)
      const _appliedSources2 = buildAppliedSourcesSet();
      items = Object.keys((currentCache && currentCache.files) || {}).map(p => ({ id: uuidv4(), canonicalPath: p, scannedAt: Date.now() }))
        .filter(it => {
          try {
            const k = canonicalize(it.canonicalPath);
            return !isHiddenOrAppliedPath(k) && !_appliedSources2.has(k);
          } catch (e) { return true; }
        });
    }
    try { if (db) db.setKV('parsedCache', parsedCache); else writeJson(parsedCacheFile, parsedCache); } catch (e) {}
    try { if (db) db.setKV('enrichCache', enrichCache); else writeJson(enrichStoreFile, enrichCache); } catch (e) {}
  } catch (e) { appendLog(`PARSE_MODULE_FAIL err=${e.message}`); }
  // Wrap the remainder of the request flow so we can release the lock if something fails
  try {

    // Determine enrichment candidates: when doing incremental scans we only want to
    // refresh metadata for new/changed items (toProcess). For full scans, use the
    // artifact items as before.
    const enrichCandidates = (Array.isArray(incrementalNewItems) && incrementalNewItems.length) ? incrementalNewItems : items;
    const artifact = { id: scanId, libraryId: libraryId || 'local', totalCount: items.length, items, generatedAt: Date.now() };
    scans[scanId] = artifact;
    // Persist scans and prune older scan artifacts so we keep only the two most recent scans.
    try {
      // write current set first including the new artifact
      if (db) db.saveScansObject(scans); else writeJson(scanStoreFile, scans);
      // prune: keep only the most recent N scans (current + previous)
      const KEEP = 2;
      const allIds = Object.keys(scans || {});
      if (allIds.length > KEEP) {
        // sort ids by generatedAt desc (most recent first)
        const sorted = allIds.map(id => ({ id, ts: (scans[id] && scans[id].generatedAt) ? Number(scans[id].generatedAt) : 0 }))
          .sort((a, b) => b.ts - a.ts)
          .map(x => x.id);
        const toKeep = new Set(sorted.slice(0, KEEP));
        const toRemove = sorted.slice(KEEP);
        if (toRemove.length) {
          for (const rid of toRemove) {
            try { delete scans[rid]; } catch (e) {}
          }
        }
      }
    } catch (e) {
      try { appendLog(`SCAN_PERSIST_PRUNE_FAIL scan=${scanId} err=${e && e.message ? e.message : String(e)}`); } catch (ee) {}
    }
    appendLog(`SCAN_COMPLETE id=${scanId} total=${items.length}`);
    // Auto-sweep stale enrich cache entries after a scan completes
    try { const removed = sweepEnrichCache(); if (removed && removed.length) appendLog(`AUTOSWEEP_AFTER_SCAN removed=${removed.length}`); } catch (e) {}
    res.json({ scanId, totalCount: items.length });
    // Launch background enrichment (first N items) using centralized helper. Keep behavior identical.
    try {
      backgroundStarted = true;
      void backgroundEnrichFirstN(scanId, enrichCandidates, req.session, libPath, lockKey, 12);
    } catch (e) { appendLog(`BACKGROUND_FIRSTN_LAUNCH_FAIL scan=${scanId} err=${e && e.message ? e.message : String(e)}`); activeScans.delete(lockKey); appendLog(`SCAN_LOCK_RELEASED path=${libPath}`); }
  } catch (err) {
    try { appendLog(`SCAN_HANDLER_FAIL scan=${scanId} err=${err && err.message ? err.message : String(err)}`); } catch (e) {}
    try { if (!backgroundStarted) { activeScans.delete(lockKey); appendLog(`SCAN_LOCK_RELEASED path=${libPath}`); } } catch (ee) {}
    return res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});

// Lightweight incremental scan trigger: prefer incremental scan behavior and avoid
// performing a full walk when a prior cache exists. This endpoint is used by the
// client when it wants to resync current files (detect additions/removals/changes)
// without forcing a full main scan that can be expensive.
app.post('/api/scan/incremental', requireAuth, async (req, res) => {
  const { libraryId, path: libraryPath } = req.body || {};
  let libPath = null;
  if (libraryPath) libPath = path.resolve(libraryPath);
  else if (req.session && req.session.username && users[req.session.username] && users[req.session.username].settings && users[req.session.username].settings.scan_input_path) libPath = path.resolve(users[req.session.username].settings.scan_input_path);
  if (!libPath) return res.status(400).json({ error: 'library path required' });
  try {
    if (!fs.existsSync(libPath)) return res.status(400).json({ error: 'path does not exist', path: libPath });
    const st = fs.statSync(libPath);
    if (!st.isDirectory()) return res.status(400).json({ error: 'path is not a directory', path: libPath });
    try { fs.accessSync(libPath, fs.constants.R_OK); } catch (accErr) { return res.status(400).json({ error: 'path is not readable', path: libPath, detail: accErr.message }); }
  } catch (err) { appendLog(`SCAN_VALIDATION_ERROR path=${libPath} err=${err.message}`); return res.status(400).json({ error: 'invalid path', detail: err.message }); }

  appendLog(`INCREMENTAL_SCAN_START library=${libraryId || 'local'} path=${libPath}`);
  const scanLib = require('./lib/scan');
  function loadScanCache() { return scanLib.loadScanCache(scanCacheFile); }
  function saveScanCache(obj) { return scanLib.saveScanCache(scanCacheFile, obj); }

  // if no prior cache exists, fall back to full scan to collect candidates
  let items = [];
  try {
    let prior = loadScanCache();
    // If scan cache is missing but we have a prior saved scan artifact, bootstrap
    // a prior cache from the latest scan so incremental scanning can proceed
    // without doing a full filesystem walk.
    if ((!prior || !prior.files || Object.keys(prior.files).length === 0) && scans && Object.keys(scans || {}).length) {
      try {
        // pick the most recent scan by generatedAt
        const allIds = Object.keys(scans || {}).map(k => scans[k]).filter(Boolean);
        allIds.sort((a,b) => (b.generatedAt || 0) - (a.generatedAt || 0));
        const recent = allIds[0];
        if (recent && Array.isArray(recent.items) && recent.items.length) {
          const priorFiles = {};
          for (const it of recent.items) {
            try {
              const p = it.canonicalPath;
              const stat = fs.statSync(p);
              priorFiles[p] = { mtime: stat.mtimeMs || Date.now(), size: stat.size || 0, id: (it.id || (String(stat.size || 0) + ':' + String(Math.floor((stat.mtimeMs||Date.now()))))) };
            } catch (e) {
              // if stat fails, still include an entry with timestamp now so incremental can compare
              try { priorFiles[it.canonicalPath] = { mtime: Date.now(), size: 0, id: it.id || String(Math.random()).slice(2) } } catch (ee) {}
            }
          }
          prior = { files: priorFiles, dirs: {} };
          try { saveScanCache(prior); appendLog(`BOOTSTRAPPED_SCAN_CACHE from_scan=${recent.id} entries=${Object.keys(priorFiles).length}`); } catch (e) {}
        }
      } catch (e) { /* best-effort */ }
    }

    if (!prior || !prior.files || Object.keys(prior.files).length === 0) {
      // fallback to full scan if we couldn't bootstrap prior cache
      items = scanLib.fullScanLibrary(libPath, { ignoredDirs: new Set(['node_modules','.git','.svn','__pycache__']), videoExts: ['mkv','mp4','avi','mov','m4v','mpg','mpeg','webm','wmv','flv','ts','ogg','ogv','3gp','3g2'], canonicalize, uuidv4 });
    } else {
      const inc = scanLib.incrementalScanLibrary(libPath, { scanCacheFile, ignoredDirs: new Set(['node_modules','.git','.svn','__pycache__']), videoExts: ['mkv','mp4','avi','mov','m4v','mpg','mpeg','webm','wmv','flv','ts','ogg','ogv','3gp','3g2'], canonicalize, uuidv4 });
      // incremental returns { toProcess, currentCache, removed }
      const { toProcess, currentCache, removed } = inc || {};
      changedItems = Array.isArray(toProcess) ? toProcess.slice(0) : [];
      // remove stale entries (but preserve enrichCache for applied/hidden items)
      for (const r of (removed || [])) {
        try {
          const e = enrichCache[r] || null;
          // Keep enrichCache entry if item was applied or hidden (prevents reappearance)
          if (!e || (!e.applied && !e.hidden)) {
            delete enrichCache[r];
          }
          delete parsedCache[r];
        } catch (e) {}
      }
      // do minimal parsing for new/changed entries
      for (const it of (toProcess || [])) doProcessParsedItem(it, req.session || {});
      // persist new cache and build items array from currentCache, prioritizing fresh items first
      if (currentCache) saveScanCache(currentCache);
      items = scanLib.buildIncrementalItems(currentCache, toProcess, uuidv4);
    }
  } catch (e) {
    appendLog(`INCREMENTAL_SCAN_FAIL err=${e && e.message ? e.message : String(e)}`);
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }

  // proceed to create artifact and background enrich similar to /api/scan
  const scanId = uuidv4();
  // Filter out items that are marked hidden or applied (enrichCache + renderedIndex fallback)
  const _appliedSources3 = buildAppliedSourcesSet();
  const filteredItems = items.filter(it => {
    try {
      const k = canonicalize(it.canonicalPath);
      return !isHiddenOrAppliedPath(k) && !_appliedSources3.has(k);
    } catch (e) { return true; }
  });
  const artifact = { id: scanId, libraryId: libraryId || 'local', totalCount: filteredItems.length, items: filteredItems, generatedAt: Date.now() };
  scans[scanId] = artifact;
  try { if (db) db.saveScansObject(scans); else writeJson(scanStoreFile, scans); } catch (e) {}
  appendLog(`INCREMENTAL_SCAN_COMPLETE id=${scanId} total=${filteredItems.length} hidden_filtered=${items.length - filteredItems.length}`);
  // include a small sample of first-page items to help clients refresh UI without
  // requiring an extra request. Clients may pass a 'limit' query param when
  // invoking incremental scan; default to 100.
  const sampleLimit = Number.isInteger(parseInt(req.query && req.query.limit)) ? parseInt(req.query.limit) : 100;
  const sample = filteredItems.slice(0, sampleLimit);
  res.json({ scanId, totalCount: filteredItems.length, items: sample, changedPaths: (changedItems || []).map(it => it && it.canonicalPath).filter(Boolean) });
  // Don't enrich new items during incremental scans - they should only be parsed and hashed
  // Enrichment will happen when user manually requests it or during full scans
});

app.get('/api/scan/:scanId', requireAuth, (req, res) => { const s = scans[req.params.scanId]; if (!s) return res.status(404).json({ error: 'scan not found' }); res.json({ libraryId: s.libraryId, totalCount: s.totalCount, generatedAt: s.generatedAt }); });
app.get('/api/scan/:scanId/items', requireAuth, (req, res) => { 
  const s = scans[req.params.scanId]; 
  if (!s) return res.status(404).json({ error: 'scan not found' }); 
  
  // Build set of applied source paths from renderedIndex as a secondary check
  // (handles the case where enrichCache entries were lost by the old sweep bug)
  const appliedSources = new Set();
  try {
    for (const rk of Object.keys(renderedIndex || {})) {
      const re = renderedIndex[rk];
      if (re && re.source) appliedSources.add(canonicalize(re.source));
    }
  } catch (err) {}

  // Filter out applied/hidden items
  const filteredItems = (s.items || []).filter(it => {
    try {
      const k = canonicalize(it.canonicalPath);
      const e = enrichCache[k] || null;
      if (e && (e.hidden || e.applied)) return false;
      if (appliedSources.has(k)) return false;
      return true;
    } catch (err) { return true; }
  });
  
  const offset = parseInt(req.query.offset || '0', 10); 
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 500); 
  const slice = filteredItems.slice(offset, offset + limit); 
  res.json({ items: slice, offset, limit, total: filteredItems.length }); 
});

// Return the most recent scan artifact optionally filtered by libraryId. Useful when client lost lastScanId.
app.get('/api/scan/latest', requireAuth, (req, res) => {
  try {
    const lib = req.query.libraryId || null
    const all = Object.keys(scans || {}).map(k => scans[k]).filter(Boolean)
    let filtered = all
    if (lib) filtered = filtered.filter(s => s.libraryId === lib)
    if (!filtered.length) {
      const include = (req.query && (req.query.includeItems === '1' || req.query.includeItems === 'true'))
      if (include) return res.json({ scanId: null, libraryId: lib, totalCount: 0, generatedAt: null, items: [] })
      return res.json({ scanId: null, libraryId: lib, totalCount: 0, generatedAt: null })
    }
    filtered.sort((a,b) => (b.generatedAt || 0) - (a.generatedAt || 0))
    const pick = filtered[0]
    // Optionally include the first page of items when requested (clients can set includeItems=true)
    const include = (req.query && (req.query.includeItems === '1' || req.query.includeItems === 'true'))
    if (include) {
      const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 500)
      // Build set of applied source paths from renderedIndex as a secondary check
      const appliedSources = new Set();
      try {
        for (const rk of Object.keys(renderedIndex || {})) {
          const re = renderedIndex[rk];
          if (re && re.source) appliedSources.add(canonicalize(re.source));
        }
      } catch (err) {}
      // Filter out hidden/applied items at read time (same as /api/scan/:scanId/items)
      const visibleItems = (Array.isArray(pick.items) ? pick.items : []).filter(it => {
        try {
          const k = canonicalize(it.canonicalPath);
          const e = enrichCache[k] || null;
          if (e && (e.hidden || e.applied)) return false;
          if (appliedSources.has(k)) return false;
          return true;
        } catch (err) { return true; }
      })
      const items = visibleItems.slice(0, limit)
      return res.json({ scanId: pick.id, libraryId: pick.libraryId, totalCount: visibleItems.length, generatedAt: pick.generatedAt, items })
    }
    return res.json({ scanId: pick.id, libraryId: pick.libraryId, totalCount: pick.totalCount, generatedAt: pick.generatedAt })
  } catch (e) { return res.status(500).json({ error: e.message }) }
})

// Search items within a scan without returning all items (server-side filter)
app.get('/api/scan/:scanId/search', requireAuth, (req, res) => {
  try {
    const s = scans[req.params.scanId];
    if (!s) return res.status(404).json({ error: 'scan not found' });
    const q = (req.query.q || req.query.query || '').trim();
    const offset = parseInt(req.query.offset || '0', 10) || 0;
    const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 500);
    if (!q) return res.json({ items: [], offset, limit, total: 0 });
    const needle = String(q).toLowerCase();
    // Build set of applied source paths from renderedIndex as a secondary check
    const appliedSources = new Set();
    try {
      for (const rk of Object.keys(renderedIndex || {})) {
        const re = renderedIndex[rk];
        if (re && re.source) appliedSources.add(canonicalize(re.source));
      }
    } catch (err) {}
    // Pre-filter: exclude hidden/applied items before searching
    const visibleForSearch = (s.items || []).filter(it => {
      try {
        const k = canonicalize(it.canonicalPath);
        const e = enrichCache[k] || null;
        if (e && (e.hidden || e.applied)) return false;
        if (appliedSources.has(k)) return false;
        return true;
      } catch (err) { return true; }
    });
    // Filter on canonicalPath and basename to support filename searches
    // First pass: exact substring matches
    let matched = visibleForSearch.filter(it => {
      try {
        const p = String(it.canonicalPath || '').toLowerCase();
        const b = (it.canonicalPath || '').split(/[\\/]/).pop().toLowerCase();
        return p.indexOf(needle) !== -1 || b.indexOf(needle) !== -1;
      } catch (e) { return false }
    });

    // If no exact matches, perform fuzzy scoring on basenames and include close matches
    if (matched.length === 0) {
      // levenshtein distance helper
      function levenshtein(a, b) {
        if (!a || !b) return Math.max(a ? a.length : 0, b ? b.length : 0)
        const al = a.length, bl = b.length
        const dp = Array.from({ length: al + 1 }, (_, i) => Array(bl + 1).fill(0))
        for (let i = 0; i <= al; i++) dp[i][0] = i
        for (let j = 0; j <= bl; j++) dp[0][j] = j
        for (let i = 1; i <= al; i++) {
          for (let j = 1; j <= bl; j++) {
            const cost = a[i-1] === b[j-1] ? 0 : 1
            dp[i][j] = Math.min(dp[i-1][j] + 1, dp[i][j-1] + 1, dp[i-1][j-1] + cost)
          }
        }
        return dp[al][bl]
      }
      const scored = []
      for (const it of visibleForSearch) {
        try {
          const b = (it.canonicalPath || '').split(/[\\/]/).pop().toLowerCase();
          const dist = levenshtein(needle, b)
          // normalize distance by length; allow matches with normalized distance < 0.4
          const norm = dist / Math.max(needle.length, b.length, 1)
          if (norm <= 0.4) scored.push({ it, score: norm })
        } catch (e) {}
      }
      scored.sort((a,b) => a.score - b.score)
      matched = scored.map(s => s.it)
    }
    const total = matched.length;
    const slice = matched.slice(offset, offset + limit);
    // Attach cached enrichment to search results so client can render preview names immediately
    const enrichedSlice = slice.map(it => {
      const copy = { ...it };
      try {
        const key = canonicalize(copy.canonicalPath || '');
        const raw = enrichCache[key] || null;
        if (raw) {
          const normalized = normalizeEnrichEntry(raw);
          if (normalized) copy.enrichment = normalized;
        }
      } catch (e) {}
      return copy;
    });
    return res.json({ items: enrichedSlice, offset, limit, total });
  } catch (e) { return res.status(500).json({ error: e.message }) }
})

app.get('/api/enrich', requireAuth, (req, res) => {
  const { path: p } = req.query;
  const key = canonicalize(p || '');
  try {
    // If the underlying file no longer exists on disk, do not return cached enrichment
    try {
      if (key && !fs.existsSync(key)) {
        // Log and inform client that path is missing so UI can drop stale entries
        appendLog(`ENRICH_MISSING path=${key}`);
        return res.json({ cached: false, enrichment: null, missing: true });
      }
    } catch (e) { /* ignore fs errors and continue */ }
    const raw = enrichCache[key] || null;
    const normalized = normalizeEnrichEntry(raw);
    // If a provider block exists but is incomplete (e.g. missing renderedName or
    // missing episodeTitle for episode entries), treat it as not-cached so clients
    // will request an external lookup instead of assuming metadata is final.
    if (normalized) {
      const prov = normalized.provider || null;
      const providerComplete = prov && prov.matched && prov.renderedName && (prov.episode == null || (prov.episodeTitle && String(prov.episodeTitle).trim()));
      const enabled = Boolean(process.env.LOG_MISSING_EPISODE_TITLE) || (serverSettings && serverSettings.log_missing_episode_title);
      if (enabled && normalized.episode && !normalized.episodeTitle) {
        try {
          appendLog(`MISSING_EP_TITLE path=${key} providerTitle=${normalized.title || ''} season=${normalized.season || ''} episode=${normalized.episode || ''}`)
        } catch (e) {}
      }
      if (prov && !providerComplete) {
        return res.json({ cached: false, enrichment: cleanEnrichmentForClient(normalized) });
      }
      if (normalized.parsed || normalized.provider) return res.json({ cached: true, enrichment: cleanEnrichmentForClient(normalized) });
    }
    return res.json({ cached: false, enrichment: null });
  } catch (e) { return res.status(500).json({ error: e.message }) }
});

// Save per-item custom metadata overrides for items missing provider data
app.post('/api/enrich/custom', requireAuth, (req, res) => {
  try {
    const body = req.body || {}
    const key = canonicalize(body.path || '')
    console.log('[CUSTOM_META] Request:', { path: body.path, key, title: body.title })
    if (!key) return res.status(400).json({ error: 'path required' })

    const toNumber = (value) => {
      if (value === null || typeof value === 'undefined' || value === '') return null
      const n = Number(value)
      return Number.isFinite(n) ? n : null
    }

    const title = String(body.title || '').trim()
    const episodeTitleRaw = String(body.episodeTitle || '').trim()
    const yearRaw = String(body.year || '').trim()
    const isMovie = body.isMovie === true || String(body.isMovie || '').toLowerCase() === 'true'
    let season = toNumber(body.season)
    let episode = toNumber(body.episode)
    let episodeTitle = episodeTitleRaw

    if (!title) return res.status(400).json({ error: 'title required' })

    if (isMovie) {
      season = null
      episode = null
      episodeTitle = ''
    }

    const extraGuess = {
      title,
      episodeTitle: episodeTitle || '',
      season,
      episode,
      year: yearRaw || null,
      isMovie
    }
    if (isMovie) extraGuess.mediaFormat = 'MOVIE'

    const cleanExtra = sanitizeExtraGuess(extraGuess, null)
    if (!cleanExtra) return res.status(400).json({ error: 'invalid metadata' })

    const existing = enrichCache[key] || {}
    const data = Object.assign({}, existing, cleanExtra)
    data.title = cleanExtra.title || existing.title || null
    data.year = cleanExtra.year || existing.year || null
    data.season = (cleanExtra.season != null) ? cleanExtra.season : (existing.season ?? null)
    data.episode = (cleanExtra.episode != null) ? cleanExtra.episode : (existing.episode ?? null)
    data.episodeTitle = (cleanExtra.episodeTitle != null) ? cleanExtra.episodeTitle : (existing.episodeTitle || '')
    data.isMovie = (typeof cleanExtra.isMovie === 'boolean') ? cleanExtra.isMovie : existing.isMovie

    const providerRendered = renderCustomMetadataName(data, req.session)
    console.log('[CUSTOM_META] Rendered name:', providerRendered)
    const providerBlock = {
      title: data.title,
      year: data.year,
      season: data.season,
      episode: data.episode,
      episodeTitle: data.episodeTitle || '',
      raw: null,
      renderedName: providerRendered,
      matched: !!data.title,
      source: 'custom',
      seriesTitleEnglish: data.seriesTitleEnglish || null,
      seriesTitleRomaji: data.seriesTitleRomaji || null,
      seriesTitleExact: data.seriesTitleExact || null,
      originalSeriesTitle: data.originalSeriesTitle || null
    }

    const updated = updateEnrichCache(key, Object.assign({}, existing, data, {
      extraGuess: cleanExtra,
      provider: providerBlock,
      sourceId: 'custom',
      cachedAt: Date.now()
    }))

    console.log('[CUSTOM_META] Updated cache, has renderedName:', !!updated?.provider?.renderedName, 'source:', updated?.provider?.source)
    // For custom metadata, keep renderedName in response so UI can display it immediately
    // Add cache buster to force client to process the update
    const response = { ok: true, enrichment: updated, _cacheBuster: Date.now() }
    console.log('[CUSTOM_META] Sending response with renderedName:', response.enrichment?.provider?.renderedName)
    return res.json(response)
  } catch (e) {
    console.error('[CUSTOM_META] Error:', e)
    return res.status(500).json({ error: e.message })
  }
})

// Lookup enrichment by rendered metadata filename (without extension)
app.get('/api/enrich/by-rendered', requireAuth, (req, res) => {
  try {
    const name = req.query.name || ''
    if (!name) return res.status(400).json({ error: 'name required' })
    const target = renderedIndex[name]
    if (!target) return res.json({ found: false })
    const e = enrichCache[target] || null
    if (!e) return res.json({ found: false })
    return res.json({ found: true, path: target, enrichment: e })
  } catch (e) { return res.status(500).json({ error: e.message }) }
})

// Bulk enrich lookup to reduce per-file GET traffic from the client during scan refreshes
app.post('/api/enrich/bulk', requireAuth, (req, res) => {
  try {
    const paths = Array.isArray(req.body && req.body.paths) ? req.body.paths : null
    if (!paths) return res.status(400).json({ error: 'paths array required' })
    const out = []
    for (const p of paths) {
      try {
        const key = canonicalize(p || '')
        const raw = enrichCache[key] || null
        const normalized = normalizeEnrichEntry(raw)
        // If provider block exists but incomplete, mark as not-cached so clients will fetch externally
        if (normalized) {
          const prov = normalized.provider || null
          const providerComplete = prov && prov.matched && prov.renderedName && (prov.episode == null || (prov.episodeTitle && String(prov.episodeTitle).trim()))
          if (prov && !providerComplete) {
            out.push({ path: p, cached: false, enrichment: normalized })
            continue
          }
          if (normalized.parsed || normalized.provider) { out.push({ path: p, cached: true, enrichment: normalized }); continue }
        }
        out.push({ path: p, cached: false, enrichment: null })
      } catch (e) { out.push({ path: p, error: e.message }) }
    }
    return res.json({ items: out })
  } catch (e) { return res.status(500).json({ error: e && e.message ? e.message : String(e) }) }
})

app.get('/api/csrf-token', (req, res) => {
  try {
    const token = res.locals && res.locals.csrfToken ? res.locals.csrfToken : (typeof req.csrfToken === 'function' ? req.csrfToken() : null);
    return res.json({ ok: true, token });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

app.get('/api/settings', requireAuth, (req, res) => {
  const userSettings = (req.session && req.session.username && users[req.session.username] && users[req.session.username].settings) ? users[req.session.username].settings : {};
  const serverOut = { ...(serverSettings || {}) };
  serverOut.delete_hardlinks_on_unapprove = resolveDeleteHardlinksSetting(req.session && req.session.username ? req.session.username : null);
  return res.json({ serverSettings: serverOut, userSettings });
});
// Diagnostic: expose current session and user presence to help debug auth issues (no secrets)
app.get('/api/debug/session', requireAuth, (req, res) => {
  try {
    const session = req.session || null;
    const username = session && session.username ? session.username : null;
    const userExists = username && users && users[username] ? true : false;
    const usersCount = users ? Object.keys(users).length : 0;
    // Do not leak password hashes; only surface counts and whether the user exists
    return res.json({ session, username, userExists, usersCount });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});


// Simple login endpoint used by the web client. Sets req.session.username on success.
app.post('/api/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username) return res.status(400).json({ error: 'username required' });
    const user = users[username];
    if (!user) return res.status(401).json({ error: 'invalid credentials' });
    // If no passwordHash is configured, allow login with empty password (bootstrap convenience)
    if (!user.passwordHash) {
      if (password && String(password).length) return res.status(401).json({ error: 'invalid credentials' });
      req.session.username = username;
      return res.json({ ok: true, username });
    }
    // compare hashed password
    bcrypt.compare(String(password || ''), String(user.passwordHash || ''), (err, same) => {
      if (err) return res.status(500).json({ error: 'compare error' });
      if (!same) return res.status(401).json({ error: 'invalid credentials' });
      req.session.username = username;
      return res.json({ ok: true, username });
    });
  } catch (e) { return res.status(500).json({ error: e && e.message ? e.message : String(e) }); }
});
app.post('/api/settings', requireAuth, (req, res) => {
  const body = req.body || {};
  const username = req.session && req.session.username;
  try {
    // if admin requested global update
    if (username && users[username] && users[username].role === 'admin' && body.global) {
      // Admins may set global server settings, but not a global scan_input_path (per-user only)
  const allowed = ['tmdb_api_key', 'anilist_api_key', 'anidb_username', 'anidb_password', 'anidb_client_name', 'anidb_client_version', 'scan_output_path', 'rename_template', 'default_meta_provider', 'metadata_provider_order', 'tvdb_v4_api_key', 'tvdb_v4_user_pin', 'output_folders', 'delete_hardlinks_on_unapprove', 'client_os', 'log_timezone'];
      for (const k of allowed) {
        if (body[k] === undefined) continue;
        if (k === 'metadata_provider_order') {
          const order = sanitizeMetadataProviderOrder(body[k]);
          serverSettings.metadata_provider_order = order;
          if (!body.default_meta_provider && order.length) {
            serverSettings.default_meta_provider = order[0];
          }
        } else if (k === 'default_meta_provider') {
          const first = String(body[k] || '').trim() || 'tmdb';
          serverSettings.default_meta_provider = first;
        } else if (k === 'output_folders') {
          serverSettings.output_folders = Array.isArray(body[k]) ? body[k] : [];
        } else if (k === 'delete_hardlinks_on_unapprove') {
          serverSettings.delete_hardlinks_on_unapprove = coerceBoolean(body[k]);
        } else {
          serverSettings[k] = body[k];
        }
      }
      if (!serverSettings.metadata_provider_order || !serverSettings.metadata_provider_order.length) {
        serverSettings.metadata_provider_order = sanitizeMetadataProviderOrder(serverSettings.metadata_provider_order);
      }
      if (!serverSettings.default_meta_provider && serverSettings.metadata_provider_order.length) {
        serverSettings.default_meta_provider = serverSettings.metadata_provider_order[0];
      }
      writeJson(settingsFile, serverSettings);
      appendLog(`SETTINGS_SAVED_GLOBAL by=${username} keys=${Object.keys(body).join(',')}`);
      return res.json({ ok: true, settings: serverSettings });
    }

    // otherwise save per-user
    if (!username) return res.status(401).json({ error: 'unauthenticated' });
    users[username] = users[username] || {};
    users[username].settings = users[username].settings || {};
  const allowed = ['tmdb_api_key', 'anilist_api_key', 'anidb_username', 'anidb_password', 'anidb_client_name', 'anidb_client_version', 'scan_input_path', 'scan_output_path', 'rename_template', 'default_meta_provider', 'metadata_provider_order', 'tvdb_v4_api_key', 'tvdb_v4_user_pin', 'output_folders', 'enable_folder_watch', 'delete_hardlinks_on_unapprove', 'client_os', 'log_timezone'];
    
    // Check if scan_input_path changed to update watcher
    const oldScanPath = users[username].settings.scan_input_path;
    const newScanPath = body.scan_input_path;
    const oldWatchEnabled = coerceBoolean(users[username].settings.enable_folder_watch);
    let newWatchEnabled = oldWatchEnabled;
    let watchProvided = false;
    
    for (const k of allowed) {
      if (body[k] === undefined) continue;
      if (k === 'metadata_provider_order') {
        const order = sanitizeMetadataProviderOrder(body[k]);
        users[username].settings.metadata_provider_order = order;
        if (!body.default_meta_provider && order.length) users[username].settings.default_meta_provider = order[0];
      } else if (k === 'default_meta_provider') {
        const first = String(body[k] || '').trim() || 'tmdb';
        users[username].settings.default_meta_provider = first;
      } else if (k === 'output_folders') {
        users[username].settings.output_folders = Array.isArray(body[k]) ? body[k] : [];
      } else if (k === 'enable_folder_watch') {
        watchProvided = true;
        const normalized = coerceBoolean(body[k]);
        users[username].settings.enable_folder_watch = normalized;
        newWatchEnabled = normalized;
      } else if (k === 'delete_hardlinks_on_unapprove') {
        users[username].settings.delete_hardlinks_on_unapprove = coerceBoolean(body[k]);
      } else {
        users[username].settings[k] = body[k];
      }
    }
    if (!users[username].settings.metadata_provider_order || !users[username].settings.metadata_provider_order.length) {
      users[username].settings.metadata_provider_order = sanitizeMetadataProviderOrder(users[username].settings.metadata_provider_order);
    }
    if (!users[username].settings.default_meta_provider && users[username].settings.metadata_provider_order.length) {
      users[username].settings.default_meta_provider = users[username].settings.metadata_provider_order[0];
    }
    writeJson(usersFile, users);
    appendLog(`SETTINGS_SAVED_USER user=${username} keys=${Object.keys(body).join(',')}`);
    
    const pathChanged = newScanPath !== undefined && newScanPath !== oldScanPath;
    const watchToggled = watchProvided && newWatchEnabled !== oldWatchEnabled;
    if (pathChanged || watchToggled) {
      stopFolderWatcher(username);
      const finalPath = users[username].settings.scan_input_path;
      if (newWatchEnabled && finalPath) {
        const libPath = path.resolve(finalPath);
        startFolderWatcher(username, libPath);
      }
    }
    
    return res.json({ ok: true, userSettings: users[username].settings });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// Get manual provider IDs
app.get('/api/manual-ids', requireAuth, (req, res) => {
  try {
    return res.json({ manualIds });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});



// Admin endpoint: force next scan to be full by clearing scan cache
app.post('/api/scan/force', requireAdmin, (req, res) => {
  try {
    // remove scan cache file so next /api/scan will perform a full walk
    try { if (fs.existsSync(scanCacheFile)) fs.unlinkSync(scanCacheFile); } catch (e) { appendLog(`SCAN_FORCE_UNLINK_FAIL err=${e && e.message ? e.message : String(e)}`); }
    appendLog(`SCAN_FORCE_CLEARED by=${req.session && req.session.username ? req.session.username : '<unknown>'}`);
    return res.json({ ok: true, forced: true });
  } catch (e) { return res.status(500).json({ error: e.message }) }
});

// Path existence check (used by the client to validate configured paths)
app.get('/api/path/exists', requireAuth, (req, res) => { const p = req.query.path || ''; try { const rp = path.resolve(p); const exists = fs.existsSync(rp); const stat = exists ? fs.statSync(rp) : null; res.json({ exists, isDirectory: stat ? stat.isDirectory() : false, resolved: rp }); } catch (err) { res.json({ exists: false, isDirectory: false, error: err.message }); } });

app.post('/api/enrich', requireAuth, async (req, res) => {
  const { path: p, tmdb_api_key: tmdb_override, force, forceHash, tvdb_v4_api_key: tvdb_override_v4_api_key, tvdb_v4_user_pin: tvdb_override_v4_user_pin, skipAnimeProviders } = req.body;
  const key = canonicalize(p || '');
  appendLog(`ENRICH_REQUEST path=${key} force=${force ? 'yes' : 'no'} forceHash=${forceHash ? 'yes' : 'no'} skipAnimeProviders=${skipAnimeProviders ? 'yes' : 'no'}`);
  try {
    // On forced rescan, clear cached enrich/parsed/rendered entries while preserving applied/hidden flags
    if (force) {
      purgeCachesForPath(key, { preserveFlags: true, persist: true });
    }
    // prefer existing enrichment when present and not forcing
    // Only short-circuit to cached provider if it appears to be a complete provider hit
    // (i.e. provider.matched and provider.renderedName present). Additionally, when the
    // provider indicates an episode (season/episode present), require provider.episodeTitle
    // to be present as well so rescans will attempt to fetch missing episode metadata.
    const existingEarly = enrichCache[key] || null;
    const provEarly = existingEarly && existingEarly.provider ? existingEarly.provider : null;
    const providerCompleteEarly = provEarly && provEarly.matched && provEarly.renderedName && (provEarly.episode == null || (provEarly.episodeTitle && String(provEarly.episodeTitle).trim()));
    if (!force && providerCompleteEarly) {
      return res.json({ enrichment: enrichCache[key] });
    }
    if (!force && existingEarly && existingEarly.providerFailure) {
      try { appendLog(`ENRICH_REQUEST_SKIP_FAILURE path=${key}`); } catch (e) {}
      return res.json({ enrichment: existingEarly });
    }
    // Resolve an effective provider key early so we can decide whether to short-circuit to parsed-only
  let tmdbKeyEarly = null
    try {
  if (tmdb_override) tmdbKeyEarly = tmdb_override;
  else if (req.session && req.session.username && users[req.session.username] && users[req.session.username].settings && users[req.session.username].settings.tmdb_api_key) tmdbKeyEarly = users[req.session.username].settings.tmdb_api_key;
  else if (serverSettings && serverSettings.tmdb_api_key) tmdbKeyEarly = serverSettings.tmdb_api_key;
    } catch (e) { tmdbKeyEarly = null }

    // Masked diagnostic: did we resolve a TMDb key for this request?
    try { appendLog(`TMDB_KEY_RESOLVED usingKey=${tmdbKeyEarly ? 'yes' : 'no'}`) } catch (e) {}

    // If we have a parsedCache entry and not forcing a provider refresh, return a lightweight enrichment
    // Check if we already have complete provider data - if so, use it even if TMDb key is present
    // This prevents losing provider metadata (e.g., AniDB) when TMDb is also configured
    const existingEnrichEarly = enrichCache[key] || null;
    const hasCompleteProvider = existingEnrichEarly && existingEnrichEarly.provider && existingEnrichEarly.provider.renderedName;
    
  if (!force && parsedCache[key] && (!tmdbKeyEarly || hasCompleteProvider)) {
      const pc = parsedCache[key]
      const epTitle = (enrichCache[key] && enrichCache[key].provider && enrichCache[key].provider.episodeTitle) ? enrichCache[key].provider.episodeTitle : ''
      // build normalized entry - preserve existing provider block if it has a renderedName (preview)
      const parsedBlock = { title: pc.title, parsedName: pc.parsedName, season: pc.season, episode: pc.episode, timestamp: Date.now() }
      const existingProvider = (enrichCache[key] && enrichCache[key].provider) ? enrichCache[key].provider : null
      // If provider block exists and has renderedName, use the provider's parsedName instead of raw parsed
      const effectiveParsedBlock = (existingProvider && existingProvider.renderedName && existingProvider.parsedName) 
        ? { title: existingProvider.title || pc.title, parsedName: existingProvider.parsedName, season: existingProvider.season != null ? existingProvider.season : pc.season, episode: existingProvider.episode != null ? existingProvider.episode : pc.episode, timestamp: Date.now() }
        : parsedBlock
      const providerBlock = existingProvider
  const normalized = normalizeEnrichEntry(Object.assign({}, enrichCache[key] || {}, { parsed: effectiveParsedBlock, provider: providerBlock, sourceId: 'parsed-cache', cachedAt: Date.now() }));
  updateEnrichCache(key, normalized);
  try { if (db) db.setKV('enrichCache', enrichCache); else writeJson(enrichStoreFile, enrichCache); } catch (e) {}
      return res.json({ enrichment: enrichCache[key] })
    }

    // otherwise perform authoritative external enrich (used by rescan/force)
    let tmdbKey = null
    try {
      if (tmdb_override) tmdbKey = tmdb_override;
      else if (req.session && req.session.username && users[req.session.username] && users[req.session.username].settings && users[req.session.username].settings.tmdb_api_key) tmdbKey = users[req.session.username].settings.tmdb_api_key;
      else if (serverSettings && serverSettings.tmdb_api_key) tmdbKey = serverSettings.tmdb_api_key;
    } catch (e) { tmdbKey = null }
    const tvdbOverride = (tvdb_override_v4_api_key || tvdb_override_v4_user_pin)
      ? { v4ApiKey: tvdb_override_v4_api_key || '', v4UserPin: tvdb_override_v4_user_pin || null }
      : null;
    // Wrap externalEnrich in a 50s timeout so the response always arrives before
    // a reverse-proxy gateway timeout (typically 60s). The enrichment continues in
    // the background and the updated cache can be fetched via GET /api/enrich later.
    const ENRICH_HANDLER_TIMEOUT_MS = 50000;
    let enrichHandlerDone = false;
    const enrichHandlerPromise = (async () => {
      const data = await externalEnrich(key, tmdbKey, { username: req.session && req.session.username, tvdbOverride, forceHash, force, skipAnimeProviders });
      // Use centralized renderer and updater so rendering logic is consistent
      try {
        if (data && data.title) {
          const providerRendered = renderProviderName(data, key, req.session);
          const providerRaw = cloneProviderRaw(extractProviderRaw(data));
          const providerBlock = { 
            title: data.title, 
            year: data.year, 
            season: data.season, 
            episode: data.episode, 
            episodeTitle: data.episodeTitle || '', 
            raw: providerRaw, 
            renderedName: providerRendered, 
            matched: !!data.title,
            source: data.source || (data.provider && data.provider.source) || null,
            seriesTitleEnglish: data.seriesTitleEnglish || null,
            seriesTitleRomaji: data.seriesTitleRomaji || null,
            seriesTitleExact: data.seriesTitleExact || null,
            originalSeriesTitle: data.originalSeriesTitle || null
          };
          try { logMissingEpisodeTitleIfNeeded(key, providerBlock) } catch (e) {}
          updateEnrichCache(key, Object.assign({}, data, { provider: providerBlock, sourceId: 'provider', cachedAt: Date.now() }));
        } else {
          updateEnrichCache(key, Object.assign({}, data, { cachedAt: Date.now() }));
        }
      } catch (e) {
        updateEnrichCache(key, Object.assign({}, data, { cachedAt: Date.now() }));
      }
      // if provider returned authoritative title/parsedName, persist into parsedCache
      try {
        if (data && data.title) {
          parsedCache[key] = parsedCache[key] || {}
          parsedCache[key].title = data.title
          parsedCache[key].parsedName = data.parsedName || parsedCache[key].parsedName
          parsedCache[key].season = data.season != null ? data.season : parsedCache[key].season
          parsedCache[key].episode = data.episode != null ? data.episode : parsedCache[key].episode
          parsedCache[key].timestamp = Date.now()
          try { if (db) db.setKV('parsedCache', parsedCache); else writeJson(parsedCacheFile, parsedCache); } catch (e) {}
        }
      } catch (e) {
        updateEnrichCache(key, Object.assign({}, enrichCache[key] || {}, data, { cachedAt: Date.now(), sourceId: 'provider' }));
      }
      enrichHandlerDone = true;
      return enrichCache[key];
    })();
    const enrichHandlerTimeout = new Promise(resolve => setTimeout(() => resolve('__timeout__'), ENRICH_HANDLER_TIMEOUT_MS));
    const handlerResult = await Promise.race([enrichHandlerPromise, enrichHandlerTimeout]);
    if (handlerResult === '__timeout__') {
      // Enrichment is still running in background — respond immediately with whatever
      // is currently cached (avoids 504 gateway timeout from reverse proxy).
      appendLog(`ENRICH_BACKGROUND_TIMEOUT path=${key} returning_cached=${!!enrichCache[key]}`);
      return res.json({ enrichment: enrichCache[key] || null, background: true });
    }
    res.json({ enrichment: enrichCache[key] });
  } catch (err) { appendLog(`ENRICH_FAIL path=${key} err=${err.message}`); res.status(500).json({ error: err.message }); }
});

// Hide a source item (mark hidden=true on the source canonical key)
app.post('/api/enrich/hide', requireAuth, async (req, res) => {
  try {
    const p = req.body && req.body.path ? req.body.path : null
    if (!p) return res.status(400).json({ error: 'path required' })
  const key = canonicalize(p)
  // Update cache and persist immediately so changes survive browser close
  try {
    enrichCache[key] = enrichCache[key] || {};
    enrichCache[key].hidden = true;
    // Persist immediately instead of debouncing
    try { if (db) db.setKV('enrichCache', enrichCache); else writeJson(enrichStoreFile, enrichCache); } catch (e) { appendLog(`HIDE_PERSIST_FAIL path=${p} err=${e && e.message ? e.message : String(e)}`) }
  } catch (e) { appendLog(`HIDE_UPDATE_FAIL path=${p} err=${e && e.message ? e.message : String(e)}`) }

  // respond immediately to the client so UI hides instantly
  res.json({ ok: true, path: key, enrichment: enrichCache[key] || null, modifiedScanIds: [] });

  // Background: remove this path from stored scan artifacts and record hide event
  (async () => {
    try {
      const modifiedScanIds = [];
      try {
        const scanIds = Object.keys(scans || {});
        for (const sid of scanIds) {
          try {
            const s = scans[sid];
            if (!s || !Array.isArray(s.items)) continue;
            const before = s.items.length;
            s.items = s.items.filter(it => {
              try { return canonicalize(it.canonicalPath) !== key } catch (e) { return true }
            });
            if (s.items.length !== before) {
              s.totalCount = s.items.length;
              modifiedScanIds.push(sid);
            }
          } catch (e) {}
        }
        // persist updated scans store if any modified
        if (modifiedScanIds.length) {
          try { if (db) db.saveScansObject(scans); else writeJson(scanStoreFile, scans); appendLog(`HIDE_UPDATED_SCANS path=${p} ids=${modifiedScanIds.join(',')}`) } catch (e) {}
        }
      } catch (e) {}

      appendLog(`HIDE path=${p}`)
      try {
        // Record hide event for clients to poll and reconcile UI
        hideEvents.push({ ts: Date.now(), path: key, originalPath: p, modifiedScanIds });
        try { if (db) db.setHideEvents(hideEvents); } catch (e) {}
        // keep recent events bounded
        if (hideEvents.length > 200) hideEvents.splice(0, hideEvents.length - 200);
      } catch (e) {}
    } catch (e) {
      appendLog(`HIDE_BG_FAIL path=${p} err=${e && e.message ? e.message : String(e)}`)
    }
  })();
  } catch (e) { return res.status(500).json({ error: e.message }) }
})

// Admin-only: Sweep enrich cache and remove entries whose source files no longer exist.
// This performs an atomic purge of stale cache entries and cleans up renderedIndex mappings
// that reference the removed source paths. Returns a summary of removals.
app.post('/api/enrich/sweep', requireAuth, requireAdmin, (req, res) => {
  try {
    const removed = [];
    const keys = Object.keys(enrichCache || {});
    for (const k of keys) {
      try {
        if (!k) continue;
        // if the file no longer exists on disk, remove from cache
        if (!fs.existsSync(k)) {
          // Preserve entries that carry hidden/applied flags so approval state
          // survives even when the source file is moved or deleted.
          const entry = enrichCache[k];
          if (entry && (entry.hidden || entry.applied)) continue;
          removed.push(k);
          delete enrichCache[k];
        }
      } catch (e) { /* ignore per-key */ }
    }
    // Clean up renderedIndex entries that reference removed sources
    try {
      const rKeys = Object.keys(renderedIndex || {});
      for (const rk of rKeys) {
        try {
          const entry = renderedIndex[rk];
          if (entry && entry.source && removed.indexOf(entry.source) !== -1) {
            delete renderedIndex[rk];
          }
        } catch (e) {}
      }
    } catch (e) {}
    // persist
  try { if (db) db.setKV('enrichCache', enrichCache); else writeJson(enrichStoreFile, enrichCache); } catch (e) {}
  try { if (db) db.setKV('renderedIndex', renderedIndex); else writeJson(renderedIndexFile, renderedIndex); } catch (e) {}
    appendLog(`ENRICH_SWEEP removed=${removed.length}`);
    return res.json({ ok: true, removedCount: removed.length, removed });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});
// Force-refresh metadata for all items in a completed scan (server-side enrichment)
app.post('/api/scan/:scanId/refresh', requireAuth, async (req, res) => {
  const s = scans[req.params.scanId];
  if (!s) return res.status(404).json({ error: 'scan not found' });
  const username = req.session && req.session.username;
  const forceCache = coerceBoolean(req.body && req.body.force);
  appendLog(`REFRESH_SCAN_REQUEST scan=${req.params.scanId} by=${username} force=${forceCache ? 'yes' : 'no'}`);
  // Prevent concurrent refreshes for the same scanId
  const refreshLockKey = `refreshScan:${req.params.scanId}`;
  if (activeScans.has(refreshLockKey)) {
    appendLog(`SCAN_CONFLICT refresh=${req.params.scanId}`);
    return res.status(409).json({ error: 'refresh already in progress for this scan' });
  }
  activeScans.add(refreshLockKey);
  appendLog(`SCAN_LOCK_ACQUIRED refresh=${req.params.scanId}`);
  // pick tmdb key if available
  const { tmdb_api_key: tmdb_override } = req.body || {};
  let tmdbKey = null
  try {
    if (tmdb_override) tmdbKey = tmdb_override;
    else if (username && users[username] && users[username].settings && users[username].settings.tmdb_api_key) tmdbKey = users[username].settings.tmdb_api_key;
    else if (serverSettings && serverSettings.tmdb_api_key) tmdbKey = serverSettings.tmdb_api_key;
  } catch (e) { tmdbKey = null }
  // launch refresh work in background and return immediately to avoid upstream timeouts
  // lightweight in-memory progress tracking for UI polling
  const refreshProgressKey = refreshLockKey; // reuse lock key as progress key
  refreshProgress[refreshProgressKey] = { processed: 0, total: s.items ? s.items.length : 0, lastUpdated: Date.now(), status: 'running' };

  const backgroundRun = async () => {
    const results = [];
    let renderedIndexMutated = false;
    // Pre-normalize existing enrich cache entries for this scan so title-case
    // changes are applied immediately even if a provider lookup fails later.
    try {
      for (const it of s.items || []) {
        try {
          const key = canonicalize(it.canonicalPath);
          if (enrichCache && enrichCache[key]) updateEnrichCacheInMemory(key, {});
        } catch (e) {}
      }
    } catch (e) {}
    try {
      for (const it of s.items) {
        try {
          const key = canonicalize(it.canonicalPath);
          if (forceCache) {
            const purgeResult = purgeCachesForPath(key, { preserveFlags: true, persist: false });
            if (purgeResult) {
              if (purgeResult.renderedIndex) renderedIndexMutated = true;
            }
          }
          let lookup = null;
          let lookupError = null;
          try {
            doProcessParsedItem(it, req.session);
          } catch (parseErr) {
            try { appendLog(`REFRESH_ITEM_PARSE_FAIL path=${key} err=${parseErr && parseErr.message ? parseErr.message : String(parseErr)}`); } catch (logErr) {}
          }
          const entryAfterParse = enrichCache[key] || null;
          const fallbackProvider = entryAfterParse && entryAfterParse.provider ? Object.assign({}, entryAfterParse.provider) : null;
          const fallbackParsed = entryAfterParse && entryAfterParse.parsed ? Object.assign({}, entryAfterParse.parsed) : null;
          try { appendLog(`REFRESH_ITEM_FORCE_LOOKUP path=${key}`); } catch (e) {}
          try {
            // Respect user's provider order: if AniDB is configured first, force hash so
            // AniDB lookups wait for ED2K computation instead of falling back immediately.
            const _refreshProviderOrder = resolveMetadataProviderOrder(username);
            const _refreshForceHash = (_refreshProviderOrder && _refreshProviderOrder.length && _refreshProviderOrder[0] === 'anidb');
            const _refreshOpts = Object.assign({}, { username, force: true });
            if (_refreshForceHash) _refreshOpts.forceHash = true;
            lookup = await externalEnrich(key, tmdbKey, _refreshOpts);
          } catch (err) {
            lookupError = err;
            try { appendLog(`REFRESH_ITEM_LOOKUP_ERR path=${key} err=${err && err.message ? err.message : String(err)}`); } catch (logErr) {}
          }
          if (!lookup && fallbackProvider) {
            const providerClone = Object.assign({}, fallbackProvider);
            lookup = {
              title: providerClone.title,
              year: providerClone.year,
              season: providerClone.season,
              episode: providerClone.episode,
              episodeTitle: providerClone.episodeTitle || '',
              provider: providerClone,
              raw: providerClone.raw || null,
              parsedName: (fallbackParsed && (fallbackParsed.parsedName || fallbackParsed.title)) || providerClone.renderedName || null,
              // Pull title variants from cached provider block OR top-level entry
              seriesTitleEnglish: providerClone.seriesTitleEnglish || (entryAfterParse && entryAfterParse.seriesTitleEnglish) || null,
              seriesTitleRomaji: providerClone.seriesTitleRomaji || (entryAfterParse && entryAfterParse.seriesTitleRomaji) || null,
              seriesTitleExact: providerClone.seriesTitleExact || (entryAfterParse && entryAfterParse.seriesTitleExact) || null
            };
          }
          if (!lookup && fallbackParsed) {
            lookup = {
              title: fallbackParsed.title || null,
              year: fallbackParsed.year || (entryAfterParse && entryAfterParse.year) || null,
              season: fallbackParsed.season,
              episode: fallbackParsed.episode,
              episodeRange: fallbackParsed.episodeRange,
              parsedName: fallbackParsed.parsedName || fallbackParsed.title || null
            };
          }
          try {
            if (lookup && lookup.title) {
              if (lookup.provider) {
                const providerRendered = renderProviderName(lookup, key, req.session);
                const providerRaw = cloneProviderRaw(extractProviderRaw(lookup));
                const providerBlock = {
                  title: lookup.title,
                  year: lookup.year,
                  season: lookup.season,
                  episode: lookup.episode,
                  episodeTitle: lookup.episodeTitle || '',
                  raw: providerRaw,
                  renderedName: providerRendered || (lookup.provider && lookup.provider.renderedName) || '',
                  matched: lookup.provider && typeof lookup.provider.matched !== 'undefined' ? lookup.provider.matched : !!lookup.title,
                  source: lookup.source || (lookup.provider && lookup.provider.source) || null,
                  // Preserve title variants from externalEnrich (seriesTitleEnglish, seriesTitleRomaji, etc.)
                  seriesTitleEnglish: lookup.seriesTitleEnglish || null,
                  seriesTitleRomaji: lookup.seriesTitleRomaji || null,
                  seriesTitleExact: lookup.seriesTitleExact || null,
                  originalSeriesTitle: lookup.originalSeriesTitle || null
                };
                try { logMissingEpisodeTitleIfNeeded(key, providerBlock) } catch (e) {}
                // Merge entire lookup object to preserve all fields like seriesTitleEnglish
                updateEnrichCache(key, Object.assign({}, enrichCache[key] || {}, lookup, { provider: providerBlock, sourceId: 'provider', cachedAt: Date.now() }));
              } else {
                updateEnrichCache(key, Object.assign({}, { ...lookup, cachedAt: Date.now() }));
              }
            } else if (lookup) {
              updateEnrichCache(key, Object.assign({}, { ...lookup, cachedAt: Date.now() }));
            } else if (fallbackProvider) {
              updateEnrichCache(key, Object.assign({}, enrichCache[key] || {}, { provider: fallbackProvider, sourceId: 'provider', cachedAt: Date.now() }));
            }
          } catch (e) {
            if (lookup) {
              updateEnrichCache(key, Object.assign({}, { ...lookup, cachedAt: Date.now() }));
            } else if (fallbackProvider) {
              updateEnrichCache(key, Object.assign({}, enrichCache[key] || {}, { provider: fallbackProvider, sourceId: 'provider', cachedAt: Date.now() }));
            }
          }
          const resolvedTitle = (lookup && lookup.title) || (fallbackProvider && fallbackProvider.title) || (fallbackParsed && fallbackParsed.title) || null;
          const resolvedParsedName = (lookup && lookup.parsedName) || (fallbackParsed && fallbackParsed.parsedName) || null;
          if (lookup || fallbackProvider || fallbackParsed) {
            results.push({ path: key, ok: true, parsedName: resolvedParsedName, title: resolvedTitle });
            try { appendLog(`REFRESH_ITEM_OK path=${key} parsedName=${resolvedParsedName || ''}`); } catch (e) {}
          } else {
            results.push({ path: key, ok: false, error: lookupError && lookupError.message ? lookupError.message : 'lookup failed' });
          }
          // update progress
          try { if (refreshProgress[refreshProgressKey]) { refreshProgress[refreshProgressKey].processed += 1; refreshProgress[refreshProgressKey].lastUpdated = Date.now(); } } catch(e){}
        } catch (err) {
          try { appendLog(`REFRESH_ITEM_FAIL path=${it.canonicalPath} err=${err && err.message ? err.message : String(err)}`); } catch (e) {}
          try { appendLog(`REFRESH_ITEM_FAIL_STACK path=${it.canonicalPath} stack=${err && err.stack ? err.stack.replace(/\n/g,' | ') : ''}`); } catch (e) {}
          results.push({ path: it.canonicalPath, ok: false, error: err && err.message ? err.message : String(err) });
          // update progress even on fail
          try { if (refreshProgress[refreshProgressKey]) { refreshProgress[refreshProgressKey].processed += 1; refreshProgress[refreshProgressKey].lastUpdated = Date.now(); } } catch(e){}
        }
      }
      try { if (db) db.setKV('enrichCache', enrichCache); else writeJson(enrichStoreFile, enrichCache); } catch (e) {}
      try { if (db) db.setKV('parsedCache', parsedCache); else writeJson(parsedCacheFile, parsedCache); } catch (e) {}
      if (renderedIndexMutated) {
        try { if (db) db.setKV('renderedIndex', renderedIndex); else writeJson(renderedIndexFile, renderedIndex); } catch (e) {}
      }
      appendLog(`REFRESH_SCAN_COMPLETE scan=${req.params.scanId} items=${results.length}`);
      // Ensure stored scan artifacts reflect applied/hidden flags updated during refresh
      try {
        const modified = [];
        const sids = Object.keys(scans || {});
        for (const sid of sids) {
          try {
            const s = scans[sid];
            if (!s || !Array.isArray(s.items)) continue;
            const before = s.items.length;
            s.items = s.items.map(it => (it && it.canonicalPath) ? Object.assign({}, it) : it).filter(it => {
              try {
                const k = canonicalize(it.canonicalPath);
                const e = enrichCache[k] || null;
                if (e && (e.hidden || e.applied)) return false;
                try { it.enrichment = enrichCache[k] || null } catch (ee) { it.enrichment = null }
                return true
              } catch (e) { return true }
            });
            if (s.items.length !== before) {
              s.totalCount = s.items.length;
              modified.push(sid);
            } else {
              let anySnapshot = false
              for (const it of s.items) {
                try { if (it && it.enrichment) { anySnapshot = true; break } } catch (e) {}
              }
              if (anySnapshot) modified.push(sid)
            }
          } catch (e) {}
        }
        if (modified.length) {
          try { if (db) db.saveScansObject(scans); else writeJson(scanStoreFile, scans); appendLog(`POST_REFRESH_SCANS_UPDATED ids=${modified.join(',')}`) } catch (e) {}
        }
        // Notify clients that scans were updated by refresh so UI can reconcile
        try {
          if (modified && modified.length && Array.isArray(hideEvents)) {
            const evt = { ts: Date.now(), path: req.params && req.params.scanId ? `scan:${req.params.scanId}` : null, originalPath: null, modifiedScanIds: modified.map(String) };
            hideEvents.push(evt);
            try { if (db) db.setHideEvents(hideEvents); } catch (e) {}
            // keep recent events bounded
            if (hideEvents.length > 200) hideEvents.splice(0, hideEvents.length - 200);
            appendLog(`HIDE_EVENTS_PUSH_BY_REFRESH ids=${modified.join(',')}`);
          }
        } catch (e) {}
      } catch (e) {}
      // mark progress as complete
      try { if (refreshProgress[refreshProgressKey]) { refreshProgress[refreshProgressKey].status = 'complete'; refreshProgress[refreshProgressKey].lastUpdated = Date.now(); } } catch(e){}
      try { const removed2 = sweepEnrichCache(); if (removed2 && removed2.length) appendLog(`AUTOSWEEP_AFTER_REFRESH removed=${removed2.length}`); } catch (e) {}
    } catch (e) {
      try { appendLog(`REFRESH_SCAN_FAIL scan=${req.params.scanId} err=${e && e.message ? e.message : String(e)}`); } catch (ee) {}
      try { appendLog(`REFRESH_SCAN_FAIL_STACK scan=${req.params.scanId} stack=${e && e.stack ? e.stack.replace(/\n/g,' | ') : ''}`); } catch (ee) {}
      // mark progress as failed
      try { if (refreshProgress[refreshProgressKey]) { refreshProgress[refreshProgressKey].status = 'failed'; refreshProgress[refreshProgressKey].lastUpdated = Date.now(); } } catch(e){}
    } finally {
      try { activeScans.delete(refreshLockKey); appendLog(`SCAN_LOCK_RELEASED refresh=${req.params.scanId}`); } catch (ee) {}
      // clear progress entry after a short delay to allow client to read final state
      try { setTimeout(() => { try { delete refreshProgress[refreshProgressKey]; } catch(e){} }, 30*1000) } catch(e){}
    }
  }

  // start background work without awaiting so we return promptly to clients (prevents Cloudflare 504)
  void backgroundRun();
  // respond immediately to caller indicating background processing has started
  return res.status(202).json({ ok: true, background: true, message: 'refresh started' });
});

// Debug enrich: return cached enrichment and what externalEnrich would produce now
app.get('/api/enrich/debug', requireAuth, requireAdmin, async (req, res) => { const p = req.query.path || ''; const key = canonicalize(p); const cached = enrichCache[key] || null; // pick tmdb key if available (use server setting only for debug)
  const tmdbKey = serverSettings && serverSettings.tmdb_api_key ? serverSettings.tmdb_api_key : null;
  let forced = null;
  try {
  forced = await externalEnrich(key, tmdbKey, { username: null });
  } catch (e) { forced = { error: e.message } }
  res.json({ key, cached, forced });
});

// Debug: return in-memory locks and last-modified times for key data files
app.get('/api/debug/locks', requireAuth, (req, res) => {
  try {
    const locks = Array.from(activeScans || []);
    const statFor = (p) => {
      try { const s = fs.statSync(p); return { exists: true, mtime: s.mtimeMs, size: s.size } } catch (e) { return { exists: false } }
    }
    const files = {
      enrichStoreFile: statFor(enrichStoreFile),
      parsedCacheFile: statFor(parsedCacheFile),
      renderedIndexFile: statFor(renderedIndexFile),
      scansFile: statFor(scansFile)
    }
    return res.json({ locks, files });
  } catch (e) { return res.status(500).json({ error: e && e.message ? e.message : String(e) }) }
})

// Client-side confirmation that it refreshed scans/items after a server-side change.
// This is best-effort and used for diagnostic logging only.
app.post('/api/debug/client-refreshed', requireAuth, (req, res) => {
  try {
    const info = req.body || {}
    const path = info.path || null
    const scanId = info.scanId || null
    if (path) appendLog(`CLIENT_REFRESHED path=${path}`)
    if (scanId) appendLog(`CLIENT_REFRESHED_SCAN id=${scanId}`)

    // Previously this endpoint attempted to correlate recent hide events and emit
    // reconciliation logs. That noisy behavior is disabled so the client simply
    // acknowledges the refresh without generating additional events or log spam.

    return res.json({ ok: true })
  } catch (e) { return res.status(500).json({ error: e && e.message ? e.message : String(e) }) }
})

// Lightweight health check for probes
app.get('/api/_health', (req, res) => {
  try {
    const lastHide = (Array.isArray(hideEvents) && hideEvents.length) ? hideEvents[hideEvents.length - 1].ts : null
    const logStat = fs.existsSync(logsFile) ? fs.statSync(logsFile) : null
    return res.json({ ok: true, lastHideEventTs: lastHide, logsSize: logStat ? logStat.size : 0 })
  } catch (e) { return res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) }) }
})

// Clients can poll this endpoint to receive recent hide events and reconcile UI.
// Query param: since (timestamp in ms) to receive events occurring after that timestamp.
// Use a light per-client cache to avoid log spam when clients poll frequently with the same since value.
const hideEventsClientCache = new Map(); // key -> { ts, resp, lastHit }
const HIDE_EVENTS_CACHE_WINDOW_MS = 5000; // 5 seconds - slightly larger to tolerate aggressive polling

app.get('/api/enrich/hide-events', requireAuth, (req, res) => {
  try {
    const since = parseInt(req.query.since || '0', 10) || 0
    const uname = req.session && req.session.username ? String(req.session.username) : '<anon>'
    const clientIp = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown'
    const clientKey = `${clientIp}|${uname}`

    const now = Date.now()
    try {
      const cached = hideEventsClientCache.get(clientKey)
      if (cached && cached.ts === since && (now - cached.lastHit) < HIDE_EVENTS_CACHE_WINDOW_MS) {
        // refresh lastHit and return cached response to avoid duplicate logs
        cached.lastHit = now
        return res.json(cached.resp)
      }
    } catch (e) { /* non-fatal cache read failure: continue */ }

    // Fast-path: if client asks since=0 and we have no recent hide events, return immediately
    // This avoids heavy logging and work when a misbehaving client polls aggressively with since=0
    try {
      if ((since === 0) && (!Array.isArray(hideEvents) || hideEvents.length === 0)) {
        const resp = { ok: true, events: [] }
        try { hideEventsClientCache.set(clientKey, { ts: since, resp, lastHit: now }) } catch (e) {}
        return res.json(resp)
      }
    } catch (e) { /* continue to normal path */ }

    // defensive: ensure hideEvents is an array
    const he = Array.isArray(hideEvents) ? hideEvents : []
    const ev = he.filter(e => (e && e.ts && e.ts > since))
    const resp = { ok: true, events: ev || [] }

    try { hideEventsClientCache.set(clientKey, { ts: since, resp, lastHit: now }) } catch (e) {}
    return res.json(resp)
  } catch (e) {
    try { appendLog(`HIDE_EVENTS_ERR err=${e && e.message ? e.message : String(e)}`) } catch (ee) {}
    try { console.error('hide-events failed', e && e.message ? e.message : e) } catch (ee) {}
    return res.status(500).json({ error: e && e.message ? e.message : String(e) })
  }
})

// Helper function to render provider name for display
// Creates format: "Title (Year) - S01E08 - Episode Title"
function renderProviderName(data, fromPath, session) {
  try {
    if (!data) return null;

    const userTemplate = (session && session.username && users[session.username] && users[session.username].settings && users[session.username].settings.rename_template)
      ? users[session.username].settings.rename_template
      : null;
    const baseNameTemplate = userTemplate || serverSettings.rename_template || '{title} ({year}) - {epLabel} - {episodeTitle}';

    function pad(n) { return String(n).padStart(2, '0'); }

    const mediaFormat = data && data.mediaFormat ? String(data.mediaFormat).toUpperCase() : '';
    const rawSource = data && data.source ? String(data.source).toLowerCase() : '';
    const looksLikeTmdbMovie = !!(data && data.raw && data.raw.title && !data.raw.name);
    const tmdbMediaType = String(
      (data && data.raw && (data.raw.media_type || data.raw.mediaType)) ||
      (data && data.tmdb && data.tmdb.raw && (data.tmdb.raw.media_type || data.tmdb.raw.mediaType)) ||
      ''
    ).toLowerCase();
    const noEpisodeContext = (data && data.season == null && data.episode == null && !data.episodeRange);
    const isMovie = data.isMovie === true
      || mediaFormat.includes('MOVIE')
      || mediaFormat === 'FILM'
      || tmdbMediaType === 'movie'
      || looksLikeTmdbMovie
      || rawSource === 'tmdb-movie'
      || (noEpisodeContext && /\bmovie\b/i.test(String(data.episodeTitle || '')));

    let rawTitle = isMovie
      ? (data.title || data.seriesTitleEnglish || data.seriesTitle || '')
      : (data.seriesTitleEnglish || data.title || '');
    rawTitle = String(rawTitle || '').trim();
    if (!rawTitle) return null;

    // If upstream mapping split a movie subtitle into episodeTitle, stitch it back into title.
    if (isMovie && data.episodeTitle) {
      const movieSubtitle = String(data.episodeTitle || '').trim();
      if (movieSubtitle) {
        const titleNorm = rawTitle.toLowerCase();
        const subtitleNorm = movieSubtitle.toLowerCase();
        if (!titleNorm.includes(subtitleNorm)) {
          rawTitle = `${rawTitle} - ${movieSubtitle}`.replace(/\s{2,}/g, ' ').trim();
        }
      }
    }

    let templateYear = data && data.year ? String(data.year).trim() : '';
    if (!templateYear && data && data.parsed && data.parsed.year) templateYear = String(data.parsed.year).trim();

    let epLabel = '';
    let episodeTitle = '';
    if (!isMovie) {
      if (data.episodeRange) epLabel = data.season != null ? `S${pad(data.season)}E${data.episodeRange}` : `E${data.episodeRange}`;
      else if (data.episode != null) epLabel = data.season != null ? `S${pad(data.season)}E${pad(data.episode)}` : `E${pad(data.episode)}`;
      episodeTitle = data.episodeTitle ? String(data.episodeTitle).trim() : '';
    }

    const titleToken = isMovie ? rawTitle : cleanTitleForRender(rawTitle, epLabel, episodeTitle);

    let rendered = String(baseNameTemplate)
      .replace('{title}', sanitize(titleToken))
      .replace('{basename}', sanitize(path.basename(fromPath || '', path.extname(fromPath || ''))))
      .replace('{year}', sanitize(templateYear || ''))
      .replace('{epLabel}', sanitize(epLabel || ''))
      .replace('{episodeTitle}', sanitize(episodeTitle || ''))
      .replace('{season}', data.season != null ? String(data.season) : '')
      .replace('{episode}', data.episode != null ? String(data.episode) : '')
      .replace('{episodeRange}', data.episodeRange || '');

    rendered = String(rendered)
      .replace(/\s*\(\s*\)\s*/g, '')
      .replace(/\s*\-\s*(?:\-\s*)+/g, ' - ')
      .replace(/(^\s*\-\s*)|(\s*\-\s*$)/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (isMovie) {
      const y = String(templateYear || '').trim();
      if (y) rendered = `${stripTrailingYear(rendered)} (${y})`;
    } else {
      rendered = ensureRenderedNameHasYear(rendered, templateYear || '');
    }
    return rendered || null;
  } catch (e) {
    console.error('[renderProviderName] Error:', e);
    return null;
  }
}

// Progress endpoint for long-running scan refreshes
app.get('/api/scan/:scanId/progress', requireAuth, (req, res) => {
  try {
    const key = `refreshScan:${req.params.scanId}`;
    const p = refreshProgress[key] || null;
    if (!p) return res.json({ ok: false, message: 'no progress', progress: null });
    return res.json({ ok: true, progress: { processed: p.processed, total: p.total, status: p.status, lastUpdated: p.lastUpdated } });
  } catch (e) { return res.status(500).json({ error: e && e.message ? e.message : String(e) }) }
})

// Standalone plan generator — used by the preview route and the server-side approve job runner.
// All req.session references are replaced with a plain `username` parameter.
function generatePlanForItem(it, { username, effectiveOutput, applyFilenameAsTitle, template }) {
    const fromPath = canonicalize(it.canonicalPath);
    const key = fromPath;
    const meta = enrichCache[fromPath] || {};
  const rawTitle = (meta && (meta.title || (meta.extraGuess && meta.extraGuess.title))) ? (meta.title || (meta.extraGuess && meta.extraGuess.title)) : path.basename(fromPath, path.extname(fromPath));
  let year = '';
  try {
    if (meta && (meta.year || (meta.extraGuess && meta.extraGuess.year))) {
      year = meta.year || (meta.extraGuess && meta.extraGuess.year) || '';
    } else if (meta && meta.provider && meta.provider.year) {
      year = meta.provider.year;
    } else {
      year = extractYear(meta, fromPath) || '';
    }
  } catch (e) { year = '' }
    const ext = path.extname(fromPath);
    const filenameBase = sanitize(path.basename(fromPath, ext));
  const userTemplate = (username && users[username] && users[username].settings && users[username].settings.rename_template) ? users[username].settings.rename_template : null;
  const baseNameTemplate = template || userTemplate || serverSettings.rename_template || '{title}';
    function pad(n){ return String(n).padStart(2,'0') }
    const anidbRawEpisode = meta && meta.extraGuess && meta.extraGuess.anidb && meta.extraGuess.anidb.episodeNumberRaw;
    const shouldUseAnidbRaw = anidbRawEpisode && /^[SCTPO]\d+$/i.test(String(anidbRawEpisode));
    let epLabel = ''
    if (meta && meta.episodeRange) {
      epLabel = meta.season != null ? `S${pad(meta.season)}E${meta.episodeRange}` : `E${meta.episodeRange}`
    } else if (shouldUseAnidbRaw) {
      epLabel = meta.season != null ? `S${pad(meta.season)}E${String(anidbRawEpisode).toUpperCase()}` : `E${String(anidbRawEpisode).toUpperCase()}`
    } else if (meta && meta.episode != null) {
      epLabel = meta.season != null ? `S${pad(meta.season)}E${pad(meta.episode)}` : `E${pad(meta.episode)}`
    }
  let episodeTitleToken = (meta && (meta.episodeTitle || (meta.extraGuess && meta.extraGuess.episodeTitle))) ? (meta.episodeTitle || (meta.extraGuess && meta.extraGuess.episodeTitle)) : '';
  let seasonToken = (meta && meta.season != null) ? String(meta.season) : '';
  let episodeToken = (meta && meta.episode != null) ? String(meta.episode) : '';
  let episodeRangeToken = (meta && meta.episodeRange) ? String(meta.episodeRange) : '';
  const tmdbIdToken = (meta && meta.tmdb && meta.tmdb.raw && (meta.tmdb.raw.id || meta.tmdb.raw.seriesId)) ? String(meta.tmdb.raw.id || meta.tmdb.raw.seriesId) : '';
  const isMovie = determineIsMovie(meta);
  if (isMovie === true) {
    epLabel = '';
    episodeTitleToken = '';
    seasonToken = '';
    episodeToken = '';
    episodeRangeToken = '';
  }
  const episodeTitleTokenFromMeta = (isMovie === true)
    ? ''
    : ((meta && (meta.episodeTitle || (meta.extraGuess && meta.extraGuess.episodeTitle))) ? (meta.episodeTitle || (meta.extraGuess && meta.extraGuess.episodeTitle)) : '');
  const resolvedSeriesTitle = resolveSeriesTitle(meta, rawTitle, fromPath, episodeTitleTokenFromMeta, { preferExact: true });
  const englishSeriesTitle = extractEnglishSeriesTitle(meta);
  const renderBaseTitle = (isMovie === true)
    ? (resolvedSeriesTitle || rawTitle)
    : (englishSeriesTitle || resolvedSeriesTitle || rawTitle);
  function cleanTitleForRender(baseTitle, epLabel, epTitle) {
    try {
      let cleaned = String(baseTitle || '').trim();
      if (!cleaned) return '';
      cleaned = cleaned.replace(/\s*[-–—:]+\s*S\d{1,2}E\d{1,3}(?:\s*[-–—:]+\s*.*)?$/i, '');
      cleaned = cleaned.replace(/\s*[-–—:]+\s*E\d{1,3}(?:\s*[-–—:]+\s*.*)?$/i, '');
      cleaned = cleaned.replace(/\s*[-–—:]+\s*Episode\s+\d+.*$/i, '');
      return cleaned.trim();
    } catch (e) {
      return String(baseTitle || '').trim();
    }
  }
  let episodeForTitle = '';
  if (meta && meta.episode != null) {
    if (shouldUseAnidbRaw) {
      episodeForTitle = meta.season != null ? `S${String(meta.season).padStart(2,'0')}E${String(anidbRawEpisode).toUpperCase()}` : `E${String(anidbRawEpisode).toUpperCase()}`;
    } else {
      episodeForTitle = meta.season != null ? `S${String(meta.season).padStart(2,'0')}E${String(meta.episode).padStart(2,'0')}` : `E${String(meta.episode).padStart(2,'0')}`;
    }
  }
  const title = cleanTitleForRender(renderBaseTitle, episodeForTitle, episodeTitleTokenFromMeta);
  const templateYear = year ? String(year) : '';
  const folderYear = (isMovie === true && templateYear) ? templateYear : '';
  const folderBaseTitle = renderBaseTitle || title;
  if (englishSeriesTitle || typeof isMovie === 'boolean') {
    try {
      const currentEnglish = meta && meta.seriesTitleEnglish ? String(meta.seriesTitleEnglish).trim() : null;
      const needsEnglishUpdate = !currentEnglish || currentEnglish !== englishSeriesTitle;
  const currentMovieFlag = (meta && typeof meta.isMovie === 'boolean') ? meta.isMovie : ((meta && meta.extraGuess && typeof meta.extraGuess.isMovie === 'boolean') ? meta.extraGuess.isMovie : null);
      const needsMovieUpdate = typeof isMovie === 'boolean' && currentMovieFlag !== isMovie;
      if (needsEnglishUpdate || needsMovieUpdate) {
        const updatedExtra = meta && meta.extraGuess && typeof meta.extraGuess === 'object' ? Object.assign({}, meta.extraGuess) : {};
  if (typeof isMovie === 'boolean') updatedExtra.isMovie = isMovie;
        const cacheUpdate = Object.assign({}, meta, {
          seriesTitleEnglish: englishSeriesTitle || currentEnglish || null,
          seriesTitle: englishSeriesTitle || meta.seriesTitle || null,
          seriesTitleExact: englishSeriesTitle || meta.seriesTitleExact || null,
          isMovie: (typeof isMovie === 'boolean') ? isMovie : (typeof currentMovieFlag === 'boolean' ? currentMovieFlag : meta && meta.isMovie),
          extraGuess: updatedExtra,
        });
        updateEnrichCacheInMemory(fromPath, cacheUpdate);
        schedulePersistEnrichCache(100);
      }
    } catch (e) { /* best-effort cache update */ }
  }
  const seriesBase = englishSeriesTitle || (meta && (meta.seriesTitleEnglish || meta.seriesTitle)) || resolvedSeriesTitle || title || rawTitle || '';
  const aliasResolved = getSeriesAlias(seriesBase);
  let baseFolderName;
  if (aliasResolved) {
    baseFolderName = stripEpisodeArtifactsForFolder(String(aliasResolved).trim());
  } else {
    const shouldStripSeason = !(isMovie === true);
    baseFolderName = stripEpisodeArtifactsForFolder(shouldStripSeason ? String(stripSeasonNumberSuffix(seriesBase)).trim() : String(seriesBase).trim());
  }
  if (!baseFolderName) baseFolderName = stripEpisodeArtifactsForFolder(path.basename(fromPath, path.extname(fromPath)) || rawTitle || title);
  try { baseFolderName = titleCase(baseFolderName); } catch (e) {}
  let sanitizedBaseFolder = sanitize(baseFolderName);
  if (!sanitizedBaseFolder) {
    const fallbackFolderTitle = stripEpisodeArtifactsForFolder(title) || stripEpisodeArtifactsForFolder(rawTitle) || 'Untitled';
    sanitizedBaseFolder = sanitize(fallbackFolderTitle) || 'Untitled';
  }
  try { sanitizedBaseFolder = stripTrailingYear(sanitizedBaseFolder) } catch (e) {}
  try {
    const osKey = (username && users[username] && users[username].settings && users[username].settings.client_os) ? users[username].settings.client_os : (serverSettings && serverSettings.client_os ? serverSettings.client_os : 'linux');
    const maxLen = getMaxFilenameLengthForOS(osKey) || 255;
    if (sanitizedBaseFolder && sanitizedBaseFolder.length > maxLen) sanitizedBaseFolder = truncateFilenameComponent(sanitizedBaseFolder, maxLen);
  } catch (e) {}
  const titleFolder = folderYear ? `${sanitizedBaseFolder} (${folderYear})` : sanitizedBaseFolder;
  const seasonFolder = (!isMovie && meta && meta.season != null) ? `Season ${String(meta.season).padStart(2,'0')}` : '';
  const folder = applyFilenameAsTitle ? effectiveOutput : (seasonFolder ? path.join(effectiveOutput, titleFolder, seasonFolder) : path.join(effectiveOutput, titleFolder));
  let nameWithoutExtRaw = null;
  if (applyFilenameAsTitle && filenameBase) {
    nameWithoutExtRaw = filenameBase;
  } else if (meta && meta.provider && meta.provider.renderedName) {
    let providerName = String(meta.provider.renderedName).replace(/\.[^/.]+$/, '');
    try {
      const shouldStripSeason = !(isMovie === true);
      if (shouldStripSeason) {
        const parts = providerName.split(/\s[-–—:]\s/);
        if (parts && parts.length > 0) {
          parts[0] = stripSeasonNumberSuffix(parts[0]);
          providerName = parts.join(' - ');
        } else {
          providerName = stripSeasonNumberSuffix(providerName);
        }
      }
      providerName = stripTrailingYear(providerName);
    } catch (e) {}
    if (isMovie === true) {
      const y = String(templateYear || '').trim();
      if (y) providerName = `${stripTrailingYear(providerName)} (${y})`;
    } else {
      providerName = ensureRenderedNameHasYear(providerName, templateYear);
    }
    try {
      const hasEpisodeMeta = (isMovie !== true) && (meta && (meta.episode != null || meta.episodeRange));
      const providerLower = String(providerName || '').toLowerCase();
      const epLabelPresent = epLabel && providerLower.indexOf(String(epLabel).toLowerCase()) !== -1;
      const epTitlePresent = episodeTitleToken && providerLower.indexOf(String(episodeTitleToken).toLowerCase()) !== -1;
      const sxxMatch = /\bS\d{2}E\d{2}\b/i.test(providerName);
      const exxMatch = /\bE\d{1,3}\b/i.test(providerName);
      if (hasEpisodeMeta && !(epLabelPresent || epTitlePresent || sxxMatch || exxMatch)) {
        nameWithoutExtRaw = null;
      } else {
        nameWithoutExtRaw = sanitize(providerName);
      }
    } catch (e) {
      nameWithoutExtRaw = sanitize(providerName);
    }
  }
  if (!nameWithoutExtRaw) {
    const titleForFilename = (isMovie === true) ? title : stripSeasonNumberSuffix(title);
    nameWithoutExtRaw = baseNameTemplate
  .replace('{title}', sanitize(titleForFilename))
      .replace('{basename}', sanitize(path.basename(key, path.extname(key))))
  .replace('{year}', sanitize(templateYear))
      .replace('{epLabel}', sanitize(epLabel))
      .replace('{episodeTitle}', sanitize(episodeTitleToken))
      .replace('{season}', sanitize(seasonToken))
      .replace('{episode}', sanitize(episodeToken))
      .replace('{episodeRange}', sanitize(episodeRangeToken))
  .replace('{tmdbId}', sanitize(tmdbIdToken));
  }
  if (!nameWithoutExtRaw && filenameBase) {
    nameWithoutExtRaw = filenameBase;
  }
    const nameWithoutExt = String(nameWithoutExtRaw)
      .replace(/\s*\(\s*\)\s*/g, '')
      .replace(/\s*\-\s*(?:\-\s*)+/g, ' - ')
      .replace(/(^\s*-\s*)|(\s*-\s*$)/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    let truncatedNameWithoutExt = nameWithoutExt;
    try {
      const osKey = (username && users[username] && users[username].settings && users[username].settings.client_os) ? users[username].settings.client_os : (serverSettings && serverSettings.client_os ? serverSettings.client_os : 'linux');
      const maxLen = getMaxFilenameLengthForOS(osKey) || 255;
      const extLen = ext ? ext.length : 0;
      const maxBasenameLen = Math.max(1, maxLen - extLen);
      if (truncatedNameWithoutExt && truncatedNameWithoutExt.length > maxBasenameLen) {
        truncatedNameWithoutExt = truncateFilenameComponent(truncatedNameWithoutExt, maxBasenameLen);
      }
    } catch (e) {}
    const fileName = (truncatedNameWithoutExt + ext).trim();
    let toPath;
    if (effectiveOutput) {
      const finalFileName = fileName.replace(/\\/g, '/');
      toPath = path.join(folder, finalFileName).replace(/\\/g, '/');
    } else {
      toPath = path.join(path.dirname(fromPath), fileName).replace(/\\/g, '/');
    }
    const action = effectiveOutput ? 'hardlink' : (fromPath === toPath ? 'noop' : 'move');
  return { itemId: it.id, fromPath, toPath, actions: [{ op: action }], templateUsed: baseNameTemplate };
}

// Rename preview (generate plan)