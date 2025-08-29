import React, { useEffect, useState } from 'react'
import axios from 'axios'
import { FixedSizeList as List } from 'react-window'
import ToastContainer from './components/Toast'
import Settings from './Settings'
import Login from './Login'
import Register from './Register'
import Users from './Users'

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
  const [theme, setTheme] = useLocalState('theme', 'dark')
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState({})
  const [enrichCache, setEnrichCache] = useLocalState('enrichCache', {})
  const [logs, setLogs] = useState('')
  const [toasts, setToasts] = useState([])
  const [loadingEnrich, setLoadingEnrich] = useState({})
  const [auth, setAuth] = useState(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [renameTemplate, setRenameTemplate] = useLocalState('rename_template', '{title} ({year}) - {epLabel} - {episodeTitle}')
  const [tvdbKey, setTvdbKey] = useLocalState('tvdb_api_key', '')
  // support modern TMDb key while staying backward-compatible with legacy tvdb_api_key
  const [tmdbKey, setTmdbKey] = useLocalState('tmdb_api_key', '')
  const providerKey = (tmdbKey && String(tmdbKey).length) ? tmdbKey : (tvdbKey || '')
  const scanOptionsRef = React.useRef({})
  const batchSize = 12

  function pushToast(title, message){
    const id = Math.random().toString(36).slice(2,9)
    setToasts(t => [...t, { id, title, message }])
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

    // fetch scan metadata and first page of items
    const meta = await axios.get(API(`/scan/${r.data.scanId}`))
    setScanMeta(meta.data)
    setTotal(meta.data.totalCount)
    const page = await axios.get(API(`/scan/${r.data.scanId}/items?offset=0&limit=${batchSize}`))
    // Filter out items that are marked hidden/applied in server cache
    const filtered = page.data.items.filter(it => {
      const e = enrichCache[it.canonicalPath]
      return !(e && (e.hidden === true || e.applied === true))
    })
    setItems(filtered)

    // handle optional forceEnrich option and persist options for lazy-load pages
    const forceEnrich = options.forceEnrich === true
    scanOptionsRef.current = options || {}
    for (const it of page.data.items) {
      if (forceEnrich) {
        enrichOne && enrichOne(it, true)
      } else {
        if (!enrichCache[it.canonicalPath]) enrichOne && enrichOne(it)
      }
    }

  // Determine whether to ask server to refresh authoritative metadata (TMDb only):
  const shouldRefresh = Boolean(providerKey)
    if (shouldRefresh) {
      pushToast && pushToast('Scan', 'Preferred provider configured — refreshing metadata from provider')
      try {
        await refreshScan(r.data.scanId)
        pushToast && pushToast('Scan', 'Provider metadata refresh complete')
      } catch (e) {
        pushToast && pushToast('Scan', 'Provider refresh failed')
      }
    }

    // return created scan id for callers that want to act on it
    return r.data.scanId
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
      if (force) setLoadingEnrich(l => ({ ...l, [key]: true }))

      // If not forcing and we already have a cache entry, return it
      if (!force && enrichCache && enrichCache[key]) return enrichCache[key]

      // First try to GET cached enrichment from server
      try {
        const r = await axios.get(API('/enrich'), { params: { path: key } })
        if (r.data && r.data.cached && !force) {
          setEnrichCache(prev => ({ ...prev, [key]: r.data.enrichment }))
          return r.data.enrichment
        }
      } catch (e) {
        // ignore and continue to POST
      }

      // POST to /enrich to generate/update enrichment (force bypasses cache check)
  const w = await axios.post(API('/enrich'), { path: key, tmdb_api_key: providerKey || undefined })
      if (w.data && w.data.enrichment) setEnrichCache(prev => ({ ...prev, [key]: w.data.enrichment }))

      // if the applied operation marked this item hidden, remove it from visible items
      try {
        if (w.data && w.data.enrichment && w.data.enrichment.hidden) {
          setItems(prev => prev.filter(it => it.canonicalPath !== key))
        }
      } catch (e) {}

      // choose a friendly name for toast
      const nameForToast = (w.data && w.data.enrichment && (w.data.enrichment.extraGuess && w.data.enrichment.extraGuess.title)) || (w.data && w.data.enrichment && w.data.enrichment.title) || (key && key.split('/')?.pop()) || key
      pushToast && pushToast('Enrich', `Updated metadata for ${nameForToast}`)
      return w.data.enrichment
    } catch (err) {
      setEnrichCache(prev => ({ ...prev, [key]: { error: err?.message || String(err) } }))
      return null
    } finally {
      if (force) setLoadingEnrich(l => { const n = { ...l }; delete n[key]; return n })
    }
  }

  const handleScrollNearEnd = async () => {
    if (!scanId) return
    const nextOffset = items.length
    if (nextOffset >= total) return
    const r = await axios.get(API(`/scan/${scanId}/items?offset=${nextOffset}&limit=${batchSize}`))
    setItems(prev => [...prev, ...r.data.items])
    const forceEnrich = scanOptionsRef.current && scanOptionsRef.current.forceEnrich === true
    for (const it of r.data.items) {
      if (forceEnrich) enrichOne && enrichOne(it, true)
      else if (!enrichCache[it.canonicalPath]) enrichOne && enrichOne(it)
    }
  }

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
          const enriched = er.data.enrichment
          setEnrichCache(prev => ({ ...prev, [p]: enriched }))
          // if the item is now hidden/applied remove it from visible items
          if (enriched && enriched.hidden) {
            setItems(prev => prev.filter(it => it.canonicalPath !== p))
          } else {
            // item is unhidden (unapproved) -> ensure it's visible in the list
            setItems(prev => {
              try {
                // if already present, leave as-is
                if (prev.find(x => x.canonicalPath === p)) return prev
                // otherwise, prepend to the list for visibility
                return [{ id: p, canonicalPath: p }, ...prev]
              } catch (e) { return prev }
            })
          }
        }
      } catch (e) {}
    }
  }

  async function applyRename(plans, dryRun = false) {
    // send plans to server; server will consult its configured scan_output_path to decide hardlink behavior
    const r = await axios.post(API('/rename/apply'), { plans, dryRun })
    // After apply, refresh enrichment for each plan.fromPath so the UI reflects applied/hidden state immediately
    try {
      const paths = (plans || []).map(p => p.fromPath).filter(Boolean)
      await refreshEnrichForPaths(paths)
    } catch (e) {}
    return r.data.results
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
             if (er.data && er.data.cached) setEnrichCache(prev => ({ ...prev, [res.path]: er.data.enrichment }))
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
    <div className="app">
      <header>
        <h1 style={{cursor:'pointer'}} onClick={() => (window.location.hash = '#/')} title="Go to dashboard">MMP Renamer</h1>
        {auth ? (
            <div className="header-actions">
            <button className={"btn-save" + (selectMode ? ' shifted' : '')} onClick={() => triggerScan(libraries[0])}><span>Scan</span></button>
            {/* Select + Approve wrapper: Approve is absolutely positioned so it doesn't reserve space when hidden */}
            <div className="select-approve-wrap" style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
              <button
                className={"btn-save approve-button" + (selectMode ? (Object.keys(selected).length ? ' visible' : ' disabled visible') : '')}
                aria-hidden={!selectMode}
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
              <button className={"btn-ghost" + (selectMode ? ' active' : '')} onClick={() => { setSelectMode(s => { if (s) setSelected({}); return !s }) }} title={selectMode ? 'Exit select mode' : 'Select items'} style={{display:'flex',alignItems:'center',gap:8}}>Select</button>
            </div>
            <button className={"btn-ghost" + (!(lastLibraryId || (scanMeta && scanMeta.libraryId)) ? ' disabled' : '')} onClick={rescan} title={!(lastLibraryId || (scanMeta && scanMeta.libraryId)) ? 'No previous scan' : 'Rescan last library'} style={{display:'flex',alignItems:'center',gap:8}} disabled={!(lastLibraryId || (scanMeta && scanMeta.libraryId))}><IconRefresh/> <span>Rescan</span></button>
            <button className={"btn-ghost" + (!(lastLibraryId || (scanMeta && scanMeta.libraryId)) ? ' disabled' : '')} onClick={async () => { if (!(lastLibraryId || (scanMeta && scanMeta.libraryId))) return; pushToast && pushToast('Refresh','Server-side refresh started'); try { await refreshScan(scanMeta ? scanMeta.id : lastLibraryId); pushToast && pushToast('Refresh','Server-side refresh complete'); } catch (e) { pushToast && pushToast('Refresh','Refresh failed') } }} title="Refresh metadata server-side" style={{display:'flex',alignItems:'center',gap:8}} disabled={!(lastLibraryId || (scanMeta && scanMeta.libraryId))}><IconRefresh/> <span>Refresh metadata</span></button>
            <button className="btn-ghost" onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}>Theme: {theme === 'dark' ? 'Dark' : 'Light'}</button>
            <button className="btn-ghost" onClick={() => (window.location.hash = route === '#/settings' ? '#/' : '#/settings')}>Settings</button>
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
          ) : (
          <>
            <section className="list">
              {scanMeta ? (
                <div>Found {total} items. Showing {items.length} loaded items.</div>
              ) : (<div>No scan yet</div>)}

              <VirtualizedList items={items} enrichCache={enrichCache} onNearEnd={handleScrollNearEnd} enrichOne={enrichOne}
                previewRename={previewRename} applyRename={applyRename} pushToast={pushToast} loadingEnrich={loadingEnrich}
                selectMode={selectMode} selected={selected} toggleSelect={(p, val) => setSelected(s => { const n = { ...s }; if (val) n[p]=true; else delete n[p]; return n })}
                providerKey={providerKey} />
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
      <div style={{display:'flex',gap:8,marginTop:8, alignItems:'center'}}>
        <button className="btn-ghost icon-only" onClick={refresh} title="Refresh logs"><IconRefresh/></button>
        <button className="btn-ghost icon-only" onClick={() => { navigator.clipboard?.writeText(logs); pushToast && pushToast('Logs', 'Copied to clipboard') }} title="Copy logs"><IconCopy/></button>
      </div>
    </div>
  )
}

