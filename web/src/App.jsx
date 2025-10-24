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
  const [scanReady, setScanReady] = useState(true)
  const [activeScanKind, setActiveScanKind] = useState(null)
  const [confirmFullScanOpen, setConfirmFullScanOpen] = useState(false)
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
  const loadingMoreRef = React.useRef(false)
  const [enrichCache, setEnrichCache] = useLocalState('enrichCache', {})
  const [logs, setLogs] = useState('')
  const [toasts, setToasts] = useState([])
  const [loadingEnrich, setLoadingEnrich] = useState({})
  // recently hidden items pending authoritative confirmation; prevents re-inserts during background merges
  const pendingHiddenRef = useRef(new Set())
  // map of path -> timeout id to clear pending flags after a grace period
  const pendingHideTimeoutsRef = useRef({})
  // last seen hide event timestamp (ms)
  const lastHideEventTsRef = useRef( Number(localStorage.getItem('lastHideEventTs') || '0') || 0 )
  const isMountedRef = useRef(true)

  // Debug flag: enable verbose debug logs by setting window.__RENAMER_DEBUG__ = true
  const DEBUG = (typeof window !== 'undefined' && !!window.__RENAMER_DEBUG__) || false
  function dlog(...args) { try { if (DEBUG && console && console.debug) console.debug(...args) } catch (e) {} }

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
  postClientRefreshed: async (sid) => { try { await postClientRefreshedDebounced({ scanId: sid }) } catch (e) {} }
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
  postClientRefreshed: async (sid) => { try { await postClientRefreshedDebounced({ scanId: sid }) } catch (e) {} }
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
  // When we create a new scan in this session, suppress the mount-effect that
  // would eagerly fetch all pages for the persisted lastScanId so we don't
  // duplicate work or trigger many paged GETs immediately after scanning.
  const newScanJustCreatedRef = React.useRef(false)
  // guard map to avoid posting repeated client-refreshed for same scanId/path
  const clientRefreshedMapRef = useRef({})

  // Post client-refreshed but debounce per key (scanId or path) to avoid spamming server
  async function postClientRefreshedDebounced({ scanId=null, path=null }) {
    try {
      const key = scanId ? `sid:${scanId}` : (path ? `path:${path}` : 'global')
      const now = Date.now()
      const last = clientRefreshedMapRef.current[key] || 0
      const MIN_MS = 2000
      if (now - last < MIN_MS) return
      clientRefreshedMapRef.current[key] = now
      // No-op: hide actions already update UI optimistically and background sync will
      // reconcile scans. Retain debounce bookkeeping for compatibility while avoiding
      // unnecessary network calls that previously generated HIDE_RECONCILED logs.
      return
    } catch (e) {}
  }
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
      const pending = pendingHiddenRef.current || new Set()
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
          // don't reinsert items that we've optimistically hidden but not yet confirmed
          if (pending && pending.has(it.canonicalPath)) continue
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
          // don't reinsert items that we've optimistically hidden but not yet confirmed
          if (pending && pending.has(it.canonicalPath)) continue
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
      // If coll looks like a partial first-page (fewer items than reported total)
      // and we already have a larger baseline in `allItems`, merge instead of
      // replacing so we don't stomp the user's current view/scroll position.
      let baseline = clean
      try {
        if (meta && meta.totalCount && clean.length < meta.totalCount && allItems && allItems.length > clean.length) {
          baseline = mergeItemsUnique(allItems || [], clean, false)
          setAllItems(prev => mergeItemsUnique(prev || [], clean, false))
        } else {
          setAllItems(clean)
        }
      } catch (e) {
        setAllItems(clean)
      }
      // If user is actively searching, prefer client-side filtering when safe so
      // we don't cause a full server-side update that could reset the view.
      if (searchQuery && searchQuery.length) {
        try {
          if ((clean.length || 0) <= MAX_IN_MEMORY_SEARCH) {
            const q = searchQuery
            const lowered = q.toLowerCase()
            // choose sourceForSearch carefully: prefer baseline only if present
            const sourceForSearch = (allItems && allItems.length) ? (baseline || clean) : (baseline || clean)
            const results = clean.filter(it => matchesQuery(it, lowered)).filter(it => { const e = enrichCache && enrichCache[it.canonicalPath]; return !(e && (e.hidden === true || e.applied === true)) })
            setItems(results)
            setTotal(results.length)
          } else {
            // baseline too large for in-memory search: delegate to doSearch
            try { doSearch(searchQuery) } catch (e) { /* best-effort */ }
          }
        } catch (e) { /* best-effort */ }
      } else {
        // No active search: if dataset small enough, show all; otherwise show provided first page
        if ((clean.length || 0) <= MAX_IN_MEMORY_SEARCH) {
          setItems((baseline || clean).slice())
        } else {
          const firstPage = clean.slice(0, Math.max(batchSize, 50))
          setItems(prev => {
            try { if (prev && prev.length > (firstPage || []).length) return mergeItemsUnique(prev, firstPage, false) } catch (e) {}
            return firstPage
          })
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

  function pushToast(title, message) {
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
                // If this event pertains to a path we're already optimistically hiding,
                // skip processing to avoid duplicate work and noisy logs.
                try {
                  const evPath = ev && (ev.path || ev.originalPath)
                  if (evPath && pendingHiddenRef.current && pendingHiddenRef.current.has(evPath)) {
                    dlog('[client] HIDE_EVENTS_SKIPPING_PENDING', evPath)
                    continue
                  }
                } catch (e) {}
                // Reload any indicated scans (but preserve current search/view)
                const modified = ev.modifiedScanIds || []
                if (modified && modified.length) {
                  // Do NOT fetch or merge scan pages here. Always perform a
                  // non-stomping background refresh + authoritative per-path enrichment
                  // update and notify the server. This preserves the user's current
                  // view/scroll regardless of search state.
                  dlog('[client] HIDE_EVENTS_BG_ONLY', { modified, scanId, lastScanId })
                  const toNotify = modified.filter(sid => sid === scanId || sid === lastScanId)
                  for (const sid of toNotify) {
                    try {
                      // Avoid triggering a full scan refresh here; only refresh per-path enrichment
                      ;(async () => {
                        try { if (ev && ev.path) await refreshEnrichForPaths([ev.path]) } catch (e) {}
                      })()
                      try { await postClientRefreshedDebounced({ scanId: sid }) } catch (e) {}
                    } catch (e) {}
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
      const payload = r.data || {}
      const userSettings = payload.userSettings || {}
      const serverSettings = payload.serverSettings || {}
      const tmdbSource = userSettings.tmdb_api_key ? userSettings : serverSettings
      try { if (!localStorage.getItem('tvdb_api_key') && tmdbSource.tmdb_api_key) localStorage.setItem('tvdb_api_key', tmdbSource.tmdb_api_key) } catch {}
      const tvdbV4Source = userSettings.tvdb_v4_api_key ? userSettings : serverSettings
      try { if (!localStorage.getItem('tvdb_v4_api_key') && tvdbV4Source.tvdb_v4_api_key) localStorage.setItem('tvdb_v4_api_key', tvdbV4Source.tvdb_v4_api_key) } catch {}
      try { if (!localStorage.getItem('tvdb_v4_user_pin') && tvdbV4Source.tvdb_v4_user_pin) localStorage.setItem('tvdb_v4_user_pin', tvdbV4Source.tvdb_v4_user_pin) } catch {}
      try { if (!localStorage.getItem('rename_template') && userSettings.rename_template) localStorage.setItem('rename_template', userSettings.rename_template) } catch {}
    }).catch(()=>{})
  }, [])

  async function hydrateScanItems(scanIdToHydrate, totalCount = 0, initialItems = []) {
    if (!scanIdToHydrate) return []
    const aggregated = []
    const seen = new Set()
    const effectiveTotal = Number.isFinite(Number(totalCount)) ? Number(totalCount) : 0
    const pageSize = 500

    const append = (list = []) => {
      for (const entry of list) {
        if (!entry || !entry.canonicalPath) continue
        if (seen.has(entry.canonicalPath)) continue
        seen.add(entry.canonicalPath)
        aggregated.push(entry)
      }
    }

    append(Array.isArray(initialItems) ? initialItems : [])

    if (isMountedRef.current) {
      try { setScanLoaded(aggregated.length) } catch (e) {}
      try {
        if (effectiveTotal > 0) setScanProgress(Math.max(0, Math.min(100, Math.round((aggregated.length / Math.max(1, effectiveTotal)) * 100))))
      } catch (e) {}
    }

    let offset = aggregated.length
    let guard = 0
    while (isMountedRef.current) {
      if (effectiveTotal > 0 && aggregated.length >= effectiveTotal) break
      const resp = await axios.get(API(`/scan/${scanIdToHydrate}/items`), { params: { offset, limit: pageSize } })
      const page = (resp && resp.data && Array.isArray(resp.data.items)) ? resp.data.items : []
      if (!page.length) break
      append(page)
      offset += page.length
      guard += 1
      if (isMountedRef.current) {
        try { setScanLoaded(aggregated.length) } catch (e) {}
        try {
          if (effectiveTotal > 0) {
            setScanProgress(Math.max(0, Math.min(100, Math.round((aggregated.length / Math.max(1, effectiveTotal)) * 100))))
          } else if (aggregated.length) {
            const approxTotal = Math.max(aggregated.length, offset)
            setScanProgress(Math.max(0, Math.min(100, Math.round((aggregated.length / Math.max(1, approxTotal)) * 100))))
          }
        } catch (e) {}
      }
      if (page.length < pageSize) break
      if (guard > 400) break
    }

    if (isMountedRef.current) {
      try { setScanLoaded(aggregated.length) } catch (e) {}
      try { setScanProgress(100) } catch (e) {}
    }

    return aggregated
  }

  async function triggerScan(lib, options = {}) {
    const mode = options && options.mode === 'full' ? 'full' : 'incremental'
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
      return null
    }

    const endpoint = mode === 'full' ? '/scan' : '/scan/incremental'

    setActiveScanKind(mode)
    setScanning(true)
    setScanReady(false)
    setScanLoaded(0)
    setScanProgress(0)
    setMetaPhase(false)
    setMetaProgress(0)

    try {
      const response = await axios.post(API(endpoint), { libraryId: lib?.id, path: configuredPath })
      const result = response && response.data ? response.data : {}
      const changedPaths = Array.isArray(result.changedPaths) ? result.changedPaths.filter(Boolean) : []
      const changedPathSet = new Set(changedPaths)
      if (!result.scanId) throw new Error('Scan did not return an id')

      setScanId(result.scanId)
      try { newScanJustCreatedRef.current = true } catch (e) {}
      try { setLastScanId(result.scanId) } catch (e) {}
      const libId = lib?.id || result.libraryId || (scanMeta && scanMeta.libraryId) || ''
      try { setLastLibraryId(libId) } catch (e) {}

      // fetch scan metadata
      const meta = await axios.get(API(`/scan/${result.scanId}`)).catch(() => ({ data: { totalCount: 0, libraryId: libId, generatedAt: Date.now() } }))
      const scanMetaPayload = meta && meta.data ? meta.data : { totalCount: 0, libraryId: libId, generatedAt: Date.now() }
      setScanMeta(scanMetaPayload)
      const reportedTotal = Number(scanMetaPayload.totalCount || 0)
      setTotal(reportedTotal)

      // hydrate first page of items either from incremental response sample or via fetch
      const firstPageSize = reportedTotal > 0 ? Math.min(reportedTotal, Math.max(batchSize, 50)) : Math.max(batchSize, 50)
      let first = []
      if (mode === 'incremental' && Array.isArray(result.items) && result.items.length) {
        first = result.items.slice(0, firstPageSize > 0 ? firstPageSize : result.items.length)
      }
      if ((!first || !first.length) && firstPageSize > 0) {
        const firstPage = await axios.get(API(`/scan/${result.scanId}/items`), { params: { offset: 0, limit: firstPageSize } }).catch(() => ({ data: { items: [] } }))
        first = (firstPage && firstPage.data && Array.isArray(firstPage.data.items)) ? firstPage.data.items : []
      }

      const hydratedFirst = Array.isArray(first) ? first : []

      pushToast && pushToast('Scan', mode === 'full' ? 'Full scan started — we’ll surface results once everything is ready.' : 'Incremental scan started — results will appear once all items are ready.')

      phaseStartRef.current.scanStart = Date.now()
      const aggregated = await hydrateScanItems(result.scanId, reportedTotal || hydratedFirst.length, hydratedFirst)
      if (phaseStartRef.current.scanStart) {
        const elapsed = Math.max(0, Date.now() - phaseStartRef.current.scanStart)
        const history = Array.isArray(timingHistoryRef.current.scanDurations) ? timingHistoryRef.current.scanDurations.slice() : []
        history.push(elapsed)
        timingHistoryRef.current.scanDurations = history.slice(-8)
        saveTimingHistory()
        phaseStartRef.current.scanStart = null
      }
      if (!isMountedRef.current) return result.scanId

      const canonicalSet = new Set(aggregated.map(it => it && it.canonicalPath).filter(Boolean))
      setCurrentScanPaths(canonicalSet)

      const visibleBaseline = aggregated.filter(it => {
        if (!it || !it.canonicalPath) return false
        const enriched = enrichCache && enrichCache[it.canonicalPath]
        return !(enriched && (enriched.hidden === true || enriched.applied === true))
      })

      setAllItems(visibleBaseline)
      setItems(visibleBaseline)
      setScanLoaded(aggregated.length)
      const denom = reportedTotal || aggregated.length
      setScanProgress(denom ? Math.min(100, Math.round((aggregated.length / Math.max(1, denom)) * 100)) : 100)
      setScanReady(true)

      pushToast && pushToast('Scan', mode === 'full' ? 'Full scan complete — all items are ready.' : 'Incremental scan complete — latest items are ready.')

      // Start background metadata work without blocking the UI. Full scans refresh the
      // entire library, while incremental scans only hydrate newly detected items.
      if (mode === 'full') {
        void (async () => { try { await refreshScan(result.scanId, true, { trackProgress: true }) } catch (e) {} })()
      } else if (mode === 'incremental' && changedPathSet.size) {
        const targeted = Array.from(changedPathSet)
        void (async () => { try { await refreshEnrichForPaths(targeted) } catch (e) {} })()
      }
      try {
        const candidatePrimeFromVisible = visibleBaseline.slice(0, Math.max(20, Math.min(60, visibleBaseline.length))).map(it => it.canonicalPath).filter(Boolean)
        const primePaths = (mode === 'incremental' && changedPathSet.size)
          ? Array.from(changedPathSet).slice(0, Math.max(20, Math.min(60, changedPathSet.size)))
          : candidatePrimeFromVisible
        if (primePaths.length) {
          const resp = await axios.post(API('/enrich/bulk'), { paths: primePaths })
          const itemsOut = resp && resp.data && Array.isArray(resp.data.items) ? resp.data.items : []
          for (const entry of itemsOut) {
            try {
              const p = entry.path
              if (entry.error) continue
              if (entry.enrichment && (entry.cached || entry.enrichment)) {
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
              }
            } catch (e) {}
          }
        }
      } catch (e) { /* best-effort */ }

      return result.scanId
    } catch (err) {
      setScanReady(true)
      try { setScanProgress(0) } catch (e) {}
      phaseStartRef.current.scanStart = null
      pushToast && pushToast('Scan', mode === 'full' ? 'Full scan failed to start' : 'Incremental scan failed to start')
      throw err
    } finally {
      if (isMountedRef.current) {
        setScanning(false)
        setActiveScanKind(null)
      }
    }
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
      if (!force && enrichCache && enrichCache[key]) {
        const cached = enrichCache[key]
        if (cached && (cached.hidden || cached.applied)) {
          setItems(prev => prev.filter(it => it.canonicalPath !== key))
          setAllItems(prev => prev.filter(it => it.canonicalPath !== key))
        }
        return cached
      }

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
          if (norm && (norm.hidden || norm.applied)) {
            setItems(prev => prev.filter(it => it.canonicalPath !== key))
            setAllItems(prev => prev.filter(it => it.canonicalPath !== key))
          }
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
        if (_norm2 && (_norm2.hidden || _norm2.applied)) {
          setItems(prev => prev.filter(it => it.canonicalPath !== key))
          setAllItems(prev => prev.filter(it => it.canonicalPath !== key))
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
    if (loadingMoreRef.current) return
    loadingMoreRef.current = true
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
    finally { loadingMoreRef.current = false }
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

  // Expose a global flag for helpers to determine if client is actively searching.
  React.useEffect(() => {
    try { if (typeof window !== 'undefined') window.__CLIENT_ACTIVE_SEARCH__ = !!(searchQuery && searchQuery.length) } catch (e) {}
    return () => { try { if (typeof window !== 'undefined' && window.__CLIENT_ACTIVE_SEARCH__) window.__CLIENT_ACTIVE_SEARCH__ = false } catch (e) {} }
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
    if (!Array.isArray(paths) || !paths.length) return
    const uniquePaths = Array.from(new Set(paths.filter(Boolean)))
    for (const p of uniquePaths) {
      try {
        const er = await axios.get(API('/enrich'), { params: { path: p } })
        if (!er.data) continue
        if (er.data.missing) {
          setEnrichCache(prev => { const n = { ...prev }; delete n[p]; return n })
          setItems(prev => prev.filter(it => it.canonicalPath !== p))
          setAllItems(prev => prev.filter(it => it.canonicalPath !== p))
        } else if ( er.data.cached || er.data.enrichment ) {
          const enriched = normalizeEnrichResponse(er.data.enrichment || er.data)
          setEnrichCache(prev => ({ ...prev, [p]: enriched }))
          if (enriched && (enriched.hidden || enriched.applied)) {
            setItems(prev => prev.filter(it => it.canonicalPath !== p))
            setAllItems(prev => prev.filter(it => it.canonicalPath !== p))
          } else {
            setItems(prev => mergeItemsUnique(prev, [{ id: p, canonicalPath: p }], true))
            setAllItems(prev => mergeItemsUnique(prev, [{ id: p, canonicalPath: p }], true))
          }
        }
      } catch (e) {}
    }
  }

  async function hideOnePath(originalPath, { silent = false } = {}) {
    if (!originalPath) return { success: false }
    try { dlog('[client] HIDE_REQUEST', { path: originalPath, itemsLen: (items||[]).length, allItemsLen: (allItems||[]).length, searchQuery }) } catch (e) {}
    if (loadingEnrich && loadingEnrich[originalPath]) return { success: false, skipped: true }
    safeSetLoadingEnrich(prev => ({ ...prev, [originalPath]: true }))
    const touchedLoading = new Set([originalPath])
    try {
      pendingHiddenRef.current.add(originalPath)
      try { if (pendingHideTimeoutsRef.current[originalPath]) clearTimeout(pendingHideTimeoutsRef.current[originalPath]) } catch (e) {}
      pendingHideTimeoutsRef.current[originalPath] = setTimeout(() => {
        try { pendingHiddenRef.current.delete(originalPath) } catch (e) {}
        try { delete pendingHideTimeoutsRef.current[originalPath] } catch (e) {}
      }, 2000)
    } catch (e) {}
    try {
      setEnrichCache(prev => ({ ...prev, [originalPath]: Object.assign({}, prev && prev[originalPath] ? prev[originalPath] : {}, { hidden: true }) }))
      setItems(prev => prev.filter(x => x.canonicalPath !== originalPath))
      setAllItems(prev => prev.filter(x => x.canonicalPath !== originalPath))
    } catch (e) {}

    let resp = null
    let didFinalToast = !!silent
    try {
      resp = await axios.post(API('/enrich/hide'), { path: originalPath })
      const serverKey = resp && resp.data && resp.data.path ? resp.data.path : originalPath
      if (serverKey && serverKey !== originalPath) touchedLoading.add(serverKey)
      const returned = resp && resp.data && (resp.data.enrichment || resp.data) ? (resp.data.enrichment || resp.data) : null
      let authoritative = null
      try {
        const er = await axios.get(API('/enrich'), { params: { path: serverKey } }).catch(() => null)
        authoritative = er && er.data && (er.data.enrichment || er.data) ? (er.data.enrichment || er.data) : null
      } catch (e) { authoritative = null }
      const enriched = authoritative ? normalizeEnrichResponse(authoritative) : (returned ? normalizeEnrichResponse(returned) : null)

      if (enriched) {
        try { pendingHiddenRef.current.delete(serverKey) } catch (e) {}
        try { if (pendingHideTimeoutsRef.current[serverKey]) { clearTimeout(pendingHideTimeoutsRef.current[serverKey]); delete pendingHideTimeoutsRef.current[serverKey] } } catch (e) {}
        setEnrichCache(prev => ({ ...prev, [serverKey]: enriched }))
        if (enriched.hidden || enriched.applied) {
          setItems(prev => prev.filter(x => x.canonicalPath !== serverKey))
          setAllItems(prev => prev.filter(x => x.canonicalPath !== serverKey))
        }
      } else {
        try { pendingHiddenRef.current.add(originalPath) } catch (e) {}
        setEnrichCache(prev => ({ ...prev, [originalPath]: Object.assign({}, prev && prev[originalPath] ? prev[originalPath] : {}, { hidden: true }) }))
        setItems(prev => prev.filter(x => x.canonicalPath !== originalPath))
        setAllItems(prev => prev.filter(x => x.canonicalPath !== originalPath))
      }

      try {
        const modified = (resp && resp.data && Array.isArray(resp.data.modifiedScanIds)) ? resp.data.modifiedScanIds : []
        if (modified && modified.length) {
          try { dlog('[client] HIDE_MODIFIED_IDS_BG_REFRESH', { path: originalPath, modified }) } catch (e) {}
          const toNotify = modified.filter(sid => sid === scanId || sid === lastScanId)
          for (const sid of toNotify) {
            ;(async () => {
              try { await refreshEnrichForPaths([ serverKey || originalPath ]) } catch (e) {}
            })()
            try { await postClientRefreshedDebounced({ scanId: sid }) } catch (e) {}
          }
        } else {
          try { dlog('[client] HIDE_NO_MODIFIED_IDS_BG', { path: originalPath }) } catch (e) {}
        }
      } catch (e) {}

      try {
        if (enriched && (enriched.hidden || enriched.applied)) {
          if (!silent) pushToast && pushToast('Hide', 'Item hidden')
          didFinalToast = true
        } else {
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
                setEnrichCache(prev => ({ ...prev, [pth]: norm }))
                setItems(prev => prev.filter(x => x.canonicalPath !== pth))
                setAllItems(prev => prev.filter(x => x.canonicalPath !== pth))
                if (!silent) pushToast && pushToast('Hide', 'Item hidden (confirmed)')
                didFinalToast = true
                confirmed = true
                break
              }
            } catch (e) {}
          }
          if (!confirmed && !didFinalToast) {
            try {
              const handled = await handleHideFailure([ (resp && resp.data && resp.data.path) ? resp.data.path : originalPath, originalPath ])
              if (!handled) {
                try { dlog('[client] HIDE_FAILED_NO_TOAST', { path: originalPath }) } catch (e) {}
              }
            } catch (e) {
              try { dlog('[client] HIDE_FAILED_NO_TOAST_ERR', { path: originalPath, err: String(e) }) } catch (ee) {}
            }
            didFinalToast = true
          }
        }
      } catch (e) {
        if (!didFinalToast) {
          try {
            const handled = await handleHideFailure([ (resp && resp.data && resp.data.path) ? resp.data.path : originalPath, originalPath ])
            if (!handled) try { dlog('[client] HIDE_FAILED_NO_TOAST', { path: originalPath }) } catch (ee) {}
          } catch (ee) {
            try { dlog('[client] HIDE_FAILED_NO_TOAST_ERR', { path: originalPath, err: String(ee) }) } catch (eee) {}
          }
        }
        didFinalToast = true
      }
      return { success: true, path: serverKey || originalPath }
    } catch (err) {
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
              setEnrichCache(prev => ({ ...prev, [pth]: norm }))
              setItems(prev => prev.filter(x => x.canonicalPath !== pth))
              setAllItems(prev => prev.filter(x => x.canonicalPath !== pth))
              if (!silent) pushToast && pushToast('Hide', 'Item hidden (confirmed)')
              didFinalToast = true
              confirmed = true
              break
            }
          } catch (e) {}
        }
        if (!confirmed && !didFinalToast) {
          if (!silent) pushToast && pushToast('Hide', 'Hide failed')
        }
      } catch (e) {
        if (!silent) pushToast && pushToast('Hide', 'Hide failed')
      }
      return { success: false, error: err }
    } finally {
      safeSetLoadingEnrich(prev => {
        const n = { ...prev }
        for (const p of touchedLoading) delete n[p]
        return n
      })
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

  async function refreshScan(scanId, silent = false, options = {}) {
    if (!scanId) throw new Error('no scan id')
    const trackProgress = options && options.trackProgress !== false
    let metaCompleted = false
    if (trackProgress) {
      try { setMetaPhase(true) } catch (e) {}
      try { setMetaProgress(0) } catch (e) {}
      phaseStartRef.current.metaStart = Date.now()
    }
    try {
      const r = await axios.post(API(`/scan/${scanId}/refresh`), { tmdb_api_key: providerKey || undefined })
      // If server started background work, poll for progress
      if (r.status === 202 && r.data && r.data.background) {
        const updateMetaProgress = (prog) => {
          if (!trackProgress) return
          const pct = Math.round((prog.processed / Math.max(1, prog.total)) * 100)
          try { setMetaProgress(pct) } catch (e) {}
        }
        if (!silent) {
          const toastId = pushToast && pushToast('Refresh','Refresh started on server', { sticky: true, spinner: true })
          try {
            await pollRefreshProgress(scanId, (prog) => {
              // update toast with percent
              const pct = Math.round((prog.processed / Math.max(1, prog.total)) * 100)
              updateMetaProgress(prog)
              if (pushToast) pushToast('Refresh', `Refreshing metadata: ${pct}% (${prog.processed}/${prog.total})`, { id: toastId, sticky: true, spinner: true })
            })
            if (pushToast) pushToast('Refresh','Server-side refresh complete')
          } catch (e) {
            if (pushToast) pushToast('Refresh','Server-side refresh failed')
          }
        } else {
          // silent background refresh: still wait for completion but do not show toasts or update meta UI
          try { await pollRefreshProgress(scanId, trackProgress ? updateMetaProgress : undefined) } catch (e) { /* swallow */ }
        }
        if (trackProgress) {
          try { setMetaProgress(100) } catch (e) {}
          if (phaseStartRef.current.metaStart) {
            const elapsed = Math.max(0, Date.now() - phaseStartRef.current.metaStart)
            const history = Array.isArray(timingHistoryRef.current.metaDurations) ? timingHistoryRef.current.metaDurations.slice() : []
            history.push(elapsed)
            timingHistoryRef.current.metaDurations = history.slice(-8)
            saveTimingHistory()
            phaseStartRef.current.metaStart = null
          }
          metaCompleted = true
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
      metaCompleted = true
      return r.data
    } catch (err) {
      throw err
    } finally {
      if (trackProgress) {
        try { setMetaProgress(metaCompleted ? 100 : 0) } catch (e) {}
        try { setMetaPhase(false) } catch (e) {}
        if (phaseStartRef.current.metaStart) phaseStartRef.current.metaStart = null
      }
    }
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

  useEffect(() => () => { isMountedRef.current = false }, [])

  useEffect(() => {
    if (!confirmFullScanOpen) return
    const handleKey = (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault()
        setConfirmFullScanOpen(false)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [confirmFullScanOpen])

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
        // If there's potentially a newer scan for this library (created externally),
        // prefer the latest scan artifact so the UI shows newly discovered items
        // without requiring a hard refresh. This checks /scan/latest for the
        // same library and swaps to it when generatedAt is newer.
        try {
          if (lastLibraryId) {
            const latest = await axios.get(API('/scan/latest'), { params: { libraryId: lastLibraryId } }).catch(() => null)
            if (latest && latest.data && latest.data.scanId) {
              const latestGen = latest.data.generatedAt || 0
              const curGen = (metaRes && metaRes.data && metaRes.data.generatedAt) ? metaRes.data.generatedAt : 0
              if (latestGen && latestGen > curGen) {
                // switch to latest scan artifact
                effectiveScanId = latest.data.scanId
                // request first-page items together to avoid an extra fetch and to allow
                // the UI to immediately merge items without requiring a hard refresh
                metaRes = await axios.get(API(`/scan/${effectiveScanId}`)).catch(() => null)
                const firstPageResp = await axios.get(API('/scan/latest'), { params: { libraryId: lastLibraryId, includeItems: true, limit: Math.max(batchSize, 50) } }).catch(() => null)
                if (firstPageResp && firstPageResp.data) {
                  try {
                    const reportedTotal = Number(firstPageResp.data.totalCount || 0)
                    // If the server-reported total is small enough to keep in-memory,
                    // eagerly fetch all pages so the UI reflects newly discovered items
                    // without requiring a hard refresh. Otherwise merge only the
                    // provided first-page sample to avoid heavy network usage.
                    if (reportedTotal > 0 && reportedTotal <= MAX_IN_MEMORY_SEARCH) {
                      const pageSize = 500
                      const all = []
                      for (let off = 0; off < reportedTotal; off += pageSize) {
                        const r = await axios.get(API(`/scan/${effectiveScanId}/items`), { params: { offset: off, limit: pageSize } }).catch(() => ({ data: { items: [] } }))
                        const chunk = (r && r.data && Array.isArray(r.data.items)) ? r.data.items : []
                        for (const it of chunk) all.push(it)
                      }
                      try { updateScanDataAndPreserveView({ scanId: effectiveScanId, libraryId: lastLibraryId, totalCount: reportedTotal, generatedAt: firstPageResp.data.generatedAt || Date.now() }, all) } catch (e) {}
                    } else {
                      const itemsSample = Array.isArray(firstPageResp.data.items) ? firstPageResp.data.items : []
                      try { updateScanDataAndPreserveView({ scanId: effectiveScanId, libraryId: lastLibraryId, totalCount: firstPageResp.data.totalCount || 0, generatedAt: firstPageResp.data.generatedAt || Date.now() }, itemsSample) } catch (e) {}
                    }
                  } catch (e) {}
                }
              }
            }
          }
        } catch (e) {
          // best-effort: ignore failures here
        }
        if (!mounted) return
        setScanId(effectiveScanId)
        setScanMeta(metaRes.data)
        const totalCount = metaRes.data.totalCount || 0
        setTotal(totalCount)
        // if we just created a scan in this session, avoid eager fetching all pages
        // — the triggerScan flow already populated the first page and started
        // background work on the server. This prevents duplicate paging requests.
        if (newScanJustCreatedRef.current) {
          if (!mounted) return
          // fetch first page only for UI hydration
          const r = await axios.get(API(`/scan/${lastScanId}/items`), { params: { offset: 0, limit: 500 } }).catch(() => ({ data: { items: [] } }))
          if (!mounted) return
          const first = r.data.items || []
          setAllItems(first)
          setItems(first)
          setCurrentScanPaths(new Set((first || []).map(i => i.canonicalPath)))
          // clear the flag so later mounts behave normally
          try { newScanJustCreatedRef.current = false } catch (e) {}
          return
        }
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

  // Background poll: periodically check for a newer scan artifact for the configured library
  // and merge in its first page non-stompingly so the UI stays up-to-date when scans are
  // created externally. This runs quietly and avoids disturbing the user's current search/view.
  useEffect(() => {
    if (!lastLibraryId) return
    let mounted = true
    const POLL_MS = 10000
    let id = null

    const pollLatest = async () => {
      try {
        // avoid polling while the client is actively creating a new scan in this session
        if (newScanJustCreatedRef.current) return
        // avoid stomping while user is actively searching
        if (searchQuery && searchQuery.length) return
        const r = await axios.get(API('/scan/latest'), { params: { libraryId: lastLibraryId } }).catch(() => null)
        if (!mounted || !r || !r.data) return
        const latest = r.data
        const latestId = latest && latest.scanId
        const latestGen = latest && latest.generatedAt ? latest.generatedAt : 0
        const localGen = (scanMeta && scanMeta.generatedAt) ? scanMeta.generatedAt : 0
        // If there's a newer artifact, fetch its first page and merge it non-stompingly
        if (latestId && latestGen && latestGen > localGen) {
          try {
            // Request the first-page items via /scan/latest?includeItems so server can return the sample
            const pg = await axios.get(API('/scan/latest'), { params: { libraryId: lastLibraryId, includeItems: true, limit: Math.max(batchSize, 50) } }).catch(() => null)
            try {
              const reportedTotal = pg && pg.data ? Number(pg.data.totalCount || 0) : 0
              if (reportedTotal > 0 && reportedTotal <= MAX_IN_MEMORY_SEARCH) {
                // fetch all pages from the scan items endpoint (pageSize capped at 500 on server)
                const pageSize = 500
                const all = []
                for (let off = 0; off < reportedTotal; off += pageSize) {
                  const r = await axios.get(API(`/scan/${latest.scanId || latest.scanId}/items`), { params: { offset: off, limit: pageSize } }).catch(() => ({ data: { items: [] } }))
                  const chunk = (r && r.data && Array.isArray(r.data.items)) ? r.data.items : []
                  for (const it of chunk) all.push(it)
                }
                try { updateScanDataAndPreserveView(latest, all) } catch (e) {}
              } else {
                const page = (pg && pg.data && Array.isArray(pg.data.items)) ? pg.data.items : []
                try { updateScanDataAndPreserveView(latest, page) } catch (e) {}
              }
              try { setScanId(latestId); setScanMeta(latest); setLastScanId(latestId); setTotal(latest.totalCount || (pg && pg.data && Array.isArray(pg.data.items) ? pg.data.items.length : 0)) } catch (e) {}
            } catch (e) {}
          } catch (e) { /* best-effort, do not disrupt UI */ }
        }
      } catch (e) { /* ignore */ }
    }

    // run immediately and then on interval
    void pollLatest()
    id = setInterval(() => { void pollLatest() }, POLL_MS)
    return () => { mounted = false; try { clearInterval(id) } catch (e) {} }
  }, [lastLibraryId, scanMeta, searchQuery])

  // When a scan is active, poll its metadata for a short window after creation
  // to detect server-side updates (new items discovered by background work).
  // If the server scan artifact changes, fetch the first page and merge so the
  // UI shows new items without requiring a manual reload.
  useEffect(() => {
    if (!scanId) return
    let stopped = false
    const POLL_INTERVAL = 5000
    const POLL_DURATION = 30 * 1000 // poll for first 30s
    const start = Date.now()
    const doPoll = async () => {
      try {
        const metaRes = await axios.get(API(`/scan/${scanId}`)).catch(() => null)
        if (!metaRes || !metaRes.data) return
        const serverMeta = metaRes.data
        // If server reports a different generatedAt or a larger totalCount, refresh first page
        const localGenerated = (scanMeta && scanMeta.generatedAt) || 0
        const localTotal = (scanMeta && scanMeta.totalCount) || 0
        if ((serverMeta.generatedAt && serverMeta.generatedAt !== localGenerated) || (serverMeta.totalCount && serverMeta.totalCount > localTotal)) {
          try {
            const reportedTotal = Number(serverMeta.totalCount || 0)
            if (reportedTotal > 0 && reportedTotal <= MAX_IN_MEMORY_SEARCH) {
              const pageSize = 500
              const all = []
              for (let off = 0; off < reportedTotal; off += pageSize) {
                const r = await axios.get(API(`/scan/${scanId}/items`), { params: { offset: off, limit: pageSize } }).catch(() => ({ data: { items: [] } }))
                const chunk = (r && r.data && r.data.items) ? r.data.items : []
                for (const it of chunk) all.push(it)
              }
              // Merge while preserving current view/search
              try { updateScanDataAndPreserveView(serverMeta, all) } catch (e) {}
              try { setScanMeta(serverMeta); setTotal(serverMeta.totalCount || all.length || 0) } catch (e) {}
            } else {
              const r = await axios.get(API(`/scan/${scanId}/items`), { params: { offset: 0, limit: Math.max(batchSize, 50) } }).catch(() => ({ data: { items: [] } }))
              const page = (r && r.data && r.data.items) ? r.data.items : []
              try { updateScanDataAndPreserveView(serverMeta, page) } catch (e) {}
              try { setScanMeta(serverMeta); setTotal(serverMeta.totalCount || page.length || 0) } catch (e) {}
            }
          } catch (e) {}
        }
      } catch (e) {}
    }
    const id = setInterval(() => {
      if (stopped) return
      if (Date.now() - start > POLL_DURATION) { clearInterval(id); stopped = true; return }
      void doPoll()
    }, POLL_INTERVAL)
    // run an immediate check once
    void doPoll()
    return () => { stopped = true; try { clearInterval(id) } catch (e) {} }
  }, [scanId])

  const selectedPathsList = React.useMemo(() => Object.keys(selected || {}).filter(Boolean), [selected])
  const selectedCount = selectedPathsList.length
  const selectedHasLoading = selectedPathsList.some(p => loadingEnrich && loadingEnrich[p])
  const searchDisabled = !scanReady
  const progressWeights = computeWeights()
  return (
  <div className={"app" + (selectMode && selectedCount ? ' select-mode-shrink' : '')}>
      {confirmFullScanOpen ? (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="full-scan-title"
          onClick={() => { if (!scanning) setConfirmFullScanOpen(false) }}
        >
          <div className="modal-card" onClick={ev => ev.stopPropagation()}>
            <p>This walk re-indexes every file and can take a while. You can keep working while it runs.</p>
            <div className="modal-actions">
              <button
                className="btn-ghost"
                onClick={() => setConfirmFullScanOpen(false)}
                disabled={scanning && activeScanKind === 'full'}
              >Cancel</button>
              <button
                className="btn-save"
                onClick={() => {
                  if (scanning) return
                  setConfirmFullScanOpen(false)
                  void triggerScan(libraries[0], { mode: 'full' }).catch(() => {})
                }}
                disabled={scanning}
              >
                <span className="btn-label">
                  {activeScanKind === 'full' ? (<><Spinner /><span>Scanning…</span></>) : 'Start full scan'}
                </span>
              </button>
            </div>
          </div>
        </div>
      ) : null}
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
        disabled={searchDisabled}
      />
      <button className='btn-ghost btn-search' onClick={() => doSearch(searchQuery)} disabled={searchDisabled || searching}>{searching ? <Spinner/> : 'Search'}</button>
      <button className='btn-ghost btn-clear' onClick={() => doSearch('')} title='Clear search' disabled={searchDisabled}>Clear</button>
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
            <button
              className={"btn-save" + (selectMode && selectedCount ? ' shifted' : '')}
              onClick={() => {
                if (scanning) { pushToast && pushToast('Scan','Scan already in progress'); return }
                setConfirmFullScanOpen(true)
              }}
              disabled={scanning}
              title="Run a full library scan"
            >
              <span className="btn-label">
                {activeScanKind === 'full' ? (<><Spinner /><span>Scanning…</span></>) : 'Scan'}
              </span>
            </button>
            <button
              className="btn-ghost btn-incremental"
              onClick={() => {
                if (scanning) { pushToast && pushToast('Scan','Scan already in progress'); return }
                void triggerScan(libraries[0], { mode: 'incremental' }).catch(() => {})
              }}
              disabled={scanning}
              title="Incremental scan"
            >
              <span className="btn-label">
                {activeScanKind === 'incremental' ? (<><Spinner /><span>Updating…</span></>) : 'Incremental scan'}
              </span>
            </button>
        {/* Global bulk-enrich indicator (shown when many enrich operations are running) */}
            <div className="select-approve-wrap">
                {selectMode && selectedCount ? (
                  <button
                    className={"btn-save approve-button visible"}
                    disabled={selectedHasLoading}
                    onClick={async () => {
                      try {
                        const selectedPaths = [...selectedPathsList]
                        if (!selectedPaths.length) return
                        const selItems = items.filter(it => selectedPaths.includes(it.canonicalPath))
                        if (!selItems.length) return
                        pushToast && pushToast('Approve', `Approving ${selItems.length} items...`)
                        const plans = await previewRename(selItems)
                        await applyRename(plans)
                        setSelected(prev => {
                          if (!prev) return {}
                          const next = { ...prev }
                          for (const p of selectedPaths) delete next[p]
                          return next
                        })
                        pushToast && pushToast('Approve', 'Approve completed')
                      } catch (e) { pushToast && pushToast('Approve', 'Approve failed') }
                    }}
                    title="Approve selected"
                  >Approve selected</button>
                ) : null}
                {selectMode && selectedCount ? (
                  <button
                    className={"btn-ghost approve-button visible"}
                    disabled={selectedHasLoading}
                    onClick={async () => {
                      const selectedPaths = [...selectedPathsList]
                      if (!selectedPaths.length) return
                      const loadingMap = {}
                      for (const p of selectedPaths) loadingMap[p] = true
                      safeSetLoadingEnrich(prev => ({ ...prev, ...loadingMap }))

                      let successCount = 0
                      let skippedCount = 0
                      const failed = []
                      try {
                        for (const path of selectedPaths) {
                          try {
                            const res = await hideOnePath(path, { silent: true })
                            if (res && res.success) {
                              successCount += 1
                            } else if (res && res.skipped) {
                              successCount += 1
                              skippedCount += 1
                            } else {
                              failed.push(path)
                            }
                          } catch (err) {
                            failed.push(path)
                          }
                        }
                      } finally {
                        safeSetLoadingEnrich(prev => { const n = { ...prev }; for (const p of selectedPaths) delete n[p]; return n })
                        setSelected(prev => {
                          if (!prev) return {}
                          const next = { ...prev }
                          for (const p of selectedPaths) delete next[p]
                          return next
                        })
                      }

                      if (failed.length && successCount) {
                        pushToast && pushToast('Hide', `Hidden ${successCount}/${selectedPaths.length} items (${failed.length} failed).`)
                      } else if (failed.length && !successCount) {
                        pushToast && pushToast('Hide', 'Hide failed for all selected items')
                      } else {
                        const skippedNote = skippedCount ? ` (${skippedCount} skipped)` : ''
                        pushToast && pushToast('Hide', `Hidden ${selectedPaths.length} items${skippedNote}.`)
                      }
                    }}
                    title="Hide selected"
                  >Hide selected</button>
                ) : null}
                {/* Rescan selected: appears only in select mode and when items are selected; does not reserve space when hidden */}
                {selectMode && selectedCount ? (
                  <button
                      className={"btn-ghost approve-button visible"}
                      disabled={selectedHasLoading}
                      onClick={async () => {
                        try {
                          const selectedPaths = [...selectedPathsList]
                          if (!selectedPaths.length) return
                          pushToast && pushToast('Rescan', `Rescanning ${selectedPaths.length} items...`)
                          // Mark selected items as loading so their buttons show spinners while processing
                          const loadingMap = {}
                          for (const p of selectedPaths) loadingMap[p] = true
                          safeSetLoadingEnrich(prev => ({ ...prev, ...loadingMap }))

                          const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
                          const RATE_DELAY_MS = 350
                          let successCount = 0
                          const failed = []

                          for (let i = 0; i < selectedPaths.length; i++) {
                            const path = selectedPaths[i]
                            try {
                              const result = await enrichOne({ canonicalPath: path }, true)
                              if (result) successCount += 1
                              else failed.push(path)
                            } catch (err) {
                              failed.push(path)
                            }
                            // add a brief delay between provider refreshes to avoid rate limiting
                            if (i < selectedPaths.length - 1) await sleep(RATE_DELAY_MS)
                          }

                          // clear loading flags (guard in case enrichOne did not remove them)
                          safeSetLoadingEnrich(prev => { const n = { ...prev }; for (const p of selectedPaths) delete n[p]; return n })

                          // Selected paths already refreshed individually above; no global refresh needed

                          setSelected(prev => {
                            if (!prev) return {}
                            const next = { ...prev }
                            for (const p of selectedPaths) delete next[p]
                            return next
                          })
                          const failureCount = failed.length
                          if (failureCount) {
                            pushToast && pushToast('Rescan', `Rescanned ${successCount}/${selectedPaths.length} items (${failureCount} failed).`)
                            try { dlog('[client] RESCAN_SELECTED_FAILED', { failed }) } catch (e) {}
                          } else {
                            pushToast && pushToast('Rescan', `Rescanned ${selectedPaths.length} items.`)
                          }
                        } catch (e) {
                          pushToast && pushToast('Rescan', 'Rescan failed')
                        }
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
              {!scanReady ? (
                <LoadingScreen
                  mode={activeScanKind || 'incremental'}
                  total={total}
                  loaded={scanLoaded}
                  scanProgress={scanProgress}
                  metaPhase={metaPhase}
                  metaProgress={metaProgress}
                  weights={progressWeights}
                />
              ) : (
                <>
                  {scanMeta ? (
                    <div>
                      Found {total} items. Showing {items.length} loaded items.
                      {metaPhase ? <span className="phase-label">Metadata refresh {metaProgress}%</span> : null}
                    </div>
                  ) : (
                    <div>No scan yet</div>
                  )}

                  {scanMeta ? (
            <VirtualizedList items={items} enrichCache={enrichCache} onNearEnd={handleScrollNearEnd} enrichOne={enrichOne}
              previewRename={previewRename} applyRename={applyRename} pushToast={pushToast} loadingEnrich={loadingEnrich}
              selectMode={selectMode} selected={selected} toggleSelect={(p, val) => setSelected(s => { const n = { ...s }; if (val) n[p]=true; else delete n[p]; return n })}
              providerKey={providerKey} hideOne={hideOnePath}
              searchQuery={searchQuery} setSearchQuery={setSearchQuery} doSearch={doSearch} searching={searching} />
                  ) : null}
                </>
              )}
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

function LoadingScreen({ mode = 'incremental', total = 0, loaded = 0, scanProgress = 0, metaPhase = false, metaProgress = 0, weights = { scanWeight: 0.3, metaWeight: 0.7 } }) {
  const scanWeight = Number.isFinite(weights?.scanWeight) ? weights.scanWeight : 0.3
  const metaWeight = Number.isFinite(weights?.metaWeight) ? weights.metaWeight : 0.7
  const scanPct = Math.min(100, Math.max(0, Number(scanProgress) || 0))
  const metaPct = Math.min(100, Math.max(0, Number(metaProgress) || 0))
  const combined = metaPhase ? Math.round((scanWeight * 100) + (metaPct * metaWeight)) : Math.round(scanPct * scanWeight)

  const friendlyMode = mode === 'full' ? 'Full scan' : 'Incremental scan'
  const description = mode === 'full'
    ? 'We’re reindexing your entire library so every title stays fresh.'
    : 'We’re preparing recent additions — search will resume once everything is indexed.'
  const totalLabel = total > 0 ? total.toLocaleString() : (total === 0 ? '0' : 'calculating…')
  const loadedLabel = loaded > 0 ? loaded.toLocaleString() : (loaded === 0 ? '0' : String(loaded))

  return (
    <div className="loading-screen">
      <div className="loading-card" role="status" aria-live="polite">
        <div className="loading-spinner">
          <svg className="icon spinner" viewBox="0 0 50 50" width="32" height="32"><circle cx="25" cy="25" r="20" stroke="currentColor" strokeWidth="4" strokeOpacity="0.18" fill="none"/><path d="M45 25a20 20 0 0 1-20 20" stroke="currentColor" strokeWidth="4" strokeLinecap="round" fill="none"><animateTransform attributeName="transform" type="rotate" from="0 25 25" to="360 25 25" dur="1s" repeatCount="indefinite"/></path></svg>
        </div>
        <h2>{friendlyMode} in progress</h2>
        <p>{description}</p>
        <div className="loading-details">
          <span>Scan {scanPct}% · {loadedLabel} of {totalLabel} files indexed</span>
          {metaPhase ? <span>Metadata refresh {metaPct}%</span> : <span>Metadata refresh queued</span>}
        </div>
        <div className="progress-bar loading-progress-bar">
          <div className="fill" style={{ width: `${combined}%` }} />
          <div className="shimmer" />
        </div>
        <div className="loading-footnote">Hang tight — this won’t take long.</div>
      </div>
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

function VirtualizedList({ items = [], enrichCache = {}, onNearEnd, enrichOne, previewRename, applyRename, pushToast, loadingEnrich = {}, selectMode = false, selected = {}, toggleSelect = () => {}, providerKey = '', hideOne = null, searchQuery = '', setSearchQuery = () => {}, doSearch = () => {}, searching = false }) {
  const Row = ({ index, style }) => {
  const it = items[index]
  const rawEnrichment = it ? enrichCache?.[it.canonicalPath] : null
  const enrichment = normalizeEnrichResponse(rawEnrichment)
  useEffect(() => { if (it && !rawEnrichment) enrichOne && enrichOne(it) }, [it?.canonicalPath, rawEnrichment, enrichOne])
  const loading = it && Boolean(loadingEnrich[it.canonicalPath])
  const isSelected = !!(selectMode && it && selected?.[it.canonicalPath])

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
  const handleRowClick = (ev) => {
    if (!selectMode || !it) return
    // ignore clicks originating from action buttons or the checkbox container
    const interactive = ev.target.closest('.actions') || ev.target.closest('button') || ev.target.closest('a') || ev.target.closest('input')
    if (interactive) return
    toggleSelect(it.canonicalPath, !isSelected)
  }

    return (
      <div
        className={"row" + (selectMode ? ' row-select-mode' : '') + (isSelected ? ' row-selected' : '')}
        style={style}
        onClick={handleRowClick}
        role={selectMode ? 'button' : undefined}
        tabIndex={selectMode ? 0 : undefined}
        onKeyDown={ev => {
          if (!selectMode || !it) return
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault()
            toggleSelect(it.canonicalPath, !isSelected)
          }
        }}
      >
        {selectMode ? (
          <div style={{width:36, display:'flex', alignItems:'center', justifyContent:'center'}}>
            <input
              type="checkbox"
              checked={!!selected[it?.canonicalPath]}
              onClick={ev => ev.stopPropagation()}
              onChange={e => toggleSelect(it?.canonicalPath, e.target.checked)}
            />
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
          <button
            title="Apply rename for this item"
            className="btn-save icon-btn"
            disabled={loading}
            onClick={async (ev) => {
              ev.stopPropagation?.()
              if (!it) return
              let successShown = false
              try {
                safeSetLoadingEnrich(prev => ({ ...prev, [it.canonicalPath]: true }))
                const plans = await previewRename([it])
                pushToast && pushToast('Preview ready', 'Rename plan generated — applying now')
                const res = await applyRename(plans)
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
                    pushToast && pushToast('Apply result', JSON.stringify(res))
                    successShown = true
                  }
                } catch (e) {
                  pushToast && pushToast('Apply result', JSON.stringify(res))
                }
                refreshEnrichForPaths([it.canonicalPath]).catch(() => {})
              } catch (e) {
                try { if (!successShown) pushToast && pushToast('Apply', `Apply failed: ${e && e.message ? e.message : String(e)}`) } catch (err) { /* swallow */ }
              } finally {
                safeSetLoadingEnrich(prev => { const n = { ...prev }; delete n[it.canonicalPath]; return n })
              }
            }}
          >
            <IconApply/> <span>Apply</span>
          </button>
          <button
            title="Rescan metadata for this item"
            className="btn-ghost"
            disabled={loading}
            onClick={async (ev) => {
              ev.stopPropagation?.()
              if (!it) return
              pushToast && pushToast('Rescan','Refreshing metadata...')
              await enrichOne(it, true)
            }}
          >
            {loading ? <Spinner/> : <><IconRefresh/> <span>Rescan</span></>}
          </button>
          <button
            title="Hide this item"
            className="btn-ghost"
            disabled={loading}
            onClick={async (ev) => {
              ev.stopPropagation?.()
              if (!it || !hideOne) return
              await hideOne(it.canonicalPath)
            }}
          >
            {loading ? <Spinner/> : <><IconCopy/> <span>Hide</span></>}
          </button>
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
