const buildPlanGenerator = require('../lib/plan');
module.exports = function createRenameRoutes(ctx) {
  const generatePlanForItem = buildPlanGenerator(ctx);
  const router = require('express').Router();
  const {
  app,
  fs,
  path,
  enrichStoreFile,
  scanStoreFile,
  renderedIndexFile,
  serverSettings,
  users,
  db,
  enrichCache,
  renderedIndex,
  scans,
  requireAuth,
  requireAdmin,
  coerceBoolean,
  appendLog,
  writeJson,
  persistEnrichCacheNow,
  healCachedEnglishAndMovieFlags,
  canonicalize,
  extractProviderRaw,
  cloneProviderRaw,
  renderProviderName,
  updateEnrichCache,
  normalizeEnrichEntry,
  externalEnrich,
  performUnapprove,
  isProviderComplete,
  resolveMetadataProviderOrder,
  normalizeForCache
} = ctx;

  router.post('/api/rename/preview', requireAuth, async (req, res) => {
  const { items, template, outputPath, useFilenameAsTitle, skipAnimeProviders } = req.body || {};
  if (!items || !Array.isArray(items)) return res.status(400).json({ error: 'items required' });
  const applyFilenameAsTitle = coerceBoolean(useFilenameAsTitle);
  // resolve effective output path: request overrides per-user setting -> server setting
  let effectiveOutput = '';
  try {
    if (outputPath) {
      effectiveOutput = outputPath;
    } else {
      const username = req.session && req.session.username;
      if (username && users[username] && users[username].settings && users[username].settings.scan_output_path) {
        effectiveOutput = users[username].settings.scan_output_path;
      } else if (serverSettings && serverSettings.scan_output_path) {
        effectiveOutput = serverSettings.scan_output_path;
      } else {
        effectiveOutput = '';
      }
    }
    if (effectiveOutput) effectiveOutput = canonicalize(effectiveOutput);
  } catch (e) {
    effectiveOutput = outputPath || (serverSettings && serverSettings.scan_output_path) || '';
  }
  try { appendLog(`PREVIEW_EFFECTIVE_OUTPUT user=${req.session && req.session.username ? req.session.username : ''} effectiveOutput=${effectiveOutput || ''}`); } catch (e) {}
  
  // Enrich items on-demand if not already enriched (fixes issue where items beyond first 12 lack metadata)
  const username = req.session && req.session.username;
  let tmdbKey = null;
  try {
    if (username && users[username] && users[username].settings && users[username].settings.tmdb_api_key) {
      tmdbKey = users[username].settings.tmdb_api_key;
    } else if (serverSettings && serverSettings.tmdb_api_key) {
      tmdbKey = serverSettings.tmdb_api_key;
    }
  } catch (e) { tmdbKey = null; }
  
  // Check which items need enrichment and enrich them
  const enrichPromises = items.map(async (it) => {
    // Skip enrichment entirely when using filename as title
    if (applyFilenameAsTitle) {
      return;
    }
    const fromPath = canonicalize(it.canonicalPath);
    const existing = enrichCache[fromPath] || null;
    const prov = existing && existing.provider ? existing.provider : null;
    
    // If provider data exists but is missing renderedName, regenerate it from cached data
    // instead of re-enriching (prevents unnecessary API calls during approve)
    if (prov && prov.matched && !prov.renderedName && existing) {
      try {
        const providerRendered = renderProviderName(existing, fromPath, req.session);
        prov.renderedName = providerRendered;
        updateEnrichCache(fromPath, Object.assign({}, existing, { provider: prov }));
      } catch (e) { /* best effort */ }
    }
    
    // Only enrich if not already complete
    // During preview/apply, we should use cached metadata if it exists and is complete,
    // regardless of provider mode settings - those only matter during explicit rescan operations
    if (!isProviderComplete(prov)) {
      try {
        // When previewing/enriching items on-demand, if AniDB is the user's primary
        // metadata provider, prefer forcing hash so AniDB results are authoritative.
        const _previewProviderOrder = resolveMetadataProviderOrder(username);
        const _previewForceHash = (_previewProviderOrder && _previewProviderOrder.length && _previewProviderOrder[0] === 'anidb');
        const _previewOpts = Object.assign({}, { username });
        if (_previewForceHash) _previewOpts.forceHash = true;
        // Note: skipAnimeProviders is intentionally NOT passed here during preview
        // because we only want to apply provider filtering during explicit rescan operations,
        // not when generating rename plans from already-enriched items
        const data = await externalEnrich(fromPath, tmdbKey, _previewOpts);
        if (data) {
          const providerRendered = renderProviderName(data, fromPath, req.session);
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
          updateEnrichCache(fromPath, Object.assign({}, enrichCache[fromPath] || {}, data, {
            provider: providerBlock,
            sourceId: 'provider',
            cachedAt: Date.now()
          }));
        }
      } catch (e) {
        try { appendLog(`PREVIEW_ENRICH_FAIL path=${fromPath} err=${e && e.message}`); } catch (ee) {}
      }
    }
  });
  
  // Wait for all enrichments to complete
  await Promise.all(enrichPromises);

  const plans = items.map(it => generatePlanForItem(it, { username, effectiveOutput, applyFilenameAsTitle, template })).filter(Boolean);
  // DEBUG: persist a compact preview plan summary to logs for diagnostic purposes
  try {
    const uname = username || '<anon>';
    const dump = (plans || []).slice(0, 50).map(p => ({ itemId: p.itemId, from: p.fromPath, to: p.toPath, templateUsed: p.templateUsed }));
    appendLog(`PREVIEW_PLANS user=${uname} count=${(plans||[]).length} payload=${JSON.stringify(dump)}`);
  } catch (e) { /* non-fatal debug logging */ }

  // Ensure any side-effect updates (English titles, movie flags) are persisted immediately
  try { persistEnrichCacheNow(); } catch (e) {}

  res.json({ plans });
});

router.post('/api/rename/apply', requireAuth, async (req, res) => {
  const { plans, dryRun, outputFolder } = req.body || {};
  if (!plans || !Array.isArray(plans)) return res.status(400).json({ error: 'plans required' });

  // Diagnostic: dump the incoming plans payload
  try {
    const dumpUser = req.session && req.session.username ? req.session.username : '<anon>';
    const dumpPath = path.join(process.cwd(), 'data', `apply-plans-dump-${Date.now()}.json`);
    try { fs.writeFileSync(dumpPath, JSON.stringify({ user: dumpUser, plans: plans }, null, 2), { encoding: 'utf8' }); } catch (e) {}
  } catch (e) {}

  try { healCachedEnglishAndMovieFlags(); } catch (e) {}

  const results = [];
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Helper to ensure directory exists with retries
  const ensureDir = async (dir) => {
    if (fs.existsSync(dir)) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      // retry once after delay
      await sleep(50);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
  };

  for (const p of plans) {
    const resultItem = { itemId: p.itemId, status: 'pending' };
    try {
      const fromPath = path.resolve(p.fromPath);
      
      // STRICTLY use the plan's toPath (Preview WYSIWYG)
      if (!p.toPath) {
        throw new Error('Plan missing target path (preview required)');
      }
      
      let toPath = path.resolve(p.toPath);

      // If an explicit output folder override was provided (e.g. via "Apply to..." UI),
      // re-base the target path to be inside that folder, preserving the folder structure
      // (series folder, season folder) from the preview.
      if (outputFolder && typeof outputFolder === 'string') {
        // Extract the relative path from the original preview by finding the portion
        // after the configured output path. This preserves Series/Season folder structure.
        const username = req.session && req.session.username ? req.session.username : null;
        const userOutput = username && users[username] && users[username].settings && users[username].settings.scan_output_path 
          ? users[username].settings.scan_output_path 
          : null;
        const configuredOutput = userOutput || (serverSettings && serverSettings.scan_output_path) || '';
        
        let relativePath = path.basename(toPath); // fallback to just filename
        if (configuredOutput) {
          try {
            const resolvedConfigOutput = path.resolve(configuredOutput);
            const resolvedToPath = path.resolve(p.toPath);
            if (resolvedToPath.startsWith(resolvedConfigOutput)) {
              relativePath = path.relative(resolvedConfigOutput, resolvedToPath);
            }
          } catch (e) {
            // If relative path extraction fails, fall back to basename
          }
        }
        
        toPath = path.join(outputFolder, relativePath);
      }

      // Validation
      if (fromPath === toPath) {
        resultItem.status = 'noop';
        results.push(resultItem);
        continue;
      }

      if (!fs.existsSync(fromPath)) {
        resultItem.status = 'error';
        resultItem.error = 'Source file not found';
        results.push(resultItem);
        continue;
      }

      if (!dryRun) {
        const parentDir = path.dirname(toPath);
        await ensureDir(parentDir);

        if (fs.existsSync(toPath)) {
          resultItem.status = 'exists';
          resultItem.to = toPath;
        } else {
          // Hardlink with retry for "fails first time" issues
          let linked = false;
          let lastErr = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              fs.linkSync(fromPath, toPath);
              linked = true;
              break;
            } catch (err) {
              lastErr = err;
              if (err.code === 'EEXIST') {
                linked = true; // effectively success
                break;
              }
              // Wait and retry
              await sleep(100 * (attempt + 1));
            }
          }

          if (!linked) {
            throw lastErr || new Error('Hardlink failed after retries');
          }

          resultItem.status = 'hardlinked';
          resultItem.to = toPath;
          appendLog(`HARDLINK_SUCCESS from=${fromPath} to=${toPath}`);

          // Update Cache/DB
          try {
            const fromKey = canonicalize(fromPath);
            enrichCache[fromKey] = enrichCache[fromKey] || {};
            enrichCache[fromKey].applied = true;
            enrichCache[fromKey].hidden = true;
            enrichCache[fromKey].appliedAt = Date.now();
            enrichCache[fromKey].appliedTo = toPath;
            
            const finalBasename = path.basename(toPath);
            enrichCache[fromKey].renderedName = finalBasename;
            enrichCache[fromKey].metadataFilename = finalBasename.replace(path.extname(finalBasename), '');

            // Update renderedIndex
            const targetKey = canonicalize(toPath);
            renderedIndex[targetKey] = {
                source: fromPath,
                renderedName: finalBasename,
                appliedTo: toPath,
                metadataFilename: enrichCache[fromKey].metadataFilename,
                provider: enrichCache[fromKey].provider || null,
                parsed: enrichCache[fromKey].parsed || null
            };
            
            // Persist immediately to avoid data loss
            if (db) {
                db.setKV('enrichCache', enrichCache);
                db.setKV('renderedIndex', renderedIndex);
            }
          } catch (dbErr) {
            appendLog(`DB_UPDATE_FAIL ${dbErr.message}`);
          }
        }
      } else {
        resultItem.status = 'dry-run';
        resultItem.to = toPath;
      }
      results.push(resultItem);

    } catch (e) {
      resultItem.status = 'error';
      resultItem.error = e.message;
      appendLog(`APPLY_ERROR item=${p.itemId} err=${e.message}`);
      results.push(resultItem);
    }
  }

  // Final bulk save if no DB
  if (!db) {
      try { writeJson(enrichStoreFile, enrichCache); } catch (e) {}
      try { writeJson(renderedIndexFile, renderedIndex); } catch (e) {}
  } else {
      // Ensure everything is flushed even if per-item saves were used
      try { persistEnrichCacheNow(); } catch (e) {}
  }

  // Remove applied items from scans to prevent them from reappearing on next load
  // This is critical to keep scans in sync with enrichCache applied/hidden state
  try {
    let removedFromScans = 0;
    const appliedPaths = new Set(plans.filter(p => {
      const r = results.find(res => res.itemId === p.itemId);
      return r && r.status === 'hardlinked';
    }).map(p => canonicalize(p.fromPath)));

    if (appliedPaths.size > 0) {
      const scanIds = Object.keys(scans || {});
      for (const sid of scanIds) {
        try {
          const scan = scans[sid];
          if (!scan || !Array.isArray(scan.items)) continue;
          const before = scan.items.length;
          scan.items = scan.items.filter(it => {
            try {
              const k = canonicalize(it.canonicalPath);
              return !appliedPaths.has(k);
            } catch (e) { return true; }
          });
          const removed = before - scan.items.length;
          if (removed > 0) {
            scan.totalCount = scan.items.length;
            removedFromScans += removed;
          }
        } catch (e) { /* ignore per-scan errors */ }
      }
      
      if (removedFromScans > 0) {
        try { 
          if (db) db.saveScansObject(scans); 
          else writeJson(scanStoreFile, scans); 
          appendLog(`APPLY_SCAN_UPDATE removed=${removedFromScans} applied items from scans`);
        } catch (e) { 
          appendLog(`APPLY_SCAN_UPDATE_FAIL err=${e && e.message ? e.message : String(e)}`);
        }
      }
    }
  } catch (e) { 
    appendLog(`APPLY_SCAN_FILTER_FAIL err=${e && e.message ? e.message : String(e)}`);
  }

  res.json({ results });
});

