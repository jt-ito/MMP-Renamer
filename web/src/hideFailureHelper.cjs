// Single clean implementation (no corrupted duplicates, no stray 'break').
module.exports = async function handleHideFailureCore(opts) {
  const {
    candidates = [],
    waitForHideEvent,
    fetchEnrichByPath,
    fetchScanMeta,
    fetchScanItemsPage,
    updateScanDataAndPreserveView,
    setEnrichCache,
    setItems,
    setAllItems,
    scanId,
    lastScanId,
    batchSize = 12,
    pushToast,
    postClientRefreshed
  } = opts || {}

  try {
    const ev = await waitForHideEvent(candidates, 4000, 350)
    if (!ev) return false

    const path = ev.path || ev.originalPath || (Array.isArray(candidates) ? candidates[0] : undefined)

    if (path && fetchEnrichByPath) {
      try {
        const auth = await fetchEnrichByPath(path)
        const norm = auth || null
        if (norm) {
          try { setEnrichCache && setEnrichCache(prev => ({ ...prev, [path]: norm })) } catch (e) {}
          if (norm.hidden || norm.applied) {
            try { setItems && setItems(prev => prev.filter(x => x.canonicalPath !== path)) } catch (e) {}
            try { setAllItems && setAllItems(prev => prev.filter(x => x.canonicalPath !== path)) } catch (e) {}
          }
        }
      } catch (e) { /* swallow per-path error */ }
    }

    const modified = Array.isArray(ev.modifiedScanIds) ? ev.modifiedScanIds : []
    const activeSearch = (typeof window !== 'undefined' && window && window.__CLIENT_ACTIVE_SEARCH__)
    const sidFallback = scanId || lastScanId

    const reloadList = (modified && modified.length) ? modified.filter(sid => sid === scanId || sid === lastScanId) : (sidFallback ? [sidFallback] : [])

    for (const sid of reloadList) {
      try {
        if (activeSearch) {
          try { postClientRefreshed && postClientRefreshed(sid) } catch (e) {}
          continue
        }

        if (fetchScanMeta && fetchScanItemsPage) {
          try {
            const m = await fetchScanMeta(sid)
            if (m) {
              const pgr = await fetchScanItemsPage(sid, 0, Math.max(batchSize, 12))
              const coll = (pgr && pgr.items) ? pgr.items : []
              try { if (updateScanDataAndPreserveView) updateScanDataAndPreserveView(m, coll) } catch (e) {}
            }
          } catch (e) { /* swallow per-sid error */ }
        }
        try { postClientRefreshed && postClientRefreshed(sid) } catch (e) {}
      } catch (e) { /* swallow */ }
    }

  // Intentionally do not emit a toast here to avoid duplicate/spammy notifications.
  // The caller will handle user-facing toasts based on authoritative checks.
    return true
  } catch (e) {
    return false
  }
}
