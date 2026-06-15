module.exports = function createJobsRoutes(ctx) {
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
  coerceBoolean,
  appendLog,
  writeJson,
  persistEnrichCacheNow,
  broadcastEvent,
  canonicalize,
  extractProviderRaw,
  cloneProviderRaw,
  renderProviderName,
  updateEnrichCache,
  externalEnrich
} = ctx;

  const resolveMetadataProviderOrder = (username) => {
    try {
      if (username && users[username] && users[username].settings && Array.isArray(users[username].settings.metadata_provider_order)) {
        return users[username].settings.metadata_provider_order;
      }
      if (serverSettings && Array.isArray(serverSettings.metadata_provider_order)) return serverSettings.metadata_provider_order;
    } catch (e) {}
    return ['anidb', 'anilist', 'tmdb', 'tvdb'];
  };

  router.get('/api/jobs', requireAuth, (req, res) => {
  try {
    const now = Date.now();
    // Return jobs created in the last 30 minutes or still running
    const jobs = [...bgJobs.values()].filter(j => j.status === 'running' || (now - j.createdAt < 30 * 60 * 1000));
    res.json({ jobs });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

router.get('/api/jobs/:id', requireAuth, (req, res) => {
  try {
    const job = bgJobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'job not found' });
    res.json({ job });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

router.post('/api/jobs/check-conflicts', requireAuth, async (req, res) => {
  try {
    const { items, outputFolder, template, useFilenameAsTitle, skipAnimeProviders } = req.body || {};
    if (!items || !Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items required' });
    const username = req.session && req.session.username ? req.session.username : null;
    const applyFilenameAsTitle = coerceBoolean(useFilenameAsTitle);

    let effectiveOutput = '';
    try {
      if (outputFolder) {
        effectiveOutput = canonicalize(outputFolder);
      } else if (username && users[username] && users[username].settings && users[username].settings.scan_output_path) {
        effectiveOutput = canonicalize(users[username].settings.scan_output_path);
      } else if (serverSettings && serverSettings.scan_output_path) {
        effectiveOutput = canonicalize(serverSettings.scan_output_path);
      } else {
        effectiveOutput = '';
      }
    } catch (e) { }
    if (!effectiveOutput) return res.status(400).json({ error: 'Output path not configured.' });

    const tmpl = template || (username && users[username] && users[username].settings && users[username].settings.rename_template) || serverSettings.rename_template || '{title} - {epLabel} - {episodeTitle}';

    const conflicts = [];
    for (const reqItem of items) {
      if (!reqItem || !reqItem.canonicalPath) continue;
      const fromPath = String(reqItem.canonicalPath);
      let parsedName = '', epLabel = '', season = null, title = '', episodeTitle = '';
      try {
        const enrichment = enrichStore[canonicalize(fromPath)];
        if (!enrichment) continue;

        if (applyFilenameAsTitle) {
          const parseFilename = require('./lib/filename-parser');
          const parsed = parseFilename(fromPath);
          season = enrichment.season || parsed.season;
          title = parsed.title || enrichment.title || '';
        } else {
          season = enrichment.season;
          title = enrichment.title || '';
        }
        
        episodeTitle = enrichment.episodeTitle || '';
        
        const isMovie = enrichment.type === 'movie';
        if (isMovie) {
          const y = enrichment.year ? ` (${enrichment.year})` : '';
          parsedName = `${title}${y}`;
          epLabel = '';
        } else if (enrichment.episodeRange) {
          epLabel = (season != null) ? `S${String(season).padStart(2,'0')}E${enrichment.episodeRange}` : `E${enrichment.episodeRange}`;
          parsedName = tmpl.replace('{title}', sanitizeForFilename(title)).replace('{epLabel}', epLabel).replace('{episodeTitle}', sanitizeForFilename(episodeTitle)).replace('{year}', enrichment.year || '').replace('{season}', season != null ? season : '').replace('{episode}', enrichment.episode != null ? enrichment.episode : '').replace('{episodeRange}', enrichment.episodeRange).replace('{tmdbId}', enrichment.tmdbId || '');
        } else if (enrichment.episode != null) {
          const pad = n => String(n).padStart(2, '0');
          epLabel = (season != null) ? `S${pad(season)}E${pad(enrichment.episode)}` : `E${pad(enrichment.episode)}`;
          parsedName = tmpl.replace('{title}', sanitizeForFilename(title)).replace('{epLabel}', epLabel).replace('{episodeTitle}', sanitizeForFilename(episodeTitle)).replace('{year}', enrichment.year || '').replace('{season}', season != null ? season : '').replace('{episode}', enrichment.episode != null ? enrichment.episode : '').replace('{episodeRange}', '').replace('{tmdbId}', enrichment.tmdbId || '');
        } else {
          // Fallback if no episode data is present
          epLabel = '';
          const y = enrichment.year ? ` (${enrichment.year})` : '';
          parsedName = `${sanitizeForFilename(title)}${y}`;
        }

        parsedName = parsedName.replace(/\s+/g, ' ').replace(/ - \s*$/, '').replace(/^ - /, '').trim();
        const ext = path.extname(fromPath);
        
        // Use keepBothTarget if supplied, otherwise compute toPath
        const finalName = reqItem.keepBothTarget ? reqItem.keepBothTarget : parsedName + ext;
        let toPath = path.join(effectiveOutput, sanitizeForFilename(title));
        if (!isMovie && season != null) {
          toPath = path.join(toPath, `Season ${String(season).padStart(2,'0')}`);
        }
        toPath = path.join(toPath, finalName);
        
        if (fs.existsSync(toPath)) {
          conflicts.push({
            original: reqItem.canonicalPath,
            toPath: toPath,
            title: parsedName
          });
        }
      } catch (e) {
        // Skip on error
      }
    }
    return res.json({ conflicts });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/api/jobs/approve', requireAuth, async (req, res) => {
  try {
    const { items, outputFolder, template, useFilenameAsTitle, skipAnimeProviders } = req.body || {};
    if (!items || !Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items required' });
    const username = req.session && req.session.username ? req.session.username : null;
    const applyFilenameAsTitle = coerceBoolean(useFilenameAsTitle);

    // Resolve effective output path the same way the preview route does
    let effectiveOutput = '';
    try {
      if (outputFolder) {
        effectiveOutput = canonicalize(outputFolder);
      } else if (username && users[username] && users[username].settings && users[username].settings.scan_output_path) {
        effectiveOutput = canonicalize(users[username].settings.scan_output_path);
      } else if (serverSettings && serverSettings.scan_output_path) {
        effectiveOutput = canonicalize(serverSettings.scan_output_path);
      }
    } catch (e) { effectiveOutput = outputFolder ? canonicalize(outputFolder) : ''; }

    const job = createBgJob('approve', items.length);
    // Respond immediately so the client can close safely
    res.json({ jobId: job.id, status: 'running' });

    // Run the entire approve workflow in the background
    ;(async () => {
      try {
        let tmdbKey = null;
        try {
          if (username && users[username] && users[username].settings && users[username].settings.tmdb_api_key) tmdbKey = users[username].settings.tmdb_api_key;
          else if (serverSettings && serverSettings.tmdb_api_key) tmdbKey = serverSettings.tmdb_api_key;
        } catch (e) {}

        const _providerOrder = resolveMetadataProviderOrder(username);
        const _forceHash = (_providerOrder && _providerOrder.length && _providerOrder[0] === 'anidb');

        // Step 1: Enrich any items not yet complete
        for (const it of items) {
          try {
            const fromPath = canonicalize(it.canonicalPath);
            if (!applyFilenameAsTitle) {
              const existing = enrichCache[fromPath] || null;
              const prov = existing && existing.provider ? existing.provider : null;
              if (!isProviderComplete(prov)) {
                const opts = { username };
                if (_forceHash) opts.forceHash = true;
                const data = await externalEnrich(fromPath, tmdbKey, opts);
                if (data) {
                  const providerRendered = renderProviderName(data, fromPath, null);
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
              }
            }
          } catch (e) { try { appendLog(`JOB_APPROVE_ENRICH_FAIL path=${it.canonicalPath} err=${e && e.message}`); } catch (ee) {} }
          job.processedItems++;
        }

        // Step 2: Generate rename plans
        const plans = items.map(it => {
          const plan = generatePlanForItem(it, { username, effectiveOutput, applyFilenameAsTitle, template });
          if (it.keepBothTarget && plan.toPath) {
            plan.toPath = path.join(path.dirname(plan.toPath), it.keepBothTarget);
          }
          plan.overwrite = it.overwrite;
          return plan;
        });
        try { persistEnrichCacheNow(); } catch (e) {}

        // Step 3: Apply each plan (hardlink + cache update)
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const appliedFromPaths = new Set();
        for (const p of plans) {
          const resultItem = { itemId: p.itemId, fromPath: p.fromPath, status: 'pending' };
          try {
            const fromPath = path.resolve(p.fromPath);
            if (!p.toPath) { resultItem.status = 'error'; resultItem.error = 'Plan missing target path'; job.results.push(resultItem); continue; }
            const toPath = path.resolve(p.toPath);
            if (fromPath === toPath) { resultItem.status = 'noop'; job.results.push(resultItem); continue; }
            if (!fs.existsSync(fromPath)) { resultItem.status = 'error'; resultItem.error = 'Source file not found'; job.results.push(resultItem); continue; }
            const parentDir = path.dirname(toPath);
            if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
            if (fs.existsSync(toPath) && p.overwrite) {
              try { fs.unlinkSync(toPath); } catch (e) {}
            }
            if (fs.existsSync(toPath)) {
              resultItem.status = 'exists'; resultItem.to = toPath;
            } else {
              let linked = false, lastErr = null;
              for (let attempt = 0; attempt < 3; attempt++) {
                try { fs.linkSync(fromPath, toPath); linked = true; break; }
                catch (err) { lastErr = err; if (err.code === 'EEXIST') { linked = true; break; } await sleep(100 * (attempt + 1)); }
              }
              if (!linked) throw lastErr || new Error('Hardlink failed');
              const fromKey = canonicalize(fromPath);
              enrichCache[fromKey] = enrichCache[fromKey] || {};
              enrichCache[fromKey].applied = true; enrichCache[fromKey].hidden = true;
              enrichCache[fromKey].appliedAt = Date.now(); enrichCache[fromKey].appliedTo = toPath;
              const finalBasename = path.basename(toPath);
              enrichCache[fromKey].renderedName = finalBasename;
              enrichCache[fromKey].metadataFilename = finalBasename.replace(path.extname(finalBasename), '');
              const targetKey = canonicalize(toPath);
              renderedIndex[targetKey] = { source: fromPath, renderedName: finalBasename, appliedTo: toPath,
                metadataFilename: enrichCache[fromKey].metadataFilename, provider: enrichCache[fromKey].provider || null, parsed: enrichCache[fromKey].parsed || null };
              if (db) { 
                db.saveEnrichCacheBatch({ [fromKey]: enrichCache[fromKey] });
                db.setKV('renderedIndex', renderedIndex);
                db.logAction({ job_id: String(job.id), action_type: 'approve', original_path: fromPath, resolved_path: toPath });
              }
              appliedFromPaths.add(fromKey);
              appendLog(`JOB_APPROVE_HARDLINK from=${fromPath} to=${toPath}`);
              resultItem.status = 'hardlinked'; resultItem.to = toPath;
            }
            // Extract/copy subtitles for both new hardlinks and already-existing outputs
            if (resultItem.status === 'hardlinked' || resultItem.status === 'exists') {
              if (resolveCopySidecarSubtitlesSetting(username)) {
                try { copyExternalSubtitles(fromPath, toPath); } catch (e) {
                  appendLog(`SUBTITLE_SIDECAR_UNEXPECTED_ERROR from=${fromPath} err=${e && e.message ? e.message : String(e)}`);
                }
              }
              if (resolveExtractSubtitlesSetting(username)) {
                const subtitleFmt = resolveExtractSubtitleFormat(username);
                try { await extractSubtitlesToSrt(fromPath, toPath, subtitleFmt); } catch (e) {
                  appendLog(`SUBTITLE_EXTRACT_UNEXPECTED_ERROR from=${fromPath} err=${e && e.message ? e.message : String(e)}`);
                }
              }
              if (resolveHardsubSetting(username)) {
                const hardsubLang = resolveHardsubLanguage(username);
                try { await burnHardsubToFile(fromPath, toPath, hardsubLang); } catch (e) {
                  appendLog(`HARDSUB_UNEXPECTED_ERROR from=${fromPath} err=${e && e.message ? e.message : String(e)}`);
                }
              }
            }
          } catch (e) {
            resultItem.status = 'error'; resultItem.error = e.message;
            appendLog(`JOB_APPROVE_APPLY_ERROR item=${p.itemId} err=${e.message}`);
          }
          job.results.push(resultItem);
        }

        // Step 4: Final cache flush + remove applied items from scans
        if (!db) { try { writeJson(enrichStoreFile, enrichCache); } catch (e) {} try { writeJson(renderedIndexFile, renderedIndex); } catch (e) {} }
        else { try { persistEnrichCacheNow(); } catch (e) {} }
        if (appliedFromPaths.size > 0) {
          try {
            for (const sid of Object.keys(scans || {})) {
              const scan = scans[sid]; if (!scan || !Array.isArray(scan.items)) continue;
              const before = scan.items.length;
              scan.items = scan.items.filter(it => { try { return !appliedFromPaths.has(canonicalize(it.canonicalPath)); } catch (e) { return true; } });
              if (scan.items.length !== before) scan.totalCount = scan.items.length;
            }
            if (db) db.saveScansObject(scans); else writeJson(scanStoreFile, scans);
          } catch (e) { appendLog(`JOB_APPROVE_SCAN_FILTER_FAIL err=${e && e.message ? e.message : String(e)}`); }
        }

        job.status = 'done';
        job.completedAt = Date.now();
        if (typeof broadcastEvent === 'function') { try { broadcastEvent('job_updated', job); } catch(e) {} }
        appendLog(`JOB_APPROVE_DONE id=${job.id} applied=${appliedFromPaths.size}/${items.length}`);
      } catch (e) {
        job.status = 'error'; job.error = e.message; job.completedAt = Date.now();
        if (typeof broadcastEvent === 'function') { try { broadcastEvent('job_updated', job); } catch(e) {} }
        appendLog(`JOB_APPROVE_FAIL id=${job.id} err=${e.message}`);
      }
    })();
  } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

router.post('/api/jobs/backfill-subtitles', requireAuth, async (req, res) => {
  try {
    const username = req.session && req.session.username ? req.session.username : null;
    if (!resolveExtractSubtitlesSetting(username)) {
      return res.status(400).json({ error: 'Extract subtitles setting is disabled' });
    }
    const subtitleFmt = resolveExtractSubtitleFormat(username);

    // Collect approved items: enrichCache entries where applied=true and appliedTo exists
    const candidates = [];
    for (const [fromKey, entry] of Object.entries(enrichCache || {})) {
      if (!entry || !entry.applied || !entry.appliedTo) continue;
      candidates.push({ fromPath: fromKey, toPath: entry.appliedTo });
    }

    const job = createBgJob('backfill-subtitles', candidates.length);
    res.json({ jobId: job.id, status: 'running', total: candidates.length });

    ;(async () => {
      try {
        let skipped = 0, extracted = 0, missing = 0, errors = 0;
        const processedFromPaths = new Set(candidates.map(c => c.fromPath));

        async function processBackfillItem(fromPath, toPath) {
          if (!fs.existsSync(fromPath)) { missing++; return; }
          if (!fs.existsSync(toPath)) { missing++; return; }
          const toDir = path.dirname(toPath);
          const toExt = path.extname(toPath);
          const toBase = path.basename(toPath, toExt);
          let existingEntries;
          try { existingEntries = fs.readdirSync(toDir).filter(f => {
            if (!f.startsWith(toBase)) return false;
            const fe = path.extname(f).toLowerCase();
            return SUBTITLE_EXTS.has(fe);
          }); } catch (e) { existingEntries = []; }
          if (existingEntries.length > 0) { skipped++; return; }
          if (resolveCopySidecarSubtitlesSetting(username)) {
            try { copyExternalSubtitles(fromPath, toPath); } catch (e) {
              appendLog(`BACKFILL_SUBTITLE_SIDECAR_ERROR from=${fromPath} err=${e && e.message ? e.message : String(e)}`);
            }
          }
          await extractSubtitlesToSrt(fromPath, toPath, subtitleFmt);
          extracted++;
        }

        for (const { fromPath, toPath } of candidates) {
          try {
            await processBackfillItem(fromPath, toPath);
          } catch (e) {
            errors++;
            appendLog(`BACKFILL_SUBTITLE_ERROR from=${fromPath} err=${e && e.message ? e.message : String(e)}`);
          }
          job.processedItems++;
        }

        // Second sweep: pick up any items approved while this backfill was running
        const lateEntries = [];
        for (const [fromKey, entry] of Object.entries(enrichCache || {})) {
          if (!entry || !entry.applied || !entry.appliedTo) continue;
          if (processedFromPaths.has(fromKey)) continue; // already handled above
          lateEntries.push({ fromPath: fromKey, toPath: entry.appliedTo });
        }
        if (lateEntries.length > 0) {
          job.totalItems += lateEntries.length;
          for (const { fromPath, toPath } of lateEntries) {
            try {
              await processBackfillItem(fromPath, toPath);
            } catch (e) {
              errors++;
              appendLog(`BACKFILL_SUBTITLE_LATE_ERROR from=${fromPath} err=${e && e.message ? e.message : String(e)}`);
            }
            job.processedItems++;
          }
        }

        job.status = 'done'; job.completedAt = Date.now();
        const total = candidates.length + lateEntries.length;
        job.results = [{ extracted, skipped, missing, errors, total }];
        appendLog(`JOB_BACKFILL_SUBTITLES done extracted=${extracted} skipped=${skipped} missing=${missing} errors=${errors} late=${lateEntries.length}`);
      } catch (e) {
        job.status = 'error'; job.error = e.message; job.completedAt = Date.now();
        appendLog(`JOB_BACKFILL_SUBTITLES_FAIL err=${e.message}`);
      }
    })();
  } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

router.post('/api/jobs/bulk-rescan', requireAuth, async (req, res) => {
  try {
    const { paths, force, skipAnimeProviders } = req.body || {};
    if (!paths || !Array.isArray(paths) || !paths.length) return res.status(400).json({ error: 'paths required' });
    const username = req.session && req.session.username ? req.session.username : null;
    let tmdbKey = null;
    try {
      if (username && users[username] && users[username].settings && users[username].settings.tmdb_api_key) tmdbKey = users[username].settings.tmdb_api_key;
      else if (serverSettings && serverSettings.tmdb_api_key) tmdbKey = serverSettings.tmdb_api_key;
    } catch (e) {}

    const job = createBgJob('bulk-rescan', paths.length);
    res.json({ jobId: job.id, status: 'running' });

    ;(async () => {
      let forcedHash = false;
      let globalSkipAnime = false;
      if (username && users[username] && users[username].settings && users[username].settings.default_rescan_force_hash !== undefined) {
        forcedHash = coerceBoolean(users[username].settings.default_rescan_force_hash);
      } else if (serverSettings && serverSettings.default_rescan_force_hash !== undefined) {
        forcedHash = coerceBoolean(serverSettings.default_rescan_force_hash);
      } else {
        const _refreshProviderOrder = resolveMetadataProviderOrder(username);
        forcedHash = (_refreshProviderOrder && _refreshProviderOrder.length && _refreshProviderOrder[0] === 'anidb');
      }

      if (username && users[username] && users[username].settings && users[username].settings.default_rescan_skip_anime !== undefined) {
        globalSkipAnime = coerceBoolean(users[username].settings.default_rescan_skip_anime);
      } else if (serverSettings && serverSettings.default_rescan_skip_anime !== undefined) {
        globalSkipAnime = coerceBoolean(serverSettings.default_rescan_skip_anime);
      }

      const RATE_DELAY_MS = 350;
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < paths.length; i++) {
        const p = paths[i];
        const resultItem = { path: p, status: 'pending' };
        try {
          const fromPath = canonicalize(p);
          const opts = { username, force: coerceBoolean(force) };
          if (forcedHash) opts.forceHash = true;
          if (typeof skipAnimeProviders === 'boolean') {
            opts.skipAnimeProviders = skipAnimeProviders;
          } else if (globalSkipAnime) {
            opts.skipAnimeProviders = true;
          }
          const data = await externalEnrich(fromPath, tmdbKey, opts);
          if (data) {
            // Mirror what the POST /enrich route does: build provider block + update cache
            const providerRendered = renderProviderName(data, fromPath, null);
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
          resultItem.status = data ? 'ok' : 'empty';
        } catch (e) {
          resultItem.status = 'error'; resultItem.error = e.message;
          appendLog(`JOB_RESCAN_FAIL path=${p} err=${e.message}`);
        }
        job.results.push(resultItem);
        job.processedItems = i + 1;
        if (i < paths.length - 1) await sleep(RATE_DELAY_MS);
      }
      try { persistEnrichCacheNow(); } catch (e) {}
      job.status = 'done'; job.completedAt = Date.now();
      appendLog(`JOB_RESCAN_DONE id=${job.id} processed=${job.processedItems}/${paths.length}`);
    })();
  } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

  return router;
};