router.post('/api/rename/unapprove', requireAuth, requireAdmin, (req, res) => {
  try {
    const username = req.session && req.session.username ? req.session.username : null;
    const requestedPaths = (req.body && Array.isArray(req.body.paths)) ? req.body.paths : null;
    const rawCount = !requestedPaths ? ((req.body && req.body.count) ?? '10') : null;
    let count = 10;
    if (rawCount !== null && rawCount !== undefined) {
      const parsed = parseInt(String(rawCount), 10);
      if (Number.isFinite(parsed)) count = parsed;
    }

    const { changed, deletedHardlinks, hardlinkErrors, shouldDeleteHardlinks } = performUnapprove({ requestedPaths, count, username });

    appendLog(`UNAPPROVE count=${changed.length} deleteHardlinks=${shouldDeleteHardlinks ? 'yes' : 'no'} removed=${deletedHardlinks.length}`);
    res.json({ ok: true, unapproved: changed, deletedHardlinks, hardlinkErrors });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

router.get('/api/rename/hidden', requireAuth, requireAdmin, (req, res) => {
  try {
    const items = []
    const entries = enrichCache || {}
    for (const key of Object.keys(entries)) {
      const entry = entries[key]
      if (!entry) continue
      const hidden = entry.hidden === true
      const applied = entry.applied === true
      if (!hidden && !applied) continue
      const provider = entry.provider || {}
      const parsed = entry.parsed || {}
      items.push({
        path: key,
        hidden,
        applied,
        appliedAt: entry.appliedAt || null,
        appliedTo: entry.appliedTo || null,
        providerTitle: provider.renderedName || provider.title || null,
        providerYear: provider.year || null,
        providerEpisodeTitle: provider.episodeTitle || null,
        parsedTitle: parsed.parsedName || parsed.title || null,
        basename: path.basename(key)
      })
    }
    items.sort((a, b) => {
      const aKey = a.appliedAt || 0
      const bKey = b.appliedAt || 0
      if (aKey !== bKey) return bKey - aKey
      return a.path.localeCompare(b.path)
    })
    res.json({ items })
  } catch (e) {
    try { appendLog(`RENAME_HIDDEN_LIST_FAIL err=${e && e.message ? e.message : String(e)}`) } catch (ee) {}
    res.status(500).json({ error: e && e.message ? e.message : String(e) })
  }
})

router.get('/api/rename/duplicates', requireAuth, requireAdmin, (req, res) => {
  try {
    const groupsByPreview = new Map();
    const groupsByHash = new Map();
    const groupsByMetadata = new Map();

    const derivePreviewName = (key, entry) => {
      try {
        const normalized = normalizeEnrichEntry(entry || {}) || {};
        if (normalized.provider && normalized.provider.renderedName) return normalized.provider.renderedName;
        if (entry && entry.renderedName) return entry.renderedName;
        // Do not fall back to parsed names here; duplicates should be based on provider-rendered previews only
        return path.basename(key);
      } catch (e) { return path.basename(key); }
    };

    const deriveMetadataKey = (entry) => {
      try {
        const normalized = normalizeEnrichEntry(entry || {}) || {};
        const seriesTitle = normalized.seriesTitleExact || normalized.seriesTitle || normalized.title || null;
        const season = normalized.season != null ? normalized.season : null;
        const episode = normalized.episode != null ? normalized.episode : null;
        if (!seriesTitle || season == null || episode == null) return null;
        const seriesNorm = normalizeForCache(seriesTitle);
        return `${seriesNorm}::S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}`;
      } catch (e) { return null; }
    };

    const resolveHash = (key, entry) => {
      let h = null;
      try {
        if (db) {
          try {
            const st = fs.existsSync(key) ? fs.statSync(key) : null;
            h = db.getEd2kHash(key, st ? st.size : null) || null;
          } catch (e) {}
        }
        if (!h && entry && entry.provider && entry.provider.raw && entry.provider.raw.ed2k) {
          h = entry.provider.raw.ed2k;
        }
      } catch (e) { h = null; }
      return h;
    };

    const addItem = (map, groupKey, meta, ctx = {}) => {
      if (!groupKey) return;
      if (!map.has(groupKey)) map.set(groupKey, { key: groupKey, items: [], ...ctx });
      const group = map.get(groupKey);
      if (ctx.previewName && !group.previewName) group.previewName = ctx.previewName;
      if (ctx.previewKey && !group.previewKey) group.previewKey = ctx.previewKey;
      group.items.push(meta);
    };

    for (const key of Object.keys(enrichCache || {})) {
      const entry = enrichCache[key];
      if (!entry) continue;
      const previewNameRaw = derivePreviewName(key, entry);
      const previewKey = previewNameRaw ? previewNameRaw.toLowerCase() : null;
      const metadataKey = deriveMetadataKey(entry);
      const hash = resolveHash(key, entry);
      const parsed = entry.parsed || {};
      const provider = entry.provider || {};
      const meta = {
        path: key,
        basename: path.basename(key),
        previewName: previewNameRaw || null,
        applied: entry.applied === true,
        hidden: entry.hidden === true,
        appliedTo: entry.appliedTo || null,
        appliedAt: entry.appliedAt || null,
        providerTitle: provider.renderedName || provider.title || null,
        parsedTitle: parsed.parsedName || parsed.title || null
      };

      if (previewKey) addItem(groupsByPreview, previewKey, meta, { previewName: previewNameRaw || null, previewKey });
      if (hash) addItem(groupsByHash, hash, meta, { previewName: previewNameRaw || null });
      if (metadataKey) addItem(groupsByMetadata, metadataKey, meta, { previewName: previewNameRaw || null });
    }

    const previewGroups = Array.from(groupsByPreview.values())
      .map((v) => ({
        groupType: 'preview',
        previewName: v.previewName || v.items[0]?.previewName || v.previewKey || v.key,
        previewKey: v.previewKey || v.key,
        items: v.items
      }))
      .filter(g => g.items.length > 1);
    const hashGroups = Array.from(groupsByHash.entries())
      .map(([k, v]) => ({ groupType: 'hash', hash: k, previewName: v.items[0]?.previewName || null, items: v.items }))
      .filter(g => g.items.length > 1);
    const metadataGroups = Array.from(groupsByMetadata.entries())
      .map(([k, v]) => ({ groupType: 'metadata', metadataKey: k, previewName: v.items[0]?.previewName || null, items: v.items }))
      .filter(g => g.items.length > 1);

    const deduped = [...previewGroups, ...hashGroups, ...metadataGroups];
    deduped.sort((a, b) => b.items.length - a.items.length || (a.previewName || '').localeCompare(b.previewName || ''));
    res.json({ groups: deduped, total: deduped.length, generatedAt: Date.now() });
  } catch (e) {
    try { appendLog(`DUPLICATES_LIST_FAIL err=${e && e.message ? e.message : String(e)}`); } catch (ee) {}
    res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
})

  return router;
};
