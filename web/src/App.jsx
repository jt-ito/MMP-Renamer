import React, { useEffect, useState } from 'react'
import axios from 'axios'
import { FixedSizeList as List } from 'react-window'
import ToastContainer from './components/Toast'
import Settings from './Settings'
import Login from './Login'
import Register from './Register'
import Users from './Users'
import Notifications from './Notifications'

function IconRefresh(){
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M21 12a9 9 0 10-3 6.75" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
  )
}

function IconCopy(){
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="9" y="9" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.6"/><rect x="4" y="4" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.6"/></svg>
  )
}

function IconApply(){
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
  )
}

const API = (path) => `/api${path}`

axios.defaults.withCredentials = true

function useLocalState(key, initial) {
  const [s, setS] = useState(() => {
    try {
      const v = localStorage.getItem(key)
      if (v === null || v === undefined) return initial
      try { return JSON.parse(v) } catch { return v }
    } catch (e) { return initial }
  })
  useEffect(() => {
    try {
      // Store primitives as raw strings for compatibility with other parts of the app
      if (typeof s === 'string' || typeof s === 'number' || typeof s === 'boolean') localStorage.setItem(key, String(s))
      else localStorage.setItem(key, JSON.stringify(s))
    } catch (e) {}
  }, [key, s])
  return [s, setS]
}

// Helper: normalize server enrich responses to { parsed, provider, hidden, applied }
function normalizeEnrichResponse(data) {
  if (!data) return null
  // Direct GET /api/enrich returns { cached, parsed, provider }
  if (data.parsed || data.provider) {
    return { parsed: data.parsed || null, provider: data.provider || null, hidden: data.hidden || false, applied: data.applied || false }
  }
  // POST /api/enrich historically returned { enrichment: {...} } or direct enrichment object
  const e = data.enrichment || data
  if (!e) return null
  // If already normalized
  if (e.parsed || e.provider) return { parsed: e.parsed || null, provider: e.provider || null, hidden: e.hidden || false, applied: e.applied || false }
  // Otherwise build parsed/provider blocks from legacy enrichment shape
  const parsed = (e.parsed) ? e.parsed : (e.parsedName || e.title ? { title: e.title || '', parsedName: e.parsedName || '', season: e.season, episode: e.episode, timestamp: e.timestamp } : null)
  const provider = (e.provider) ? e.provider : ((e.episodeTitle || e.year || e.providerRenderedName || e.tvdb) ? { title: e.title || parsed && parsed.title || '', year: e.year || null, season: e.season, episode: e.episode, episodeTitle: e.episodeTitle || '', raw: e.provider || e.tvdb || null, renderedName: e.providerRenderedName || e.renderedName || null, matched: !!(e.title || e.episodeTitle) } : null)
  return { parsed: parsed || null, provider: provider || null, hidden: e.hidden || false, applied: e.applied || false }
}

function Spinner(){
  return (
    <svg className="icon spinner" viewBox="0 0 50 50" width="18" height="18"><circle cx="25" cy="25" r="20" stroke="currentColor" strokeWidth="4" strokeOpacity="0.18" fill="none"/><path d="M45 25a20 20 0 0 1-20 20" stroke="currentColor" strokeWidth="4" strokeLinecap="round" fill="none"><animateTransform attributeName="transform" type="rotate" from="0 25 25" to="360 25 25" dur="1s" repeatCount="indefinite"/></path></svg>
  )
}