function VirtualizedList({ items = [], enrichCache = {}, onNearEnd, enrichOne, previewRename, applyRename, pushToast, loadingEnrich = {}, selectMode = false, selected = {}, toggleSelect = () => {}, providerKey = '' }) {
  function RowComponent({ index, style, items, enrichCache, enrichOne, loadingEnrich, selectMode, selected, toggleSelect, previewRename, applyRename, pushToast, providerKey }) {
  const it = items[index]
  const enrichment = it ? enrichCache?.[it.canonicalPath] : null
  React.useEffect(() => { if (it && !enrichment) enrichOne && enrichOne(it) }, [it?.canonicalPath, enrichment, enrichOne])
  const loading = it && Boolean(loadingEnrich[it.canonicalPath])
    // Build displayName from structured enrichment fields (prefer API data over raw parsedName)
  const baseSeriesTitle = (enrichment && (enrichment.title || (enrichment.tvdb && enrichment.tvdb.matched && enrichment.tvdb.name))) || enrichment?.extraGuess?.title || null
  const seriesTitle = baseSeriesTitle ? (baseSeriesTitle + (enrichment && enrichment.year ? ` (${enrichment.year})` : '')) : null
  const epRange = enrichment?.episodeRange
    const season = enrichment?.season
    const episode = enrichment?.episode
    const episodeTitle = enrichment?.episodeTitle || enrichment?.extraGuess?.episodeTitle || ''

    let displayName = seriesTitle || ''
    function pad(n){ return String(n).padStart(2,'0') }
    if (epRange) {
      const epLabel = season != null ? `S${pad(season)}E${epRange}` : `E${epRange}`
      displayName = (displayName ? displayName + ' - ' + epLabel : epLabel)
    } else if (episode != null) {
      const epVal = String(episode)
      const epLabelPart = /^\d+(?:\.\d+)?$/.test(epVal) ? (epVal.indexOf('.') === -1 ? pad(epVal) : (() => { const p = epVal.split('.'); return pad(p[0]) + '.' + p[1] })()) : epVal
      const epLabel = season != null ? `S${pad(season)}E${epLabelPart}` : `E${epLabelPart}`
      displayName = (displayName ? displayName + ' - ' + epLabel : epLabel)
    }
    if (episodeTitle) displayName += (displayName ? ' - ' : '') + episodeTitle
    if (!displayName) {
  // if user provided a provider API key, do not show the local parsedName as the primary display
  if (providerKey) {
        displayName = (it && it.canonicalPath ? it.canonicalPath.split('/').pop() : '')
      } else {
        displayName = enrichment?.parsedName || (it && it.canonicalPath ? it.canonicalPath.split('/').pop() : '')
      }
    }
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
            {displayName}
            { (season != null || episode != null) ? (
              <div style={{fontSize:12, opacity:0.8, marginTop:4}}>
                { (season != null && episode != null) ? (() => { const ep = String(episode); const epPart = ep.indexOf('.') === -1 ? String(ep).padStart(2,'0') : (String(ep).split('.')[0].padStart(2,'0') + '.' + String(ep).split('.')[1]); return `S${String(season).padStart(2,'0')}E${epPart}` })() : (episode != null ? (() => { const ep = String(episode); return ep.indexOf('.')===-1 ? `E${String(ep).padStart(2,'0')}` : `E${String(ep).split('.')[0].padStart(2,'0')}.${String(ep).split('.')[1]}` })() : '') }
              </div>
            ) : null }
            {/* small source indicator for episodeTitle: TMDb vs parsed */}
            { (episodeTitle) ? (() => {
                const epSource = (enrichment && enrichment.tvdb && (enrichment.tvdb.episode || enrichment.tvdb.matched)) ? 'TMDb' : 'parsed'
                return (<div style={{fontSize:11, opacity:0.65, marginTop:3}}>Source: {epSource}</div>)
              })() : null }
          </div>
        </div>
  <div className="actions">
            <button title="Apply rename for this item" className="btn-save icon-btn" disabled={loading} onClick={async () => {
              if (!it) return
              // Do not pass a hardcoded template here so the user's configured template is used
              const plans = await previewRename([it])
              pushToast && pushToast('Preview ready', 'Rename plan generated — applying now')
              const res = await applyRename(plans)
              pushToast && pushToast('Apply result', JSON.stringify(res))
            }}><IconApply/> <span>Apply</span></button>
          <button title="Rescan metadata for this item" className="btn-ghost" disabled={loading} onClick={async () => { if (!it) return; pushToast && pushToast('Rescan','Refreshing metadata...'); await enrichOne(it, true) }}>{loading ? <Spinner/> : <><IconRefresh/> <span>Rescan</span></>} </button>
        </div>
      </div>
    )
  }
  const Row = React.memo(RowComponent);

  function onItemsRendered(info) {
    const visibleStopIndex = info.visibleStopIndex ?? info.visibleRange?.[1]
    if (typeof visibleStopIndex === 'number' && visibleStopIndex >= items.length - 3) onNearEnd && onNearEnd()
  }
  return (
    <List height={600} itemCount={items.length} itemSize={80} width={'100%'} onItemsRendered={onItemsRendered}>
      {props => <Row {...props} items={items} enrichCache={enrichCache} enrichOne={enrichOne} loadingEnrich={loadingEnrich} selectMode={selectMode} selected={selected} toggleSelect={toggleSelect} previewRename={previewRename} applyRename={applyRename} pushToast={pushToast} providerKey={providerKey} />}
    </List>
  )
}
