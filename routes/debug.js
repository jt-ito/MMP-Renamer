module.exports = function createDebugRoutes(ctx) {
  const router = require('express').Router();
  const {
  app,
  fs,
  path,
  enrichStoreFile,
  parsedCacheFile,
  renderedIndexFile,
  logsFile,
  hideEvents,
  db,
  enrichCache,
  activeScans,
  refreshProgress,
  sseClients,
  requireAuth,
  requireAdmin,
  appendLog,
  performUnapprove
} = ctx;

  router.get('/api/events', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  
  const client = { res, username: req.session.username };
  sseClients.add(client);
  
  req.on('close', () => {
    sseClients.delete(client);
  });
});

router.get('/api/debug/locks', requireAuth, (req, res) => {
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

router.post('/api/debug/client-refreshed', requireAuth, (req, res) => {
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

router.get('/api/_health', (req, res) => {
  try {
    const lastHide = (Array.isArray(hideEvents) && hideEvents.length) ? hideEvents[hideEvents.length - 1].ts : null
    const logStat = fs.existsSync(logsFile) ? fs.statSync(logsFile) : null
    return res.json({ ok: true, lastHideEventTs: lastHide, logsSize: logStat ? logStat.size : 0 })
  } catch (e) { return res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) }) }
})

router.get('/api/history', requireAuth, requireAdmin, (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '100', 10);
    const history = db ? db.getHistory(limit) : [];
    res.json({ ok: true, history });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/history/undo', requireAuth, requireAdmin, (req, res) => {
  try {
    const username = req.session && req.session.username ? req.session.username : null;
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [req.body.id].filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'Missing action IDs to undo' });
    
    const pathsToUnapprove = [];
    if (db) {
      for (const id of ids) {
        const action = db.getActionById(id);
        if (action && action.status === 'applied') {
          pathsToUnapprove.push(action.original_path);
          db.updateActionStatus(id, 'reverted');
        }
      }
    }
    
    if (pathsToUnapprove.length > 0) {
      const { changed, deletedHardlinks, hardlinkErrors } = performUnapprove({ requestedPaths: pathsToUnapprove, username });
      appendLog(`UNDO_HISTORY ids=${ids.join(',')} unapproved=${changed.length}`);
      res.json({ ok: true, unapproved: changed, deletedHardlinks, hardlinkErrors });
    } else {
      res.json({ ok: true, unapproved: [] });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/logs/recent', requireAuth, requireAdmin, (req, res) => {
  try {
    if (!fs.existsSync(logsFile)) return res.json({ logs: '' })
    const stat = fs.statSync(logsFile)
    // Dashboard mode needs a much larger read window: approved-series image-fetching can flood
    // the log tail with APPROVED_SERIES_* entries, which are all filtered out on the dashboard
    // side — leaving no visible lines unless we read back far enough to find older ones.
    const filterMode = req.query.filter || 'dashboard'
    const maxBytes = filterMode === 'dashboard' ? 2 * 1024 * 1024 : 200 * 1024
    const start = Math.max(0, stat.size - maxBytes)
    const stream = fs.createReadStream(logsFile, { start, end: stat.size })
    let sb = ''
    stream.setEncoding('utf8')
    stream.on('data', d => sb += d)
    stream.on('error', (err) => {
      try { console.error('logs/recent stream failed', err && err.message ? err.message : err) } catch (ee) {}
      try {
        const stat2 = fs.existsSync(logsFile) ? fs.statSync(logsFile) : null
        const info = stat2 ? { size: stat2.size, mtime: stat2.mtimeMs } : { size: 0 }
        return res.json({ logs: '', fallback: true, message: 'logs temporarily unavailable', info })
      } catch (ee) {
        return res.json({ logs: '', fallback: true, message: 'logs temporarily unavailable' })
      }
    })
    stream.on('end', () => {
      try {
        // Parse query parameters: line count (filterMode already resolved above)
        const lineCount = parseInt(req.query.lines, 10) || 200
        const isApprovedSeriesLog = (line) => {
          const text = String(line || '').trim()
          if (!text) return false
          const content = text.replace(/^\S+\s+/, '')
          return content.includes('APPROVED_SERIES_')
        }
        
        // Split into lines and filter based on mode
        let lines = String(sb || '').split('\n')
        
        // Apply filtering based on filter mode
        if (filterMode === 'dashboard') {
          // Dashboard mode: exclude APPROVED_SERIES_* logs to reduce noise
          lines = lines.filter(line => !isApprovedSeriesLog(line))
        } else if (filterMode === 'approved_series') {
          // Approved Series mode: show only APPROVED_SERIES_* logs for debugging artwork fetching
          lines = lines.filter(line => isApprovedSeriesLog(line))
          // If a specific outputKey was requested, scope to that output only.
          // Use a two-pass approach: first collect series names seen in FETCH_ATTEMPT/SOURCE_RESOLVED
          // lines for this output, then filter all lines to those that reference the output or
          // one of its known series names.
          const requestedOutputKey = req.query.outputKey ? String(req.query.outputKey).trim() : ''
          if (requestedOutputKey) {
            // Pass 1: extract series names from lines that contain the output key
            const outputSeriesNames = new Set()
            for (const line of lines) {
              const content = line.replace(/^\S+\s+/, '')
              // Lines that explicitly reference the output key (FETCH_ATTEMPT has output=, SOURCE_RESOLVED has key=)
              if (content.includes(`output=${requestedOutputKey}`) || content.includes(`key=${requestedOutputKey}`)) {
                // Extract the series name: appears as series=NAME followed by a space+word= key
                const sm = content.match(/series=(.+?)(?:\s+(?:source|aid|output|reason|anidbId|cached|requested|result|imageUrl|provider|restricted|forceHash|force)\s*=)/)
                if (sm && sm[1]) outputSeriesNames.add(sm[1].trim())
              }
            }
            // Pass 2: keep lines that match the output key directly OR mention a known series for that output.
            // Build a sorted-longest-first list so partial-prefix names don't shadow longer ones.
            const sortedNames = Array.from(outputSeriesNames).sort((a, b) => b.length - a.length)
            lines = lines.filter(line => {
              const content = line.replace(/^\S+\s+/, '')
              if (content.includes(`output=${requestedOutputKey}`) || content.includes(`key=${requestedOutputKey}`)) return true
              if (sortedNames.length > 0) {
                const idx = content.indexOf('series=')
                if (idx !== -1) {
                  const after = content.slice(idx + 'series='.length)
                  for (const name of sortedNames) {
                    if (after.startsWith(name) && (after.length === name.length || after[name.length] === ' ')) return true
                  }
                }
              }
              return false
            })
          }
        }
        // For any other filter mode or no filter, show all logs
        
        // Take the last N lines and join them back
        const tail = lines.slice(-lineCount).join('\n')
        return res.json({ logs: tail })
      } catch (e) {
        try { console.error('logs/recent post-process failed', e && e.message ? e.message : e) } catch (ee) {}
        return res.status(500).json({ error: e && e.message ? e.message : String(e) })
      }
    })
  } catch (e) {
    try { console.error('logs/recent read failed', e && e.message ? e.message : e) } catch (ee) {}
    return res.status(500).json({ error: e && e.message ? e.message : String(e) })
  }
});

router.post('/api/logs/clear', requireAuth, requireAdmin, (req, res) => {
  fs.writeFileSync(logsFile, '');
  res.json({ ok: true });
});

router.get('/api/debug/trace', requireAuth, requireAdmin, (req, res) => {
  try {
    const tail = fs.existsSync(logsFile) ? fs.readFileSync(logsFile, 'utf8').split('\n').slice(-500).join('\n') : '';
    const state = {
      pid: process.pid,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      hideEventsLen: Array.isArray(hideEvents) ? hideEvents.length : 0,
      enrichCacheSize: Object.keys(enrichCache || {}).length,
      refreshProgressKeys: Object.keys(refreshProgress || {}).length
    }
    return res.json({ ok: true, state, logs: tail })
  } catch (e) {
    try { appendLog(`TRACE_ERR err=${e && e.message ? e.message : String(e)}`) } catch (ee) {}
    return res.status(500).json({ error: e && e.message ? e.message : String(e) })
  }
})

  return router;
};
