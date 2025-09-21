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
              try {
                if (updateScanDataAndPreserveView) updateScanDataAndPreserveView(m, coll)
              } catch (e) {
                // If the shared helper fails for any reason, avoid stomping the
                // user's current visible items (which can include an active search).
                // Only update scan-level metadata if available; leave items/allItems
                // unchanged so the UI preserves search and scroll context.
                try { setScanMeta && setScanMeta(m) } catch (ee) {}
                // don't setItems/setAllItems here — merging is best-effort and
                // updateScanDataAndPreserveView should have handled it. Swallow.
              }
              try { postClientRefreshed && postClientRefreshed(sid) } catch (e) {}
            }
          } catch (e) { /* swallow */ }
        }
      } else {
        // Fallback: attempt targeted-page lookup for the path in the current scan
        // to avoid touching unrelated pages. If not found within maxPages, fall
        // back to fetching the first page.
        const sid = scanId || lastScanId
        if (sid) {
          try {
            const m = await fetchScanMeta(sid)
            if (m) {
              const targetPath = p || (candidates && candidates[0])
              let coll = []
              let found = false
              const pageSize = Math.max(batchSize, 12)
              const maxPages = 8
              if (targetPath) {
                let off = 0
                for (let pi = 0; pi < maxPages && off < (m.totalCount || 0); pi++) {
                  try {
                    const pgr = await fetchScanItemsPage(sid, off, pageSize)
                    const its = (pgr && pgr.items) ? pgr.items : []
                    if (Array.isArray(its) && its.length) {
                      for (const it of its) {
                        if (it && it.canonicalPath && String(it.canonicalPath) === String(targetPath)) {
                          // found the page containing the path
                          coll = its
                          found = true
                          break
                        }
                      }
                    }
                    if (found) break
                    off += its.length
                  } catch (e) { break }
                }
              }
              if (!found) {
                // fallback to first page
                try { const pgr = await fetchScanItemsPage(sid, 0, pageSize); coll = (pgr && pgr.items) ? pgr.items : [] } catch (e) { coll = [] }
              }
              try {
                if (updateScanDataAndPreserveView) updateScanDataAndPreserveView(m, coll)
              } catch (e) {
                try { setScanMeta && setScanMeta(m) } catch (ee) {}
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
