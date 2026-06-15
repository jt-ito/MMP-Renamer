import React, { useEffect, useState, useRef } from 'react'
import axios from 'axios'
import { VariableSizeList as List } from 'react-window'
import normalizeEnrichResponse from './normalizeEnrichResponse'
import ToastContainer from './components/Toast'
import FilterBar from './components/FilterBar'
import LogsPanel from './components/LogsPanel'
import CustomMetadataInputs from './components/CustomMetadataInputs'
import ManualIdInputs, { mergeManualIdDebugLogs, setManualIdLogSubscriber } from './components/ManualIdInputs'
import { IconRefresh, IconCopy, IconApply, IconHelp } from './components/Icons'
import { Spinner, LoadingIndicator } from './components/LoadingComponents'
import VirtualizedList from './components/VirtualizedList'
import { API, PROVIDER_LABELS } from './constants'
// Lazy load KeyboardShortcutsHelp since it's only shown on user action
const KeyboardShortcutsHelp = React.lazy(() => import('./components/KeyboardShortcutsHelp'))
import Settings from './Settings'
import Login from './Login'
import Register from './Register'
import Users from './Users'
import Notifications from './Notifications'
import HiddenItems from './HiddenItems'
import Duplicates from './Duplicates'
import ApprovedSeries from './ApprovedSeries'


