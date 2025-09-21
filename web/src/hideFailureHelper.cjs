// CommonJS helper used by both tests and the client App to handle hide-failure reconciliation
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
    const p = ev.path || ev.originalPath || (candidates && candidates[0])

    // authoritative enrichment
    if (p && fetchEnrichByPath) {
      try {
        const auth = await fetchEnrichByPath(p)
        const norm = auth || null
        if (norm) {
          try { setEnrichCache && setEnrichCache(prev => ({ ...prev, [p]: norm })) } catch (e) {}
          if (norm.hidden || norm.applied) {
            try { setItems && setItems(prev => prev.filter(x => x.canonicalPath !== p)) } catch (e) {}
            try { setAllItems && setAllItems(prev => prev.filter(x => x.canonicalPath !== p)) } catch (e) {}
          }
        }
      } catch (e) { /* swallow */ }
    }

    // reload modified scans (small first page) or fallback to full reload of current scan
    try {
      const modified = Array.isArray(ev.modifiedScanIds) ? ev.modifiedScanIds : []
      const toReload = (modified || []).filter(sid => sid === scanId || sid === lastScanId)
      if (toReload.length) {
        for (const sid of toReload) {
          try {
            const m = await fetchScanMeta(sid)
            if (m) {
              const pgr = await fetchScanItemsPage(sid, 0, Math.max(batchSize, 12))
              const coll = (pgr && pgr.items) ? pgr.items : []
              try { if (updateScanDataAndPreserveView) updateScanDataAndPreserveView(m, coll) } catch (e) {
                try { setScanMeta && setScanMeta(m) } catch (ee) {}
                try { setItems && setItems(coll.filter(it => it && it.canonicalPath)) } catch (ee) {}
                try { setAllItems && setAllItems(coll.filter(it => it && it.canonicalPath)) } catch (ee) {}
              }
              try { postClientRefreshed && postClientRefreshed(sid) } catch (e) {}
            }
          } catch (e) { /* swallow */ }
        }
      } else {
        // Fallback: fetch only the first page and merge it into baseline instead
        // of walking the entire scan (this avoids stomping the current view/scroll).
        const sid = scanId || lastScanId
        if (sid) {
          try {
            const m = await fetchScanMeta(sid)
            if (m) {
              const pgr = await fetchScanItemsPage(sid, 0, Math.max(batchSize, 12))
              const coll = (pgr && pgr.items) ? pgr.items : []
              try {
                if (updateScanDataAndPreserveView) updateScanDataAndPreserveView(m, coll)
              } catch (e) {
                try { setItems && setItems(coll.filter(it => it && it.canonicalPath)) } catch (ee) {}
                try { setAllItems && setAllItems(coll.filter(it => it && it.canonicalPath)) } catch (ee) {}
              }
            }
          } catch (e) { /* swallow */ }
        }
      }
    } catch (e) { /* swallow */ }

    try { pushToast && pushToast('Hide', 'Item hidden (server event)') } catch (e) {}
    return true
  } catch (e) {
    return false
  }
}
