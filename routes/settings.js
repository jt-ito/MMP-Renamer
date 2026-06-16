module.exports = function createSettingsRoutes(ctx) {
  const router = require('express').Router();
  const {
  app,
  fs,
  path,
  tvdb,
  settingsFile,
  usersFile,
  logsFile,
  manualIdsFile,
  serverSettings,
  users,
  manualIds,
  normalizeManualIdKey,
  normalizeManualIdValue,
  normalizeAniDbEpisodeId,
  normalizeManualPathKey,
  requireAuth,
  requireAdmin,
  coerceBoolean,
  appendLog,
  writeJson,
  getEffectiveScanInputPath,
  isFolderWatchEnabledForUser,
  startFolderWatcher,
  stopFolderWatcher,
  canonicalize,
  resolveDeleteHardlinksSetting,
  sanitizeMetadataProviderOrder,
  VALID_SUBTITLE_FORMATS
} = ctx;

  router.get('/api/meta/status', requireAuth, (req, res) => {
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

router.get('/api/tmdb/status', (req, res) => {
  return app._router.handle(req, res, () => {}, 'GET', '/api/meta/status')
})

router.get('/api/settings', requireAuth, (req, res) => {
  const userSettings = (req.session && req.session.username && users[req.session.username] && users[req.session.username].settings) ? users[req.session.username].settings : {};
  const serverOut = { ...(serverSettings || {}) };
  serverOut.delete_hardlinks_on_unapprove = resolveDeleteHardlinksSetting(req.session && req.session.username ? req.session.username : null);
  return res.json({ serverSettings: serverOut, userSettings });
});

router.post('/api/settings', requireAuth, (req, res) => {
  const body = req.body || {};
  const username = req.session && req.session.username;
  try {
    // if admin requested global update
    if (username && users[username] && users[username].role === 'admin' && body.global) {
      // Admins may set global server settings, but not a global scan_input_path (per-user only)
  const allowed = ['tmdb_api_key', 'anilist_api_key', 'anidb_username', 'anidb_password', 'anidb_client_name', 'anidb_client_version', 'scan_output_path', 'rename_template', 'default_meta_provider', 'metadata_provider_order', 'tvdb_v4_api_key', 'tvdb_v4_user_pin', 'output_folders', 'delete_hardlinks_on_unapprove', 'extract_subtitles', 'extract_subtitle_format', 'copy_sidecar_subtitles', 'client_os', 'log_timezone', 'custom_regexes', 'default_rescan_force_hash', 'default_rescan_skip_anime'];
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
        } else if (k === 'extract_subtitles') {
          serverSettings.extract_subtitles = coerceBoolean(body[k]);
        } else if (k === 'extract_subtitle_format') {
          if (VALID_SUBTITLE_FORMATS.has(body[k])) serverSettings.extract_subtitle_format = body[k];
        } else if (k === 'copy_sidecar_subtitles') {
          serverSettings.copy_sidecar_subtitles = coerceBoolean(body[k]);
        } else if (k === 'default_rescan_force_hash') {
          serverSettings.default_rescan_force_hash = coerceBoolean(body[k]);
        } else if (k === 'default_rescan_skip_anime') {
          serverSettings.default_rescan_skip_anime = coerceBoolean(body[k]);
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
      global.customRegexes = (serverSettings.custom_regexes || []).map(r => { try { return new RegExp(r, 'i') } catch(e) { return null } }).filter(Boolean);
      writeJson(settingsFile, serverSettings);
      appendLog(`SETTINGS_SAVED_GLOBAL by=${username} keys=${Object.keys(body).join(',')}`);
      return res.json({ ok: true, settings: serverSettings });
    }

    // otherwise save per-user
    if (!username) return res.status(401).json({ error: 'unauthenticated' });
    users[username] = users[username] || {};
    users[username].settings = users[username].settings || {};
  const allowed = ['tmdb_api_key', 'anilist_api_key', 'anidb_username', 'anidb_password', 'anidb_client_name', 'anidb_client_version', 'scan_input_path', 'scan_output_path', 'rename_template', 'default_meta_provider', 'metadata_provider_order', 'tvdb_v4_api_key', 'tvdb_v4_user_pin', 'output_folders', 'enable_folder_watch', 'delete_hardlinks_on_unapprove', 'extract_subtitles', 'copy_sidecar_subtitles', 'client_os', 'log_timezone', 'custom_regexes', 'default_rescan_force_hash', 'default_rescan_skip_anime'];
    
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
      } else if (k === 'extract_subtitles') {
        users[username].settings.extract_subtitles = coerceBoolean(body[k]);
      } else if (k === 'extract_subtitle_format') {
        if (VALID_SUBTITLE_FORMATS.has(body[k])) users[username].settings.extract_subtitle_format = body[k];
      } else if (k === 'copy_sidecar_subtitles') {
        users[username].settings.copy_sidecar_subtitles = coerceBoolean(body[k]);
      } else if (k === 'default_rescan_force_hash') {
        users[username].settings.default_rescan_force_hash = coerceBoolean(body[k]);
      } else if (k === 'default_rescan_skip_anime') {
        users[username].settings.default_rescan_skip_anime = coerceBoolean(body[k]);
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
    if (body.custom_regexes !== undefined) {
      let allRegexes = new Set(serverSettings.custom_regexes || []);
      for (const u of Object.values(users)) {
        if (u.settings && u.settings.custom_regexes) {
          u.settings.custom_regexes.forEach(r => allRegexes.add(r));
        }
      }
      global.customRegexes = Array.from(allRegexes).map(r => { try { return new RegExp(r, 'i') } catch(e) { return null } }).filter(Boolean);
    }
    writeJson(usersFile, users);
    appendLog(`SETTINGS_SAVED_USER user=${username} keys=${Object.keys(body).join(',')}`);
    
    const pathChanged = newScanPath !== undefined && newScanPath !== oldScanPath;
    const watchToggled = watchProvided && newWatchEnabled !== oldWatchEnabled;
    if (pathChanged || watchToggled) {
      stopFolderWatcher(username);
      const finalPath = getEffectiveScanInputPath(username);
      if (isFolderWatchEnabledForUser(username) && finalPath) {
        const libPath = path.resolve(finalPath);
        startFolderWatcher(username, libPath);
      }
    }
    
    return res.json({ ok: true, userSettings: users[username].settings });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.get('/api/manual-ids', requireAuth, (req, res) => {
  try {
    return res.json({ manualIds });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.get('/api/path/exists', requireAuth, (req, res) => { const p = req.query.path || ''; try { const rp = path.resolve(p); const exists = fs.existsSync(rp); const stat = exists ? fs.statSync(rp) : null; res.json({ exists, isDirectory: stat ? stat.isDirectory() : false, resolved: rp }); } catch (err) { res.json({ exists: false, isDirectory: false, error: err.message }); } });

router.get('/api/manual-ids', requireAuth, requireAdmin, (req, res) => {
  try {
    return res.json({ manualIds: manualIds || {} });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

router.post('/api/manual-ids', requireAuth, requireAdmin, (req, res) => {
  try {
    const title = req && req.body ? req.body.title : null;
    if (!title) return res.status(400).json({ error: 'title is required' });
    const aliasTitles = (req && req.body && Array.isArray(req.body.aliasTitles)) ? req.body.aliasTitles : [];
    const filePath = req && req.body ? req.body.filePath : null;
    const normalizedFilePath = filePath ? normalizeManualPathKey(filePath) : null;
    let canonicalFilePath = null;
    try { canonicalFilePath = normalizedFilePath ? canonicalize(normalizedFilePath) : null; } catch (e) { canonicalFilePath = normalizedFilePath; }
    const filePathKeys = Array.from(new Set([filePath, normalizedFilePath, canonicalFilePath].filter(Boolean)));
    
    const keys = [title, ...aliasTitles]
      .map((value) => normalizeManualIdKey(value))
      .filter(Boolean)
      .filter((value, index, arr) => arr.indexOf(value) === index);
    if (!keys.length) return res.status(400).json({ error: 'invalid title' });

    const seriesEntry = {};
    const anilistId = normalizeManualIdValue(req.body.anilist);
    const tmdbId = normalizeManualIdValue(req.body.tmdb);
    const tvdbId = normalizeManualIdValue(req.body.tvdb);
    const anidbEpisodeId = normalizeAniDbEpisodeId(req.body.anidbEpisode);

    if (anidbEpisodeId !== null && !filePath) {
      return res.status(400).json({ error: 'filePath is required when setting anidbEpisode' });
    }

    // Series-level IDs go in the series entry
    if (anilistId !== null) seriesEntry.anilist = anilistId;
    if (tmdbId !== null) seriesEntry.tmdb = tmdbId;
    if (tvdbId !== null) seriesEntry.tvdb = tvdbId;
    // Media type hints for TMDB and TVDB (distinguishes movie vs TV/series endpoints)
    const tmdbType = req.body.tmdbType === 'movie' ? 'movie' : (req.body.tmdbType === 'tv' ? 'tv' : null);
    const tvdbType = req.body.tvdbType === 'movie' ? 'movie' : (req.body.tvdbType === 'series' ? 'series' : null);
    if (tmdbType !== null) seriesEntry.tmdbType = tmdbType;
    if (tvdbType !== null) seriesEntry.tvdbType = tvdbType;

    const rawClear = req && req.body ? req.body.clear : null;
    const clearRequested = rawClear === true || rawClear === 'true' || rawClear === 1 || rawClear === '1';

    // manualIds is always an object and passed by reference as const, do not reassign
    
    // Handle series-level IDs (AniList, TMDB, TVDB)
    if (Object.keys(seriesEntry).length === 0 && !anidbEpisodeId) {
      if (!clearRequested) {
        return res.status(400).json({ error: 'at least one manual ID is required (or pass clear=true to delete existing mapping)' });
      }
      for (const key of keys) {
        if (manualIds[key]) {
          // Only remove series-level IDs, preserve episode-level IDs
          delete manualIds[key].anilist;
          delete manualIds[key].tmdb;
          delete manualIds[key].tmdbType;
          delete manualIds[key].tvdb;
          delete manualIds[key].tvdbType;
          if (Object.keys(manualIds[key]).length === 0) delete manualIds[key];
        }
      }
      // Also clear episode-specific entry if clearing all
      for (const pathKey of filePathKeys) {
        if (manualIds[pathKey]) delete manualIds[pathKey];
      }
      try {
        appendLog(`MANUAL_ID_CLEARED title=${normalizeManualIdKey(title)} aliases=${Math.max(0, keys.length - 1)} by=${req && req.session && req.session.username ? req.session.username : 'unknown'}`);
      } catch (e) {}
    } else {
      // Save series-level IDs to all title keys
      if (Object.keys(seriesEntry).length > 0) {
        for (const key of keys) {
          if (!manualIds[key]) manualIds[key] = {};
          Object.assign(manualIds[key], seriesEntry);
          // If type hints were not sent, clear any previously stored ones so stale
          // values don't persist after the user unchecks the checkbox.
          if (tmdbType === null) delete manualIds[key].tmdbType;
          if (tvdbType === null) delete manualIds[key].tvdbType;
        }
      }
      
      // Handle episode-level AniDB Episode ID (stored per file path)
      if (anidbEpisodeId !== null && filePathKeys.length) {
        for (const pathKey of filePathKeys) {
          if (!manualIds[pathKey]) manualIds[pathKey] = {};
          manualIds[pathKey].anidbEpisode = anidbEpisodeId;
        }
        
        // Clean up old episode IDs that were stored at title keys (migration cleanup)
        // Episode IDs should only be stored at file paths, not title keys
        for (const key of keys) {
          if (manualIds[key] && manualIds[key].anidbEpisode) {
            delete manualIds[key].anidbEpisode;
            if (Object.keys(manualIds[key]).length === 0) {
              delete manualIds[key];
            }
          }
        }
      } else if (anidbEpisodeId === null && filePathKeys.length) {
        // Clear episode ID if explicitly set to null
        for (const pathKey of filePathKeys) {
          if (!manualIds[pathKey]) continue;
          delete manualIds[pathKey].anidbEpisode;
          if (Object.keys(manualIds[pathKey]).length === 0) delete manualIds[pathKey];
        }
      }
      
      try {
        const episodeNote = normalizedFilePath ? ` filePath=${normalizedFilePath}` : '';
        const canonicalNote = canonicalFilePath ? ` canonicalFilePath=${canonicalFilePath}` : '';
        appendLog(`MANUAL_ID_SAVED title=${normalizeManualIdKey(title)} anilist=${anilistId != null ? anilistId : '<none>'} tmdb=${tmdbId != null ? tmdbId : '<none>'} tvdb=${tvdbId != null ? tvdbId : '<none>'} anidbEpisode=${anidbEpisodeId != null ? anidbEpisodeId : '<none>'}${episodeNote}${canonicalNote} filePathKeys=${filePathKeys.length} aliases=${Math.max(0, keys.length - 1)} by=${req && req.session && req.session.username ? req.session.username : 'unknown'}`);
      } catch (e) {}
    }

    try { writeJson(manualIdsFile, manualIds); } catch (e) {}
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

router.get('/api/tvdb/status', (req, res) => {
  return app._router.handle(req, res, () => {}, 'GET', '/api/meta/status')
})

router.get('/api/tmdb/status', (req, res) => {
  return app._router.handle(req, res, () => {}, 'GET', '/api/meta/status')
})

  return router;
};
