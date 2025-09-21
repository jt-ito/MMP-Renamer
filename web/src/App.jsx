import React, { useEffect, useState, useRef } from 'react'
import axios from 'axios'
import { FixedSizeList as List } from 'react-window'
import normalizeEnrichResponse from './normalizeEnrichResponse'
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
// normalizeEnrichResponse is imported from web/src/normalizeEnrichResponse.js

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
  const [lastScanId, setLastScanId] = useLocalState('lastScanId', null)
  const [items, setItems] = useState([])
  // allItems is the baseline full listing for the current scan (post-scan).
  // This is the single source of truth for the visible dataset; searches filter this in-memory.
  const [allItems, setAllItems] = useState([])
  const [total, setTotal] = useState(0)
  // track canonical paths for the currently-loaded scan so we don't reveal cached paths
  // that aren't present in the current scan results
  const [currentScanPaths, setCurrentScanPaths] = useState(new Set())
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
  // last seen hide event timestamp (ms)
  const lastHideEventTsRef = useRef( Number(localStorage.getItem('lastHideEventTs') || '0') || 0 )

  // Wait for a hide event matching any of the provided candidate paths.
  // Returns the event object if found within timeoutMs, otherwise null.
  async function waitForHideEvent(candidates = [], timeoutMs = 5000, interval = 400) {
    const start = Date.now()
    try {
      while (Date.now() - start < timeoutMs) {
        try {
          const since = lastHideEventTsRef.current || 0
          const r = await axios.get(API('/enrich/hide-events'), { params: { since } }).catch(() => null)
          if (r && r.data && Array.isArray(r.data.events) && r.data.events.length) {
            for (const ev of r.data.events) {
              try {
                // update last seen ts
                if (ev && ev.ts && ev.ts > (lastHideEventTsRef.current || 0)) {
                  lastHideEventTsRef.current = ev.ts
                  try { localStorage.setItem('lastHideEventTs', String(lastHideEventTsRef.current)) } catch (e) {}
                }
                // match by canonical path or originalPath if provided
                if (!ev) continue
                const p = ev.path || ev.originalPath || ''
                for (const c of candidates) {
                  if (!c) continue
                  try { if (String(p) === String(c) || String(ev.originalPath) === String(c)) return ev } catch (e) {}
                }
              } catch (e) {}
            }
          }
        } catch (e) {}
        await new Promise(r => setTimeout(r, interval))
      }
    } catch (e) {}
    return null
  }

  // If hide appears to have failed, wait briefly for any server-side hide event
  // matching the provided candidate paths. If an event is seen, refresh scans
  // and authoritative enrichment for the affected path(s) and show success.
  // Delegate to small helper so it can be unit-tested in isolation.
  async function handleHideFailure(candidates = []) {
    try {
      const helper = await import('./hideFailureHelper.cjs')
      const result = await helper.default ? helper.default({
        candidates,
        waitForHideEvent,
        fetchEnrichByPath: async (p) => {
          try { const er = await axios.get(API('/enrich'), { params: { path: p } }).catch(() => null); return er && er.data && (er.data.enrichment || er.data) ? (er.data.enrichment || er.data) : null } catch (e) { return null }
        },
        fetchScanMeta: async (sid) => { try { const m = await axios.get(API(`/scan/${sid}`)).catch(() => null); return m && m.data ? m.data : null } catch (e) { return null } },
        fetchScanItemsPage: async (sid, offset, limit) => { try { const pgr = await axios.get(API(`/scan/${sid}/items`), { params: { offset, limit } }).catch(() => ({ data: { items: [] } })); return pgr && pgr.data ? { items: pgr.data.items || [] } : { items: [] } } catch (e) { return { items: [] } } },
        updateScanDataAndPreserveView,
        setEnrichCache,
        setItems,
        setAllItems,
        scanId,
        lastScanId,
        batchSize,
        pushToast,
        postClientRefreshed: async (sid) => { try { await axios.post(API('/debug/client-refreshed'), { scanId: sid }).catch(()=>null) } catch (e) {} }
      }) : helper({
        candidates,
        waitForHideEvent,
        fetchEnrichByPath: async (p) => {
          try { const er = await axios.get(API('/enrich'), { params: { path: p } }).catch(() => null); return er && er.data && (er.data.enrichment || er.data) ? (er.data.enrichment || er.data) : null } catch (e) { return null }
        },
        fetchScanMeta: async (sid) => { try { const m = await axios.get(API(`/scan/${sid}`)).catch(() => null); return m && m.data ? m.data : null } catch (e) { return null } },
        fetchScanItemsPage: async (sid, offset, limit) => { try { const pgr = await axios.get(API(`/scan/${sid}/items`), { params: { offset, limit } }).catch(() => ({ data: { items: [] } })); return pgr && pgr.data ? { items: pgr.data.items || [] } : { items: [] } } catch (e) { return { items: [] } } },
        updateScanDataAndPreserveView,
        setEnrichCache,
        setItems,
        setAllItems,
        scanId,
        lastScanId,
        batchSize,
        pushToast,
        postClientRefreshed: async (sid) => { try { await axios.post(API('/debug/client-refreshed'), { scanId: sid }).catch(()=>null) } catch (e) {} }
      })
      return !!result
    } catch (e) {
      return false
    }
  }

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
    try {
      if (typeof window !== 'undefined') {
        window.safeSetLoadingEnrich = safeSetLoadingEnrich
      }
    } catch (e) {}
    return () => {
      try {
        if (typeof window !== 'undefined' && window.safeSetLoadingEnrich === safeSetLoadingEnrich) delete window.safeSetLoadingEnrich
      } catch (e) {}
    }
  }, [])
  const [auth, setAuth] = useState(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [renameTemplate, setRenameTemplate] = useLocalState('rename_template', '{title} ({year}) - {epLabel} - {episodeTitle}')
  const [legacyTvdbKey, setLegacyTvdbKey] = useLocalState('tvdb_api_key', '')
  // support modern TMDb key while staying backward-compatible with legacy tvdb_api_key
  const [tmdbKey, setTmdbKey] = useLocalState('tmdb_api_key', '')
  const providerKey = (tmdbKey && String(tmdbKey).length) ? tmdbKey : (legacyTvdbKey || '')
  const scanOptionsRef = React.useRef({})
  const batchSize = 12
  // dynamic weighting heuristic: store recent durations in localStorage and compute weights
  const timingHistoryRef = useRef({ scanDurations: [], metaDurations: [] })
  try {
    const raw = localStorage.getItem('progressTimingHistory')
    if (raw) timingHistoryRef.current = JSON.parse(raw)
  } catch (e) {}
  const saveTimingHistory = () => {
    try { localStorage.setItem('progressTimingHistory', JSON.stringify(timingHistoryRef.current)) } catch (e) {}
  }
  function computeWeights() {
    try {
      const s = timingHistoryRef.current.scanDurations || []
      const m = timingHistoryRef.current.metaDurations || []
      const avg = (arr) => { if (!arr || !arr.length) return null; const sum = arr.reduce((a,b) => a + b, 0); return sum / arr.length }
      const sAvg = avg(s)
      const mAvg = avg(m)
  // require at least 3 historical entries for both phases before trusting the heuristic
  if (!sAvg || !mAvg || (s.length < 3) || (m.length < 3)) return { scanWeight: 0.3, metaWeight: 0.7 }
      const total = sAvg + mAvg
      if (total <= 0) return { scanWeight: 0.3, metaWeight: 0.7 }
      const scanWeight = Math.max(0.05, Math.min(0.9, sAvg / total))
      return { scanWeight, metaWeight: 1 - scanWeight }
    } catch (e) { return { scanWeight: 0.3, metaWeight: 0.7 } }
  }
  const phaseStartRef = useRef({ scanStart: null, metaStart: null })

  // Helper: consider an enrichment entry hidden for UI purposes if hidden or applied
  function isHiddenOrApplied(enriched) {
    return enriched && (enriched.hidden === true || enriched.applied === true)
  }

  // Verify cached enrich entries actually exist on disk/server. If server reports missing
  // for a cached path, remove it from local cache and visible items to avoid showing stale rows.
  async function verifyCachePaths(paths = null) {
    try {
      const keys = paths && Array.isArray(paths) && paths.length ? paths : Object.keys(enrichCache || {})
      if (!keys || !keys.length) return
      try {
        // Use bulk endpoint to check many paths at once
        const resp = await axios.post(API('/enrich/bulk'), { paths: keys }).catch(() => null)
        if (resp && resp.data && Array.isArray(resp.data.items)) {
          for (const it of resp.data.items) {
            try {
              const p = it.path
              if (it && it.enrichment && it.enrichment.missing) {
                setEnrichCache(prev => { const n = { ...prev }; delete n[p]; return n })
                setItems(prev => prev.filter(it2 => it2.canonicalPath !== p))
              }
            } catch (e) {}
          }
        }
      } catch (e) { /* fallback ignored */ }
    } catch (e) { /* best-effort */ }
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
          // if we have an active scan, only reveal items that exist in that scan
          if (currentScanPaths && currentScanPaths.size > 0 && !currentScanPaths.has(it.canonicalPath)) continue
          // skip items that are hidden/applied in client cache
          const e = enrichCache && enrichCache[it.canonicalPath]
          if (isHiddenOrApplied(e)) continue
          seen.add(it.canonicalPath)
          out.push(it)
        }
        for (const it of (prev || [])) {
          if (!it || !it.canonicalPath) continue
          if (seen.has(it.canonicalPath)) continue
          // ensure prev items are also part of the active scan if present
          if (currentScanPaths && currentScanPaths.size > 0 && !currentScanPaths.has(it.canonicalPath)) continue
          const e = enrichCache && enrichCache[it.canonicalPath]
          if (isHiddenOrApplied(e)) continue
          seen.add(it.canonicalPath)
          out.push(it)
        }
      } else {
        for (const it of (prev || [])) {
          if (!it || !it.canonicalPath) continue
          if (seen.has(it.canonicalPath)) continue
          if (currentScanPaths && currentScanPaths.size > 0 && !currentScanPaths.has(it.canonicalPath)) continue
          const e = enrichCache && enrichCache[it.canonicalPath]
          if (isHiddenOrApplied(e)) continue
          seen.add(it.canonicalPath)
          out.push(it)
        }
        for (const it of (newItems || [])) {
          if (!it || !it.canonicalPath) continue
          if (seen.has(it.canonicalPath)) continue
          if (currentScanPaths && currentScanPaths.size > 0 && !currentScanPaths.has(it.canonicalPath)) continue
          const e = enrichCache && enrichCache[it.canonicalPath]
          if (isHiddenOrApplied(e)) continue
          seen.add(it.canonicalPath)
          out.push(it)
        }
      }
      return out
    } catch (e) { return prev || [] }
  }

  // Update scan metadata and allItems, but preserve the current search/filter and view.
  // If a search is active, re-run the search to keep results stable. If no search,
  // update visible items based on the new allItems (or first page for large scans).
  function updateScanDataAndPreserveView(meta, coll) {
    try {
      const clean = (coll || []).filter(it => it && it.canonicalPath)
      setScanMeta(meta)
      setTotal(meta.totalCount || clean.length)
      // replace baseline listing
      setAllItems(clean)
      // If user is actively searching, re-run the search so results remain focused
      if (searchQuery && searchQuery.length) {
        // doSearch will update items based on searchQuery; use it to preserve behavior
        try { doSearch(searchQuery) } catch (e) { /* best-effort */ }
      } else {
        // No active search: if dataset small enough, show all; otherwise show provided first page
        if ((clean.length || 0) <= MAX_IN_MEMORY_SEARCH) {
          setItems(clean.slice())
        } else {
          // for large scans, show the provided coll as the current loaded items
          setItems(clean.slice(0, Math.max(batchSize, 50)))
        }
      }
      try { setCurrentScanPaths(new Set((clean||[]).map(x => x.canonicalPath))) } catch (e) {}
    } catch (e) {}
  }

      // Maximum number of items to perform in-memory search on; if exceeded, fall back to server search
      const MAX_IN_MEMORY_SEARCH = 20000

      // normalize text for search: lowercase, remove diacritics, collapse whitespace
      function normalizeForSearch(s) {
        if (!s && s !== 0) return ''
        try {
          const str = String(s)
          // NFKD then strip combining marks
          const n = str.normalize ? str.normalize('NFKD') : str
          // remove diacritics (Unicode marks) and non-word punctuation
          return n.replace(/\p{M}/gu, '').replace(/[\s\-_.()\[\],;:!"'\/\\]+/g, ' ').toLowerCase().trim()
        } catch (e) { return String(s).toLowerCase() }
      }

      // Build a searchable text blob for an item from canonical path and any enrichment
      function buildSearchText(it) {
        const parts = []
        try {
          parts.push(it.canonicalPath || '')
          const b = (it.canonicalPath || '').split('/').pop()
          if (b) parts.push(b)
          const e = enrichCache && enrichCache[it.canonicalPath]
          const norm = normalizeEnrichResponse(e)
          if (norm) {
            if (norm.parsed) {
              parts.push(norm.parsed.parsedName || '')
              parts.push(norm.parsed.title || '')
              if (norm.parsed.season != null) parts.push(`s${String(norm.parsed.season)}`)
              if (norm.parsed.episode != null) parts.push(`e${String(norm.parsed.episode)}`)
            }
            if (norm.provider) {
              parts.push(norm.provider.renderedName || '')
              parts.push(norm.provider.title || '')
              parts.push(norm.provider.episodeTitle || '')
              if (norm.provider.season != null) parts.push(`s${String(norm.provider.season)}`)
              if (norm.provider.episode != null) parts.push(`e${String(norm.provider.episode)}`)
              if (norm.provider.year) parts.push(String(norm.provider.year))
            }
          }
        } catch (e) {}
        return normalizeForSearch(parts.join(' '))
      }

      // cache for computed searchText per canonicalPath to avoid recomputing repeatedly
      const searchTextCacheRef = useRef({})
      function getSearchText(it) {
        try {
          const key = it && it.canonicalPath
          if (!key) return ''
          const cache = searchTextCacheRef.current || {}
          if (cache[key]) return cache[key]
          const txt = buildSearchText(it)
          cache[key] = txt
          searchTextCacheRef.current = cache
          return txt
        } catch (e) { return buildSearchText(it) }
      }

      // invalidate cache whenever enrichCache changes (simple strategy)
      useEffect(() => { searchTextCacheRef.current = {} }, [enrichCache])

      // Helper: check whether an item matches the query using enriched metadata when available
      function matchesQuery(it, q) {
        if (!it || !q) return false
        // If the baseline is too large, signal to caller that server-side search should be used instead
        if (allItems && allItems.length > MAX_IN_MEMORY_SEARCH) return null
        const qnorm = normalizeForSearch(q)
        if (!qnorm) return true
        const tokens = qnorm.split(/\s+/).filter(Boolean)
        if (!tokens.length) return true
        const searchText = getSearchText(it)
        // all tokens must be present somewhere in the searchText (AND semantics)
        return tokens.every(t => searchText.indexOf(t) !== -1)
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

  // On mount, verify cached paths to remove any stale entries from previous runs
  useEffect(() => { verifyCachePaths().catch(()=>{}) }, [])
  // Poll for hide events so client can force-refresh affected scans/items even if hide was initiated elsewhere
  useEffect(() => {
    let mounted = true
    let timer = null
    async function poll() {
      // Exponential backoff parameters
      let interval = 800
      const maxInterval = 30000
      while (mounted) {
        try {
          const since = lastHideEventTsRef.current || 0
          const r = await axios.get(API('/enrich/hide-events'), { params: { since } }).catch(() => null)
          if (!mounted) return
          let hadEvents = false
          if (r && r.data && Array.isArray(r.data.events) && r.data.events.length) {
            hadEvents = true
            for (const ev of r.data.events) {
              try {
                // update last seen ts and persist
                if (ev && ev.ts && ev.ts > (lastHideEventTsRef.current || 0)) {
                  lastHideEventTsRef.current = ev.ts
                  try { localStorage.setItem('lastHideEventTs', String(lastHideEventTsRef.current)) } catch (e) {}
                }
                // Reload any indicated scans (but preserve current search/view)
                const modified = ev.modifiedScanIds || []
                if (modified && modified.length) {
                  // keep reloads fast by fetching only the first page for the affected scans
                  const toReload = modified.filter(sid => sid === scanId || sid === lastScanId)
                  for (const sid of toReload) {
                    try {
                      const m = await axios.get(API(`/scan/${sid}`)).catch(() => null)
                      if (m && m.data) {
                        const pgr = await axios.get(API(`/scan/${sid}/items?offset=0&limit=${Math.max(batchSize,12)}`)).catch(() => ({ data: { items: [] } }))
                        const coll = pgr.data.items || []
                        try { updateScanDataAndPreserveView(m.data, coll) } catch(e) {}
                        try { await axios.post(API('/debug/client-refreshed'), { scanId: sid }).catch(()=>null) } catch (e) {}
                      }
                    } catch (e) { /* swallow */ }
                  }
                }
                // Always refresh authoritative enrichment for the event path so hidden/applied flags are up-to-date
                if (ev && ev.path) {
                  try {
                    const er = await axios.get(API('/enrich'), { params: { path: ev.path } }).catch(() => null)
                    const auth = er && er.data && (er.data.enrichment || er.data) ? (er.data.enrichment || er.data) : null
                    const norm = auth ? normalizeEnrichResponse(auth) : null
                    if (norm) {
                      setEnrichCache(prev => ({ ...prev, [ev.path]: norm }))
                      if (norm.hidden || norm.applied) {
                        setItems(prev => prev.filter(x => x.canonicalPath !== ev.path))
                        setAllItems(prev => prev.filter(x => x.canonicalPath !== ev.path))
                      }
                    }
                  } catch (e) {}
                }
              } catch (e) { /* per-event best-effort */ }
            }
          }
          // adjust polling based on whether we received events
          if (hadEvents) {
            interval = 800 // reset to responsive interval
          } else {
            // exponential backoff up to maxInterval when there are no events
            interval = Math.min(maxInterval, Math.max(800, interval * 2))
          }
        } catch (e) {
          // on error, back off as well
          interval = Math.min(30000, (interval || 800) * 2)
        }
        // schedule next poll
        if (!mounted) return
        await new Promise(r => timer = setTimeout(r, interval))
      }
    }
    poll()
    return () => { mounted = false; if (timer) clearTimeout(timer) }
  }, [scanId, lastScanId])

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
  try { setLastScanId(r.data.scanId) } catch (e) {}
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
  // record scan start time
  try { phaseStartRef.current.scanStart = Date.now() } catch (e) {}
    // Persist options
    scanOptionsRef.current = options || {}

    // After collecting all items, run the same server-side refresh the rescan uses so parsing is consistent
    try {
      pushToast && pushToast('Scan', 'Refreshing metadata (server-side) — this may take a while')
  // enter metadata phase and reset metadata progress
  setMetaPhase(true)
  setMetaProgress(0)
  try { phaseStartRef.current.metaStart = Date.now() } catch (e) {}
      // Start a background poll to update header progress during the full refresh.
      // This mirrors the progress the notification would show but only updates the header state
      // (no toasts) so the header progress doesn't stay at 0% for large scans.
      (async () => {
        try {
          await pollRefreshProgress(r.data.scanId, (prog) => {
            const pct = Math.round((prog.processed / Math.max(1, prog.total)) * 100)
            try { setMetaProgress(pct) } catch (e) {}
          })
        } catch (e) {
          // ignore background poll errors; refreshScan will still handle toasts/errors
        }
      })();

      await refreshScan(r.data.scanId)
      // record durations after metadata refresh completes
      try {
        const now = Date.now()
        const scanStart = phaseStartRef.current.scanStart
        const metaStart = phaseStartRef.current.metaStart
        if (scanStart && metaStart) {
          const scanDur = metaStart - scanStart
          const metaDur = now - metaStart
          const hist = timingHistoryRef.current || { scanDurations: [], metaDurations: [] }
          hist.scanDurations = (hist.scanDurations || []).concat([scanDur]).slice(-10)
          hist.metaDurations = (hist.metaDurations || []).concat([metaDur]).slice(-10)
          timingHistoryRef.current = hist
          saveTimingHistory()
        }
      } catch (e) {}
      // Now refresh client-side enrich for all collected paths and report progress
      const paths = collected.map(it => it.canonicalPath).filter(Boolean)
      if (paths.length > 0) {
        try {
          // Use bulk endpoint to reduce many individual GET requests
          const resp = await axios.post(API('/enrich/bulk'), { paths })
          const itemsOut = resp && resp.data && Array.isArray(resp.data.items) ? resp.data.items : []
          let done = 0
          for (const entry of itemsOut) {
            try {
              const p = entry.path
              if (entry.error) {
                // skip errored entries
              } else if (entry.enrichment && (entry.cached || entry.enrichment)) {
                if (entry.enrichment.missing) {
                  setEnrichCache(prev => { const n = { ...prev }; delete n[p]; return n })
                  setItems(prev => prev.filter(it => it.canonicalPath !== p))
                  setAllItems(prev => prev.filter(it => it.canonicalPath !== p))
                } else {
                  const enriched = normalizeEnrichResponse(entry.enrichment || null)
                  if (enriched) {
                    setEnrichCache(prev => ({ ...prev, [p]: enriched }))
                    if (enriched.hidden || enriched.applied) {
                      setItems(prev => prev.filter(it => it.canonicalPath !== p))
                      setAllItems(prev => prev.filter(it => it.canonicalPath !== p))
                    } else {
                      setItems(prev => mergeItemsUnique(prev, [{ id: p, canonicalPath: p }], true))
                      setAllItems(prev => mergeItemsUnique(prev, [{ id: p, canonicalPath: p }], true))
                    }
                  }
                }
              } else {
                // not cached: leave for individual enrichOne requests later
              }
            } catch (e) {}
            done++
            try { setMetaProgress(Math.round((done / paths.length) * 100)) } catch (e) {}
          }
        } catch (e) {
          // fallback: ignore bulk errors and continue
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
    // set the persistent baseline and the currently-visible items
    setAllItems(filtered)
    setItems(filtered)
    // record current scan canonical paths so cached enrichments not present in the scan are ignored
    try { setCurrentScanPaths(new Set((collected || []).map(i => i.canonicalPath).filter(Boolean))) } catch (e) {}
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
    // Rescan should not re-walk the library. Instead, refresh metadata for items
    // in the current scan by calling the server-side refresh endpoint which will
    // hit the external provider for each item.
    const sid = scanId || (scanMeta && scanMeta.id)
    if (!sid) {
      pushToast && pushToast('Rescan', 'No existing scan to refresh — perform a Scan first')
      return
    }
    try {
      pushToast && pushToast('Rescan', 'Refreshing metadata for current scan (will call provider for each item)')
      await refreshScan(sid)
      pushToast && pushToast('Rescan', 'Provider metadata refresh complete')
      try { await verifyCachePaths(); } catch (e) {}
    } catch (e) {
      pushToast && pushToast('Rescan', 'Rescan (refresh) failed')
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
      if (r.data) {
        if (r.data.missing) {
          // underlying file missing
          setEnrichCache(prev => { const n = { ...prev }; delete n[key]; return n })
          return null
        }
        if ((r.data.cached || r.data.enrichment) && !force) {
          const norm = normalizeEnrichResponse(r.data.enrichment || r.data)
          setEnrichCache(prev => ({ ...prev, [key]: norm }))
          return norm
        }
      }
      } catch (e) {
        // ignore and continue to POST
      }

    // POST to /enrich to generate/update enrichment (force bypasses cache check)
  const w = await axios.post(API('/enrich'), { path: key, tmdb_api_key: providerKey || undefined, force: force || undefined })
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
    // Attempt to fetch pages until we either find visible items or reach a reasonable attempt limit.
    // This handles cases where the server reports a non-zero total but the first N pages contain
    // only items that are hidden/applied on the client and therefore filtered out locally.
    let nextOffset = items.length
    if (nextOffset >= total) return
    let r = null
    const maxAttempts = 8
    let attempts = 0
    // local mutable copy of current items for merge checks
    let curr = items.slice()
    while (nextOffset < total && attempts < maxAttempts) {
      if (searchQuery && searchQuery.length > 0) {
        r = await searchScan(searchQuery, nextOffset, batchSize)
        const page = (r.items || [])
        const merged = mergeItemsUnique(curr, page, false)
        // if merged produced new visible rows, commit and stop looping
        if (merged.length > curr.length) {
          setItems(merged)
          curr = merged
          break
        }
        // otherwise advance offset and try next page
        curr = merged
        nextOffset += (page || []).length
      } else {
        r = await axios.get(API(`/scan/${scanId}/items?offset=${nextOffset}&limit=${batchSize}`))
        const page = (r.data && r.data.items) || []
        const merged = mergeItemsUnique(curr, page, false)
        if (merged.length > curr.length) {
          setItems(merged)
          curr = merged
          // update current scan paths with new page
          try {
            setCurrentScanPaths(prev => {
              const s = new Set(prev || [])
              for (const it of page) if (it && it.canonicalPath) s.add(it.canonicalPath)
              return s
            })
          } catch (e) {}
          break
        }
        curr = merged
        // update current scan paths even when nothing visible was added
        try {
          setCurrentScanPaths(prev => {
            const s = new Set(prev || [])
            for (const it of page) if (it && it.canonicalPath) s.add(it.canonicalPath)
            return s
          })
        } catch (e) {}
        nextOffset += page.length
      }
      attempts++
    }

    // If we fetched a page object that contains raw items, trigger enrich for them if needed
    try {
      const pageItems = (r && (r.items || (r.data && r.data.items))) || []
      const forceEnrich = scanOptionsRef.current && scanOptionsRef.current.forceEnrich === true
      for (const it of pageItems) {
        if (!it) continue
        if (forceEnrich) enrichOne && enrichOne(it, true)
        else if (!enrichCache[it.canonicalPath]) enrichOne && enrichOne(it)
      }
    } catch (e) {}
  }

  // run a fresh search and replace visible items with results
  // perform search immediately (used by buttons); live-search handled by debounce effect below
  async function doSearch(q) {
    setSearchQuery(q || '')
    // clear: restore baseline listing immediately from allItems if present
    if (!q) {
      try {
        setSearching(false)
        if (allItems && allItems.length) {
          setItems(allItems.slice())
          setTotal(allItems.length)
          return
        }
        // fetch first page of items from server-side scan listing as fallback
        if (scanId) {
          const r = await axios.get(API(`/scan/${scanId}/items`), { params: { offset: 0, limit: batchSize } })
          const page = (r.data.items || []).filter(it => { const e = enrichCache && enrichCache[it.canonicalPath]; return !(e && (e.hidden === true || e.applied === true)) })
          setItems(page)
          setTotal((scanMeta && scanMeta.totalCount) || page.length || 0)
          try { setCurrentScanPaths(new Set((r.data.items || []).map(i => i.canonicalPath).filter(Boolean))) } catch (e) {}
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
              // If first page returned zero visible items but server reports more, try loading more pages
              if ((page || []).length === 0 && ((scanMeta && scanMeta.totalCount) || 0) > 0) {
                // attempt to load further pages up to a small limit
                try { await handleScrollNearEnd() } catch (e) {}
              }
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
    // if clearing search and there is no active scan, clear tracked scan paths
    if (!scanId) setCurrentScanPaths(new Set())

    // explicit Search button: perform server-side search and ensure each result is enriched
    try {
      setSearching(true)
      // If we have the baseline in-memory, perform client-side filtering using enriched metadata
      if (allItems && allItems.length) {
        const qq = (q || '').trim()
        if (!qq) {
          if (allItems.length <= MAX_IN_MEMORY_SEARCH) {
            setItems(allItems.slice())
            setTotal(allItems.length)
          } else {
            // large baseline: fetch first page from server instead of rendering all in-memory
            const r = await axios.get(API(`/scan/${scanId}/items`), { params: { offset: 0, limit: batchSize } })
            const page = (r.data.items || []).filter(it => { const e = enrichCache && enrichCache[it.canonicalPath]; return !(e && (e.hidden === true || e.applied === true)) })
            setItems(page)
            setTotal((scanMeta && scanMeta.totalCount) || page.length || 0)
            try { setCurrentScanPaths(new Set((r.data.items || []).map(i => i.canonicalPath).filter(Boolean))) } catch (e) {}
          }
        } else {
          const lowered = qq.toLowerCase()
          const results = allItems.filter(it => matchesQuery(it, lowered)).filter(it => { const e = enrichCache && enrichCache[it.canonicalPath]; return !(e && (e.hidden === true || e.applied === true)) })
          setItems(results)
          setTotal(results.length)
          for (const it of results || []) if (!enrichCache[it.canonicalPath]) enrichOne && enrichOne(it)
        }
      } else {
        const r = await searchScan(q, 0, batchSize)
        const results = (r.items || []).filter(it => { const e = enrichCache && enrichCache[it.canonicalPath]; return !(e && (e.hidden === true || e.applied === true)) })
        setItems(results)
        setTotal(r.total || 0)
      }
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
    // if empty query, restore normal listing (prefer `allItems` if present)
    if (!searchQuery || searchQuery.length === 0) {
      // If we have a cached full listing in-memory and it's reasonably sized, use it immediately
      if (allItems && allItems.length && allItems.length <= MAX_IN_MEMORY_SEARCH) {
        try { setItems(allItems.slice()) } catch (e) {}
        try { setTotal(allItems.length) } catch (e) {}
      } else if (allItems && allItems.length && allItems.length > MAX_IN_MEMORY_SEARCH) {
        // baseline is too large for in-memory rendering -> fetch first page from server
        try {
          // prefer using current scanId paging if available
          if (scanId) {
            searchTimeoutRef.current = setTimeout(() => { handleScrollNearEnd().catch(()=>{}) }, 150)
          } else {
            setItems([])
            searchTimeoutRef.current = setTimeout(() => { handleScrollNearEnd().catch(()=>{}) }, 150)
          }
        } catch (e) { setItems([]) }
      } else {
        // otherwise fall back to loading pages from the server
        setItems([])
        // small timeout to allow UI to update
        searchTimeoutRef.current = setTimeout(() => { handleScrollNearEnd().catch(()=>{}) }, 150)
      }
      return () => { if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current) }
    }
    // debounce live search (300ms)
    searchTimeoutRef.current = setTimeout(async () => {
      try {
        if (allItems && allItems.length) {
          const q = (searchQuery || '').trim()
          if (!q) {
            setItems(allItems.slice())
            setTotal(allItems.length)
          } else {
            // If baseline is too large, fall back to server-side search
            if (allItems.length > MAX_IN_MEMORY_SEARCH) {
              const r = await searchScan(searchQuery, 0, batchSize)
              const filtered = (r.items || []).filter(it => { const e = enrichCache && enrichCache[it.canonicalPath]; return !(e && (e.hidden === true || e.applied === true)) })
              setItems(filtered)
              setTotal(r.total || 0)
              for (const it of filtered || []) if (!enrichCache[it.canonicalPath]) enrichOne && enrichOne(it)
            } else {
              const lowered = q.toLowerCase()
              const filtered = allItems.filter(it => matchesQuery(it, lowered)).filter(it => { const e = enrichCache && enrichCache[it.canonicalPath]; return !(e && (e.hidden === true || e.applied === true)) })
              setItems(filtered)
              setTotal(filtered.length)
              for (const it of filtered || []) if (!enrichCache[it.canonicalPath]) enrichOne && enrichOne(it)
            }
          }
        } else {
          // perform search with cancellation via searchScan
          const r = await searchScan(searchQuery, 0, batchSize)
          const filtered = (r.items || []).filter(it => { const e = enrichCache && enrichCache[it.canonicalPath]; return !(e && (e.hidden === true || e.applied === true)) })
          setItems(filtered)
          setTotal(r.total || 0)
          for (const it of filtered || []) if (!enrichCache[it.canonicalPath]) enrichOne && enrichOne(it)
        }
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
        if (er.data) {
          if (er.data.missing) {
            setEnrichCache(prev => { const n = { ...prev }; delete n[p]; return n })
            setItems(prev => prev.filter(it => it.canonicalPath !== p))
          } else if (er.data.cached || er.data.enrichment) {
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
      // If server started background work, poll for progress
      if (r.status === 202 && r.data && r.data.background) {
        const toastId = pushToast && pushToast('Refresh','Refresh started on server', { sticky: true, spinner: true })
        try {
          await pollRefreshProgress(scanId, (prog) => {
            // update toast with percent
            const pct = Math.round((prog.processed / Math.max(1, prog.total)) * 100)
            try { setMetaProgress(pct) } catch(e){}
            if (pushToast) pushToast('Refresh', `Refreshing metadata: ${pct}% (${prog.processed}/${prog.total})`, { id: toastId, sticky: true, spinner: true })
          })
          if (pushToast) pushToast('Refresh','Server-side refresh complete')
        } catch (e) {
          if (pushToast) pushToast('Refresh','Server-side refresh failed')
        }
        // after background run completes, fetch latest enrich entries for items
        try {
          const logs = await axios.get(API('/logs/recent'))
        } catch(e){}
        return { ok: true, background: true }
      }
      // otherwise behave as before: synchronous response may include results
      if (r.data && r.data.results) {
        for (const res of r.data.results) {
          try {
            const er = await axios.get(API('/enrich'), { params: { path: res.path } })
            if (er.data) {
              if (er.data.missing) {
                setEnrichCache(prev => { const n = { ...prev }; delete n[res.path]; return n })
              } else if (er.data.cached || er.data.enrichment) {
                const norm = normalizeEnrichResponse(er.data.enrichment || er.data)
                setEnrichCache(prev => ({ ...prev, [res.path]: norm }))
              }
            }
          } catch (e) {}
        }
      }
      return r.data
     } catch (err) { throw err }
   }

  // Poll the server progress endpoint until completion or failure
  async function pollRefreshProgress(scanId, onProgress) {
    const endpoint = API(`/scan/${scanId}/progress`)
    return new Promise((resolve, reject) => {
      let stopped = false
      const id = setInterval(async () => {
        try {
          const r = await axios.get(endpoint)
          if (!r.data || !r.data.progress) return
          const prog = r.data.progress
          if (onProgress) onProgress(prog)
          if (prog.status === 'complete') { clearInterval(id); stopped = true; resolve(prog) }
          else if (prog.status === 'failed') { clearInterval(id); stopped = true; reject(new Error('refresh failed')); }
        } catch (e) {
          // transient network or auth error: keep polling a few times
        }
      }, 1000)
      // safety timeout after 30 minutes
      setTimeout(() => { if (!stopped) { clearInterval(id); reject(new Error('timeout')) } }, 30*60*1000)
    })
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

  // On mount: if we have a persisted lastScanId, attempt to load it and populate allItems
  useEffect(() => {
    let mounted = true
    async function loadLastScan() {
      try {
        let effectiveScanId = lastScanId
        let metaRes = null
        if (effectiveScanId) metaRes = await axios.get(API(`/scan/${effectiveScanId}`)).catch(() => null)
        // If persisted lastScanId not found on server, fallback to latest scan for the library
        if ((!metaRes || !metaRes.data) && lastLibraryId) {
          const pick = await axios.get(API('/scan/latest'), { params: { libraryId: lastLibraryId } }).catch(() => null)
          if (pick && pick.data && pick.data.scanId) {
            effectiveScanId = pick.data.scanId
            metaRes = await axios.get(API(`/scan/${effectiveScanId}`)).catch(() => null)
          }
        }
        if (!metaRes || !metaRes.data) return
        if (!mounted) return
        setScanId(effectiveScanId)
        setScanMeta(metaRes.data)
        const totalCount = metaRes.data.totalCount || 0
        setTotal(totalCount)
        // if the scan is small enough, fetch all items in one go; otherwise, fetch first page only
        if (totalCount <= MAX_IN_MEMORY_SEARCH) {
          // fetch in pages of 500
          const pageSize = 500
          let all = []
          for (let off = 0; off < totalCount; off += pageSize) {
            const r = await axios.get(API(`/scan/${lastScanId}/items`), { params: { offset: off, limit: pageSize } }).catch(() => ({ data: { items: [] } }))
            if (!mounted) return
            all = all.concat(r.data.items || [])
          }
          setAllItems(all)
          setItems(all)
          setCurrentScanPaths(new Set((all || []).map(i => i.canonicalPath)))
        } else {
          // large scan: fetch first page only and rely on server search/paging for the rest
          const r = await axios.get(API(`/scan/${lastScanId}/items`), { params: { offset: 0, limit: 500 } }).catch(() => ({ data: { items: [] } }))
          if (!mounted) return
          const first = r.data.items || []
          setAllItems(first)
          setItems(first)
          setCurrentScanPaths(new Set((first || []).map(i => i.canonicalPath)))
        }
      } catch (e) { /* best-effort */ }
    }
    loadLastScan()
    return () => { mounted = false }
  }, [lastScanId])

  const selectedCount = Object.keys(selected || {}).length
  return (
  <div className={"app" + (selectMode && selectedCount ? ' select-mode-shrink' : '')}>
      <header>
        <h1 style={{cursor:'pointer'}} onClick={() => (window.location.hash = '#/')} title="Go to dashboard">MMP Renamer</h1>
  {/* Header search: only show when authenticated */}
  {auth ? (
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
  ) : null}
        {/* Global bulk-enrich indicator (shown when many enrich operations are running) */}
  {auth && visibleGlobalEnrichPending ? (
    <div className="bulk-enrich" title="Bulk metadata refresh in progress">
      <Spinner />
      <span className="bulk-enrich-label">{metaPhase ? `Refreshing metadata ${metaProgress}%` : `Updating ${enrichPendingCount} item${enrichPendingCount === 1 ? '' : 's'}`}</span>
    </div>
  ) : null}

        {auth ? (
            <div className="header-actions">
            <button className={"btn-save" + (selectMode && selectedCount ? ' shifted' : '')} onClick={() => {
                try {
                  if (scanning) { pushToast && pushToast('Scan','Scan already in progress'); return }
                  // Provide immediate feedback and prevent duplicate clicks by setting scanning now
                  setScanning(true)
                  // Start the scan asynchronously; triggerScan manages its own scanning state during metadata phases
                  void triggerScan(libraries[0]).catch(e => { pushToast && pushToast('Scan','Scan failed to start') })
                } catch (e) {
                  pushToast && pushToast('Scan','Scan failed to start')
                  setScanning(false)
                }
              }} disabled={scanning}><span>{scanning ? <Spinner/> : 'Scan'}</span></button>
            {/* Select + Approve wrapper: Approve is absolutely positioned so it doesn't reserve space when hidden */}
            <div className="select-approve-wrap">
                {selectMode && Object.keys(selected).length ? (
                  <button
                    className={"btn-save approve-button visible"}
                    onClick={async () => {
                      try {
                        const selectedPaths = Object.keys(selected).filter(Boolean)
                        if (!selectedPaths.length) return
                        const selItems = items.filter(it => selectedPaths.includes(it.canonicalPath))
                        if (!selItems.length) return
                        pushToast && pushToast('Approve', `Approving ${selItems.length} items...`)
                        const plans = await previewRename(selItems)
                        await applyRename(plans)
                        setSelected({})
                        pushToast && pushToast('Approve', 'Approve completed')
                      } catch (e) { pushToast && pushToast('Approve', 'Approve failed') }
                    }}
                    title="Approve selected"
                  >Approve selected</button>
                ) : null}
                {/* Rescan selected: appears only in select mode and when items are selected; does not reserve space when hidden */}
                {selectMode && Object.keys(selected).length ? (
                  <button
                    className={"btn-ghost approve-button visible"}
                    onClick={async () => {
                      try {
                        const selectedPaths = Object.keys(selected).filter(Boolean)
                        if (!selectedPaths.length) return
                        pushToast && pushToast('Rescan', `Rescanning ${selectedPaths.length} items...`)
                        // set per-item loading while refresh happens
                        const loadingMap = {}
                        for (const p of selectedPaths) loadingMap[p] = true
                        safeSetLoadingEnrich(prev => ({ ...prev, ...loadingMap }))
                        await refreshEnrichForPaths(selectedPaths)
                        safeSetLoadingEnrich(prev => { const n = { ...prev }; for (const p of selectedPaths) delete n[p]; return n })
                        setSelected({})
                        pushToast && pushToast('Rescan', 'Rescan complete')
                      } catch (e) { pushToast && pushToast('Rescan', 'Rescan failed') }
                    }}
                    title="Rescan selected"
                  >Rescan selected</button>
                ) : null}
              <button className={"btn-ghost" + (selectMode ? ' active' : '')} onClick={() => { setSelectMode(s => { if (s) setSelected({}); return !s }) }} title={selectMode ? 'Exit select mode' : 'Select items'}>Select</button>
            </div>
            {/* Removed duplicate Rescan button per request; keep Refresh metadata */}
            <button className={"btn-ghost" + (!(lastLibraryId || (scanMeta && scanMeta.libraryId)) ? ' disabled' : '')} onClick={async () => { if (!(lastLibraryId || (scanMeta && scanMeta.libraryId))) return; pushToast && pushToast('Refresh','Server-side refresh started'); try { await refreshScan(scanMeta ? scanMeta.id : lastLibraryId); pushToast && pushToast('Refresh','Server-side refresh complete'); } catch (e) { pushToast && pushToast('Refresh','Refresh failed') } }} title="Refresh metadata server-side" disabled={!(lastLibraryId || (scanMeta && scanMeta.libraryId))}><IconRefresh/> <span>Refresh metadata</span></button>
            <button className="btn-ghost" onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}>Theme: {theme === 'dark' ? 'Dark' : 'Light'}</button>
            <button className="btn-ghost" onClick={() => (window.location.hash = route === '#/settings' ? '#/' : '#/settings')}>Settings</button>
            <button className="btn-ghost icon-only" title="Notifications" onClick={() => (window.location.hash = '#/notifications')}>
              {/* compact bell icon - centered and sized to avoid cropping */}
              <svg className="icon" viewBox="0 0 24 24" width="18" height="18" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 22c1.1 0 2-.9 2-2H10c0 1.1.9 2 2 2z" />
                <path d="M18 16v-5c0-3.07-1.63-5.64-4.5-6.32V4a1.5 1.5 0 10-3 0v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z" />
              </svg>
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
                    {/* combinedProgress maps scanProgress to 0-50% and metaProgress to 50-100% */}
                    {(() => {
                      // Configurable split for header progress: scan occupies SCAN_WEIGHT of the range
                      // and metadata occupies META_WEIGHT. We map overall progress to 0-100.
                      const { scanWeight, metaWeight } = computeWeights()
                      const scanPct = Math.min(100, Math.max(0, Number(scanProgress) || 0))
                      const metaPct = Math.min(100, Math.max(0, Number(metaProgress) || 0))
                      const combined = metaPhase ? Math.round((scanWeight * 100) + (metaPct * metaWeight)) : Math.round(scanPct * scanWeight)
                      return (
                        <div>Found {total} items. Scanning: {scanLoaded}/{total} ({combined}%)</div>
                      )
                    })()}
                    <div style={{height:12, width:'100%'}}>
                      <div className="progress-bar">
                        <div className="fill" style={{ width: (metaPhase ? ((computeWeights().scanWeight * 100) + (metaProgress * computeWeights().metaWeight)) : (scanProgress * computeWeights().scanWeight)) + '%' }} />
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
            const originalPath = it.canonicalPath
            // guard concurrent clicks
            if (loadingEnrich && loadingEnrich[originalPath]) return
            safeSetLoadingEnrich(prev => ({ ...prev, [originalPath]: true }))
            let resp = null
            let didFinalToast = false
            try {
              // attempt hide
              resp = await axios.post(API('/enrich/hide'), { path: originalPath })
              // prefer canonical key returned by server when present
              const serverKey = resp && resp.data && resp.data.path ? resp.data.path : originalPath
              const returned = resp && resp.data && (resp.data.enrichment || resp.data) ? (resp.data.enrichment || resp.data) : null
              // Always fetch authoritative enrichment after the operation to avoid races
              let authoritative = null
              try {
                const er = await axios.get(API('/enrich'), { params: { path: serverKey } }).catch(() => null)
                authoritative = er && er.data && (er.data.enrichment || er.data) ? (er.data.enrichment || er.data) : null
              } catch (e) { authoritative = null }
              const enriched = authoritative ? normalizeEnrichResponse(authoritative) : (returned ? normalizeEnrichResponse(returned) : null)

              // Apply authoritative/optimistic changes to local cache/UI but do NOT show final toast yet.
              if (enriched) {
                setEnrichCache(prev => ({ ...prev, [serverKey]: enriched }))
                // remove from visible lists if hidden/applied
                if (enriched.hidden || enriched.applied) {
                  setItems(prev => prev.filter(x => x.canonicalPath !== serverKey))
                  setAllItems(prev => prev.filter(x => x.canonicalPath !== serverKey))
                }
              } else {
                // no authoritative enrichment — fallback to optimistic hide but still attempt to refresh scans
                setEnrichCache(prev => ({ ...prev, [originalPath]: Object.assign({}, prev && prev[originalPath] ? prev[originalPath] : {}, { hidden: true }) }))
                setItems(prev => prev.filter(x => x.canonicalPath !== originalPath))
                setAllItems(prev => prev.filter(x => x.canonicalPath !== originalPath))
              }

              // refresh affected scans if server indicates modification and wait for them to complete
              try {
                const modified = (resp && resp.data && Array.isArray(resp.data.modifiedScanIds)) ? resp.data.modifiedScanIds : []
                if (modified && modified.length) {
                  const toReload = modified.filter(sid => sid === scanId || sid === lastScanId)
                  for (const sid of toReload) {
                    try {
                      const m = await axios.get(API(`/scan/${sid}`))
                      const total = m.data.totalCount || 0
                      const coll = []
                      let off = 0
                      while (off < total) {
                        const pgr = await axios.get(API(`/scan/${sid}/items?offset=${off}&limit=${batchSize}`))
                        const its = pgr.data.items || []
                        coll.push(...its)
                        off += its.length
                      }
                      if (sid === scanId || sid === lastScanId) {
                        try { updateScanDataAndPreserveView(m.data, coll) } catch (e) {
                          setScanMeta(m.data)
                          setTotal(m.data.totalCount || coll.length)
                          setItems(coll.filter(it => it && it.canonicalPath))
                          setAllItems(coll.filter(it => it && it.canonicalPath))
                          try { setCurrentScanPaths(new Set((coll||[]).map(x => x.canonicalPath))) } catch (ee) {}
                        }
                        // inform server we refreshed this scan so server logs can confirm client-side refresh
                        try { await axios.post(API('/debug/client-refreshed'), { scanId: sid }).catch(()=>null) } catch (e) {}
                      }
                    } catch (e) { /* best-effort */ }
                  }
                }
              } catch (e) { /* swallow */ }

              // Now that we've reloaded scans (if applicable), confirm final state and show a single toast.
              try {
                // If we have an authoritative enriched object that indicates hidden/applied, show success
                if (enriched && (enriched.hidden || enriched.applied)) {
                  pushToast && pushToast('Hide', 'Item hidden')
                  didFinalToast = true
                } else {
                  // Otherwise, perform a final authoritative check before declaring failure
                  const tryPaths = []
                  if (resp && resp.data && resp.data.path) tryPaths.push(resp.data.path)
                  tryPaths.push(originalPath)
                  let confirmed = false
                  for (const pth of tryPaths) {
                    try {
                      const check = await axios.get(API('/enrich'), { params: { path: pth } }).catch(() => null)
                      const auth = check && check.data && (check.data.enrichment || check.data) ? (check.data.enrichment || check.data) : null
                      const norm = auth ? normalizeEnrichResponse(auth) : null
                      if (norm && (norm.hidden || norm.applied)) {
                        // server applied hide — treat as success
                        setEnrichCache(prev => ({ ...prev, [pth]: norm }))
                        setItems(prev => prev.filter(x => x.canonicalPath !== pth))
                        setAllItems(prev => prev.filter(x => x.canonicalPath !== pth))
                        pushToast && pushToast('Hide', 'Item hidden (confirmed)')
                        didFinalToast = true
                        confirmed = true
                        break
                      }
                    } catch (e) {}
                  }
                  if (!confirmed && !didFinalToast) {
                    // genuine failure — but wait briefly for any server-side hide event before giving up
                    try {
                      const handled = await handleHideFailure([ (resp && resp.data && resp.data.path) ? resp.data.path : originalPath, originalPath ])
                      if (!handled) {
                        pushToast && pushToast('Hide', 'Failed to hide')
                      }
                    } catch (e) {
                      pushToast && pushToast('Hide', 'Failed to hide')
                    }
                    didFinalToast = true
                  }
                }
              } catch (e) {
                if (!didFinalToast) {
                  try {
                    const handled = await handleHideFailure([ (resp && resp.data && resp.data.path) ? resp.data.path : originalPath, originalPath ])
                    if (!handled) pushToast && pushToast('Hide', 'Failed to hide')
                  } catch (e) { pushToast && pushToast('Hide', 'Failed to hide') }
                }
                didFinalToast = true
              }
            } catch (err) {
              // On network error, consult authoritative GET before deciding failure (existing behavior)
              try {
                const tryPaths = []
                if (resp && resp.data && resp.data.path) tryPaths.push(resp.data.path)
                tryPaths.push(originalPath)
                let confirmed = false
                for (const pth of tryPaths) {
                  try {
                    const check = await axios.get(API('/enrich'), { params: { path: pth } }).catch(() => null)
                    const auth = check && check.data && (check.data.enrichment || check.data) ? (check.data.enrichment || check.data) : null
                    const norm = auth ? normalizeEnrichResponse(auth) : null
                    if (norm && (norm.hidden || norm.applied)) {
                      // server likely applied hide but POST failed — treat as success
                      setEnrichCache(prev => ({ ...prev, [pth]: norm }))
                      setItems(prev => prev.filter(x => x.canonicalPath !== pth))
                      setAllItems(prev => prev.filter(x => x.canonicalPath !== pth))
                      pushToast && pushToast('Hide', 'Item hidden (confirmed)')
                      confirmed = true
                      break
                    }
                  } catch (e) {}
                }
                    if (!confirmed) {
                      // genuine failure — wait for server hide event briefly before declaring failure
                      try {
                        const handled = await handleHideFailure([ (resp && resp.data && resp.data.path) ? resp.data.path : originalPath, originalPath ])
                        if (!handled) pushToast && pushToast('Hide', 'Failed to hide')
                      } catch (e) { pushToast && pushToast('Hide', 'Failed to hide') }
                    }
                // If POST did return modifiedScanIds before network error, reload those scans
                try {
                  const modified = (resp && resp.data && Array.isArray(resp.data.modifiedScanIds)) ? resp.data.modifiedScanIds : []
                  if (modified && modified.length) {
                    const toReload = modified.filter(sid => sid === scanId || sid === lastScanId)
                    for (const sid of toReload) {
                      try {
                        const m = await axios.get(API(`/scan/${sid}`))
                        const total = m.data.totalCount || 0
                        const coll = []
                        let off = 0
                        while (off < total) {
                          const pgr = await axios.get(API(`/scan/${sid}/items?offset=${off}&limit=${batchSize}`))
                          const its = pgr.data.items || []
                          coll.push(...its)
                          off += its.length
                        }
                        if (sid === scanId || sid === lastScanId) {
                            try { updateScanDataAndPreserveView(m.data, coll) } catch (e) {
                              setScanMeta(m.data)
                              setTotal(m.data.totalCount || coll.length)
                              setItems(coll.filter(it => it && it.canonicalPath))
                              setAllItems(coll.filter(it => it && it.canonicalPath))
                              try { setCurrentScanPaths(new Set((coll||[]).map(x => x.canonicalPath))) } catch (ee) {}
                            }
                          // inform server we refreshed this scan so server logs can confirm client-side refresh
                          try { await axios.post(API('/debug/client-refreshed'), { scanId: sid }).catch(()=>null) } catch (e) {}
                        }
                      } catch (e) {}
                    }
                  }
                } catch (ee) {}
              } catch (ee) {
                try {
                  const handled = await handleHideFailure([ (resp && resp.data && resp.data.path) ? resp.data.path : originalPath, originalPath ])
                  if (!handled) pushToast && pushToast('Hide', 'Failed to hide')
                } catch (e) { pushToast && pushToast('Hide', 'Failed to hide') }
              }
            } finally {
              // Always attempt to refresh affected scans so UI matches server state.
              try {
                const modified = (resp && resp.data && Array.isArray(resp.data.modifiedScanIds)) ? resp.data.modifiedScanIds : []
                if (modified && modified.length) {
                  const toReload = modified.filter(sid => sid === scanId || sid === lastScanId)
                  for (const sid of toReload) {
                    try {
                      const m = await axios.get(API(`/scan/${sid}`)).catch(() => null)
                      if (m && m.data) {
                        const total = m.data.totalCount || 0
                        const coll = []
                        let off = 0
                        while (off < total) {
                          const pgr = await axios.get(API(`/scan/${sid}/items?offset=${off}&limit=${batchSize}`)).catch(() => ({ data: { items: [] } }))
                          const its = pgr.data.items || []
                          coll.push(...its)
                          off += its.length
                        }
                        if (sid === scanId || sid === lastScanId) {
                          try { updateScanDataAndPreserveView(m.data, coll) } catch (e) {
                            setScanMeta(m.data)
                            setTotal(m.data.totalCount || coll.length)
                            setItems(coll.filter(it => it && it.canonicalPath))
                            setAllItems(coll.filter(it => it && it.canonicalPath))
                            try { setCurrentScanPaths(new Set((coll||[]).map(x => x.canonicalPath))) } catch (ee) {}
                          }
                        }
                      }
                    } catch (e) { /* swallow */ }
                  }
                } else {
                  // Fallback: if server didn't return modifiedScanIds (or POST failed), reload the current scan(s)
                  const sid = scanId || lastScanId
                  if (sid) {
                    try {
                      const m = await axios.get(API(`/scan/${sid}`)).catch(() => null)
                      if (m && m.data) {
                        const total = m.data.totalCount || 0
                        const coll = []
                        let off = 0
                        while (off < total) {
                          const pgr = await axios.get(API(`/scan/${sid}/items?offset=${off}&limit=${batchSize}`)).catch(() => ({ data: { items: [] } }))
                          const its = pgr.data.items || []
                          coll.push(...its)
                          off += its.length
                        }
                        try { updateScanDataAndPreserveView(m.data, coll) } catch (e) {
                          // helper failed — fall back to explicit state updates
                          setScanMeta(m.data)
                          setTotal(m.data.totalCount || coll.length)
                          setItems(coll.filter(it => it && it.canonicalPath))
                          setAllItems(coll.filter(it => it && it.canonicalPath))
                          try { setCurrentScanPaths(new Set((coll||[]).map(x => x.canonicalPath))) } catch (ee) {}
                        }
                      }
                    } catch (e) { /* swallow */ }
                  }
                }
              } catch (ee) { /* best-effort refresh */ }
              safeSetLoadingEnrich(prev => { const n = { ...prev }; delete n[originalPath]; return n })
            }
          }}>{loading ? <Spinner/> : <><IconCopy/> <span>Hide</span></>}</button>
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