export default function App() {
  const [libraries, setLibraries] = useState([])
  const [scanId, setScanId] = useState(null)
  const [scanMeta, setScanMeta] = useState(null)
  const [lastLibraryId, setLastLibraryId] = useLocalState('lastLibraryId', '')
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [scanning, setScanning] = useState(false)
  const [scanLoaded, setScanLoaded] = useState(0)
  const [scanProgress, setScanProgress] = useState(0)
  const [metaPhase, setMetaPhase] = useState(false)
  const [metaProgress, setMetaProgress] = useState(0)
  const [theme, setTheme] = useLocalState('theme', 'dark')
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState({})
  const [searchQuery, setSearchQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const searchAbortRef = React.useRef(null)
  const searchTimeoutRef = React.useRef(null)
  const [enrichCache, setEnrichCache] = useLocalState('enrichCache', {})
  const [logs, setLogs] = useState('')
  const [toasts, setToasts] = useState([])
  const [loadingEnrich, setLoadingEnrich] = useState({})

  // computed: whether a bulk enrich/metadata refresh is in-flight
  const enrichPendingCount = Object.keys(loadingEnrich || {}).length
  const globalEnrichPending = metaPhase || enrichPendingCount > 0
  // debounce hiding the global indicator to avoid flicker
  const [visibleGlobalEnrichPending, setVisibleGlobalEnrichPending] = useState(globalEnrichPending)
  const hideDebounceRef = React.useRef(null)

  React.useEffect(() => {
    // if pending, show immediately and cancel any pending hide timeout
    if (globalEnrichPending) {
      if (hideDebounceRef.current) { clearTimeout(hideDebounceRef.current); hideDebounceRef.current = null }
      setVisibleGlobalEnrichPending(true)
      return
    }
    // if not pending, schedule hide after 300ms to avoid flicker
    if (!globalEnrichPending) {
      if (hideDebounceRef.current) clearTimeout(hideDebounceRef.current)
      hideDebounceRef.current = setTimeout(() => {
        setVisibleGlobalEnrichPending(false)
        hideDebounceRef.current = null
      }, 300)
    }
    return () => { if (hideDebounceRef.current) { clearTimeout(hideDebounceRef.current); hideDebounceRef.current = null } }
  }, [globalEnrichPending])

  // defensive setter wrapper: some runtime bundles or injection can cause the
  // state setter to be unavailable in certain scopes; use this wrapper to
  // avoid uncaught ReferenceError when event handlers run.
  function safeSetLoadingEnrich(updater) {
    try { setLoadingEnrich(updater) } catch (e) { /* swallow */ }
  }

  // expose global alias for compatibility with any injected or legacy code
  React.useEffect(() => {
    try { if (typeof window !== 'undefined') window.safeSetLoadingEnrich = safeSetLoadingEnrich } catch (e) {}
    return () => { try { if (typeof window !== 'undefined' && window.safeSetLoadingEnrich === safeSetLoadingEnrich) delete window.safeSetLoadingEnrich } catch (e) {} }
  }, [])
  const [auth, setAuth] = useState(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [renameTemplate, setRenameTemplate] = useLocalState('rename_template', '{title} ({year}) - {epLabel} - {episodeTitle}')
  const [tvdbKey, setTvdbKey] = useLocalState('tvdb_api_key', '')
  // support modern TMDb key while staying backward-compatible with legacy tvdb_api_key
  const [tmdbKey, setTmdbKey] = useLocalState('tmdb_api_key', '')
  const providerKey = (tmdbKey && String(tmdbKey).length) ? tmdbKey : (tvdbKey || '')
  const scanOptionsRef = React.useRef({})
  const batchSize = 12

  // Helper: consider an enrichment entry hidden for UI purposes if hidden or applied
  function isHiddenOrApplied(enriched) {
    return enriched && (enriched.hidden === true || enriched.applied === true)
  }

  // Merge arrays of items (objects with canonicalPath) into a deduped list.
  // If prepend=true, newItems are placed before prev; otherwise appended after prev.
  function mergeItemsUnique(prev = [], newItems = [], prepend = false) {
    try {
      const seen = new Set()
      const out = []
      if (prepend) {
        for (const it of (newItems || [])) {
          if (!it || !it.canonicalPath) continue
          if (seen.has(it.canonicalPath)) continue
          // skip items that are hidden/applied in client cache
          const e = enrichCache && enrichCache[it.canonicalPath]
          if (isHiddenOrApplied(e)) continue
          seen.add(it.canonicalPath)
          out.push(it)
        }
        for (const it of (prev || [])) {
          if (!it || !it.canonicalPath) continue
          if (seen.has(it.canonicalPath)) continue
          const e = enrichCache && enrichCache[it.canonicalPath]
          if (isHiddenOrApplied(e)) continue
          seen.add(it.canonicalPath)
          out.push(it)
        }
      } else {
        for (const it of (prev || [])) {
          if (!it || !it.canonicalPath) continue
          if (seen.has(it.canonicalPath)) continue
          const e = enrichCache && enrichCache[it.canonicalPath]
          if (isHiddenOrApplied(e)) continue
          seen.add(it.canonicalPath)
          out.push(it)
        }
        for (const it of (newItems || [])) {
          if (!it || !it.canonicalPath) continue
          if (seen.has(it.canonicalPath)) continue
          const e = enrichCache && enrichCache[it.canonicalPath]
          if (isHiddenOrApplied(e)) continue
          seen.add(it.canonicalPath)
          out.push(it)
        }
      }
      return out
    } catch (e) { return prev || [] }
  }

  

  function pushToast(title, message){
    const id = Math.random().toString(36).slice(2,9)
    const ts = new Date().toISOString()
    const entry = { id, title, message, ts }
    setToasts(t => [...t, entry])
    // persist into localStorage for notifications history
    try {
      const existing = JSON.parse(localStorage.getItem('notifications') || '[]')
      existing.unshift(entry)
      // keep recent 200 notifications to avoid unbounded growth
      localStorage.setItem('notifications', JSON.stringify(existing.slice(0, 200)))
    } catch (e) {}
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 6000)
  }

  useEffect(() => { axios.get(API('/libraries')).then(r => setLibraries(r.data)).catch(()=>{}) }, [])

  // check auth status on load (prevents deep-link bypass)
  useEffect(() => {
    let mounted = true
    axios.get(API('/session')).then(r => {
      if (!mounted) return
      if (r.data && r.data.authenticated) setAuth({ username: r.data.username, role: r.data.role })
    }).catch(()=>{}).finally(()=>{ if (mounted) setAuthChecked(true) })
    return () => { mounted = false }
  }, [])
  // fetch server-side settings so client and server agree on configured output path
  useEffect(() => {
    axios.get(API('/settings')).then(r => {
      const s = r.data || {}
      // hydrate local storage-backed state if empty (keep backward-compatible tvdb_api_key storage)
      try { if (!localStorage.getItem('tvdb_api_key') && s.tvdb_api_key) localStorage.setItem('tvdb_api_key', s.tvdb_api_key) } catch {}
      try { if (!localStorage.getItem('rename_template') && s.userSettings && s.userSettings.rename_template) localStorage.setItem('rename_template', s.userSettings.rename_template) } catch {}
    }).catch(()=>{})
  }, [])

  async function triggerScan(lib, options = {}) {
    // prefer user-configured input path (localStorage fallback), otherwise ask server
    let configuredPath = ''
    try { configuredPath = localStorage.getItem('scan_input_path') || '' } catch {}
    if (!configuredPath) {
      try {
        const s = await axios.get(API('/settings'))
        configuredPath = (s.data && s.data.userSettings && s.data.userSettings.scan_input_path) || ''
      } catch (e) { /* ignore */ }
    }
    if (!configuredPath) {
      pushToast && pushToast('Scan', 'No input path configured — set one in Settings before scanning')
      return
    }

    const r = await axios.post(API('/scan'), { libraryId: lib?.id, path: configuredPath })
    // set the current scan id and persist last library id so rescan works across reloads
    setScanId(r.data.scanId)
    const libId = lib?.id || (r.data && r.data.libraryId) || (scanMeta && scanMeta.libraryId) || ''
    try { setLastLibraryId(libId) } catch (e) {}

    // fetch scan metadata
    const meta = await axios.get(API(`/scan/${r.data.scanId}`))
    setScanMeta(meta.data)
    setTotal(meta.data.totalCount)

  // Collect all pages before revealing any items to the UI
    setScanning(true)
  setScanLoaded(0)
  setScanProgress(0)
  setMetaPhase(false)
  setMetaProgress(0)
    const collected = []
    let offset = 0
    while (offset < meta.data.totalCount) {
      const page = await axios.get(API(`/scan/${r.data.scanId}/items?offset=${offset}&limit=${batchSize}`))
      const pageItems = page.data.items || []
      collected.push(...pageItems)
      offset += pageItems.length
      setScanLoaded(prev => {
        const n = prev + pageItems.length
        try { setScanProgress(Math.min(100, Math.round((n / Math.max(1, meta.data.totalCount)) * 100))) } catch(e){}
        return n
      })
    }

    // Persist options
    scanOptionsRef.current = options || {}

    // After collecting all items, run the same server-side refresh the rescan uses so parsing is consistent
    try {
      pushToast && pushToast('Scan', 'Refreshing metadata (server-side) — this may take a while')
      // enter metadata phase and reset metadata progress
      setMetaPhase(true)
      setMetaProgress(0)
      await refreshScan(r.data.scanId)
      // Now refresh client-side enrich for all collected paths and report progress
      const paths = collected.map(it => it.canonicalPath).filter(Boolean)
      if (paths.length > 0) {
        let done = 0
        const batch = 6
        for (let i = 0; i < paths.length; i += batch) {
          const chunk = paths.slice(i, i + batch)
          await Promise.all(chunk.map(async p => {
            try {
              const er = await axios.get(API('/enrich'), { params: { path: p } })
          if (er.data && er.data.cached) {
                const enriched = normalizeEnrichResponse(er.data.enrichment || er.data)
                setEnrichCache(prev => ({ ...prev, [p]: enriched }))
                if (enriched && (enriched.hidden || enriched.applied)) {
                  setItems(prev => prev.filter(it => it.canonicalPath !== p))
                } else {
                  // prepend in deduped fashion and skip any hidden/applied
                  setItems(prev => mergeItemsUnique(prev, [{ id: p, canonicalPath: p }], true))
                }
              }
            } catch (e) {}
            done++
            setMetaProgress(Math.round((done / paths.length) * 100))
          }))
        }
      }
      pushToast && pushToast('Scan', 'Provider metadata refresh complete')
    } catch (e) {
      pushToast && pushToast('Scan', 'Provider refresh failed')
    }

    // Filter out items that are marked hidden/applied in server cache and reveal
    const filtered = collected.filter(it => {
      const e = enrichCache[it.canonicalPath]
      return !(e && (e.hidden === true || e.applied === true))
    })
    setItems(filtered)
    setMetaPhase(false)
    setScanning(false)
    setScanProgress(100)

  // return created scan id for callers that want to act on it
  return r.data.scanId
  }

  // server-side search — do not load all items into memory on client
  async function searchScan(query, offset = 0, limit = 50, signal) {
    if (!scanId) return { items: [], offset: 0, limit: 0, total: 0 }
    try {
      setSearching(true)
      // cancel previous request if present
      if (searchAbortRef.current && typeof searchAbortRef.current.abort === 'function') try { searchAbortRef.current.abort() } catch (e) {}
      // use AbortController for cancellation
      const controller = new AbortController()
      searchAbortRef.current = controller
      const r = await axios.get(API(`/scan/${scanId}/search`), { params: { q: query, offset, limit }, signal: signal || controller.signal })
      setSearching(false)
      return r.data || { items: [], offset, limit, total: 0 }
    } catch (e) { if (axios.isCancel && axios.isCancel(e)) { /* cancelled */ } setSearching(false); return { items: [], offset: 0, limit, total: 0 } }
  }

  async function rescan() {
    const libId = lastLibraryId || (scanMeta && scanMeta.libraryId)
    if (!libId) {
      pushToast && pushToast('Rescan', 'No previous scan to rescan — perform a Scan first')
      return
    }
    // trigger scan for the persisted library id
    try {
      const sid = await triggerScan({ id: libId }, { forceEnrich: true })
      // If user has provided a TMDb API key, request server-side refresh to populate TMDb metadata
  const shouldRefresh = Boolean(providerKey)
      if (shouldRefresh) {
        pushToast && pushToast('Rescan', 'Preferred provider configured — refreshing metadata from provider')
        try {
          await refreshScan(sid)
          pushToast && pushToast('Rescan', 'Provider metadata refresh complete')
        } catch (e) {
          pushToast && pushToast('Rescan', 'Provider refresh failed')
        }
      }
    } catch (e) {
      pushToast && pushToast('Rescan', 'Rescan failed')
    }
  }

  async function enrichOne(item, force = false) {
    if (!item) return
    const key = item.canonicalPath
    try {
  if (force) safeSetLoadingEnrich(l => ({ ...l, [key]: true }))

      // If not forcing and we already have a cache entry, return it
      if (!force && enrichCache && enrichCache[key]) return enrichCache[key]

      // First try to GET cached enrichment from server
      try {
        const r = await axios.get(API('/enrich'), { params: { path: key } })
      if (r.data && r.data.cached && !force) {
        const norm = normalizeEnrichResponse(r.data.enrichment || r.data)
        setEnrichCache(prev => ({ ...prev, [key]: norm }))
        return norm
        }
      } catch (e) {
        // ignore and continue to POST
      }

      // POST to /enrich to generate/update enrichment (force bypasses cache check)
  const w = await axios.post(API('/enrich'), { path: key, tmdb_api_key: providerKey || undefined })
      if (w.data) {
        const norm = normalizeEnrichResponse(w.data.enrichment || w.data)
        if (norm) setEnrichCache(prev => ({ ...prev, [key]: norm }))
      }

      // if the applied operation marked this item hidden, remove it from visible items
      try {
        const _norm2 = (w.data && (w.data.enrichment || w.data)) ? normalizeEnrichResponse(w.data.enrichment || w.data) : null
        if (_norm2 && _norm2.hidden) {
          setItems(prev => prev.filter(it => it.canonicalPath !== key))
        }
      } catch (e) {}

      // choose a friendly name for toast
  // choose a friendly name for toast from normalized enrichment (prefer parsed then provider)
  const _norm = (w.data && (w.data.enrichment || w.data)) ? normalizeEnrichResponse(w.data.enrichment || w.data) : null
  const nameForToast = (_norm && (_norm.parsed?.title || _norm.provider?.title)) || (key && key.split('/')?.pop()) || key
  pushToast && pushToast('Enrich', `Updated metadata for ${nameForToast}`)
  return (w.data && (w.data.enrichment || w.data)) ? normalizeEnrichResponse(w.data.enrichment || w.data) : null
    } catch (err) {
      setEnrichCache(prev => ({ ...prev, [key]: { error: err?.message || String(err) } }))
      return null
    } finally {
  if (force) safeSetLoadingEnrich(l => { const n = { ...l }; delete n[key]; return n })
    }
  }

  const handleScrollNearEnd = async () => {
    if (!scanId) return
    const nextOffset = items.length
    if (nextOffset >= total) return
    let r
    if (searchQuery && searchQuery.length > 0) {
      r = await searchScan(searchQuery, nextOffset, batchSize)
      setItems(prev => mergeItemsUnique(prev, r.items || [], false))
    } else {
      r = await axios.get(API(`/scan/${scanId}/items?offset=${nextOffset}&limit=${batchSize}`))
      setItems(prev => mergeItemsUnique(prev, r.data.items || [], false))
    }
    const forceEnrich = scanOptionsRef.current && scanOptionsRef.current.forceEnrich === true
    for (const it of r.data.items) {
      if (forceEnrich) enrichOne && enrichOne(it, true)
      else if (!enrichCache[it.canonicalPath]) enrichOne && enrichOne(it)
    }
  }

  // run a fresh search and replace visible items with results
  // perform search immediately (used by buttons); live-search handled by debounce effect below
  async function doSearch(q) {
    setSearchQuery(q || '')
    // clear: restore normal listing (first page)
    if (!q) {
      try {
        setItems([])
        setSearching(false)
        // fetch first page of items from server-side scan listing
        if (scanId) {
          const r = await axios.get(API(`/scan/${scanId}/items`), { params: { offset: 0, limit: batchSize } })
          const page = (r.data.items || []).filter(it => { const e = enrichCache && enrichCache[it.canonicalPath]; return !(e && (e.hidden === true || e.applied === true)) })
          setItems(page)
          setTotal((scanMeta && scanMeta.totalCount) || page.length || 0)
          // Warm-up client cache only by GETting any server-cached enrichment.
          // Do NOT call enrichOne or POST to /enrich here — that can trigger
          // server-side provider refresh which may unintentionally unhide
          // already-approved items. Only hydrate from server cache if present.
          try {
            await Promise.all((page || []).map(async it => {
              try {
                if (!it || !it.canonicalPath) return
                if (enrichCache && enrichCache[it.canonicalPath]) return
                const er = await axios.get(API('/enrich'), { params: { path: it.canonicalPath } })
                // Accept server-provided enrichment even when cached=false so we honor
                // applied/hidden flags and any partial provider tokens for display.
                if (er.data && (er.data.cached || er.data.enrichment)) {
                  const norm = normalizeEnrichResponse(er.data.enrichment || er.data)
                  setEnrichCache(prev => ({ ...prev, [it.canonicalPath]: norm }))
                  if (norm && (norm.hidden || norm.applied)) {
                    // remove hidden or applied items from visible list
                    setItems(prev => prev.filter(x => x.canonicalPath !== it.canonicalPath))
                  }
                }
              } catch (e) { /* ignore per-item failures */ }
            }))
          } catch (e) { /* ignore overall warm-up failures */ }
          return
        }
      } catch (e) {
        // fallback to default paging
        setItems([])
        await handleScrollNearEnd()
        return
      }
    }

    // explicit Search button: perform server-side search and ensure each result is enriched
    try {
      setSearching(true)
      const r = await searchScan(q, 0, batchSize)
  const results = (r.items || []).filter(it => { const e = enrichCache && enrichCache[it.canonicalPath]; return !(e && (e.hidden === true || e.applied === true)) })
  setItems(results)
      setTotal(r.total || 0)
      // For each matched item, poll server /enrich until cached (or timeout) so UI shows full metadata
      const pollEnrich = async (path) => {
        const maxMs = 5000
        const start = Date.now()
            while (Date.now() - start < maxMs) {
          try {
            const er = await axios.get(API('/enrich'), { params: { path } })
            // If server reports cached=true or returned an enrichment object (possibly incomplete),
            // use the returned enrichment for UI rendering. If the provider is incomplete, also
            // POST a forced enrich to start an external lookup.
            if (er.data && (er.data.cached || er.data.enrichment)) {
              const norm = normalizeEnrichResponse(er.data.enrichment || er.data)
              try { setEnrichCache(prev => ({ ...prev, [path]: norm })) } catch (e) {}
              // If the server explicitly marked the cache as complete, stop polling now.
              if (er.data.cached) return
              // Otherwise, initiate a forced enrich to populate missing provider fields.
              try {
                await axios.post(API('/enrich'), { path, tmdb_api_key: providerKey || undefined, force: true })
              } catch (e) { /* ignore forced start errors */ }
            }
          } catch (e) {}
          // small delay before retry
          await new Promise(s => setTimeout(s, 400))
        }
        // ensure at least one attempt to load client-side cache entry
        try { enrichOne && enrichOne({ canonicalPath: path }, true) } catch (e) {}
      }

      await Promise.all(results.map(it => pollEnrich(it.canonicalPath)))
    } finally { setSearching(false) }
  }

  // Live search: debounce input and cancel previous inflight requests
  React.useEffect(() => {
    // clear any pending timeout
    if (searchTimeoutRef.current) { clearTimeout(searchTimeoutRef.current); searchTimeoutRef.current = null }
    // if empty query, clear and load normal listing
    if (!searchQuery || searchQuery.length === 0) {
      // reset items to first page
      setItems([])
      // small timeout to allow UI to update
      searchTimeoutRef.current = setTimeout(() => { handleScrollNearEnd().catch(()=>{}) }, 150)
      return () => { if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current) }
    }
    // debounce live search (300ms)
    searchTimeoutRef.current = setTimeout(async () => {
      try {
        // perform search with cancellation via searchScan
  const r = await searchScan(searchQuery, 0, batchSize)
  const filtered = (r.items || []).filter(it => { const e = enrichCache && enrichCache[it.canonicalPath]; return !(e && (e.hidden === true || e.applied === true)) })
  setItems(filtered)
  setTotal(r.total || 0)
  for (const it of filtered || []) if (!enrichCache[it.canonicalPath]) enrichOne && enrichOne(it)
      } catch (e) {}
    }, 300)
    return () => { if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery])

  async function previewRename(selected, template) {
  // include configured output path from local storage (client preference), server will also accept its persisted setting
  const outputPath = (() => { try { return localStorage.getItem('scan_output_path') || '' } catch { return '' } })()
  const effectiveTemplate = template || (() => { try { return localStorage.getItem('rename_template') || renameTemplate } catch { return renameTemplate } })()
  const r = await axios.post(API('/rename/preview'), { items: selected, template: effectiveTemplate, outputPath })
    return r.data.plans
  }

  // Refresh enrichment for a list of canonical paths and update visible items
  async function refreshEnrichForPaths(paths = []) {
    if (!paths || !Array.isArray(paths) || paths.length === 0) return
    for (const p of paths) {
      try {
        const er = await axios.get(API('/enrich'), { params: { path: p } })
        if (er.data && er.data.cached) {
          const enriched = normalizeEnrichResponse(er.data.enrichment || er.data)
          setEnrichCache(prev => ({ ...prev, [p]: enriched }))
          // if the item is now hidden/applied remove it from visible items
          if (enriched && (enriched.hidden || enriched.applied)) {
            setItems(prev => prev.filter(it => it.canonicalPath !== p))
          } else {
            // item is unhidden (unapproved) -> ensure it's visible in the list (deduped)
            setItems(prev => mergeItemsUnique(prev, [{ id: p, canonicalPath: p }], true))
          }
        }
      } catch (e) {}
    }
  }

  async function applyRename(plans, dryRun = false) {
    // send plans to server; server will consult its configured scan_output_path to decide hardlink behavior
    try {
      const r = await axios.post(API('/rename/apply'), { plans, dryRun })
      // After apply, refresh enrichment for each plan.fromPath so the UI reflects applied/hidden state immediately
      try {
        const paths = (plans || []).map(p => p.fromPath).filter(Boolean)
        // set per-item loading while refresh happens
        const loadingMap = {}
        for (const p of paths) loadingMap[p] = true
  safeSetLoadingEnrich(prev => ({ ...prev, ...loadingMap }))
        await refreshEnrichForPaths(paths)
        // clear loading flags
  safeSetLoadingEnrich(prev => { const n = { ...prev }; for (const p of paths) delete n[p]; return n })
      } catch (e) {
        // best-effort
      }
      return r.data.results
    } catch (err) {
      throw err
    }
  }

  async function refreshScan(scanId) {
    if (!scanId) throw new Error('no scan id')
    try {
  const r = await axios.post(API(`/scan/${scanId}/refresh`), { tmdb_api_key: providerKey || undefined })
       // update enrichCache for items that were refreshed
       if (r.data && r.data.results) {
         // fetch each updated enrichment from server.cache
         for (const res of r.data.results) {
           try {
             const er = await axios.get(API('/enrich'), { params: { path: res.path } })
             if (er.data && er.data.cached) {
               const norm = normalizeEnrichResponse(er.data.enrichment || er.data)
               setEnrichCache(prev => ({ ...prev, [res.path]: norm }))
             }
           } catch (e) {}
         }
       }
       return r.data
     } catch (err) { throw err }
   }

  async function fetchLogs() { try { const r = await axios.get(API('/logs/recent')); setLogs(r.data.logs) } catch(e){} }
  useEffect(() => { fetchLogs(); const t = setInterval(fetchLogs, 3000); return () => clearInterval(t) }, [])

  const [route, setRoute] = useState(window.location.hash || '#/')
  useEffect(() => { const onHash = () => setRoute(window.location.hash || '#/'); window.addEventListener('hashchange', onHash); return () => window.removeEventListener('hashchange', onHash) }, [])

  useEffect(() => { try { document.documentElement.classList.toggle('light', theme === 'light') } catch(e){} }, [theme])

  // listen for cross-component notifications (Settings dispatches when items are unapproved)
  useEffect(() => {
    const handler = (ev) => {
      try {
        const paths = ev && ev.detail && ev.detail.paths ? ev.detail.paths : []
        if (paths && paths.length) refreshEnrichForPaths(paths)
      } catch (e) {}
    }
    window.addEventListener('renamer:unapproved', handler)
    return () => window.removeEventListener('renamer:unapproved', handler)
  }, [])

  return (
  <div className={"app" + (selectMode ? ' select-mode-shrink' : '')}>
      <header>
        <h1 style={{cursor:'pointer'}} onClick={() => (window.location.hash = '#/')} title="Go to dashboard">MMP Renamer</h1>
  {/* Header search: placed between title and header actions so it doesn't overlap buttons */}
  <div className="header-search">
          <input
            className="form-input"
            placeholder="Search files (server-side)"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
          <button className='btn-ghost btn-search' onClick={() => doSearch(searchQuery)} disabled={searching}>{searching ? <Spinner/> : 'Search'}</button>
          <button className='btn-ghost btn-clear' onClick={() => doSearch('')} title='Clear search'>Clear</button>
        </div>
        {/* Global bulk-enrich indicator (shown when many enrich operations are running) */}
  {visibleGlobalEnrichPending ? (
          <div className="bulk-enrich" title="Bulk metadata refresh in progress">
            <Spinner />
            <span className="bulk-enrich-label">{metaPhase ? `Refreshing metadata ${metaProgress}%` : `Updating ${enrichPendingCount} item${enrichPendingCount === 1 ? '' : 's'}`}</span>
          </div>
        ) : null}

        {auth ? (
            <div className="header-actions">
            <button className={"btn-save" + (selectMode ? ' shifted' : '')} onClick={() => triggerScan(libraries[0])}><span>Scan</span></button>
            {/* Select + Approve wrapper: Approve is absolutely positioned so it doesn't reserve space when hidden */}
            <div className="select-approve-wrap">
              <button
                className={"btn-save approve-button" + ((selectMode && Object.keys(selected).length) ? ' visible' : '')}
                aria-hidden={!(selectMode && Object.keys(selected).length)}
                onClick={async () => {
                try {
                  const selectedPaths = Object.keys(selected).filter(Boolean)
                  if (!selectedPaths.length) return
                  // build item objects for selected paths for loaded items
                  const selItems = items.filter(it => selectedPaths.includes(it.canonicalPath))
                  if (!selItems.length) return
                  pushToast && pushToast('Approve', `Approving ${selItems.length} items...`)
                  const plans = await previewRename(selItems)
                  await applyRename(plans)
                  // clear selection but stay in select mode
                  setSelected({})
                  pushToast && pushToast('Approve', 'Approve completed')
                } catch (e) { pushToast && pushToast('Approve', 'Approve failed') }
              }}
              title="Approve selected"
              >Approve selected</button>
              <button className={"btn-ghost" + (selectMode ? ' active' : '')} onClick={() => { setSelectMode(s => { if (s) setSelected({}); return !s }) }} title={selectMode ? 'Exit select mode' : 'Select items'}>Select</button>
            </div>
            <button className={"btn-ghost" + (!(lastLibraryId || (scanMeta && scanMeta.libraryId)) ? ' disabled' : '')} onClick={rescan} title={!(lastLibraryId || (scanMeta && scanMeta.libraryId)) ? 'No previous scan' : 'Rescan last library'} disabled={!(lastLibraryId || (scanMeta && scanMeta.libraryId))}><IconRefresh/> <span>Rescan</span></button>
            <button className={"btn-ghost" + (!(lastLibraryId || (scanMeta && scanMeta.libraryId)) ? ' disabled' : '')} onClick={async () => { if (!(lastLibraryId || (scanMeta && scanMeta.libraryId))) return; pushToast && pushToast('Refresh','Server-side refresh started'); try { await refreshScan(scanMeta ? scanMeta.id : lastLibraryId); pushToast && pushToast('Refresh','Server-side refresh complete'); } catch (e) { pushToast && pushToast('Refresh','Refresh failed') } }} title="Refresh metadata server-side" disabled={!(lastLibraryId || (scanMeta && scanMeta.libraryId))}><IconRefresh/> <span>Refresh metadata</span></button>
            <button className="btn-ghost" onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}>Theme: {theme === 'dark' ? 'Dark' : 'Light'}</button>
            <button className="btn-ghost" onClick={() => (window.location.hash = route === '#/settings' ? '#/' : '#/settings')}>Settings</button>
            <button className="btn-ghost" title="Notifications" onClick={() => (window.location.hash = '#/notifications')}>
              {/* bell icon */}
              <svg className="icon" viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6 6 0 10-12 0v3.159c0 .538-.214 1.055-.595 1.436L4 17h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
            {auth && auth.role === 'admin' && <button className="btn-ghost" onClick={() => (window.location.hash = '#/users')}>Users</button>}
            {auth && <button className="btn-ghost" onClick={async ()=>{ try { await axios.post(API('/logout')); setAuth(null); pushToast && pushToast('Auth','Logged out') } catch { pushToast && pushToast('Auth','Logout failed') } }}>Logout</button>}
          </div>
        ) : null}
      </header>

      <main>
        {/* Auth gating: don't render any protected pages until we know auth; if unauthenticated show Login regardless of hash */}
        {!authChecked ? (
          <section className="list"><div style={{padding:24}}>Checking authentication...</div></section>
        ) : !auth ? (
          <section className="list">
            <Register onRegistered={(d) => { setAuth(d); setAuthChecked(true) }} pushToast={pushToast} />
            <Login onLogin={(d)=>{ setAuth(d); setAuthChecked(true) }} pushToast={pushToast} />
          </section>
        ) : route === '#/users' ? (
            <section className="list">
              <Users pushToast={pushToast} />
            </section>
          ) : route === '#/settings' ? (
            <section className="list">
              <Settings pushToast={pushToast} />
            </section>
          ) : route === '#/notifications' ? (
            <section className="list">
              <Notifications />
            </section>
          ) : (
          <>
            <section className="list">
              {scanMeta ? (
                (scanning) ? (
                  <div style={{display:'flex',flexDirection:'column'}}>
                    <div>Found {total} items. Scanning: {scanLoaded}/{total} ({metaPhase ? metaProgress : scanProgress}%)</div>
                    <div style={{height:12, width:'100%'}}>
                      <div className="progress-bar">
                        <div className="fill" style={{ width: (metaPhase ? metaProgress : scanProgress) + '%' }} />
                        <div className="shimmer" />
                      </div>
                    </div>
                    {metaPhase ? <div style={{fontSize:13, color:'var(--muted)'}}>Scan complete — moving onto metadata refresh</div> : null}
                  </div>
                ) : (
                  <div>Found {total} items. Showing {items.length} loaded items.</div>
                )
              ) : (
                <div>No scan yet</div>
              )}

              {/* only show the list after the full scan collection finished */}
              {!scanning && scanMeta ? (
          <VirtualizedList items={items} enrichCache={enrichCache} onNearEnd={handleScrollNearEnd} enrichOne={enrichOne}
            previewRename={previewRename} applyRename={applyRename} pushToast={pushToast} loadingEnrich={loadingEnrich}
            selectMode={selectMode} selected={selected} toggleSelect={(p, val) => setSelected(s => { const n = { ...s }; if (val) n[p]=true; else delete n[p]; return n })}
            providerKey={providerKey}
            searchQuery={searchQuery} setSearchQuery={setSearchQuery} doSearch={doSearch} searching={searching} />
              ) : null}
            </section>
            <aside className="side">
              <LogsPanel logs={logs} refresh={fetchLogs} pushToast={pushToast} />
            </aside>
          </>
        )}
      </main>

      <ToastContainer toasts={toasts} remove={(id)=>setToasts(t=>t.filter(x=>x.id!==id))} />
    </div>
  )
}

