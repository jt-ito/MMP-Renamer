// Minimal, robust implementation.
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

    // Always attempt per-path enrichment refresh (safe while searching).
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
          // Do NOT fetch pages while searching. Notify server and rely on per-path update above.
          try { postClientRefreshed && postClientRefreshed(sid) } catch (e) {}
          continue
        }

        // When not searching: fetch minimal first page and merge (non-stomping).
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

    try { pushToast && pushToast('Hide', 'Item hidden (server event)') } catch (e) {}
    return true
  } catch (e) {
    return false
  }
}
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

    // Refresh authoritative enrichment for the path when available
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
      } catch (e) { /* swallow per-path error */ }
    }

    // If server indicated modifiedScanIds, notify or refresh them. When the
    // client is actively searching, never fetch scan pages; instead notify the
    // server we refreshed and rely on per-path enrichment above to remove items.
    try {
      const modified = Array.isArray(ev.modifiedScanIds) ? ev.modifiedScanIds : []
      const toReload = (modified || []).filter(sid => sid === scanId || sid === lastScanId)
      const activeSearch = (typeof window !== 'undefined' && window && window.__CLIENT_ACTIVE_SEARCH__)

      if (toReload.length) {
        for (const sid of toReload) {
          try {
            if (activeSearch) {
              try { postClientRefreshed && postClientRefreshed(sid) } catch (e) {}
              continue
            }
            const m = await fetchScanMeta(sid)
            if (m) {
              const pgr = await fetchScanItemsPage(sid, 0, Math.max(batchSize, 12))
              const coll = (pgr && pgr.items) ? pgr.items : []
              try { if (updateScanDataAndPreserveView) updateScanDataAndPreserveView(m, coll) } catch (e) { /* best-effort */ }
              try { postClientRefreshed && postClientRefreshed(sid) } catch (e) {}
            }
          } catch (e) { /* swallow per-sid errors */ }
        }
      } else {
        const sid = scanId || lastScanId
        if (sid) {
          try {
            if (activeSearch) {
              try { postClientRefreshed && postClientRefreshed(sid) } catch (e) {}
            } else {
              const m = await fetchScanMeta(sid)
              if (m) {
                const pgr = await fetchScanItemsPage(sid, 0, Math.max(batchSize, 12))
                const coll = (pgr && pgr.items) ? pgr.items : []
                try { if (updateScanDataAndPreserveView) updateScanDataAndPreserveView(m, coll) } catch (e) { /* best-effort */ }
              }
            }
          } catch (e) { /* swallow */ }
        }
      }
    } catch (e) { /* swallow overall reload errors */ }

    try { pushToast && pushToast('Hide', 'Item hidden (server event)') } catch (e) {}
    return true
  } catch (e) {
    return false
  }
}
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

          // detect whether the client is actively searching; if so, never fetch scan pages
          const activeSearch = (typeof window !== 'undefined' && window && window.__CLIENT_ACTIVE_SEARCH__)

          // reload modified scans (small first page) or fallback to full reload of current scan
          if (norm.hidden || norm.applied) {
            try { setItems && setItems(prev => prev.filter(x => x.canonicalPath !== p)) } catch (e) {}
            try { setAllItems && setAllItems(prev => prev.filter(x => x.canonicalPath !== p)) } catch (e) {}
          }
            for (const sid of toReload) {
              try {
                // If client is searching, avoid fetching pages entirely — just notify
                // the server we refreshed and rely on per-path enrichment updates.
                if (activeSearch) {
                  try { postClientRefreshed && postClientRefreshed(sid) } catch (e) {}
                  continue
                }
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
                  }
                  try { postClientRefreshed && postClientRefreshed(sid) } catch (e) {}
                }
              } catch (e) { /* swallow */ }
            }
                const pgr = await fetchScanItemsPage(sid, 0, Math.max(batchSize, 12))
            // Fallback: attempt targeted-page lookup for the path in the current scan
            // to avoid touching unrelated pages. If the client is actively searching,
            // skip any page fetches entirely (do not run targeted lookup) — rely on
            // per-path enrichment which was already fetched above.
                } catch (e) {
                  // If the shared helper fails for any reason, avoid stomping the
                  // user's current visible items (which can include an active search).
                  // Only update scan-level metadata if available; leave items/allItems
                  // unchanged so the UI preserves search and scroll context.
                  try { setScanMeta && setScanMeta(m) } catch (ee) {}
                }
                try { postClientRefreshed && postClientRefreshed(sid) } catch (e) {}
              }
            } catch (e) { /* swallow */ }
                  if (activeSearch) {
                    // Skip targeted lookup entirely when the client is actively searching.
                    coll = []
                    found = false
                  } else {
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
                  }
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
