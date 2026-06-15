import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { VariableSizeList as List } from 'react-window';
import normalizeEnrichResponse from '../normalizeEnrichResponse';
import CustomMetadataInputs from './CustomMetadataInputs';
import ManualIdInputs, { manualIdDebugLog } from './ManualIdInputs';
import { IconRefresh, IconCopy, IconApply } from './Icons';
import { Spinner, LoadingIndicator } from './LoadingComponents';
import { API, PROVIDER_LABELS } from '../constants';

const DEFAULT_ROW_HEIGHT = 90;

export default function VirtualizedList({ items = [], enrichCache = {}, setEnrichCache, onNearEnd, enrichOne, previewRename, applyRename, pushToast, loadingEnrich = {}, selectMode = false, selected = {}, toggleSelect = () => {}, providerKey = '', hideOne = null, optimisticHide = null, searchQuery = '', setSearchQuery = () => {}, doSearch = () => {}, searching = false, selectOutputFolder = null, setContextMenu = () => {}, safeSetLoadingEnrich, refreshEnrichForPaths }) {
  const listRef = useRef(null)
  const containerRef = useRef(null)
  const [listHeight, setListHeight] = useState(700)
  const lastClickedIndex = useRef(null)
  const selectionUtilsRef = useRef(null)
  const rowHeights = useRef({})
  const [manualIdOpen, setManualIdOpen] = useState({})
  const [manualIdsTick, setManualIdsTick] = useState(0)
  const [customMetaOpen, setCustomMetaOpen] = useState({})
  const [customMetaTick, setCustomMetaTick] = useState(0)

  useEffect(() => {
    // dynamically import selection utils (CommonJS module) and cache
    import('../selection-utils').then(m => {
      // interop: module may export via module.exports (default) or named
      const sel = m && (m.selectRange || (m.default && m.default.selectRange) || (m.default || m))
      selectionUtilsRef.current = sel
    }).catch(() => { selectionUtilsRef.current = null })
  }, [])
  

  // Measure container height dynamically
  useEffect(() => {
    if (!containerRef.current) return
    const updateHeight = () => {
      if (containerRef.current) {
        const height = containerRef.current.clientHeight
        if (height > 0) setListHeight(height)
      }
    }
    updateHeight()
    const resizeObserver = new ResizeObserver(updateHeight)
    resizeObserver.observe(containerRef.current)
    return () => resizeObserver.disconnect()
  }, [])
  
  const getItemSize = (index) => {
    return rowHeights.current[index] || DEFAULT_ROW_HEIGHT
  }

  const getItemKey = (index) => {
    const item = items[index]
    return item && item.canonicalPath ? item.canonicalPath : `row-${index}`
  }

  const setItemSize = (index, size) => {
    const nextSize = Math.max(DEFAULT_ROW_HEIGHT, size || 0)
    if (rowHeights.current[index] !== nextSize) {
      rowHeights.current[index] = nextSize
      if (listRef.current) {
        listRef.current.resetAfterIndex(index)
      }
    }
  }
  
  const Row = ({ index, style }) => {
  const it = items[index]
  const rawEnrichment = it ? enrichCache?.[it.canonicalPath] : null
  const enrichment = normalizeEnrichResponse(rawEnrichment)
  const rowRef = useRef(null)
  
  // Declare loading and isSelected before using in useEffect dependencies
  const loadingState = it && loadingEnrich[it.canonicalPath]
  const loading = Boolean(loadingState)
  const isSelected = !!(selectMode && it && selected?.[it.canonicalPath])
  
  useEffect(() => {
    if (rowRef.current) {
      const el = rowRef.current
      const measured = Math.ceil(el.scrollHeight || el.getBoundingClientRect().height || DEFAULT_ROW_HEIGHT)
      setItemSize(index, measured)
    }
  }, [index, it, enrichment, isSelected, loading, manualIdsTick, customMetaTick])
  
  useEffect(() => { if (it && !rawEnrichment) enrichOne && enrichOne(it, false, false, true) }, [it?.canonicalPath, rawEnrichment, enrichOne])

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
  const parsedTitle = parsed?.title || null
  const providerTitleRaw = provider?.title || null
  const providerEpisodeTitle = provider?.episodeTitle || ''

  // Prefer parsed title when it carries a Part N marker that provider title lacks
  const parsedHasPart = parsedTitle && /\bPart\s+\d{1,2}\b/i.test(parsedTitle)
  const providerHasPart = providerTitleRaw && /\bPart\s+\d{1,2}\b/i.test(providerTitleRaw)
  const providerTitle = (parsedHasPart && !providerHasPart) ? parsedTitle : providerTitleRaw

  // Avoid double year when provider title already embeds a year
  const providerYearValue = provider?.year
  const providerHasYearInTitle = !!(providerTitle && providerYearValue && new RegExp(`\\b${providerYearValue}\\b`).test(providerTitle))
  const providerYear = (providerYearValue && !providerHasYearInTitle) ? ` (${providerYearValue})` : ''

  // Construct rendered name with proper format: Title (Year) - S01E08 - Episode Title
  // Year must come BEFORE episode label for TV shows
  const providerRendered = provider?.renderedName || (providerTitle ? `${providerTitle}${providerYear}${epLabel ? ' - ' + epLabel : ''}${providerEpisodeTitle ? ' - ' + providerEpisodeTitle : ''}` : null)
  const providerSourceLabel = provider?.source || (provider?.provider ? (PROVIDER_LABELS[String(provider.provider).toLowerCase()] || provider.provider) : 'provider')
  const manualIdTitle = parsedTitle || providerTitle || (it?.canonicalPath ? it.canonicalPath.split('/').pop() : '')
  const manualIdAliasTitles = [providerTitle, parsedTitle, parsed?.parsedName]
    .map(v => (v ? String(v).trim() : ''))
    .filter(Boolean)
    .filter((v, idx, arr) => arr.indexOf(v) === idx)
  const isManualOpen = !!(it && manualIdOpen[it.canonicalPath])
  const toggleManualOpen = (next) => {
    if (!it || !it.canonicalPath) return
    setManualIdOpen(prev => {
      const nextState = typeof next === 'boolean' ? next : !prev[it.canonicalPath]
      return { ...prev, [it.canonicalPath]: nextState }
    })
    setManualIdsTick(t => t + 1)
  }
  const isCustomOpen = !!(it && customMetaOpen[it.canonicalPath])
  const toggleCustomOpen = (next) => {
    if (!it || !it.canonicalPath) return
    setCustomMetaOpen(prev => ({ ...prev, [it.canonicalPath]: typeof next === 'boolean' ? next : !prev[it.canonicalPath] }))
    setCustomMetaTick(t => t + 1)
  }
  const providerIdCandidates = []
  try { if (provider?.sources?.series?.id) providerIdCandidates.push(String(provider.sources.series.id).toLowerCase()) } catch (e) {}
  try { if (provider?.sources?.episode?.id) providerIdCandidates.push(String(provider.sources.episode.id).toLowerCase()) } catch (e) {}
  try { if (provider?.provider) providerIdCandidates.push(String(provider.provider).toLowerCase()) } catch (e) {}
  const isAniDbProvider = providerIdCandidates.includes('anidb')

  const basename = (it && it.canonicalPath ? it.canonicalPath.split('/').pop() : '')
  const primary = providerRendered || parsedName || basename || ''
  const handleRowClick = (ev) => {
    if (!selectMode || !it) return
    // ignore clicks originating from action buttons or the checkbox container
    const interactive = ev.target.closest('.actions') || ev.target.closest('button') || ev.target.closest('a') || ev.target.closest('input')
    if (interactive) return

    // Handle shift-click for range selection
    if (ev.shiftKey && lastClickedIndex.current !== null && lastClickedIndex.current !== index) {
      ev.preventDefault()
      const start = Math.min(lastClickedIndex.current, index)
      const end = Math.max(lastClickedIndex.current, index)
      // Select all items in range via helper when available
      const selFn = selectionUtilsRef.current
      if (selFn && typeof selFn === 'function') {
        const paths = selFn(items, start, end)
        for (const p of paths || []) toggleSelect(p, true)
      } else {
        for (let i = start; i <= end; i++) {
          const item = items[i]
          if (item && item.canonicalPath) toggleSelect(item.canonicalPath, true)
        }
      }
      // Update last clicked index for future shift-clicks
      lastClickedIndex.current = index
    } else {
      // Normal click - always toggle selection, even if already selected and lastClickedIndex matches
      toggleSelect(it.canonicalPath, !isSelected)
      // Update last clicked index for future shift-clicks
      lastClickedIndex.current = index
    }
  }

    return (
      <div
        ref={rowRef}
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
            lastClickedIndex.current = index
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
          <div className="path" style={{marginTop:3, display: 'flex', alignItems: 'center', gap: '8px'}}>
            <span style={{flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis'}}>{it?.canonicalPath}</span>
            <button
              onClick={(e) => {
                e.stopPropagation()
                try {
                  navigator.clipboard.writeText(it?.canonicalPath || '')
                  pushToast && pushToast('Copied', 'Path copied to clipboard')
                } catch (err) {
                  pushToast && pushToast('Copy Failed', 'Could not copy to clipboard')
                }
              }}
              title="Copy path to clipboard"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--muted)',
                cursor: 'pointer',
                padding: '2px 6px',
                borderRadius: '4px',
                fontSize: '11px',
                opacity: 0.6,
                transition: 'opacity 120ms ease'
              }}
              onMouseEnter={(e) => e.target.style.opacity = '1'}
              onMouseLeave={(e) => e.target.style.opacity = '0.6'}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="9" y="9" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="2"/>
                <rect x="4" y="4" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="2"/>
              </svg>
            </button>
          </div>
           <div className="title">
            {primary}
            { (useSeason != null || useEpisode != null) ? (
              <div style={{fontSize:12, opacity:0.8, marginTop:4}}>
                { (useSeason != null && useEpisode != null) ? `S${String(useSeason).padStart(2,'0')}E${String(useEpisode).padStart(2,'0')}` : (useEpisode != null ? `E${String(useEpisode).padStart(2,'0')}` : '') }
              </div>
            ) : null }
            {/* show source of primary info: provider vs parsed */}
            <div style={{fontSize:11, opacity:0.65, marginTop:3}}>
              Source: {provider ? (
                <>
                  <span>
                    {providerSourceLabel}
                  </span>
                  {isAniDbProvider && 
                   <span style={{marginLeft:4, opacity:0.8}}>(ED2K hash)</span>}
                </>
              ) : (parsed ? 'parsed' : 'unknown')}
            </div>
            <CustomMetadataInputs
              path={it?.canonicalPath}
              enrichment={enrichment}
              isOpen={isCustomOpen}
              onToggle={toggleCustomOpen}
              onSaved={async (enrichment) => {
                try {
                  if (enrichment) {
                    const norm = normalizeEnrichResponse(enrichment)
                    if (norm) setEnrichCache(prev => ({ ...prev, [it.canonicalPath]: norm }))
                  } else {
                    const r = await axios.get(API('/enrich'), { params: { path: it?.canonicalPath } }).catch(() => null)
                    const norm = normalizeEnrichResponse((r && r.data && r.data.enrichment) ? r.data.enrichment : (r && r.data ? r.data : null))
                    if (norm) setEnrichCache(prev => ({ ...prev, [it.canonicalPath]: norm }))
                  }
                } catch (e) {}
                setCustomMetaTick(t => t + 1)
              }}
              pushToast={pushToast}
            />
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
                if (safeSetLoadingEnrich) safeSetLoadingEnrich(prev => ({ ...prev, [it.canonicalPath]: true }))
                let selectedFolderPath = null
                let useFilenameAsTitle = false
                if (selectOutputFolder) {
                  const selection = await selectOutputFolder([it.canonicalPath])
                  if (!selection || selection.cancelled) {
                    if (safeSetLoadingEnrich) safeSetLoadingEnrich(prev => { const n = { ...prev }; delete n[it.canonicalPath]; return n })
                    return
                  }
                  selectedFolderPath = selection.path ?? null
                  useFilenameAsTitle = selection.applyAsFilename ?? false
                }

                const plans = await previewRename([it], undefined, { useFilenameAsTitle })

                // Optimistically hide before network call for instant feedback
                optimisticHide && optimisticHide(it.canonicalPath)

                const res = await applyRename(plans, false, selectedFolderPath)
                let applySucceeded = false
                try {
                  const first = (Array.isArray(res) && res.length) ? res[0] : null
                  const status = first && (first.status || first.result || '')
                  if (status === 'hardlinked' || status === 'copied' || status === 'moved' || status === 'exists' || status === 'dryrun' || status === 'noop') {
                    const kind = (status === 'copied') ? 'Copied (fallback)' : (status === 'hardlinked' ? 'Hardlinked' : (status === 'moved' ? 'Moved' : (status === 'exists' ? 'Exists' : (status === 'dryrun' ? 'Dry run' : 'No-op'))))
                    pushToast && pushToast('Apply', `${kind}: ${first.to || first.path || ''}`)
                    successShown = true
                    applySucceeded = true
                  } else if (first && first.status === 'error') {
                    pushToast && pushToast('Apply', `Failed: ${first.error || 'unknown error'}`)
                  } else {
                    pushToast && pushToast('Apply result', JSON.stringify(res))
                    successShown = true
                    applySucceeded = true
                  }
                } catch (e) {
                  pushToast && pushToast('Apply result', JSON.stringify(res))
                }
                // Only refresh enrich on failure — on success applyRename already removed
                // the item optimistically; refreshing would race the server and add it back.
                if (!applySucceeded && refreshEnrichForPaths) refreshEnrichForPaths([it.canonicalPath]).catch(() => {})
              } catch (e) {
                try { if (!successShown) pushToast && pushToast('Apply', `Apply failed: ${e && e.message ? e.message : String(e)}`) } catch (err) { /* swallow */ }
              } finally {
                if (safeSetLoadingEnrich) safeSetLoadingEnrich(prev => { const n = { ...prev }; delete n[it.canonicalPath]; return n })
              }
            }}
            onContextMenu={(ev) => {
              ev.preventDefault()
              ev.stopPropagation?.()
              if (loading) return
              setContextMenu({
                x: ev.clientX,
                y: ev.clientY,
                type: 'approve',
                selectedPaths: [it.canonicalPath],
                item: it
              })
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
            onContextMenu={(ev) => {
              ev.preventDefault()
              ev.stopPropagation?.()
              if (loading) return
              setContextMenu({
                x: ev.clientX,
                y: ev.clientY,
                type: 'single',
                item: it
              })
            }}
            style={{ minWidth: loading ? '200px' : 'auto' }}
          >
            {loading ? (
              <LoadingIndicator 
                status={typeof loadingState === 'object' ? loadingState.status : undefined}
                stage={typeof loadingState === 'object' ? loadingState.stage : undefined}
              />
            ) : (
              <><IconRefresh/> <span>Rescan</span></>
            )}
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
          <ManualIdInputs
            title={manualIdTitle}
            aliasTitles={manualIdAliasTitles}
            filePath={it?.canonicalPath}
            isOpen={isManualOpen}
            onToggle={toggleManualOpen}
            inActions={true}
            onSaved={async (savedValues) => {
              setManualIdsTick(t => t + 1)
              if (it && enrichOne) {
                try {
                  // Only skip anime providers (and thus ED2K hash computation) when
                  // neither an AniDB episode ID nor an AniList ID was saved.
                  // AniDB needs the hash; AniList doesn't but it's safe to let it run.
                  // TMDB/TVDB-only saves don't need the hash at all.
                  const hasAniDBId = !!(savedValues && savedValues.anidbEpisode)
                  const hasAniListId = !!(savedValues && savedValues.anilist)
                  const skipAnime = !hasAniDBId && !hasAniListId
                  await enrichOne(it, true, skipAnime)
                } catch (e) {
                  console.error('[ManualIdInputs] Force rescan after save failed:', e)
                }
              }
            }}
            pushToast={pushToast}
          />
        </div>
      </div>
    )
  }

  function onItemsRendered(info) {
    const visibleStopIndex = info.visibleStopIndex ?? info.visibleRange?.[1]
    if (typeof visibleStopIndex === 'number' && visibleStopIndex >= items.length - 3) onNearEnd && onNearEnd()
  }

  return (
    <div ref={containerRef} style={{ flex: 1, minHeight: 0 }}>
      <List ref={listRef} height={listHeight} itemCount={items.length} itemSize={getItemSize} itemKey={getItemKey} width={'100%'} onItemsRendered={onItemsRendered}>
      {Row}
    </List>
    </div>
  )
}
