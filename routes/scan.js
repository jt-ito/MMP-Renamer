module.exports = function createScanRoutes(ctx) {
  const router = require('express').Router();
  const {
  app,
  fs,
  path,
  uuidv4,
  enrichStoreFile,
  parsedCacheFile,
  scanStoreFile,
  scanCacheFile,
  renderedIndexFile,
  serverSettings,
  users,
  hideEvents,
  db,
  enrichCache,
  parsedCache,
  renderedIndex,
  scans,
  activeScans,
  refreshProgress,
  requireAuth,
  requireAdmin,
  coerceBoolean,
  appendLog,
  writeJson,
  canonicalize,
  doProcessParsedItem,
  extractProviderRaw,
  cloneProviderRaw,
  renderProviderName,
  logMissingEpisodeTitleIfNeeded,
  updateEnrichCache,
  purgeCachesForPath,
  normalizeEnrichEntry,
  externalEnrich,
  buildAppliedSourcesSet,
  isHiddenOrAppliedPath,
  sweepEnrichCache,
  updateEnrichCacheInMemory,
  bgEnrichPaused: _bgEnrichPaused,
  resumeBgEnrich,
  isProviderComplete
} = ctx;

  // Local reference so mutations in backgroundEnrichAll can read the current value
  const isBgEnrichPaused = () => {
    try { return typeof ctx.isBgEnrichPaused === 'function' && ctx.isBgEnrichPaused(); } catch (e) { return false; }
  };

  const resolveMetadataProviderOrder = (username) => {
    try {
      if (username && users[username] && users[username].settings && Array.isArray(users[username].settings.metadata_provider_order)) {
        return users[username].settings.metadata_provider_order;
      }
      if (serverSettings && Array.isArray(serverSettings.metadata_provider_order)) return serverSettings.metadata_provider_order;
    } catch (e) {}
    return ['anidb', 'anilist', 'tmdb', 'tvdb'];
  };

  const backgroundEnrichAll = async (scanId, enrichCandidates, session, libPath, lockKey) => {
    const username = session && session.username ? session.username : null;
    let tmdbKey = null;
    try {
      if (username && users[username] && users[username].settings && users[username].settings.tmdb_api_key) tmdbKey = users[username].settings.tmdb_api_key;
      else if (serverSettings && serverSettings.tmdb_api_key) tmdbKey = serverSettings.tmdb_api_key;
    } catch (e) {}

    let forcedHash = false;
    let skipAnime = false;
    if (username && users[username] && users[username].settings && users[username].settings.default_rescan_force_hash !== undefined) {
      forcedHash = coerceBoolean(users[username].settings.default_rescan_force_hash);
    } else if (serverSettings && serverSettings.default_rescan_force_hash !== undefined) {
      forcedHash = coerceBoolean(serverSettings.default_rescan_force_hash);
    } else {
      const _refreshProviderOrder = resolveMetadataProviderOrder(username);
      forcedHash = (_refreshProviderOrder && _refreshProviderOrder.length && _refreshProviderOrder[0] === 'anidb');
    }

    if (username && users[username] && users[username].settings && users[username].settings.default_rescan_skip_anime !== undefined) {
      skipAnime = coerceBoolean(users[username].settings.default_rescan_skip_anime);
    } else if (serverSettings && serverSettings.default_rescan_skip_anime !== undefined) {
      skipAnime = coerceBoolean(serverSettings.default_rescan_skip_anime);
    }

    const RATE_DELAY_MS = 350;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    appendLog(`BACKGROUND_ENRICH_ALL_START scan=${scanId} items=${enrichCandidates.length}`);
    for (let i = 0; i < enrichCandidates.length; i++) {
      // Check pause flag between each item (never mid-item)
      if (isBgEnrichPaused()) {
        appendLog(`BACKGROUND_ENRICH_PAUSED at item=${i}/${enrichCandidates.length} scan=${scanId}`);
        try { activeScans.delete(lockKey); appendLog(`SCAN_LOCK_RELEASED path=${libPath}`); } catch (ee) {}
        return;
      }
      const p = enrichCandidates[i];
      try {
        const fromPath = canonicalize(p);
        // Skip items that already have a complete provider enrichment
        const existingEntry = enrichCache[fromPath] || null;
        if (existingEntry && isProviderComplete && isProviderComplete(existingEntry.provider)) {
          appendLog(`BACKGROUND_ENRICH_SKIP_COMPLETE path=${fromPath}`);
          continue;
        }
        const opts = { username, force: false };
        if (forcedHash) opts.forceHash = true;
        if (skipAnime) opts.skipAnimeProviders = true;

        const data = await externalEnrich(fromPath, tmdbKey, opts);
        if (data) {
          const providerRendered = renderProviderName(data, fromPath, session);
          const providerRaw = cloneProviderRaw(extractProviderRaw(data));
          const providerBlock = {
            title: data.title, year: data.year, season: data.season, episode: data.episode,
            episodeTitle: data.episodeTitle || '', raw: providerRaw, renderedName: providerRendered,
            matched: !!data.title, source: data.source || (data.provider && data.provider.source) || null,
            seriesTitleEnglish: data.seriesTitleEnglish || null, seriesTitleRomaji: data.seriesTitleRomaji || null,
            seriesTitleExact: data.seriesTitleExact || null, originalSeriesTitle: data.originalSeriesTitle || null
          };
          updateEnrichCache(fromPath, Object.assign({}, enrichCache[fromPath] || {}, data, { provider: providerBlock, sourceId: 'provider', cachedAt: Date.now() }));
        }
      } catch (e) {
        appendLog(`BACKGROUND_ENRICH_FAIL path=${p} err=${e.message}`);
      }
      if (i < enrichCandidates.length - 1) await sleep(RATE_DELAY_MS);
    }
    
    // Save enrich cache when done
    try {
      if (db) db.setKV('enrichCache', enrichCache);
      else writeJson(enrichStoreFile, enrichCache);
    } catch (e) {}

    appendLog(`BACKGROUND_ENRICH_ALL_DONE scan=${scanId}`);
    try { activeScans.delete(lockKey); appendLog(`SCAN_LOCK_RELEASED path=${libPath}`); } catch (ee) {}
  };

  router.get('/api/libraries', requireAuth, (req, res) => {
    // Let user choose an existing folder under cwd or provide custom path via config later
    res.json([{ id: 'local', name: 'Local folder', canonicalPath: path.resolve('.') }]);
  });

router.post('/api/scan', requireAuth, async (req, res) => {
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
  const scanLib = require('../lib/scan');
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
    // Launch background enrichment using centralized helper.
    try {
      backgroundStarted = true;
      void backgroundEnrichAll(scanId, enrichCandidates, req.session, libPath, lockKey);
    } catch (e) { appendLog(`BACKGROUND_FIRSTN_LAUNCH_FAIL scan=${scanId} err=${e && e.message ? e.message : String(e)}`); activeScans.delete(lockKey); appendLog(`SCAN_LOCK_RELEASED path=${libPath}`); }
  } catch (err) {
    try { appendLog(`SCAN_HANDLER_FAIL scan=${scanId} err=${err && err.message ? err.message : String(err)}`); } catch (e) {}
    try { if (!backgroundStarted) { activeScans.delete(lockKey); appendLog(`SCAN_LOCK_RELEASED path=${libPath}`); } } catch (ee) {}
    return res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});

router.post('/api/scan/incremental', requireAuth, async (req, res) => {
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
  const scanLib = require('../lib/scan');
  function loadScanCache() { return scanLib.loadScanCache(scanCacheFile); }
  function saveScanCache(obj) { return scanLib.saveScanCache(scanCacheFile, obj); }

  // if no prior cache exists, fall back to full scan to collect candidates
  let items = [];
  let changedItems = [];
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

router.get('/api/scan/:scanId', requireAuth, (req, res) => { const s = scans[req.params.scanId]; if (!s) return res.status(404).json({ error: 'scan not found' }); res.json({ libraryId: s.libraryId, totalCount: s.totalCount, generatedAt: s.generatedAt }); });

router.get('/api/scan/:scanId/items', requireAuth, (req, res) => { 
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

router.get('/api/scan/latest', requireAuth, (req, res) => {
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

router.get('/api/scan/:scanId/search', requireAuth, (req, res) => {
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

router.post('/api/scan/force', requireAdmin, (req, res) => {
  try {
    // remove scan cache file so next /api/scan will perform a full walk
    try { if (fs.existsSync(scanCacheFile)) fs.unlinkSync(scanCacheFile); } catch (e) { appendLog(`SCAN_FORCE_UNLINK_FAIL err=${e && e.message ? e.message : String(e)}`); }
    appendLog(`SCAN_FORCE_CLEARED by=${req.session && req.session.username ? req.session.username : '<unknown>'}`);
    return res.json({ ok: true, forced: true });
  } catch (e) { return res.status(500).json({ error: e.message }) }
});

router.post('/api/scan/:scanId/refresh', requireAuth, async (req, res) => {
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
            const _refreshOpts = Object.assign({}, { username, force: true });
            let forcedHash = false;
            let skipAnime = false;
            
            if (username && users[username] && users[username].settings && users[username].settings.default_rescan_force_hash !== undefined) {
              forcedHash = coerceBoolean(users[username].settings.default_rescan_force_hash);
            } else if (serverSettings && serverSettings.default_rescan_force_hash !== undefined) {
              forcedHash = coerceBoolean(serverSettings.default_rescan_force_hash);
            } else {
              const _refreshProviderOrder = resolveMetadataProviderOrder(username);
              forcedHash = (_refreshProviderOrder && _refreshProviderOrder.length && _refreshProviderOrder[0] === 'anidb');
            }

            if (username && users[username] && users[username].settings && users[username].settings.default_rescan_skip_anime !== undefined) {
              skipAnime = coerceBoolean(users[username].settings.default_rescan_skip_anime);
            } else if (serverSettings && serverSettings.default_rescan_skip_anime !== undefined) {
              skipAnime = coerceBoolean(serverSettings.default_rescan_skip_anime);
            }

            if (forcedHash) _refreshOpts.forceHash = true;
            if (skipAnime) _refreshOpts.skipAnimeProviders = true;
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

router.get('/api/scan/:scanId/progress', requireAuth, (req, res) => {
  try {
    const key = `refreshScan:${req.params.scanId}`;
    const p = refreshProgress[key] || null;
    if (!p) return res.json({ ok: false, message: 'no progress', progress: null });
    return res.json({ ok: true, progress: { processed: p.processed, total: p.total, status: p.status, lastUpdated: p.lastUpdated } });
  } catch (e) { return res.status(500).json({ error: e && e.message ? e.message : String(e) }) }
})

  return router;
};