function LogsPanel({ logs, refresh, pushToast }) {
  return (
    <div className="logs">
      <h3>Logs</h3>
      <pre>{logs}</pre>
  <div style={{display:'flex',marginTop:8, alignItems:'center'}}>
        <button className="btn-ghost icon-only" onClick={refresh} title="Refresh logs"><IconRefresh/></button>
        <button className="btn-ghost icon-only" onClick={() => { navigator.clipboard?.writeText(logs); pushToast && pushToast('Logs', 'Copied to clipboard') }} title="Copy logs"><IconCopy/></button>
      </div>
    </div>
  )
}

function VirtualizedList({ items = [], enrichCache = {}, onNearEnd, enrichOne, previewRename, applyRename, pushToast, loadingEnrich = {}, selectMode = false, selected = {}, toggleSelect = () => {}, providerKey = '', searchQuery = '', setSearchQuery = () => {}, doSearch = () => {}, searching = false }) {
  const Row = ({ index, style }) => {
  const it = items[index]
  const rawEnrichment = it ? enrichCache?.[it.canonicalPath] : null
  const enrichment = normalizeEnrichResponse(rawEnrichment)
  useEffect(() => { if (it && !rawEnrichment) enrichOne && enrichOne(it) }, [it?.canonicalPath, rawEnrichment, enrichOne])
  const loading = it && Boolean(loadingEnrich[it.canonicalPath])

  // Only use the two canonical outputs: parsed and provider
  const parsed = enrichment?.parsed || null
  const provider = enrichment?.provider || null

  // parsed name should be provided by server as parsed.parsedName
  const parsedName = parsed?.parsedName || (parsed?.title ? `${parsed.title}` : null)

  // provider rendered name: prefer provider.renderedName, otherwise compose from provider tokens
  function pad(n){ return String(n).padStart(2,'0') }
  const useSeason = (provider?.season != null) ? provider?.season : parsed?.season
  const useEpisode = (provider?.episode != null) ? provider?.episode : parsed?.episode
  let epLabel = null
  if (useEpisode != null) epLabel = (useSeason != null) ? `S${pad(useSeason)}E${pad(useEpisode)}` : `E${pad(useEpisode)}`
  const providerTitle = provider?.title || null
  const providerYear = provider?.year ? ` (${provider.year})` : ''
  const providerEpisodeTitle = provider?.episodeTitle || ''
  const providerRendered = provider?.renderedName || (providerTitle ? `${providerTitle}${providerYear}${epLabel ? ' - ' + epLabel : ''}${providerEpisodeTitle ? ' - ' + providerEpisodeTitle : ''}` : null)

  const basename = (it && it.canonicalPath ? it.canonicalPath.split('/').pop() : '')
  const primary = providerRendered || parsedName || basename || ''
    return (
      <div className="row" style={style}>
        {selectMode ? (
          <div style={{width:36, display:'flex', alignItems:'center', justifyContent:'center'}}>
            <input type="checkbox" checked={!!selected[it?.canonicalPath]} onChange={e => toggleSelect(it?.canonicalPath, e.target.checked)} />
          </div>
        ) : <div style={{width:36}} /> }
        <div className="meta">
          <div className="path" style={{marginTop:3}}>{it?.canonicalPath}</div>
           <div className="title">
            {primary}
            { (useSeason != null || useEpisode != null) ? (
              <div style={{fontSize:12, opacity:0.8, marginTop:4}}>
                { (useSeason != null && useEpisode != null) ? `S${String(useSeason).padStart(2,'0')}E${String(useEpisode).padStart(2,'0')}` : (useEpisode != null ? `E${String(useEpisode).padStart(2,'0')}` : '') }
              </div>
            ) : null }
            {/* show source of primary info: provider vs parsed */}
            <div style={{fontSize:11, opacity:0.65, marginTop:3}}>Source: {provider ? 'provider' : (parsed ? 'parsed' : 'unknown')}</div>
          </div>
        </div>
  <div className="actions">
      <button title="Apply rename for this item" className="btn-save icon-btn" disabled={loading} onClick={async () => {
              if (!it) return
              try {
                safeSetLoadingEnrich(prev => ({ ...prev, [it.canonicalPath]: true }))
                // Do not pass a hardcoded template here so the user's configured template is used
                const plans = await previewRename([it])
                pushToast && pushToast('Preview ready', 'Rename plan generated — applying now')
        let successShown = false
        const res = await applyRename(plans)
                // interpret server results (array of per-plan results)
                try {
                  const first = (Array.isArray(res) && res.length) ? res[0] : null
                  const status = first && (first.status || first.result || '')
                  if (status === 'hardlinked' || status === 'copied' || status === 'moved' || status === 'exists' || status === 'dryrun' || status === 'noop') {
                    const kind = (status === 'copied') ? 'Copied (fallback)' : (status === 'hardlinked' ? 'Hardlinked' : (status === 'moved' ? 'Moved' : (status === 'exists' ? 'Exists' : (status === 'dryrun' ? 'Dry run' : 'No-op'))))
          pushToast && pushToast('Apply', `${kind}: ${first.to || first.path || ''}`)
          successShown = true
                  } else if (first && first.status === 'error') {
                    pushToast && pushToast('Apply', `Failed: ${first.error || 'unknown error'}`)
                  } else {
                    // fallback display
                    pushToast && pushToast('Apply result', JSON.stringify(res))
          successShown = true
                  }
                } catch (e) {
                  pushToast && pushToast('Apply result', JSON.stringify(res))
                }
                // refresh enrichment for this item (server marks source hidden) — do this best-effort in background
                refreshEnrichForPaths([it.canonicalPath]).catch(()=>{})
              } catch (e) {
        // Only show failure toast if we did not already show a success message
        try { if (!successShown) pushToast && pushToast('Apply', `Apply failed: ${e && e.message ? e.message : String(e)}`) } catch (ee) { /* swallow */ }
              } finally {
                safeSetLoadingEnrich(prev => { const n = { ...prev }; delete n[it.canonicalPath]; return n })
              }
            }}><IconApply/> <span>Apply</span></button>
          <button title="Rescan metadata for this item" className="btn-ghost" disabled={loading} onClick={async () => { if (!it) return; pushToast && pushToast('Rescan','Refreshing metadata...'); await enrichOne(it, true) }}>{loading ? <Spinner/> : <><IconRefresh/> <span>Rescan</span></>} </button>
          <button title="Hide this item" className="btn-ghost" disabled={loading} onClick={async () => {
            if (!it) return
            try {
              await axios.post(API('/enrich/hide'), { path: it.canonicalPath })
              pushToast && pushToast('Hide', 'Item hidden')
              await refreshEnrichForPaths([it.canonicalPath])
            } catch (e) { pushToast && pushToast('Hide', 'Failed to hide') }
          }}><IconCopy/> <span>Hide</span></button>
        </div>
      </div>
    )
  }

  function onItemsRendered(info) {
    const visibleStopIndex = info.visibleStopIndex ?? info.visibleRange?.[1]
    if (typeof visibleStopIndex === 'number' && visibleStopIndex >= items.length - 3) onNearEnd && onNearEnd()
  }

  return (
    <>
      <List height={600} itemCount={items.length} itemSize={80} width={'100%'} onItemsRendered={onItemsRendered}>
      {Row}
    </List>
    </>
  )
}