function ProviderStats({ filteredItems, enrichCache, total, metaPhase, metaProgress, selectMode, selectedPathsList, filterProvider, setFilterProvider }) {
  const isSelectionView = !!(selectMode && selectedPathsList && selectedPathsList.length > 1)

  const displayItems = React.useMemo(() => {
    if (!isSelectionView) return filteredItems
    const selSet = new Set(selectedPathsList)
    return filteredItems.filter(it => selSet.has(it.canonicalPath))
  }, [filteredItems, isSelectionView, selectedPathsList])

  const stats = React.useMemo(() => {
    if (displayItems.length === 0) return null
    const providerCounts = {}
    let withMetadata = 0
    let withoutMetadata = 0
    for (const it of displayItems) {
      const enriched = enrichCache && enrichCache[it.canonicalPath]
      const norm = normalizeEnrichResponse(enriched)
      if (norm && norm.provider && norm.provider.title) {
        withMetadata++
        // Extract just the provider type without title info
        let source = (norm.provider.source || norm.provider.provider || 'unknown')
        // Take first provider if multiple joined by '+' (e.g., "ANILIST + TVDB" -> "ANILIST + TVDB")
        const firstProviders = source.split(/\s*\+\s*/)[0]
        // Remove everything from first '(' onwards to strip series/episode detail (e.g., "ANILIST (Series Name)" -> "ANILIST")
        const cleanedProvider = firstProviders.split('(')[0].trim()
        // Extract just the provider name (first word only, handles malformed strings)
        const baseProvider = cleanedProvider.split(/\s+/)[0].toLowerCase()
        providerCounts[baseProvider] = (providerCounts[baseProvider] || 0) + 1
      } else {
        withoutMetadata++
      }
    }
    return { providerCounts, withMetadata, withoutMetadata }
  }, [displayItems, enrichCache])

  const handleBadgeClick = (provider) => {
    if (!setFilterProvider) return
    setFilterProvider(filterProvider === provider ? 'all' : provider)
  }

  return (
    <div style={{ padding: '12px 20px', fontSize: '14px', color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
      <div>
        {isSelectionView
          ? <span>{selectedPathsList.length} items selected</span>
          : <>Found {total} items. Showing {filteredItems.length} loaded items.</>
        }
        {metaPhase ? <span className="phase-label">Metadata refresh {metaProgress}%</span> : null}
      </div>
      {stats && (
        <div style={{ display: 'flex', gap: '12px', fontSize: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
          {isSelectionView && <span style={{ color: 'var(--muted)', opacity: 0.7, fontSize: '11px', fontStyle: 'italic' }}>selected only:</span>}
          <span style={{ color: 'var(--accent-cta)', fontWeight: 600 }}>{stats.withMetadata} with metadata</span>
          {stats.withoutMetadata > 0 && <span style={{ color: 'var(--muted)' }}>{stats.withoutMetadata} without</span>}
          {Object.entries(stats.providerCounts).map(([provider, count]) => {
            const isActive = filterProvider === provider
            return (
              <span
                key={provider}
                className="item-stats-badge"
                onClick={() => handleBadgeClick(provider)}
                style={{
                  cursor: setFilterProvider ? 'pointer' : undefined,
                  background: isActive ? 'var(--accent-cta)' : undefined,
                  color: isActive ? 'var(--bg-900)' : undefined,
                  fontWeight: isActive ? 700 : undefined,
                  outline: isActive ? '2px solid var(--accent-cta)' : undefined
                }}
                title={isActive ? `Click to clear "${provider.toUpperCase()}" filter` : `Click to filter by ${provider.toUpperCase()}`}
              >
                {provider.toUpperCase()}: {count}
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}


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



export default function App() {
  const [libraries, setLibraries] = useState([])
  const [scanId, setScanId] = useState(null)
  const [scanMeta, setScanMeta] = useState(null)
  const [lastLibraryId, setLastLibraryId] = useLocalState('lastLibraryId', '')
  const [lastScanId, setLastScanId] = useLocalState('lastScanId', null)
  const [conflictResolutionState, setConflictResolutionState] = useState(null)
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
  const [folderSelectorOpen, setFolderSelectorOpen] = useState(false)
  const [folderSelectorCallback, setFolderSelectorCallback] = useState(null)
  const [folderSelectorPaths, setFolderSelectorPaths] = useState([])
  const [defaultOutputPath, setDefaultOutputPath] = useState(() => {
    try { return localStorage.getItem('scan_output_path') || '' } catch (e) { return '' }
  })
  const [alternativeOutputFolders, setAlternativeOutputFolders] = useState(() => {
    try {
      const stored = localStorage.getItem('output_folders')
      if (!stored) return []
      const parsed = JSON.parse(stored)
      return Array.isArray(parsed) ? parsed : []
    } catch (e) { return [] }
  })
  const [scanLoaded, setScanLoaded] = useState(0)
  const [scanProgress, setScanProgress] = useState(0)
  const [metaPhase, setMetaPhase] = useState(false)
  const [metaProgress, setMetaProgress] = useState(0)
  const [theme, setTheme] = useLocalState('theme', 'dark')
  const [cardParallax, setCardParallax] = useLocalState('card_parallax', true)
  const [folderSelectorApplyAsFilename, setFolderSelectorApplyAsFilename] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState({})
  const [searchQuery, setSearchQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const searchAbortRef = React.useRef(null)
  const searchTimeoutRef = React.useRef(null)
  const searchQueryRef = React.useRef('')
  const loadingMoreRef = React.useRef(false)
  const [enrichCache, setEnrichCache] = useState({})
  // Filter state with localStorage persistence
  const [filterSortOrder, setFilterSortOrder] = useLocalState('filterSortOrder', 'dateAdded-desc')
  const [filterProvider, setFilterProvider] = useLocalState('filterProvider', 'all')
  const [filterShowMode, setFilterShowMode] = useLocalState('filterShowMode', 'all')
  const [showKeyboardHelp, setShowKeyboardHelp] = useState(false)
  const [showScrollTop, setShowScrollTop] = useState(false)
  // Context menu state for rescan buttons
  const [contextMenu, setContextMenu] = useState(null)
  // Parsed-only approve warning modal
  const [parsedOnlyWarning, setParsedOnlyWarning] = useState(null) // { count, resolve }
  
  // Compute filtered and sorted items based on active filters
  // Use useMemo to compute the filtered list
  const computedFilteredItems = React.useMemo(() => {
    return applyFiltersAndSort(items)
  }, [items, filterSortOrder, filterProvider, filterShowMode, enrichCache])
  
  // Use deferred value to prevent flickering during filter changes
  const filteredItems = React.useDeferredValue(computedFilteredItems)

  // Auto-deselect items that are no longer visible in filteredItems (e.g. user changed search
  // or filter after selecting items). In-flight rescan/approve operations are independent of
  // `selected` state and will complete regardless — only the visual selection is cleared.
  React.useEffect(() => {
    if (!selectMode) return
    const visibleSet = new Set(filteredItems.map(it => it.canonicalPath))
    setSelected(prev => {
      const toRemove = Object.keys(prev).filter(p => !visibleSet.has(p))
      if (!toRemove.length) return prev
      const next = { ...prev }
      for (const p of toRemove) delete next[p]
      return next
    })
  }, [filteredItems, selectMode])

  const [logs, setLogs] = useState('')
  const [logTimezone, setLogTimezone] = useLocalState('log_timezone', '')
  const [toasts, setToasts] = useState([])
  const [loadingEnrich, setLoadingEnrich] = useState({})
  // recently hidden items pending authoritative confirmation; prevents re-inserts during background merges
  const pendingHiddenRef = useRef(new Set())
  // map of path -> timeout id to clear pending flags after a grace period
  const pendingHideTimeoutsRef = useRef({})
  // last seen hide event timestamp (ms)
  const lastHideEventTsRef = useRef( Number(localStorage.getItem('lastHideEventTs') || '0') || 0 )
  const isMountedRef = useRef(true)

  const refreshOutputDestinations = React.useCallback((detail = {}) => {
    let nextOutputPath = ''
    try {
      if (Object.prototype.hasOwnProperty.call(detail, 'outputPath')) {
        nextOutputPath = detail.outputPath || ''
      } else {
        nextOutputPath = localStorage.getItem('scan_output_path') || ''
      }
    } catch (e) { nextOutputPath = '' }
    setDefaultOutputPath(nextOutputPath)

    let nextOutputFolders = []
    try {
      if (Object.prototype.hasOwnProperty.call(detail, 'outputFolders')) {
        nextOutputFolders = Array.isArray(detail.outputFolders) ? detail.outputFolders : []
      } else {
        const storedFolders = localStorage.getItem('output_folders')
        if (storedFolders) {
          const parsed = JSON.parse(storedFolders)
          nextOutputFolders = Array.isArray(parsed) ? parsed : []
        }
      }
    } catch (e) { 
      nextOutputFolders = [] 
    }
    setAlternativeOutputFolders(nextOutputFolders)
    return { outputPath: nextOutputPath, outputFolders: nextOutputFolders }
  }, [])

  useEffect(() => {
    const handleStorage = () => refreshOutputDestinations()
    const handleCustom = (event) => refreshOutputDestinations(event && event.detail ? event.detail : {})
    window.addEventListener('storage', handleStorage)
    window.addEventListener('renamer:settings-output-folders', handleCustom)
    refreshOutputDestinations()
    return () => {
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener('renamer:settings-output-folders', handleCustom)
    }
  }, [refreshOutputDestinations])

  // Close context menu on click outside
  useEffect(() => {
    const handleClickOutside = () => setContextMenu(null)
    if (contextMenu) {
      document.addEventListener('click', handleClickOutside)
      return () => document.removeEventListener('click', handleClickOutside)
    }
  }, [contextMenu])

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

  // Global SSE EventSource
  useEffect(() => {
    if (!auth) return
    const es = new EventSource(API('/events'), { withCredentials: true })
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === 'scan_updated' || msg.type === 'hide_event') {
           window.dispatchEvent(new CustomEvent('renamer:sse_trigger_poll'))
        } else if (msg.type === 'enrichment_updated') {
           setAllItems(prev => prev.map(it => it.canonicalPath === msg.payload.path ? { ...it, enrichment: msg.payload.data } : it))
           setItems(prev => prev.map(it => it.canonicalPath === msg.payload.path ? { ...it, enrichment: msg.payload.data } : it))
           setEnrichCache(prev => ({ ...prev, [msg.payload.path]: msg.payload.data }))
        }
      } catch (err) {}
    }
    return () => es.close()
  }, [auth])
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

  // Helper: merge a new enrichment object from the server while preserving existing
  // hidden/applied flags. This prevents a server response (which may omit these flags
  // during a force-rescan) from accidentally un-hiding an item on the client.
  function mergePreservingHiddenFlag(existingEntry, newEntry) {
    if (!newEntry) return newEntry
    const merged = Object.assign({}, newEntry)
    if (existingEntry && existingEntry.hidden === true && !merged.hidden) merged.hidden = true
    if (existingEntry && existingEntry.applied === true && !merged.applied) merged.applied = true
    return merged
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
  function updateScanDataAndPreserveView(meta, coll, options = {}) {
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
      
      // If this update came from background polling (not a user-initiated scan),
      // immediately close the scanning overlay so the user doesn't see loading
      if (options.fromBackgroundPoll) {
        try {
          setScanning(false)
          setScanReady(true)
          setActiveScanKind(null)
        } catch (e) {}
      }
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

  // Apply filters and sorting to items
  function applyFiltersAndSort(itemsToFilter) {
    if (!itemsToFilter || !Array.isArray(itemsToFilter)) return []
    
    // Cache normalized responses to avoid repeated calls
    const normCache = new Map()
    const getNorm = (it) => {
      if (!it?.canonicalPath) return null
      if (normCache.has(it.canonicalPath)) return normCache.get(it.canonicalPath)
      const enriched = enrichCache && enrichCache[it.canonicalPath]
      const norm = normalizeEnrichResponse(enriched)
      normCache.set(it.canonicalPath, norm)
      return norm
    }
    
    let filtered = itemsToFilter.slice()
    
    // Always filter out hidden and applied items using global enrichCache
    filtered = filtered.filter(it => {
      const norm = getNorm(it)
      // Use global approval: hide if enrichCache marks as hidden/applied, regardless of library/output
      return !norm || (!norm.hidden && !norm.applied)
    })
    
    // Filter by provider source
    if (filterProvider && filterProvider !== 'all') {
      filtered = filtered.filter(it => {
        const norm = getNorm(it)
        const provider = norm?.provider
        if (!provider) return false
        const rawSource = (provider.source || provider.provider || '')
        const firstPart = rawSource.split(/\s*\+\s*/)[0]
        const cleanedPart = firstPart.split('(')[0].trim()
        const baseProvider = cleanedPart.split(/\s+/)[0].toLowerCase()
        if (filterProvider === 'unknown') {
          return !baseProvider || baseProvider === 'unknown'
        }
        return baseProvider === filterProvider.toLowerCase()
      })
    }
    
    // Filter by show mode (with/without metadata, etc.)
    if (filterShowMode && filterShowMode !== 'all') {
      filtered = filtered.filter(it => {
        const norm = getNorm(it)
        if (filterShowMode === 'withMetadata') {
          return norm && norm.provider && norm.provider.title
        } else if (filterShowMode === 'withoutMetadata') {
          return !norm || !norm.provider || !norm.provider.title
        } else if (filterShowMode === 'parsedOnly') {
          return norm && norm.parsed && (!norm.provider || !norm.provider.title)
        }
        return true
      })
    }
    
    // Sort items
    if (filterSortOrder && filterSortOrder !== 'none') {
      const origItems = itemsToFilter.slice()
      filtered.sort((a, b) => {
        const aPath = a.canonicalPath || ''
        const bPath = b.canonicalPath || ''
        const aNorm = getNorm(a)
        const bNorm = getNorm(b)
        
        if (filterSortOrder === 'alphabetical-asc' || filterSortOrder === 'alphabetical-desc') {
          // Sort by title (provider title > parsed title > basename)
          const aTitle = (aNorm?.provider?.title || aNorm?.parsed?.title || aPath.split('/').pop() || '').toLowerCase()
          const bTitle = (bNorm?.provider?.title || bNorm?.parsed?.title || bPath.split('/').pop() || '').toLowerCase()
          const cmp = aTitle.localeCompare(bTitle)
          return filterSortOrder === 'alphabetical-asc' ? cmp : -cmp
        } else if (filterSortOrder === 'dateAdded-asc' || filterSortOrder === 'dateAdded-desc') {
          // Sort by date added (newer items at bottom for asc, top for desc)
          // Use item index as proxy for date added (items are added chronologically)
          const aIndex = origItems.indexOf(a)
          const bIndex = origItems.indexOf(b)
          return filterSortOrder === 'dateAdded-asc' ? aIndex - bIndex : bIndex - aIndex
        } else if (filterSortOrder === 'path-asc' || filterSortOrder === 'path-desc') {
          const cmp = aPath.localeCompare(bPath)
          return filterSortOrder === 'path-asc' ? cmp : -cmp
        }
        return 0
      })
    }
    
    return filtered
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

  function pushToast(title, message, silent = false) {
    const id = Math.random().toString(36).slice(2,9)
    const ts = new Date().toISOString()
    const entry = { id, title, message, ts }
    if (!silent) {
      setToasts(t => [...t, entry])
    }
    // persist into localStorage for notifications history
    try {
      const existing = JSON.parse(localStorage.getItem('notifications') || '[]')
      existing.unshift(entry)
      // keep recent 200 notifications to avoid unbounded growth
      localStorage.setItem('notifications', JSON.stringify(existing.slice(0, 200)))
    } catch (e) {}
    if (!silent) {
      setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 6000)
    }
  }

  // Update an existing toast in-place (for progress updates) or create one if it doesn't exist yet.
  // The toast stays until explicitly dismissed — call setToasts to remove it when done.
  function upsertToast(stableId, title, message) {
    setToasts(t => {
      const idx = t.findIndex(x => x.id === stableId)
      if (idx >= 0) {
        const updated = [...t]
        updated[idx] = { ...updated[idx], title, message }
        return updated
      }
      return [...t, { id: stableId, title, message, ts: new Date().toISOString() }]
    })
  }

  function removeToast(stableId) {
    setToasts(t => t.filter(x => x.id !== stableId))
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
      try {
        const tz = userSettings.log_timezone || serverSettings.log_timezone || ''
        if (!localStorage.getItem('log_timezone') && tz) localStorage.setItem('log_timezone', tz)
        if (tz) setLogTimezone(tz)
      } catch {}
    }).catch(()=>{})
  }, [])

  useEffect(() => {
    const handleLogTimezone = (ev) => {
      try {
        const tz = ev && ev.detail ? ev.detail.logTimezone : ''
        setLogTimezone(tz || '')
      } catch (e) {}
    }
    window.addEventListener('renamer:settings-log-timezone', handleLogTimezone)
    return () => window.removeEventListener('renamer:settings-log-timezone', handleLogTimezone)
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

      // If the server is running the scan asynchronously, wait for it to finish
      // before fetching results so the UI shows actual data instead of 0 items.
      if (result.scanning) {
        let waited = 0
        while (waited < 90000) {
          await new Promise(r => setTimeout(r, 600))
          waited += 600
          try {
            const check = await axios.get(API(`/scan/${result.scanId}`))
            if (check && check.data && !check.data.scanning) { result.scanning = false; break }
          } catch (e) { result.scanning = false; break }
        }
        if (result.scanning) result.scanning = false // timed out — proceed anyway
      }

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
      // For incremental scans, skip full hydration and show items immediately
      // so they appear without delay. Items will populate with metadata as
      // background enrichment completes.
      const aggregated = mode === 'incremental'
        ? hydratedFirst
        : await hydrateScanItems(result.scanId, reportedTotal || hydratedFirst.length, hydratedFirst)
      if (phaseStartRef.current.scanStart) {
        const elapsed = Math.max(0, Date.now() - phaseStartRef.current.scanStart)
        const history = Array.isArray(timingHistoryRef.current.scanDurations) ? timingHistoryRef.current.scanDurations.slice() : []
        history.push(elapsed)
        timingHistoryRef.current.scanDurations = history.slice(-8)
        saveTimingHistory()
        phaseStartRef.current.scanStart = null
      }
      if (!isMountedRef.current) return result.scanId

      // For incremental scans: build a merged canonical set that includes both the
      // new scan items AND the previous scan items so existing items remain visible
      // while new pages load. This prevents items from disappearing during load and
      // fixes ordering instability when a scan is triggered before the previous one
      // fully loaded.
      let canonicalSet
      if (mode === 'incremental') {
        const newPaths = new Set(aggregated.map(it => it && it.canonicalPath).filter(Boolean))
        // Expand the scan path set to also include all previously-known paths
        // so mergeItemsUnique doesn't drop existing items that aren't in the first sample page.
        canonicalSet = new Set(newPaths)
        try {
          const prevItems = allItems || []
          for (const it of prevItems) {
            if (it && it.canonicalPath) canonicalSet.add(it.canonicalPath)
          }
        } catch (e) {}
      } else {
        canonicalSet = new Set(aggregated.map(it => it && it.canonicalPath).filter(Boolean))
      }
      setCurrentScanPaths(canonicalSet)

      const visibleBaseline = aggregated.filter(it => {
        if (!it || !it.canonicalPath) return false
        const enriched = enrichCache && enrichCache[it.canonicalPath]
        return !(enriched && (enriched.hidden === true || enriched.applied === true))
      })

      if (mode === 'incremental') {
        // For incremental scans: prepend new/changed items but keep existing items in place.
        // This preserves the user's scroll position and avoids order disruption.
        setAllItems(prev => {
          const newPathSet = new Set(visibleBaseline.map(it => it && it.canonicalPath).filter(Boolean))
          const existingFiltered = (prev || []).filter(it => {
            if (!it || !it.canonicalPath) return false
            if (newPathSet.has(it.canonicalPath)) return false // will be replaced by new entry
            const enriched = enrichCache && enrichCache[it.canonicalPath]
            return !(enriched && (enriched.hidden === true || enriched.applied === true))
          })
          return [...visibleBaseline, ...existingFiltered]
        })
        setItems(prev => {
          const newPathSet = new Set(visibleBaseline.map(it => it && it.canonicalPath).filter(Boolean))
          const existingFiltered = (prev || []).filter(it => {
            if (!it || !it.canonicalPath) return false
            if (newPathSet.has(it.canonicalPath)) return false
            const enriched = enrichCache && enrichCache[it.canonicalPath]
            return !(enriched && (enriched.hidden === true || enriched.applied === true))
          })
          return [...visibleBaseline, ...existingFiltered]
        })
      } else {
        setAllItems(visibleBaseline)
        setItems(visibleBaseline)
      }
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
                    // Preserve existing hidden/applied flags — server may omit them during bulk enrich
                    setEnrichCache(prev => ({ ...prev, [p]: mergePreservingHiddenFlag(prev && prev[p], enriched) }))
                    const effectiveHidden = enriched.hidden || enriched.applied || !!(enrichCache && enrichCache[p] && (enrichCache[p].hidden || enrichCache[p].applied))
                    if (effectiveHidden) {
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

  // ── Pending-rescan persistence helpers ────────────────────────────────────
  // When a force-rescan is started we write the path to localStorage so that
  // if the user navigates away before it finishes we can still pick up the
  // completed result on the next mount.
  function addPendingRescan(path) {
    try {
      const raw = localStorage.getItem('pending_rescans')
      const set = raw ? JSON.parse(raw) : []
      if (!set.includes(path)) set.push(path)
      localStorage.setItem('pending_rescans', JSON.stringify(set))
    } catch (e) {}
  }
  function removePendingRescan(path) {
    try {
      const raw = localStorage.getItem('pending_rescans')
      if (!raw) return
      const set = JSON.parse(raw).filter(p => p !== path)
      localStorage.setItem('pending_rescans', JSON.stringify(set))
    } catch (e) {}
  }
  // ─────────────────────────────────────────────────────────────────────────
  // Track server-side background jobs (bulk-rescan, approve) in localStorage so
  // they can be resumed if the user closes or backgrounds the tab.
  const BG_JOBS_KEY = 'mmp_bg_jobs'
  function trackBgJob(jobId, { type, paths, skipAnimeProviders }) {
    try {
      const raw = localStorage.getItem(BG_JOBS_KEY)
      const jobs = raw ? JSON.parse(raw) : []
      if (!jobs.find(j => j.jobId === jobId)) {
        jobs.push({ jobId, type, paths: paths || [], skipAnimeProviders: !!skipAnimeProviders, startedAt: Date.now() })
      }
      localStorage.setItem(BG_JOBS_KEY, JSON.stringify(jobs))
    } catch (e) {}
  }
  function untrackBgJob(jobId) {
    try {
      const raw = localStorage.getItem(BG_JOBS_KEY)
      if (!raw) return
      const jobs = JSON.parse(raw).filter(j => j.jobId !== jobId)
      localStorage.setItem(BG_JOBS_KEY, JSON.stringify(jobs))
    } catch (e) {}
  }
  function getPendingBgJobs() {
    try {
      const raw = localStorage.getItem(BG_JOBS_KEY)
      return raw ? JSON.parse(raw) : []
    } catch (e) { return [] }
  }
  // ─────────────────────────────────────────────────────────────────────────
  // Rescan queue: saves the full set of paths for the "Rescan selected" operation
  // so the remaining queue can be resumed if the user closes or backgrounds the tab.
  const RESCAN_QUEUE_KEY = 'mmp_rescan_queue'
  function saveRescanQueue(paths) {
    try { localStorage.setItem(RESCAN_QUEUE_KEY, JSON.stringify(Array.from(new Set(paths)))) } catch (e) {}
  }
  function getRescanQueue() {
    try { const raw = localStorage.getItem(RESCAN_QUEUE_KEY); return raw ? JSON.parse(raw) : [] } catch (e) { return [] }
  }
  function removeFromRescanQueue(path) {
    try {
      const q = getRescanQueue().filter(p => p !== path)
      if (q.length) localStorage.setItem(RESCAN_QUEUE_KEY, JSON.stringify(q))
      else localStorage.removeItem(RESCAN_QUEUE_KEY)
    } catch (e) {}
  }
  function clearRescanQueue() {
    try { localStorage.removeItem(RESCAN_QUEUE_KEY) } catch (e) {}
  }
  // ─────────────────────────────────────────────────────────────────────────

  async function enrichOne(item, force = false, skipAnimeProviders = undefined, silent = false) {
    if (!item) return
    const key = item.canonicalPath
    if (force) addPendingRescan(key)
    try {
  if (force) safeSetLoadingEnrich(l => ({ ...l, [key]: { status: 'Starting rescan...', stage: 'init' } }))

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
  if (force) safeSetLoadingEnrich(l => ({ ...l, [key]: { status: 'Computing hash & fetching metadata...', stage: 'fetching' } }))
  const payload = { path: key }
  if (providerKey) payload.tmdb_api_key = providerKey
  if (force) payload.force = true
  if (typeof skipAnimeProviders === 'boolean') payload.skipAnimeProviders = skipAnimeProviders
  const w = await axios.post(API('/enrich'), payload)
      // If the server returned a background:true response (enrichment is still running
      // in the background to avoid a proxy gateway timeout), schedule a follow-up GET
      // in 8 seconds to pick up the result once it has been written to the cache.
      if (w.data && w.data.background) {
        setTimeout(async () => {
          try {
            const check = await axios.get(API('/enrich'), { params: { path: key } })
            if (check.data && (check.data.cached || check.data.enrichment)) {
              const norm = normalizeEnrichResponse(check.data.enrichment || check.data)
              if (norm) setEnrichCache(prev => ({ ...prev, [key]: mergePreservingHiddenFlag(prev && prev[key], norm) }))
            }
          } catch (e) {}
        }, 8000)
        // Return whatever enrichment data was sent back (may be the pre-existing cached entry)
        const existingNorm = w.data.enrichment ? normalizeEnrichResponse(w.data.enrichment) : null
        return existingNorm
      }
      if (w.data) {
        const norm = normalizeEnrichResponse(w.data.enrichment || w.data)
        if (norm) setEnrichCache(prev => ({ ...prev, [key]: mergePreservingHiddenFlag(prev && prev[key], norm) }))
      }

      // if the applied operation marked this item hidden, remove it from visible items
      try {
        const _norm2 = (w.data && (w.data.enrichment || w.data)) ? normalizeEnrichResponse(w.data.enrichment || w.data) : null
        if (_norm2 && (_norm2.hidden || _norm2.applied)) {
          setItems(prev => prev.filter(it => it.canonicalPath !== key))
          setAllItems(prev => prev.filter(it => it.canonicalPath !== key))
        }
      } catch (e) {}

      // choose a friendly name for toast from normalized enrichment (prefer parsed then provider)
  const _norm = (w.data && (w.data.enrichment || w.data)) ? normalizeEnrichResponse(w.data.enrichment || w.data) : null
  const nameForToast = (_norm && (_norm.parsed?.title || _norm.provider?.title)) || (key && key.split('/')?.pop()) || key
  pushToast && pushToast('Enrich', `Updated metadata for ${nameForToast}`, silent)
  return (w.data && (w.data.enrichment || w.data)) ? normalizeEnrichResponse(w.data.enrichment || w.data) : null
    } catch (err) {
      setEnrichCache(prev => ({ ...prev, [key]: { error: err?.message || String(err) } }))
      return null
    } finally {
  if (force) {
    removePendingRescan(key)
    removeFromRescanQueue(key)
    safeSetLoadingEnrich(l => { const n = { ...l }; delete n[key]; return n })
  }
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
                  setEnrichCache(prev => ({ ...prev, [it.canonicalPath]: mergePreservingHiddenFlag(prev && prev[it.canonicalPath], norm) }))
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
        const newEnrich = {}
        let hasNew = false
        if (r.items && r.items.length) {
          for (const it of r.items) {
            if (it.enrichment) {
              newEnrich[it.canonicalPath] = it.enrichment
              hasNew = true
            }
          }
          if (hasNew) setEnrichCache(prev => ({ ...prev, ...newEnrich }))
        }
        const results = (r.items || []).filter(it => { 
          const e = newEnrich[it.canonicalPath] || (enrichCache && enrichCache[it.canonicalPath]); 
          return !(e && (e.hidden === true || e.applied === true)) 
        })
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

      // Removed automatic enrichment polling to avoid forcing metadata lookup on all scanned items
      // Users can manually enrich items if needed via the rescan button
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
              if (r.items && r.items.length) {
                const newEnrich = {}
                let hasNew = false
                for (const it of r.items) {
                  if (it.enrichment) { newEnrich[it.canonicalPath] = it.enrichment; hasNew = true }
                }
                if (hasNew) setEnrichCache(prev => ({ ...prev, ...newEnrich }))
              }
              const filtered = (r.items || []).filter(it => { const e = it.enrichment || (enrichCache && enrichCache[it.canonicalPath]); return !(e && (e.hidden === true || e.applied === true)) })
              setItems(filtered)
              setTotal(r.total || 0)
              for (const it of filtered || []) if (!enrichCache[it.canonicalPath] && !it.enrichment) enrichOne && enrichOne(it)
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
          if (r.items && r.items.length) {
            const newEnrich = {}
            let hasNew = false
            for (const it of r.items) {
              if (it.enrichment) { newEnrich[it.canonicalPath] = it.enrichment; hasNew = true }
            }
            if (hasNew) setEnrichCache(prev => ({ ...prev, ...newEnrich }))
          }
          const filtered = (r.items || []).filter(it => { const e = it.enrichment || (enrichCache && enrichCache[it.canonicalPath]); return !(e && (e.hidden === true || e.applied === true)) })
          setItems(filtered)
          setTotal(r.total || 0)
          for (const it of filtered || []) if (!enrichCache[it.canonicalPath] && !it.enrichment) enrichOne && enrichOne(it)
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

  // Keyboard shortcuts for selection management
  React.useEffect(() => {
    const handleKeyDown = (e) => {
      // Ignore if user is typing in an input field
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return
      
      // Escape key: exit select mode
      if (e.key === 'Escape' && selectMode) {
        e.preventDefault()
        setSelectMode(false)
        setSelected({})
      }
      
      // Ctrl+A: Select all visible items
      if (e.ctrlKey && e.key === 'a' && selectMode && filteredItems.length > 0) {
        e.preventDefault()
        const newSelected = {}
        for (const it of filteredItems) {
          if (it && it.canonicalPath) newSelected[it.canonicalPath] = true
        }
        setSelected(newSelected)
      }
      
      // Ctrl+D: Deselect all
      if (e.ctrlKey && e.key === 'd' && selectMode) {
        e.preventDefault()
        setSelected({})
      }
      
      // ? or F1: Show keyboard shortcuts help
      if (e.key === '?' || e.key === 'F1') {
        e.preventDefault()
        setShowKeyboardHelp(true)
      }
    }
    
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectMode, filteredItems])

  async function previewRename(selected, template, options = {}) {
    const { useFilenameAsTitle = false, skipAnimeProviders } = options || {}
    // include configured output path from local storage (client preference), server will also accept its persisted setting
    const outputPath = (() => { try { return localStorage.getItem('scan_output_path') || '' } catch { return '' } })()
    const outputFolders = (() => { try { const stored = localStorage.getItem('output_folders'); return stored ? JSON.parse(stored) : [] } catch { return [] } })()
    const effectiveTemplate = template || (() => { try { return localStorage.getItem('rename_template') || renameTemplate } catch { return renameTemplate } })()
    // Only send canonicalPath to reduce payload size (server looks up enrichment from cache)
    const itemPaths = selected.map(it => ({ canonicalPath: it.canonicalPath }))
    const payload = { items: itemPaths, template: effectiveTemplate, outputPath, useFilenameAsTitle }
    if (typeof skipAnimeProviders === 'boolean') payload.skipAnimeProviders = skipAnimeProviders
    const r = await axios.post(API('/rename/preview'), payload)
    return r.data.plans
  }

  // Refresh enrichment for a list of canonical paths and update visible items
  async function refreshEnrichForPaths(paths = []) {
    if (!Array.isArray(paths) || !paths.length) return
    const uniquePaths = Array.from(new Set(paths.filter(Boolean)))

    // Fetch all paths in parallel instead of sequentially
    const results = await Promise.all(uniquePaths.map(async (p) => {
      try {
        const er = await axios.get(API('/enrich'), { params: { path: p } })
        return { p, data: er.data || null }
      } catch (e) {
        return { p, data: null }
      }
    }))

    // Accumulate all changes, then apply in a single batch of state updates
    const cacheUpdates = {}
    const deletedFromCache = new Set()
    const removeFromItems = new Set()
    const upsertPaths = []

    for (const { p, data } of results) {
      if (!data) continue
      if (data.missing) {
        deletedFromCache.add(p)
        removeFromItems.add(p)
      } else if (data.enrichment != null) {
        // Accept any non-null enrichment regardless of the cached flag — the server
        // may mark cached:false for incomplete providers but still return valid data.
        const enriched = normalizeEnrichResponse(data.enrichment)
        // Preserve existing hidden/applied flags from client cache — the server may omit them
        // (e.g. during a background refresh) but we must not un-hide an already-hidden item.
        const existing = enrichCache && enrichCache[p]
        cacheUpdates[p] = mergePreservingHiddenFlag(existing, enriched)
        const isHiddenNow = (cacheUpdates[p] && (cacheUpdates[p].hidden || cacheUpdates[p].applied))
        if (isHiddenNow) {
          removeFromItems.add(p)
        } else {
          upsertPaths.push(p)
        }
      }
    }

    // Single enrich-cache update — merge updates with existing entries to preserve any flags
    if (deletedFromCache.size || Object.keys(cacheUpdates).length) {
      setEnrichCache(prev => {
        const n = { ...prev }
        for (const [p, upd] of Object.entries(cacheUpdates)) {
          n[p] = mergePreservingHiddenFlag(prev && prev[p], upd)
        }
        for (const p of deletedFromCache) delete n[p]
        return n
      })
    }

    // Single items/allItems update.
    // NOTE: Do NOT use mergeItemsUnique here. mergeItemsUnique applies a
    // currentScanPaths guard to existing prev items, which would silently drop
    // any item not present in the most recent (possibly partial) scan set —
    // causing unrelated visible items to vanish after a hide or targeted refresh.
    // Instead, directly filter out removed items and append any new upserts.
    if (removeFromItems.size || upsertPaths.length) {
      const upsertItems = upsertPaths.map(p => ({ id: p, canonicalPath: p }))
      const applyUpdate = (prev) => {
        const filtered = prev.filter(it => !removeFromItems.has(it.canonicalPath))
        if (!upsertItems.length) return filtered
        const existingSet = new Set(filtered.map(it => it.canonicalPath))
        const toAdd = upsertItems.filter(it => !existingSet.has(it.canonicalPath))
        return toAdd.length ? [...filtered, ...toAdd] : filtered
      }
      setItems(applyUpdate)
      setAllItems(applyUpdate)
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
      const enriched = returned ? normalizeEnrichResponse(returned) : null

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

  const fetchOutputDestinationsFromServer = React.useCallback(async () => {
    try {
      const r = await axios.get(API('/settings')).catch(() => null)
      const user = (r && r.data && r.data.userSettings) ? r.data.userSettings : null
      if (!user) return null
      const outputPath = user.scan_output_path || ''
      const outputFolders = Array.isArray(user.output_folders) ? user.output_folders : []
      try { if (outputPath) localStorage.setItem('scan_output_path', outputPath) } catch (e) {}
      try { localStorage.setItem('output_folders', JSON.stringify(outputFolders)) } catch (e) {}
      setDefaultOutputPath(outputPath)
      setAlternativeOutputFolders(outputFolders)
      return { outputPath, outputFolders }
    } catch (e) {
      return null
    }
  }, [])

  // Show folder selector modal and wait for user selection
  const selectOutputFolder = React.useCallback(async (paths = []) => {
    setFolderSelectorApplyAsFilename(false)
    const refreshed = refreshOutputDestinations()
    const refreshedFolders = refreshed && Array.isArray(refreshed.outputFolders) ? refreshed.outputFolders : null
    let activeAlternatives = Array.isArray(refreshedFolders) && refreshedFolders.length
      ? refreshedFolders
      : (Array.isArray(alternativeOutputFolders) ? alternativeOutputFolders : [])

    if (!activeAlternatives.length) {
      const server = await fetchOutputDestinationsFromServer()
      const serverFolders = server && Array.isArray(server.outputFolders) ? server.outputFolders : []
      if (serverFolders.length) {
        activeAlternatives = serverFolders
      } else {
        return { cancelled: false, path: null, applyAsFilename: false }
      }
    }

    // Ensure the modal has the latest folder data by updating state immediately
    // This fixes the bug where only the first alternative folder was shown
    if (refreshedFolders && refreshedFolders.length > 0) {
      setAlternativeOutputFolders(refreshedFolders)
    }

    return await new Promise((resolve) => {
      setFolderSelectorPaths(paths)
      setFolderSelectorCallback(() => (selection) => {
        setFolderSelectorOpen(false)
        setFolderSelectorCallback(null)
        if (selection && typeof selection === 'object') {
          resolve(selection)
        } else {
          resolve({ cancelled: true })
        }
      })
      setFolderSelectorOpen(true)
    })
  }, [alternativeOutputFolders, fetchOutputDestinationsFromServer, refreshOutputDestinations])

  async function applyRename(plans, dryRun = false, outputFolder = null) {
    // send plans to server; server will consult its configured scan_output_path to decide hardlink behavior
    try {
      const r = await axios.post(API('/rename/apply'), { plans, dryRun, outputFolder })
      // Optimistically update UI from the apply response instead of making N extra GET requests
      try {
        const results = (r.data && r.data.results) ? r.data.results : []
        const planByItemId = new Map((plans || []).map(p => [p.itemId, p]))
        const appliedPaths = new Set()
        for (let i = 0; i < results.length; i++) {
          const res = results[i]
          if (res.status === 'hardlinked') {
            // itemId is undefined when plans come from preview (client sends only canonicalPath, not id)
            // Fall back to index-based match since server processes plans in the same order
            const plan = (res.itemId != null ? planByItemId.get(res.itemId) : null) || (plans && plans[i])
            if (plan && plan.fromPath) appliedPaths.add(plan.fromPath)
          }
        }
        if (appliedPaths.size > 0) {
          setEnrichCache(prev => {
            const n = { ...prev }
            for (const p of appliedPaths) n[p] = Object.assign({}, n[p] || {}, { applied: true, hidden: true })
            return n
          })
          setItems(prev => prev.filter(it => !appliedPaths.has(it.canonicalPath)))
          setAllItems(prev => prev.filter(it => !appliedPaths.has(it.canonicalPath)))
        }
      } catch (e) {
        // best-effort
      }
      return r.data.results
    } catch (err) {
      throw err
    }
  }

  // ── Background job helpers ──────────────────────────────────────────────────
  // Poll a server-side job until it finishes (or times out after 30 min).
  async function pollJob(jobId, { onProgress } = {}) {
    const INTERVAL = 1500
    const TIMEOUT = 30 * 60 * 1000
    const start = Date.now()
    return new Promise((resolve, reject) => {
      let settled = false
      const doPoll = async () => {
        try {
          if (settled) return
          if (Date.now() - start > TIMEOUT) { cleanup(); reject(new Error('job poll timeout')); return }
          const r = await axios.get(API(`/jobs/${jobId}`)).catch(() => null)
          if (settled) return
          if (!r || !r.data || !r.data.job) return
          const job = r.data.job
          if (onProgress) onProgress(job)
          if (job.status === 'done' || job.status === 'error') { cleanup(); resolve(job) }
        } catch (e) { /* keep polling on transient errors */ }
      }
      // Wake up immediately when the browser tab becomes visible again —
      // setInterval is throttled in background tabs (Chrome: up to 1-min wake period).
      const onVisible = () => { if (document.visibilityState === 'visible') void doPoll() }
      document.addEventListener('visibilitychange', onVisible)
      const t = setInterval(doPoll, INTERVAL)
      function cleanup() { settled = true; clearInterval(t); document.removeEventListener('visibilitychange', onVisible) }
    })
  }

  // Submit an approve job and handle the full lifecycle (optimistic UI + toast on completion).
  // Replaces the previewRename + applyRename two-step for bulk operations.

  // Returns a Promise<boolean> — resolves true to proceed, false to cancel.
  // Shows a warning modal if any of the selected items have no provider metadata (parsed-only).
  function confirmParsedOnly(selItems) {
    const count = (selItems || []).filter(it => {
      const norm = enrichCache && enrichCache[it.canonicalPath]
      return norm && norm.parsed && (!norm.provider || !norm.provider.title)
    }).length
    if (!count) return Promise.resolve(true)
    return new Promise(resolve => {
      setParsedOnlyWarning({ count, resolve })
    })
  }

  async function submitApproveJob(selItems, { outputFolder = null, useFilenameAsTitle = false, skipAnimeProviders } = {}, skipConflictCheck = false) {
    if (!selItems || !selItems.length) return

    // Conflict Check
    if (!skipConflictCheck) {
      try {
        const checkRes = await axios.post(API('/jobs/check-conflicts'), {
          items: selItems.map(it => ({ canonicalPath: it.canonicalPath })),
          outputFolder, useFilenameAsTitle, skipAnimeProviders
        });
        if (checkRes.data && checkRes.data.conflicts && checkRes.data.conflicts.length > 0) {
          setConflictResolutionState({
            conflicts: checkRes.data.conflicts,
            originalPayload: { selItems, outputFolder, useFilenameAsTitle, skipAnimeProviders },
            resolutions: {}
          });
          return;
        }
      } catch (e) {
        console.error("Conflict check failed:", e);
      }
    }

    const paths = selItems.map(it => it.canonicalPath)
    // Optimistic: remove items from UI immediately
    setItems(prev => prev.filter(it => !paths.includes(it.canonicalPath)))
    setAllItems(prev => prev.filter(it => !paths.includes(it.canonicalPath)))
    setEnrichCache(prev => {
      const n = { ...prev }
      for (const p of paths) n[p] = Object.assign({}, n[p] || {}, { hidden: true })
      return n
    })
    // Guard against stale-closure re-insertion: mergeItemsUnique (used by handleScrollNearEnd
    // and refreshEnrichForPaths) checks pendingHiddenRef before re-adding items from server
    // pages or enrichment refreshes. Without this, a scroll-triggered page fetch while the
    // server job is still running can pull item(s) back into the list before job completion.
    for (const p of paths) pendingHiddenRef.current.add(p)
    try {
      const r = await axios.post(API('/jobs/approve'), {
        items: selItems.map(it => ({
          canonicalPath: it.canonicalPath,
          overwrite: it.overwrite,
          keepBothTarget: it.keepBothTarget
        })),
        outputFolder, useFilenameAsTitle, skipAnimeProviders
      })
      const jobId = r.data && r.data.jobId
      if (!jobId) throw new Error('no jobId returned')
      // Track in localStorage so tab-close doesn't lose the job
      trackBgJob(jobId, { type: 'approve', paths })
      // Poll in background — does not block UI and survives page reload (server keeps running)
      const progressToastId = `approve-job-${jobId}`
      pollJob(jobId, {
        onProgress: (job) => {
          const done = job.processedItems || 0
          const total = job.totalItems || 0
          if (total > 1) upsertToast(progressToastId, 'Approve', `Approving… ${done}/${total}`)
        }
      }).then(job => {
        untrackBgJob(jobId)
        for (const p of paths) pendingHiddenRef.current.delete(p)
        removeToast(progressToastId)
        const applied = (job.results || []).filter(r => r.status === 'hardlinked').length
        const errors  = (job.results || []).filter(r => r.status === 'error').length
        if (job.status === 'error') {
          pushToast && pushToast('Approve', `Approve failed: ${job.error || 'unknown error'}`)
        } else if (errors) {
          pushToast && pushToast('Approve', `Approved ${applied} item(s) (${errors} failed)`)
        } else {
          pushToast && pushToast('Approve', `Approved ${applied} item(s)`)
        }
      }).catch(e => {
        untrackBgJob(jobId)
        for (const p of paths) pendingHiddenRef.current.delete(p)
        removeToast(progressToastId)
        pushToast && pushToast('Approve', `Approve job error: ${e && e.message ? e.message : String(e)}`)
      })
    } catch (e) {
      for (const p of paths) pendingHiddenRef.current.delete(p)
      pushToast && pushToast('Approve', `Approve failed: ${e && e.message ? e.message : String(e)}`)
    }
  }

  // Submit a bulk-rescan job and handle lifecycle.
  // Sets per-item loading spinners immediately, tracks job in localStorage for tab-close recovery.
  async function submitBulkRescanJob(paths, { force = true, skipAnimeProviders } = {}) {
    if (!paths || !paths.length) return
    // Mark all paths as loading so spinners appear immediately
    safeSetLoadingEnrich(prev => {
      const next = { ...prev }
      for (const p of paths) if (!next[p]) next[p] = { status: 'Queued for rescan...', stage: 'fetching' }
      return next
    })
    try {
      const r = await axios.post(API('/jobs/bulk-rescan'), { paths, force, skipAnimeProviders })
      const jobId = r.data && r.data.jobId
      if (!jobId) throw new Error('no jobId returned')
      trackBgJob(jobId, { type: 'rescan', paths, skipAnimeProviders })
      const progressToastId = `rescan-job-${jobId}`
      pollJob(jobId, {
        onProgress: (job) => {
          const done = job.processedItems || 0
          const total = job.totalItems || 0
          if (total > 1) upsertToast(progressToastId, 'Rescan', `Rescanning… ${done}/${total}`)
        }
      }).then(async (job) => {
        untrackBgJob(jobId)
        removeToast(progressToastId)
        safeSetLoadingEnrich(prev => { const n = { ...prev }; for (const p of paths) delete n[p]; return n })
        const ok = (job.results || []).filter(r => r.status === 'ok').length
        const errors = (job.results || []).filter(r => r.status === 'error').length
        if (job.status === 'error') {
          pushToast && pushToast('Rescan', `Rescan failed: ${job.error || 'unknown error'}`)
        } else if (errors) {
          pushToast && pushToast('Rescan', `Rescanned ${ok} item(s) (${errors} failed)`)
        } else {
          pushToast && pushToast('Rescan', `Rescanned ${ok} item(s)`)
        }
        // Refresh enrich cache for all processed paths to pick up new metadata in UI
        try { await refreshEnrichForPaths(paths) } catch (e) {}
      }).catch(e => {
        untrackBgJob(jobId)
        removeToast(progressToastId)
        safeSetLoadingEnrich(prev => { const n = { ...prev }; for (const p of paths) delete n[p]; return n })
        pushToast && pushToast('Rescan', `Rescan job error: ${e && e.message ? e.message : String(e)}`)
      })
    } catch (e) {
      safeSetLoadingEnrich(prev => { const n = { ...prev }; for (const p of paths) delete n[p]; return n })
      pushToast && pushToast('Rescan', `Rescan failed: ${e && e.message ? e.message : String(e)}`)
    }
  }
  // ───────────────────────────────────────────────────────────────────────────

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

  async function fetchLogs() {
    try {
      const r = await axios.get(API('/logs/recent'))
      const serverLogs = (r && r.data && r.data.logs) ? String(r.data.logs) : ''
      setLogs(mergeManualIdDebugLogs(serverLogs))
    } catch(e) {
      setLogs(mergeManualIdDebugLogs(''))
    }
  }
  useEffect(() => { fetchLogs(); const t = setInterval(fetchLogs, 3000); return () => clearInterval(t) }, [])

  useEffect(() => {
    const onManualIdLog = (line) => {
      setLogs(prev => {
        const next = `${line}${prev ? `\n${prev}` : ''}`
        const lines = next.split('\n')
        return lines.slice(0, 1200).join('\n')
      })
    }
    setManualIdLogSubscriber(onManualIdLog)
    return () => {
      setManualIdLogSubscriber(null)
    }
  }, [])

  const [route, setRoute] = useState(window.location.hash || '#/')
  useEffect(() => { const onHash = () => setRoute(window.location.hash || '#/'); window.addEventListener('hashchange', onHash); return () => window.removeEventListener('hashchange', onHash) }, [])

  useEffect(() => { try { document.documentElement.classList.toggle('light', theme === 'light') } catch(e){} }, [theme])

  useEffect(() => () => { isMountedRef.current = false }, [])

  // On mount and whenever the tab becomes visible again, check whether the server
  // has any single-item enrichments still in progress (e.g. started before the user
  // pressed Back). Restore the loading indicator state and poll until each one finishes.
  useEffect(() => {
    const activeEnrichPollers = new Map() // path → intervalId

    async function syncActiveEnriches() {
      try {
        const r = await axios.get(API('/enrich/active')).catch(() => null)
        if (!r || !r.data || !Array.isArray(r.data.active)) return
        const activePaths = r.data.active.map(e => e.path).filter(Boolean)

        // Also check paths that were pending when the user last navigated away
        // — these may have already finished on the server (not in activeEnriches)
        // but their results haven't been pulled into the local enrichCache yet.
        let pendingPaths = []
        try {
          const raw = localStorage.getItem('pending_rescans')
          pendingPaths = raw ? JSON.parse(raw) : []
        } catch (e) { pendingPaths = [] }

        // Paths that finished while away: in pending but no longer active
        const finishedPaths = pendingPaths.filter(p => !activePaths.includes(p))
        if (finishedPaths.length) {
          // Immediately fetch fresh enrichment from server for each finished path
          try { await refreshEnrichForPaths(finishedPaths) } catch (e) {}
          // Clear them from the pending list and rescan queue
          for (const p of finishedPaths) { removePendingRescan(p); removeFromRescanQueue(p) }
        }

        if (!activePaths.length) return
        // Restore loading state for any path we aren't already tracking
        safeSetLoadingEnrich(prev => {
          const next = { ...prev }
          for (const p of activePaths) {
            if (!next[p]) next[p] = { status: 'Computing hash & fetching metadata...', stage: 'fetching' }
          }
          return next
        })
        // Start a poller for each active path not already being polled
        for (const p of activePaths) {
          if (activeEnrichPollers.has(p)) continue
          const POLL_INTERVAL = 2500
          const POLL_TIMEOUT = 10 * 60 * 1000
          const startedAt = Date.now()
          const id = setInterval(async () => {
            try {
              // Stop if the path is no longer in the server's active list
              if (Date.now() - startedAt > POLL_TIMEOUT) {
                clearInterval(id)
                activeEnrichPollers.delete(p)
                safeSetLoadingEnrich(prev => { const n = { ...prev }; delete n[p]; return n })
                return
              }
              const check = await axios.get(API('/enrich/active')).catch(() => null)
              const still = check && check.data && Array.isArray(check.data.active)
                ? check.data.active.some(e => e.path === p)
                : true // assume still running on error
              if (!still) {
                clearInterval(id)
                activeEnrichPollers.delete(p)
                // Pick up the completed enrichment result
                try { await refreshEnrichForPaths([p]) } catch (e) {}
                safeSetLoadingEnrich(prev => { const n = { ...prev }; delete n[p]; return n })
                removeFromRescanQueue(p)
              }
            } catch (e) { /* keep polling on transient errors */ }
          }, POLL_INTERVAL)
          activeEnrichPollers.set(p, id)
        }
      } catch (e) { /* ignore */ }
    }

    syncActiveEnriches()

    const onVisible = () => { if (document.visibilityState === 'visible') syncActiveEnriches() }
    document.addEventListener('visibilitychange', onVisible)
    // pageshow fires when the browser restores the page from the bfcache (user navigated
    // away to a different origin and came back with the browser back button). Only fire when
    // the page was restored from cache (persisted=true); the initial load is already handled
    // by the syncActiveEnriches() call above.
    const onPageShow = (e) => { if (e.persisted) syncActiveEnriches() }
    window.addEventListener('pageshow', onPageShow)

    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pageshow', onPageShow)
      for (const id of activeEnrichPollers.values()) clearInterval(id)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // On mount: check localStorage for any background jobs (rescan/approve) that were
  // started before the user closed or navigated away from the tab, and resume polling them.
  useEffect(() => {
    async function recoverPendingBgJobs() {
      const jobs = getPendingBgJobs()
      if (!jobs.length) return
      const MAX_AGE_MS = 24 * 60 * 60 * 1000 // discard jobs older than 24h
      for (const trackedJob of jobs) {
        if (Date.now() - trackedJob.startedAt > MAX_AGE_MS) { untrackBgJob(trackedJob.jobId); continue }
        try {
          const r = await axios.get(API(`/jobs/${trackedJob.jobId}`)).catch(() => null)
          if (!r || !r.data || !r.data.job) { untrackBgJob(trackedJob.jobId); continue }
          const serverJob = r.data.job
          if (serverJob.status === 'done' || serverJob.status === 'error') {
            // Job finished while tab was closed — handle completion and show toast
            untrackBgJob(trackedJob.jobId)
            if (trackedJob.type === 'rescan') {
              safeSetLoadingEnrich(prev => { const n = { ...prev }; for (const p of trackedJob.paths) delete n[p]; return n })
              const ok = (serverJob.results || []).filter(r => r.status === 'ok').length
              const errors = (serverJob.results || []).filter(r => r.status === 'error').length
              if (serverJob.status === 'error') {
                pushToast && pushToast('Rescan', `Rescan failed: ${serverJob.error || 'unknown error'}`)
              } else if (errors) {
                pushToast && pushToast('Rescan', `Rescanned ${ok} item(s) (${errors} failed)`)
              } else {
                pushToast && pushToast('Rescan', `Rescanned ${ok} item(s)`)
              }
              try { await refreshEnrichForPaths(trackedJob.paths) } catch (e) {}
            } else if (trackedJob.type === 'approve') {
              const applied = (serverJob.results || []).filter(r => r.status === 'hardlinked').length
              const errors = (serverJob.results || []).filter(r => r.status === 'error').length
              if (serverJob.status === 'error') {
                pushToast && pushToast('Approve', `Approve failed: ${serverJob.error || 'unknown error'}`)
              } else if (errors) {
                pushToast && pushToast('Approve', `Approved ${applied} item(s) (${errors} failed)`)
              } else {
                pushToast && pushToast('Approve', `Approved ${applied} item(s)`)
              }
            }
          } else {
            // Job still running — restore loading state and resume polling
            if (trackedJob.type === 'rescan') {
              safeSetLoadingEnrich(prev => {
                const next = { ...prev }
                for (const p of trackedJob.paths) if (!next[p]) next[p] = { status: 'Rescanning...', stage: 'fetching' }
                return next
              })
            } else if (trackedJob.type === 'approve') {
              // Re-guard against scroll-triggered re-insertion of items being approved
              for (const p of trackedJob.paths) pendingHiddenRef.current.add(p)
              setItems(prev => prev.filter(it => !trackedJob.paths.includes(it.canonicalPath)))
              setAllItems(prev => prev.filter(it => !trackedJob.paths.includes(it.canonicalPath)))
            }
            const progressToastId = `${trackedJob.type}-job-${trackedJob.jobId}`
            pollJob(trackedJob.jobId, {
              onProgress: (job) => {
                const done = job.processedItems || 0
                const total = job.totalItems || 0
                if (total > 1) {
                  const label = trackedJob.type === 'rescan' ? 'Rescan' : 'Approve'
                  const verb = trackedJob.type === 'rescan' ? 'Rescanning' : 'Approving'
                  upsertToast(progressToastId, label, `${verb}… ${done}/${total}`)
                }
              }
            }).then(async (job) => {
              untrackBgJob(trackedJob.jobId)
              removeToast(progressToastId)
              if (trackedJob.type === 'rescan') {
                safeSetLoadingEnrich(prev => { const n = { ...prev }; for (const p of trackedJob.paths) delete n[p]; return n })
                const ok = (job.results || []).filter(r => r.status === 'ok').length
                const errors = (job.results || []).filter(r => r.status === 'error').length
                if (job.status === 'error') {
                  pushToast && pushToast('Rescan', `Rescan failed: ${job.error || 'unknown error'}`)
                } else if (errors) {
                  pushToast && pushToast('Rescan', `Rescanned ${ok} item(s) (${errors} failed)`)
                } else {
                  pushToast && pushToast('Rescan', `Rescanned ${ok} item(s)`)
                }
                try { await refreshEnrichForPaths(trackedJob.paths) } catch (e) {}
              } else if (trackedJob.type === 'approve') {
                for (const p of trackedJob.paths) pendingHiddenRef.current.delete(p)
                const applied = (job.results || []).filter(r => r.status === 'hardlinked').length
                const errors = (job.results || []).filter(r => r.status === 'error').length
                if (job.status === 'error') {
                  pushToast && pushToast('Approve', `Approve failed: ${job.error || 'unknown error'}`)
                } else if (errors) {
                  pushToast && pushToast('Approve', `Approved ${applied} item(s) (${errors} failed)`)
                } else {
                  pushToast && pushToast('Approve', `Approved ${applied} item(s)`)
                }
              }
            }).catch(() => {
              untrackBgJob(trackedJob.jobId)
              removeToast(progressToastId)
              if (trackedJob.type === 'rescan') {
                safeSetLoadingEnrich(prev => { const n = { ...prev }; for (const p of trackedJob.paths) delete n[p]; return n })
              } else if (trackedJob.type === 'approve') {
                for (const p of trackedJob.paths) pendingHiddenRef.current.delete(p)
              }
            })
          }
        } catch (e) { /* ignore per-job errors, continue */ }
      }
    }
    recoverPendingBgJobs()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // On mount: resume any "Rescan selected" queue that was interrupted by a tab close.
  // Items currently being processed are already handled by syncActiveEnriches via
  // pending_rescans / activeEnriches; this effect only submits items that haven't
  // reached the server yet.
  useEffect(() => {
    async function recoverRescanQueue() {
      const queue = getRescanQueue()
      if (!queue.length) return

      // Check what's currently active / pending on the server
      const r = await axios.get(API('/enrich/active')).catch(() => null)
      const activePaths = (r && r.data && Array.isArray(r.data.active))
        ? r.data.active.map(e => e.path).filter(Boolean) : []
      let pendingPaths = []
      try { const raw = localStorage.getItem('pending_rescans'); pendingPaths = raw ? JSON.parse(raw) : [] } catch (e) {}

      // Show "Queued" for items not already displaying a loading state
      safeSetLoadingEnrich(prev => {
        const next = { ...prev }
        for (const p of queue) if (!next[p]) next[p] = { status: 'Queued for rescan...', stage: 'init' }
        return next
      })

      // Items not yet submitted to the server — submit them now
      const toProcess = queue.filter(p => !activePaths.includes(p) && !pendingPaths.includes(p))
      if (!toProcess.length) return // syncActiveEnriches covers the rest

      const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
      let successCount = 0
      const failed = []
      for (let i = 0; i < toProcess.length; i++) {
        const path = toProcess[i]
        try {
          const result = await enrichOne({ canonicalPath: path }, true)
          if (result) successCount += 1
          else failed.push(path)
        } catch (err) { failed.push(path) }
        // Remove from queue immediately after processing (success or failure) so a
        // subsequent tab open does not re-trigger a force rescan (which would purge
        // the enrichment from the DB and potentially leave the item as "Source: unknown"
        // if the re-enrich fails due to rate limiting or network errors).
        removeFromRescanQueue(path)
        if (i < toProcess.length - 1) await sleep(350)
      }

      // Guard: clear any loading indicators enrichOne may not have cleared
      safeSetLoadingEnrich(prev => { const n = { ...prev }; for (const p of toProcess) delete n[p]; return n })

      if (toProcess.length > 0) {
        const failureCount = failed.length
        if (failureCount) {
          pushToast && pushToast('Rescan', `Resumed rescan: ${successCount}/${toProcess.length} completed (${failureCount} failed)`)
        } else {
          pushToast && pushToast('Rescan', `Resumed rescan: ${successCount} item(s) completed`)
        }
      }
    }
    recoverRescanQueue()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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

  // Scroll to top button visibility
  useEffect(() => {
    const handleScroll = () => {
      setShowScrollTop(window.scrollY > 300)
    }
    window.addEventListener('scroll', handleScroll)
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  // On mount: if we have a persisted lastScanId, attempt to load it and populate allItems.
  // Also depends on authChecked so it re-runs once the session cookie check completes —
  // without this, the initial run fires before auth is confirmed (all scan routes require
  // auth), the 401 responses bail out early, and the scan never loads after a full browser
  // restart even though lastScanId is still in localStorage.
  useEffect(() => {
    if (!authChecked || !auth) return   // wait until we know we're authenticated
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
          const r = await axios.get(API(`/scan/${effectiveScanId}/items`), { params: { offset: 0, limit: 500 } }).catch(() => ({ data: { items: [] } }))
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
            const r = await axios.get(API(`/scan/${effectiveScanId}/items`), { params: { offset: off, limit: pageSize } }).catch(() => ({ data: { items: [] } }))
            if (!mounted) return
            all = all.concat(r.data.items || [])
          }
          setAllItems(all)
          setItems(all)
          setCurrentScanPaths(new Set((all || []).map(i => i.canonicalPath)))
        } else {
          // large scan: fetch first page only and rely on server search/paging for the rest
          const r = await axios.get(API(`/scan/${effectiveScanId}/items`), { params: { offset: 0, limit: 500 } }).catch(() => ({ data: { items: [] } }))
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
  }, [lastScanId, authChecked, auth]) // eslint-disable-line react-hooks/exhaustive-deps

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
                try { updateScanDataAndPreserveView(latest, all, { fromBackgroundPoll: true }) } catch (e) {}
              } else {
                const page = (pg && pg.data && Array.isArray(pg.data.items)) ? pg.data.items : []
                try { updateScanDataAndPreserveView(latest, page, { fromBackgroundPoll: true }) } catch (e) {}
              }
              try { setScanId(latestId); setScanMeta(latest); setLastScanId(latestId); setTotal(latest.totalCount || (pg && pg.data && Array.isArray(pg.data.items) ? pg.data.items.length : 0)) } catch (e) {}
            } catch (e) {}
          } catch (e) { /* best-effort, do not disrupt UI */ }
        }
      } catch (e) { /* ignore */ }
    }

    // run immediately and then on SSE events
    void pollLatest()
    const handleSseTrigger = () => { void pollLatest() }
    window.addEventListener('renamer:sse_trigger_poll', handleSseTrigger)
    return () => { mounted = false; window.removeEventListener('renamer:sse_trigger_poll', handleSseTrigger) }
  }, [lastLibraryId, scanMeta, searchQuery])

  // Keep a ref in sync with searchQuery so closures in long-lived effects always see the latest value
  React.useEffect(() => { searchQueryRef.current = searchQuery }, [searchQuery])

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
      // bail out if user has an active search — same guard as the library poll —
      // prevents the stale-closure version of updateScanDataAndPreserveView from
      // running with searchQuery='' and resetting the filtered view to all items.
      if (searchQueryRef.current && searchQueryRef.current.length) return
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
              try { updateScanDataAndPreserveView(serverMeta, all, { fromBackgroundPoll: true }) } catch (e) {}
              try { setScanMeta(serverMeta); setTotal(serverMeta.totalCount || all.length || 0) } catch (e) {}
            } else {
              const r = await axios.get(API(`/scan/${scanId}/items`), { params: { offset: 0, limit: Math.max(batchSize, 50) } }).catch(() => ({ data: { items: [] } }))
              const page = (r && r.data && r.data.items) ? r.data.items : []
              try { updateScanDataAndPreserveView(serverMeta, page, { fromBackgroundPoll: true }) } catch (e) {}
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
      {parsedOnlyWarning ? (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          onClick={() => { parsedOnlyWarning.resolve(false); setParsedOnlyWarning(null) }}
        >
          <div className="modal-card" onClick={ev => ev.stopPropagation()}>
            <p>
              <strong>{parsedOnlyWarning.count} item{parsedOnlyWarning.count !== 1 ? 's' : ''}</strong> {parsedOnlyWarning.count !== 1 ? 'have' : 'has'} no provider metadata — {parsedOnlyWarning.count !== 1 ? 'they' : 'it'} will be renamed using the parsed filename only.
            </p>
            <p style={{ fontSize: '0.85em', opacity: 0.75 }}>Consider rescanning first to fetch metadata from a provider.</p>
            <div className="modal-actions">
              <button
                className="btn-ghost"
                onClick={() => { parsedOnlyWarning.resolve(false); setParsedOnlyWarning(null) }}
              >Cancel</button>
              <button
                className="btn-save"
                onClick={() => { parsedOnlyWarning.resolve(true); setParsedOnlyWarning(null) }}
              >Approve anyway</button>
            </div>
          </div>
        </div>
      ) : null}
      {folderSelectorOpen ? (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          onClick={() => {
            setFolderSelectorOpen(false)
            if (folderSelectorCallback) {
              folderSelectorCallback({ cancelled: true })
            }
          }}
        >
          <div className="modal-card folder-selector-modal" onClick={ev => ev.stopPropagation()}>
            <h3>Select Output Folder</h3>
            <div style={{ position: 'absolute', top: 12, right: 12 }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={!!folderSelectorApplyAsFilename}
                  onChange={e => setFolderSelectorApplyAsFilename(!!e.target.checked)}
                />
                <span>Apply as filename</span>
              </label>
            </div>
            <p className="folder-selector-subtitle">Choose where to apply the rename{folderSelectorPaths && folderSelectorPaths.length > 1 ? 's' : ''}.</p>
            {folderSelectorPaths && folderSelectorPaths.length ? (
              <div className="folder-selector-context">
                {folderSelectorPaths.slice(0, 3).map(p => (
                  <span key={p} className="folder-chip" title={p}>{p.split(/[\\/]/).pop() || p}</span>
                ))}
                {folderSelectorPaths.length > 3 ? (
                  <span className="folder-chip more">+{folderSelectorPaths.length - 3}</span>
                ) : null}
              </div>
            ) : null}
            <div className="folder-list">
              <button
                type="button"
                className="folder-option"
                onClick={() => {
                  setFolderSelectorOpen(false)
                  if (folderSelectorCallback) {
                    const choice = { cancelled: false, path: null, applyAsFilename: folderSelectorApplyAsFilename }
                    folderSelectorCallback(choice)
                  }
                }}
              >
                <div className="folder-option-body">
                  <div>
                    <div className="folder-name">Default Output Path</div>
                    <div className="folder-path">{defaultOutputPath || '(not configured)'}</div>
                  </div>
                  <span className="folder-option-icon" aria-hidden="true">&gt;</span>
                </div>
              </button>
              {alternativeOutputFolders && alternativeOutputFolders.map((folder, idx) => (
                <button
                  type="button"
                  key={`${folder.path || 'alt'}-${idx}`}
                  className="folder-option"
                  onClick={() => {
                    setFolderSelectorOpen(false)
                    if (folderSelectorCallback) {
                      const choice = { cancelled: false, path: folder.path || '', applyAsFilename: folderSelectorApplyAsFilename }
                      folderSelectorCallback(choice)
                    }
                  }}
                >
                  <div className="folder-option-body">
                    <div>
                      <div className="folder-name">{folder.name || `Folder ${idx + 1}`}</div>
                      <div className="folder-path">{folder.path || '(no path set)'}</div>
                    </div>
                    <span className="folder-option-icon" aria-hidden="true">&gt;</span>
                  </div>
                </button>
              ))}
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  setFolderSelectorOpen(false)
                  if (folderSelectorCallback) {
                    folderSelectorCallback({ cancelled: true })
                  }
                }}
              >Cancel</button>
            </div>
          </div>
        </div>
      ) : null}
      {/* Progress bar at top of page */}
      {(scanning || metaPhase) && (
        <div className="top-progress-bar">
          <div 
            className="top-progress-bar-fill"
            style={{ width: `${metaPhase ? metaProgress : scanProgress}%` }}
          ></div>
        </div>
      )}
      <header>
        <h1 
          style={{cursor:'pointer'}} 
          onClick={() => {
            // If user is actively searching, clicking the title clears the search (acts as clear button)
            if (searchQuery && searchQuery.trim()) {
              doSearch('')
            } else {
              // Otherwise navigate to dashboard (existing behavior)
              window.location.hash = '#/'
            }
          }} 
          title={searchQuery && searchQuery.trim() ? "Clear search" : "Go to dashboard"}
        >
          MMP Renamer
        </h1>
  {/* Header search: only show when authenticated and on the dashboard */}
  {auth && route === '#/' ? (
    <div className="header-search">
      <input
        className="form-input"
        placeholder="Search files (server-side)"
        value={searchQuery}
        onChange={e => setSearchQuery(e.target.value)}
        disabled={searchDisabled}
      />
      <button className='btn-ghost btn-search' style={{ display: selectMode && selectedCount ? 'none' : '' }} onClick={() => doSearch(searchQuery)} disabled={searchDisabled || searching}>{searching ? <Spinner/> : 'Search'}</button>
      <button className='btn-ghost btn-clear' style={{ display: selectMode && selectedCount ? 'none' : '' }} onClick={() => doSearch('')} title='Clear search' disabled={searchDisabled}>Clear</button>
    </div>
  ) : auth && route !== '#/' ? (
    <div className="header-page-title">
      {{
        '#/settings': 'Settings',
        '#/hidden': 'Hidden Items',
        '#/duplicates': 'Duplicates',
        '#/notifications': 'Notifications',
        '#/approved-series': 'Approved Series',
        '#/users': 'Users',
      }[route] ?? 'MMP Renamer'}
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
              {route === '#/' && (
                <button className={"btn-ghost" + (selectMode ? ' active' : '')} onClick={() => { setSelectMode(s => { if (s) setSelected({}); return !s }) }} title={selectMode ? 'Exit select mode (Esc)' : 'Select items'}>Select</button>
              )}
              {route === '#/' && selectMode && filteredItems.length > 0 && (
                <>
                  <button 
                    className="btn-ghost"
                    onClick={() => {
                      const newSelected = {}
                      for (const it of filteredItems) {
                        if (it && it.canonicalPath) newSelected[it.canonicalPath] = true
                      }
                      setSelected(newSelected)
                    }}
                    title="Select all visible items (Ctrl+A)"
                  >
                    Select All
                  </button>
                  <button 
                    className="btn-ghost"
                    onClick={() => setSelected({})}
                    title="Deselect all items (Ctrl+D)"
                  >
                    Deselect All
                  </button>
                </>
              )}
        {/* Global bulk-enrich indicator (shown when many enrich operations are running) */}
            <div className="select-approve-wrap">
                {selectMode && selectedCount ? (
                  <button
                    className={"btn-save approve-button visible"}
                    disabled={selectedHasLoading}
                    onClick={async () => {
                      try {
                        const selectedPaths = [...selectedPathsList]
                        console.log('[Approve] selectedPaths:', selectedPaths.length)
                        if (!selectedPaths.length) return
                        const selItems = items.filter(it => selectedPaths.includes(it.canonicalPath))
                        console.log('[Approve] selItems:', selItems.length)
                        if (!selItems.length) return
                        
                        // Show folder selector if alternative folders are configured
                        console.log('[Approve] Calling selectOutputFolder...')
                        const selection = await selectOutputFolder(selectedPaths)
                        console.log('[Approve] Selection result:', selection)
                        if (!selection || selection.cancelled) {
                          console.log('[Approve] Selection cancelled or null, aborting')
                          return
                        }
                        const selectedFolderPath = selection.path ?? null
                        const useFilenameAsTitle = selection.applyAsFilename ?? false
                        
                        if (!await confirmParsedOnly(selItems)) return
                        pushToast && pushToast('Approve', `Queuing ${selItems.length} item(s) for approval...`)
                        await submitApproveJob(selItems, { outputFolder: selectedFolderPath, useFilenameAsTitle })
                        setSelected(prev => {
                          if (!prev) return {}
                          const next = { ...prev }
                          for (const p of selectedPaths) delete next[p]
                          return next
                        })
                      } catch (e) { pushToast && pushToast('Approve', 'Approve failed') }
                    }}
                    onContextMenu={(ev) => {
                      ev.preventDefault()
                      ev.stopPropagation?.()
                      if (selectedHasLoading) return
                      setContextMenu({
                        x: ev.clientX,
                        y: ev.clientY,
                        type: 'approve',
                        selectedPaths: [...selectedPathsList]
                      })
                    }}
                    title="Approve selected (right-click for TV/Movie or Anime mode)"
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
                    onContextMenu={(ev) => {
                      ev.preventDefault()
                      ev.stopPropagation?.()
                      if (selectedHasLoading) return
                      setContextMenu({
                        x: ev.clientX,
                        y: ev.clientY,
                        type: 'hide',
                        selectedPaths: [...selectedPathsList]
                      })
                    }}
                    title="Hide selected (right-click for TV/Movie or Anime mode)"
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
                          // Save full queue to localStorage for tab-close recovery
                          saveRescanQueue(selectedPaths)
                          pushToast && pushToast('Rescan', `Rescanning ${selectedPaths.length} items...`)
                          // Mark all items as queued so the user sees which are pending before each starts
                          safeSetLoadingEnrich(prev => {
                            const next = { ...prev }
                            for (const p of selectedPaths) if (!next[p]) next[p] = { status: 'Queued for rescan...', stage: 'init' }
                            return next
                          })

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

                          clearRescanQueue()
                          // clear loading flags (guard in case enrichOne did not remove them)
                          safeSetLoadingEnrich(prev => { const n = { ...prev }; for (const p of selectedPaths) delete n[p]; return n })

                          const failureCount = failed.length
                          if (failureCount) {
                            pushToast && pushToast('Rescan', `Rescanned ${successCount}/${selectedPaths.length} items (${failureCount} failed).`)
                            try { dlog('[client] RESCAN_SELECTED_FAILED', { failed }) } catch (e) {}
                          } else {
                            pushToast && pushToast('Rescan', `Rescanned ${selectedPaths.length} items.`)
                          }
                        } catch (e) {
                          clearRescanQueue()
                          pushToast && pushToast('Rescan', 'Rescan failed')
                        }
                      }}
                      onContextMenu={(ev) => {
                        ev.preventDefault()
                        ev.stopPropagation?.()
                        if (selectedHasLoading) return
                        setContextMenu({
                          x: ev.clientX,
                          y: ev.clientY,
                          type: 'bulk',
                          selectedPaths: [...selectedPathsList]
                        })
                      }}
                      title="Rescan selected"
                    >Rescan selected</button>
                ) : null}
              {route === '#/' && (
              <button
                className={"btn-save" + (selectMode && selectedCount ? ' shifted' : '')}
                style={{ display: selectMode && selectedCount ? 'none' : '' }}
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
              )}
              {route === '#/' && (
              <button
                className="btn-ghost btn-incremental"
                style={{ display: selectMode && selectedCount ? 'none' : '' }}
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
              )}
            </div>
            <div className="header-nav">
            <button className="btn-ghost" onClick={() => (window.location.hash = route === '#/settings' ? '#/' : '#/settings')}>Settings</button>
            {auth && auth.role === 'admin' && (
              <button className="btn-ghost" onClick={() => (window.location.hash = route === '#/hidden' ? '#/' : '#/hidden')}>Hidden items</button>
            )}
            {auth && auth.role === 'admin' && (
              <button className="btn-ghost" onClick={() => (window.location.hash = route === '#/duplicates' ? '#/' : '#/duplicates')}>Duplicates</button>
            )}
            <button className="btn-ghost icon-only" title="Notifications" onClick={() => (window.location.hash = '#/notifications')}>
              {/* compact bell icon - centered and sized to avoid cropping */}
              <svg className="icon" viewBox="0 0 24 24" width="18" height="18" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 22c1.1 0 2-.9 2-2H10c0 1.1.9 2 2 2z" />
                <path d="M18 16v-5c0-3.07-1.63-5.64-4.5-6.32V4a1.5 1.5 0 10-3 0v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z" />
              </svg>
            </button>
            <button className="btn-ghost" onClick={() => (window.location.hash = route === '#/approved-series' ? '#/' : '#/approved-series')}>Approved Series</button>
            {auth && auth.role === 'admin' && <button className="btn-ghost" onClick={() => (window.location.hash = '#/users')}>Users</button>}
            {auth && <button className="btn-ghost" onClick={async ()=>{ try { await axios.post(API('/logout')); setAuth(null); pushToast && pushToast('Auth','Logged out') } catch { pushToast && pushToast('Auth','Logout failed') } }}>Logout</button>}
            </div>
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
            <section className="list settings-page">
              <Settings pushToast={pushToast} cardParallax={cardParallax} setCardParallax={setCardParallax} />
            </section>
          ) : route === '#/hidden' ? (
            <section className="list">
              <HiddenItems pushToast={pushToast} />
            </section>
          ) : route === '#/duplicates' ? (
            <section className="list">
              <Duplicates pushToast={pushToast} />
            </section>
          ) : route === '#/approved-series' ? (
            <section className="list settings-page">
              <ApprovedSeries pushToast={pushToast} parallax={cardParallax} />
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
                    <>
                      <FilterBar
                        sortOrder={filterSortOrder}
                        onSortOrderChange={setFilterSortOrder}
                        provider={filterProvider}
                        onProviderChange={setFilterProvider}
                        showMode={filterShowMode}
                        onShowModeChange={setFilterShowMode}
                        totalItems={items.length}
                        filteredItems={filteredItems.length}
                        onClearFilters={() => {
                          setFilterSortOrder('dateAdded-desc')
                          setFilterProvider('all')
                          setFilterShowMode('all')
                        }}
                      />
                      <ProviderStats 
                        filteredItems={filteredItems} 
                        enrichCache={enrichCache} 
                        total={total} 
                        metaPhase={metaPhase} 
                        metaProgress={metaProgress}
                        selectMode={selectMode}
                        selectedPathsList={selectedPathsList}
                        filterProvider={filterProvider}
                        setFilterProvider={setFilterProvider}
                      />
                    </>
                  ) : (
                    <div style={{ padding: '12px 20px' }}>No scan yet</div>
                  )}

                  {scanMeta ? (
            <VirtualizedList items={filteredItems} enrichCache={enrichCache} setEnrichCache={setEnrichCache} onNearEnd={handleScrollNearEnd} enrichOne={enrichOne}
              previewRename={previewRename} applyRename={applyRename} pushToast={pushToast} loadingEnrich={loadingEnrich}
              safeSetLoadingEnrich={safeSetLoadingEnrich} refreshEnrichForPaths={refreshEnrichForPaths}
              selectOutputFolder={selectOutputFolder}
              selectMode={selectMode} selected={selected} toggleSelect={(p, val) => setSelected(s => { const n = { ...s }; if (val) n[p]=true; else delete n[p]; return n })}
              providerKey={providerKey} hideOne={hideOnePath}
              optimisticHide={(path) => { pendingHiddenRef.current.add(path); setEnrichCache(prev => ({ ...prev, [path]: Object.assign({}, prev && prev[path] ? prev[path] : {}, { hidden: true }) })); setItems(prev => prev.filter(x => x.canonicalPath !== path)); setAllItems(prev => prev.filter(x => x.canonicalPath !== path)) }}
              searchQuery={searchQuery} setSearchQuery={setSearchQuery} doSearch={doSearch} searching={searching}
              setContextMenu={setContextMenu} />
                  ) : null}
                </>
              )}
            </section>
            <aside className="side">
              <LogsPanel logs={logs} refresh={fetchLogs} pushToast={pushToast} logTimezone={logTimezone} />
            </aside>
          </>
        )}
      </main>

      {route === '#/settings' && (
        <button
          onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          style={{
            position: 'fixed', top: 99, right: 23, zIndex: 200,
            width: 40, height: 40,
            borderRadius: '50%',
            background: 'var(--bg-800)',
            border: '1px solid var(--bg-600)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer',
            color: 'var(--accent)',
            padding: 0,
            boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
          }}
        >
          {theme === 'dark' ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="5"/>
              <line x1="12" y1="1" x2="12" y2="3"/>
              <line x1="12" y1="21" x2="12" y2="23"/>
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
              <line x1="1" y1="12" x2="3" y2="12"/>
              <line x1="21" y1="12" x2="23" y2="12"/>
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
            </svg>
          )}
        </button>
      )}
      <ToastContainer toasts={toasts} remove={(id)=>setToasts(t=>t.filter(x=>x.id!==id))} />
      {showKeyboardHelp && (
        <React.Suspense fallback={null}>
          <KeyboardShortcutsHelp isOpen={showKeyboardHelp} onClose={() => setShowKeyboardHelp(false)} />
        </React.Suspense>
      )}
      
      {/* Scroll to top button */}
      {showScrollTop && (
        <button
          className="scroll-to-top"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          title="Scroll to top"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="18 15 12 9 6 15"></polyline>
          </svg>
        </button>
      )}

      {/* Context menu for rescan buttons */}
      {contextMenu && (
        <div
          className="context-menu"
          style={{
            left: contextMenu.x,
            top: contextMenu.y
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="context-menu-items">
            <button
              className="context-menu-item"
              onClick={async (e) => {
                e.stopPropagation()
                setContextMenu(null)
                if (contextMenu.type === 'single') {
                  pushToast && pushToast('Rescan', 'Refreshing metadata (TV/Movie mode)...')
                  await enrichOne(contextMenu.item, true, true)
                } else if (contextMenu.type === 'bulk') {
                  const selectedPaths = contextMenu.selectedPaths
                  if (!selectedPaths.length) return
                  pushToast && pushToast('Rescan', `Queuing ${selectedPaths.length} item(s) for rescan (TV/Movie mode)...`)
                  await submitBulkRescanJob(selectedPaths, { force: true, skipAnimeProviders: true })
                } else if (contextMenu.type === 'approve') {
                  const selectedPaths = contextMenu.selectedPaths
                  if (!selectedPaths.length) return
                  try {
                    const selItems = items.filter(it => selectedPaths.includes(it.canonicalPath))
                    if (!selItems.length) return
                    const selection = await selectOutputFolder(selectedPaths)
                    if (!selection || selection.cancelled) return
                    const selectedFolderPath = selection.path ?? null
                    const useFilenameAsTitle = selection.applyAsFilename ?? false
                    if (!await confirmParsedOnly(selItems)) return
                    pushToast && pushToast('Approve', `Queuing ${selItems.length} item(s) for approval (TV/Movie mode)...`)
                    await submitApproveJob(selItems, { outputFolder: selectedFolderPath, useFilenameAsTitle, skipAnimeProviders: true })
                    setSelected(prev => {
                      if (!prev) return {}
                      const next = { ...prev }
                      for (const p of selectedPaths) delete next[p]
                      return next
                    })
                  } catch (err) {
                    pushToast && pushToast('Approve', 'Approve failed')
                  }
                }
              }}
            >
              TV/Movie
            </button>
            <button
              className="context-menu-item"
              onClick={async (e) => {
                e.stopPropagation()
                setContextMenu(null)
                if (contextMenu.type === 'single') {
                  pushToast && pushToast('Rescan', 'Refreshing metadata (Anime mode)...')
                  await enrichOne(contextMenu.item, true, false)
                } else if (contextMenu.type === 'bulk') {
                  const selectedPaths = contextMenu.selectedPaths
                  if (!selectedPaths.length) return
                  pushToast && pushToast('Rescan', `Queuing ${selectedPaths.length} item(s) for rescan (Anime mode)...`)
                  await submitBulkRescanJob(selectedPaths, { force: true, skipAnimeProviders: false })
                } else if (contextMenu.type === 'approve') {
                  const selectedPaths = contextMenu.selectedPaths
                  if (!selectedPaths.length) return
                  try {
                    const selItems = items.filter(it => selectedPaths.includes(it.canonicalPath))
                    if (!selItems.length) return
                    const selection = await selectOutputFolder(selectedPaths)
                    if (!selection || selection.cancelled) return
                    const selectedFolderPath = selection.path ?? null
                    const useFilenameAsTitle = selection.applyAsFilename ?? false
                    if (!await confirmParsedOnly(selItems)) return
                    pushToast && pushToast('Approve', `Queuing ${selItems.length} item(s) for approval (Anime mode)...`)
                    await submitApproveJob(selItems, { outputFolder: selectedFolderPath, useFilenameAsTitle, skipAnimeProviders: false })
                    setSelected(prev => {
                      if (!prev) return {}
                      const next = { ...prev }
                      for (const p of selectedPaths) delete next[p]
                      return next
                    })
                  } catch (err) {
                    pushToast && pushToast('Approve', 'Approve failed')
                  }
                }
              }}
            >
              Anime
            </button>
            {(contextMenu.type === 'approve' || contextMenu.type === 'hide') && (
              <>
                {contextMenu.type === 'approve' && (
              <>
                <button
                  className="context-menu-item"
                  onClick={async (e) => {
                    console.log('[Approve Context] TV/Movie mode clicked')
                    e.stopPropagation()
                    setContextMenu(null)
                    const selectedPaths = contextMenu.selectedPaths
                    console.log('[Approve Context] selectedPaths:', selectedPaths)
                    if (!selectedPaths.length) return
                    const selection = await selectOutputFolder(selectedPaths)
                    if (!selection || selection.cancelled) return
                    const selectedFolderPath = selection.path ?? null
                    const useFilenameAsTitle = selection.applyAsFilename ?? false
                    // Rescan + approve as a single server-side job that survives browser close
                    pushToast && pushToast('Approve', `Queuing ${selectedPaths.length} item(s) for rescan + approve (TV/Movie mode)...`)
                    await submitBulkRescanJob(selectedPaths, { force: true, skipAnimeProviders: true })
                    const selItems = selectedPaths.map(p => ({ canonicalPath: p }))
                    await submitApproveJob(selItems, { outputFolder: selectedFolderPath, useFilenameAsTitle, skipAnimeProviders: true })
                    setSelected(prev => {
                      if (!prev) return {}
                      const next = { ...prev }
                      for (const p of selectedPaths) delete next[p]
                      return next
                    })
                  }}
                >
                  TV/Movie mode (rescan + approve)
                </button>
                <button
                  className="context-menu-item"
                  onClick={async (e) => {
                    console.log('[Approve Context] Anime mode clicked')
                    e.stopPropagation()
                    setContextMenu(null)
                    const selectedPaths = contextMenu.selectedPaths
                    console.log('[Approve Context] selectedPaths:', selectedPaths)
                    if (!selectedPaths.length) return
                    const selection = await selectOutputFolder(selectedPaths)
                    if (!selection || selection.cancelled) return
                    const selectedFolderPath = selection.path ?? null
                    const useFilenameAsTitle = selection.applyAsFilename ?? false
                    // Rescan + approve as a single server-side job that survives browser close
                    pushToast && pushToast('Approve', `Queuing ${selectedPaths.length} item(s) for rescan + approve (Anime mode)...`)
                    await submitBulkRescanJob(selectedPaths, { force: true, skipAnimeProviders: false })
                    const selItems = selectedPaths.map(p => ({ canonicalPath: p }))
                    await submitApproveJob(selItems, { outputFolder: selectedFolderPath, useFilenameAsTitle, skipAnimeProviders: false })
                    setSelected(prev => {
                      if (!prev) return {}
                      const next = { ...prev }
                      for (const p of selectedPaths) delete next[p]
                      return next
                    })
                  }}
                >
                  Anime mode (rescan + approve)
                </button>
              </>
            )}
            {contextMenu.type === 'hide' && (
              <>
                <button
                  className="context-menu-item"
                  onClick={async (e) => {
                    e.stopPropagation()
                    setContextMenu(null)
                    const selectedPaths = contextMenu.selectedPaths
                    if (!selectedPaths.length) return

                    // Instantly hide all selected items from the UI before the rescan starts
                    setEnrichCache(prev => {
                      const n = { ...prev }
                      for (const p of selectedPaths) n[p] = Object.assign({}, n[p] || {}, { hidden: true })
                      return n
                    })
                    setItems(prev => prev.filter(it => !selectedPaths.includes(it.canonicalPath)))
                    setAllItems(prev => prev.filter(it => !selectedPaths.includes(it.canonicalPath)))
                    for (const p of selectedPaths) pendingHiddenRef.current.add(p)
                    
                    // Then rescan in TV/Movie mode (background — UI already updated)
                    pushToast && pushToast('Hide', `Rescanning ${selectedPaths.length} items (TV/Movie mode)...`)
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
                        const result = await enrichOne({ canonicalPath: path }, true, true)
                        if (result) successCount += 1
                        else failed.push(path)
                      } catch (err) {
                        failed.push(path)
                      }
                      if (i < selectedPaths.length - 1) await sleep(RATE_DELAY_MS)
                    }
                    safeSetLoadingEnrich(prev => { const n = { ...prev }; for (const p of selectedPaths) delete n[p]; return n })
                    
                    // Then hide
                    try {
                      successCount = 0
                      let skippedCount = 0
                      failed.length = 0
                      for (const path of selectedPaths) {
                        loadingMap[path] = true
                      }
                      safeSetLoadingEnrich(prev => ({ ...prev, ...loadingMap }))
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
                      safeSetLoadingEnrich(prev => { const n = { ...prev }; for (const p of selectedPaths) delete n[p]; return n })
                      setSelected(prev => {
                        if (!prev) return {}
                        const next = { ...prev }
                        for (const p of selectedPaths) delete next[p]
                        return next
                      })
                      if (failed.length && successCount) {
                        pushToast && pushToast('Hide', `Hidden ${successCount}/${selectedPaths.length} items (${failed.length} failed).`)
                      } else if (failed.length && !successCount) {
                        pushToast && pushToast('Hide', 'Hide failed for all selected items')
                      } else {
                        const skippedNote = skippedCount ? ` (${skippedCount} skipped)` : ''
                        pushToast && pushToast('Hide', `Hidden ${selectedPaths.length} items${skippedNote}.`)
                      }
                    } catch (err) {
                      safeSetLoadingEnrich(prev => { const n = { ...prev }; for (const p of selectedPaths) delete n[p]; return n })
                      pushToast && pushToast('Hide', 'Hide failed')
                    }
                  }}
                >
                  TV/Movie mode (rescan + hide)
                </button>
                <button
                  className="context-menu-item"
                  onClick={async (e) => {
                    e.stopPropagation()
                    setContextMenu(null)
                    const selectedPaths = contextMenu.selectedPaths
                    if (!selectedPaths.length) return

                    // Instantly hide all selected items from the UI before the rescan starts
                    setEnrichCache(prev => {
                      const n = { ...prev }
                      for (const p of selectedPaths) n[p] = Object.assign({}, n[p] || {}, { hidden: true })
                      return n
                    })
                    setItems(prev => prev.filter(it => !selectedPaths.includes(it.canonicalPath)))
                    setAllItems(prev => prev.filter(it => !selectedPaths.includes(it.canonicalPath)))
                    for (const p of selectedPaths) pendingHiddenRef.current.add(p)

                    // Then rescan in Anime mode (background — UI already updated)
                    pushToast && pushToast('Hide', `Rescanning ${selectedPaths.length} items (Anime mode)...`)
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
                        const result = await enrichOne({ canonicalPath: path }, true, false)
                        if (result) successCount += 1
                        else failed.push(path)
                      } catch (err) {
                        failed.push(path)
                      }
                      if (i < selectedPaths.length - 1) await sleep(RATE_DELAY_MS)
                    }
                    safeSetLoadingEnrich(prev => { const n = { ...prev }; for (const p of selectedPaths) delete n[p]; return n })
                    
                    // Then hide
                    try {
                      successCount = 0
                      let skippedCount = 0
                      failed.length = 0
                      for (const path of selectedPaths) {
                        loadingMap[path] = true
                      }
                      safeSetLoadingEnrich(prev => ({ ...prev, ...loadingMap }))
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
                      safeSetLoadingEnrich(prev => { const n = { ...prev }; for (const p of selectedPaths) delete n[p]; return n })
                      setSelected(prev => {
                        if (!prev) return {}
                        const next = { ...prev }
                        for (const p of selectedPaths) delete next[p]
                        return next
                      })
                      if (failed.length && successCount) {
                        pushToast && pushToast('Hide', `Hidden ${successCount}/${selectedPaths.length} items (${failed.length} failed).`)
                      } else if (failed.length && !successCount) {
                        pushToast && pushToast('Hide', 'Hide failed for all selected items')
                      } else {
                        const skippedNote = skippedCount ? ` (${skippedCount} skipped)` : ''
                        pushToast && pushToast('Hide', `Hidden ${selectedPaths.length} items${skippedNote}.`)
                      }
                    } catch (err) {
                      safeSetLoadingEnrich(prev => { const n = { ...prev }; for (const p of selectedPaths) delete n[p]; return n })
                      pushToast && pushToast('Hide', 'Hide failed')
                    }
                  }}
                >
                  Anime mode (rescan + hide)
                </button>
              </>
            )}
              </>
            )}
          </div>
        </div>
      )}
      {conflictResolutionState ? (
        <ConflictResolutionModal
          state={conflictResolutionState}
          onClose={() => setConflictResolutionState(null)}
          onConfirm={(resolvedItems) => {
            const { originalPayload } = conflictResolutionState;
            setConflictResolutionState(null);
            submitApproveJob(resolvedItems, {
              outputFolder: originalPayload.outputFolder,
              useFilenameAsTitle: originalPayload.useFilenameAsTitle,
              skipAnimeProviders: originalPayload.skipAnimeProviders
            }, true);
          }}
        />
      ) : null}
    </div>
  )
}

function ConflictResolutionModal({ state, onClose, onConfirm }) {
  const { conflicts, originalPayload } = state;
  const [resolutions, setResolutions] = useState({});

  const handleResolve = (originalPath, action) => {
    setResolutions(prev => ({ ...prev, [originalPath]: action }));
  };

  const handleConfirm = () => {
    const resolvedItems = originalPayload.selItems.filter(it => {
      const conflict = conflicts.find(c => c.original === it.canonicalPath);
      if (!conflict) return true; // no conflict
      const action = resolutions[it.canonicalPath] || 'skip';
      if (action === 'skip') return false;
      return true;
    }).map(it => {
      const conflict = conflicts.find(c => c.original === it.canonicalPath);
      if (!conflict) return it;
      const action = resolutions[it.canonicalPath] || 'skip';
      if (action === 'overwrite') return { ...it, overwrite: true };
      if (action === 'keep_both') {
        const ext = it.canonicalPath.slice(it.canonicalPath.lastIndexOf('.'));
        const newTitle = conflict.title + '_' + Math.random().toString(36).substring(2, 6);
        return { ...it, keepBothTarget: newTitle + ext };
      }
      return it;
    });
    onConfirm(resolvedItems);
  };

  return (
    <div className="modal-backdrop" onClick={onClose} style={{ zIndex: 9999 }}>
      <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: 800, width: '100%' }}>
        <h2>File Conflicts Detected</h2>
        <p style={{ color: 'var(--muted)', marginBottom: 16 }}>
          The following files already exist at the destination. Please select how to resolve these conflicts.
        </p>
        
        <div style={{ maxHeight: '60vh', overflowY: 'auto', marginBottom: 24, border: '1px solid var(--bg-600)', borderRadius: 8 }}>
          {conflicts.map(c => {
            const currentRes = resolutions[c.original] || 'skip';
            return (
              <div key={c.original} style={{ padding: 12, borderBottom: '1px solid var(--bg-600)', display: 'flex', alignItems: 'center', gap: 16 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 'bold', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>{c.title}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>{c.toPath}</div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <input type="radio" name={`res-${c.original}`} checked={currentRes === 'skip'} onChange={() => handleResolve(c.original, 'skip')} />
                    Skip
                  </label>
                  <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 4, color: '#e74c3c' }}>
                    <input type="radio" name={`res-${c.original}`} checked={currentRes === 'overwrite'} onChange={() => handleResolve(c.original, 'overwrite')} />
                    Overwrite
                  </label>
                  <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <input type="radio" name={`res-${c.original}`} checked={currentRes === 'keep_both'} onChange={() => handleResolve(c.original, 'keep_both')} />
                    Keep Both
                  </label>
                </div>
              </div>
            )
          })}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleConfirm}>Confirm & Approve</button>
        </div>
      </div>
    </div>
  );
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






const DEFAULT_ROW_HEIGHT = 90


