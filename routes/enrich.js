module.exports = function createEnrichRoutes(ctx) {
  const router = require('express').Router();
  const {
  app,
  fs,
  path,
  enrichStoreFile,
  parsedCacheFile,
  scanStoreFile,
  renderedIndexFile,
  serverSettings,
  users,
  hideEvents,
  db,
  enrichCache,
  parsedCache,
  renderedIndex,
  scans,
  activeEnriches,
  requireAuth,
  requireAdmin,
  appendLog,
  writeJson,
  persistEnrichCacheNow,
  schedulePersistEnrichCache,
  broadcastEvent,
  canonicalize,
  extractProviderRaw,
  cloneProviderRaw,
  renderProviderName,
  logMissingEpisodeTitleIfNeeded,
  updateEnrichCache,
  purgeCachesForPath,
  normalizeEnrichEntry,
  externalEnrich
} = ctx;

  router.get('/api/enrich', requireAuth, (req, res) => {
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
      // Even without a full provider/parsed block, return hidden/applied state so clients
      // that have lost their in-memory cache (e.g. after page reload) can still see the item
      // is hidden and won't re-show it in the UI on the next scan.
      if (normalized.hidden || normalized.applied) return res.json({ cached: true, enrichment: cleanEnrichmentForClient(normalized) });
    }
    return res.json({ cached: false, enrichment: null });
  } catch (e) { return res.status(500).json({ error: e.message }) }
});

router.post('/api/enrich/custom', requireAuth, (req, res) => {
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

router.get('/api/enrich/by-rendered', requireAuth, (req, res) => {
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

router.post('/api/enrich/bulk', requireAuth, (req, res) => {
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

router.post('/api/enrich', requireAuth, async (req, res) => {
  const { path: p, tmdb_api_key: tmdb_override, force, forceHash, tvdb_v4_api_key: tvdb_override_v4_api_key, tvdb_v4_user_pin: tvdb_override_v4_user_pin, skipAnimeProviders } = req.body;
  const key = canonicalize(p || '');
  appendLog(`ENRICH_REQUEST path=${key} force=${force ? 'yes' : 'no'} forceHash=${forceHash ? 'yes' : 'no'} skipAnimeProviders=${skipAnimeProviders ? 'yes' : 'no'}`);
  try {
    // On forced rescan, clear cached enrich/parsed/rendered entries while preserving applied/hidden flags.
    // Capture the previous enrichment first so we can restore it if the rescan fails — this ensures the
    // DB always holds either the old (valid) enrichment or a fresh successful result, never an empty entry
    // left behind by a failed or timed-out rescan.
    const prevEnrichment = force ? (enrichCache[key] ? Object.assign({}, enrichCache[key]) : null) : null;
    if (force) {
      // Don't write the purged state to DB yet.  We only write once we have new enrichment.
      purgeCachesForPath(key, { preserveFlags: true, persist: false });
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
    activeEnriches.set(key, { startedAt: Date.now(), stage: 'fetching' });
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
          // No title found — avoid persisting an empty entry on a force rescan.
          // Restore the previous enrichment so server memory matches the DB (which was never purged).
          if (force && prevEnrichment) {
            enrichCache[key] = prevEnrichment;
            try { appendLog(`ENRICH_FORCE_FAILED_RESTORED path=${key}`); } catch (e) {}
          } else {
            updateEnrichCache(key, Object.assign({}, data, { cachedAt: Date.now() }));
          }
        }
      } catch (e) {
        if (force && prevEnrichment) {
          enrichCache[key] = prevEnrichment;
          try { appendLog(`ENRICH_FORCE_RENDER_FAIL_RESTORED path=${key} err=${e && e.message ? e.message : String(e)}`); } catch (ee) {}
        } else {
          updateEnrichCache(key, Object.assign({}, data, { cachedAt: Date.now() }));
        }
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
      // Persist to DB immediately. Skip when a force rescan failed and we restored the previous
      // enrichment — the DB was never purged (persist: false above) so it already holds the
      // correct state. Calling persistEnrichCacheNow() here would overwrite it with the restored
      // (old) in-memory entry which would be a no-op at best, but skip it to avoid any confusion.
      if ((data && data.title) || !force) {
        try { persistEnrichCacheNow(); } catch (e) {
          try { appendLog(`ENRICH_PERSIST_FINAL_FAIL path=${key} err=${e && e.message ? e.message : String(e)}`); } catch (ee) {}
        }
      }
      return enrichCache[key];
    })();
    enrichHandlerPromise.finally(() => { activeEnriches.delete(key); });
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

router.post('/api/enrich/hide', requireAuth, async (req, res) => {
  try {
    const p = req.body && req.body.path ? req.body.path : null
    if (!p) return res.status(400).json({ error: 'path required' })
  const key = canonicalize(p)
  // Update cache and persist immediately so changes survive browser close
  try {
    enrichCache[key] = enrichCache[key] || {};
    enrichCache[key].hidden = true;
    try { schedulePersistEnrichCache(50); } catch (e) {}
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
        const evt = { ts: Date.now(), path: key, originalPath: p, modifiedScanIds };
        hideEvents.push(evt);
        try { if (db) db.setHideEvents(hideEvents); } catch (e) {}
        // keep recent events bounded
        if (hideEvents.length > 200) hideEvents.splice(0, hideEvents.length - 200);
        
        if (typeof broadcastEvent === 'function') {
          try { broadcastEvent('hide_event', evt); } catch(e) {}
          if (modifiedScanIds.length) {
            try { broadcastEvent('scan_updated', {}); } catch(e) {}
          }
        }
      } catch (e) {}
    } catch (e) {
      appendLog(`HIDE_BG_FAIL path=${p} err=${e && e.message ? e.message : String(e)}`)
    }
  })();
  } catch (e) { return res.status(500).json({ error: e.message }) }
})

router.post('/api/enrich/sweep', requireAuth, requireAdmin, (req, res) => {
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

router.get('/api/enrich/debug', requireAuth, requireAdmin, async (req, res) => { const p = req.query.path || ''; const key = canonicalize(p); const cached = enrichCache[key] || null; // pick tmdb key if available (use server setting only for debug)
  const tmdbKey = serverSettings && serverSettings.tmdb_api_key ? serverSettings.tmdb_api_key : null;
  let forced = null;
  try {
  forced = await externalEnrich(key, tmdbKey, { username: null });
  } catch (e) { forced = { error: e.message } }
  res.json({ key, cached, forced });
});

router.get('/api/enrich/active', requireAuth, (req, res) => {
  try {
    const active = [];
    for (const [path, info] of activeEnriches.entries()) {
      active.push({ path, startedAt: info.startedAt, stage: info.stage });
    }
    res.json({ active });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/enrich/hide-events', requireAuth, (req, res) => {
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

  return router;
};
