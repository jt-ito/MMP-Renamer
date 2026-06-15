module.exports = function createApprovedSeriesRoutes(ctx) {
  const router = require('express').Router();
  const {
  app,
  path,
  approvedSeriesImagesFile,
  enrichCache,
  requireAuth,
  requireAdmin,
  appendLog,
  writeJson,
  getSeriesNameForApprovedEntry
} = ctx;

  router.get('/api/approved-series', requireAuth, (req, res) => {
  try {
    const username = req.session && req.session.username ? req.session.username : null;
    const payload = buildApprovedSeriesPayload(username);
    return res.json(payload);
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

router.get('/api/approved-series/items', requireAuth, (req, res) => {
  try {
    const outputKey = normalizeOutputKey(req.query.outputKey || '');
    const seriesName = String(req.query.seriesName || '').trim();
    if (!outputKey || !seriesName) return res.status(400).json({ error: 'outputKey and seriesName are required' });

    const items = [];
    for (const cacheKey of Object.keys(enrichCache || {})) {
      const entry = enrichCache[cacheKey];
      if (!entry || entry.applied !== true || !entry.appliedTo) continue;
      const targets = Array.isArray(entry.appliedTo) ? entry.appliedTo : [entry.appliedTo];
      for (const target of targets) {
        if (!target) continue;
        const targetOutputKey = normalizeOutputKey(deriveAppliedSeriesInfo(target).outputRoot || path.dirname(path.dirname(target)));
        if (targetOutputKey !== outputKey) continue;
        const entrySeriesName = getSeriesNameForApprovedEntry(entry, target);
        if (entrySeriesName !== seriesName) continue;
        const info = deriveAppliedSeriesInfo(target);
        const provider = entry.provider || {};
        const parsed = entry.parsed || {};
        items.push({
          path: target,
          basename: path.basename(target),
          seasonFolder: info.seriesFolder ? path.basename(info.seriesFolder) : null,
          providerTitle: provider.renderedName || provider.title || null,
          providerEpisodeTitle: provider.episodeTitle || null,
          providerYear: provider.year || null,
          parsedTitle: parsed.parsedName || parsed.title || null,
          appliedAt: entry.appliedAt || null
        });
      }
    }

    items.sort((a, b) => a.basename.localeCompare(b.basename, undefined, { numeric: true, sensitivity: 'base' }));
    return res.json({ items, seriesName, outputKey });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

router.post('/api/approved-series/source', requireAuth, (req, res) => {
  try {
    const username = req.session && req.session.username ? req.session.username : null;
    const outputKey = normalizeOutputKey(req && req.body ? req.body.outputKey : '');
    const source = normalizeApprovedSeriesSource(req && req.body ? req.body.source : 'anilist');
    if (!outputKey) return res.status(400).json({ error: 'outputKey is required' });
    if (!['anilist', 'tmdb', 'anidb'].includes(source)) return res.status(400).json({ error: 'invalid source' });
    const ok = setApprovedSeriesSourcePreference(username, outputKey, source);
    if (!ok) return res.status(500).json({ error: 'failed to save preference' });
    return res.json({ ok: true, source });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

router.post('/api/approved-series/clear-cache', requireAuth, requireAdmin, (req, res) => {
  try {
    const outputKey = normalizeOutputKey(req && req.body ? req.body.outputKey : '');
    if (!outputKey) return res.status(400).json({ error: 'outputKey is required' });

    let removed = 0;
    for (const key of Object.keys(approvedSeriesImages || {})) {
      if (!key || !key.startsWith(`${outputKey}::`)) continue;
      delete approvedSeriesImages[key];
      removed += 1;
    }

    for (const lockKey of Array.from(approvedSeriesImageFetchLocks.keys())) {
      if (!lockKey || lockKey.indexOf(`::${outputKey}::`) === -1) continue;
      approvedSeriesImageFetchLocks.delete(lockKey);
    }

    try { writeJson(approvedSeriesImagesFile, approvedSeriesImages); } catch (e) {}
    try { appendLog(`APPROVED_SERIES_CACHE_CLEARED outputKey=${outputKey} removed=${removed}`); } catch (e) {}
    return res.json({ ok: true, removed, outputKey });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

router.post('/api/approved-series/fetch-images', requireAuth, async (req, res) => {
  try {
    const username = req.session && req.session.username ? req.session.username : null;
    const outputKey = normalizeOutputKey(req && req.body ? req.body.outputKey : '');
    if (!outputKey) return res.status(400).json({ error: 'outputKey is required' });

    const payload = buildApprovedSeriesPayload(username);
    const output = (payload.outputs || []).find((o) => o.key === outputKey);
    if (!output) return res.status(404).json({ error: 'output not found' });

    const sourcePrefs = getApprovedSeriesSourcePreferences(username);
    const resolvedPref = resolveApprovedSeriesSourcePreference(sourcePrefs, outputKey);
    const selectedSource = normalizeApprovedSeriesSource((req && req.body && req.body.source) || resolvedPref.source || 'anilist');
    if (!['anilist', 'tmdb', 'anidb'].includes(selectedSource)) return res.status(400).json({ error: 'invalid source' });

    setApprovedSeriesSourcePreference(username, outputKey, selectedSource);

    let fetched = 0;
    let skipped = 0;
    const seriesList = Array.isArray(output.series) ? output.series : [];
    for (const series of seriesList) {
      const seriesName = series && series.name ? String(series.name) : '';
      if (!seriesName) { skipped++; continue; }
      const result = await fetchAndCacheApprovedSeriesImage({ username, outputKey, source: selectedSource, seriesName, allowCooldown: true });
      if (result && result.fetched) fetched++;
      else skipped++;
    }
    return res.json({ ok: true, fetched, skipped, source: selectedSource });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

router.post('/api/approved-series/fetch-image', requireAuth, async (req, res) => {
  try {
    const username = req.session && req.session.username ? req.session.username : null;
    const outputKey = normalizeOutputKey(req && req.body ? req.body.outputKey : '');
    const seriesName = req && req.body && req.body.seriesName ? String(req.body.seriesName).trim() : '';
    if (!outputKey) return res.status(400).json({ error: 'outputKey is required' });
    if (!seriesName) return res.status(400).json({ error: 'seriesName is required' });

    const sourcePrefs = getApprovedSeriesSourcePreferences(username);
    const resolvedPref = resolveApprovedSeriesSourcePreference(sourcePrefs, outputKey);
    const selectedSource = normalizeApprovedSeriesSource((req && req.body && req.body.source) || resolvedPref.source || 'anilist');
    if (!['anilist', 'tmdb', 'anidb'].includes(selectedSource)) return res.status(400).json({ error: 'invalid source' });

    const result = await fetchAndCacheApprovedSeriesImage({ username, outputKey, source: selectedSource, seriesName, allowCooldown: true });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

router.post('/api/approved-series/refresh-series', requireAuth, async (req, res) => {
  try {
    const username = req.session && req.session.username ? req.session.username : null;
    const outputKey = normalizeOutputKey(req && req.body ? req.body.outputKey : '');
    const seriesName = req && req.body && req.body.seriesName ? String(req.body.seriesName).trim() : '';
    if (!outputKey) return res.status(400).json({ error: 'outputKey is required' });
    if (!seriesName) return res.status(400).json({ error: 'seriesName is required' });
    const sourcePrefs = getApprovedSeriesSourcePreferences(username);
    const resolvedPref = resolveApprovedSeriesSourcePreference(sourcePrefs, outputKey);
    const selectedSource = normalizeApprovedSeriesSource((req && req.body && req.body.source) || resolvedPref.source || 'anilist');
    if (!['anilist', 'tmdb', 'anidb'].includes(selectedSource)) return res.status(400).json({ error: 'invalid source' });
    const result = await fetchAndCacheApprovedSeriesImage({ username, outputKey, source: selectedSource, seriesName, allowCooldown: false, force: true });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

  return router;
};
