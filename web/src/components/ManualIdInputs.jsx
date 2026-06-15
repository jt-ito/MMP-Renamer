import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { API } from '../constants';

const manualIdDraftCache = new Map()
const manualIdTouchedKeys = new Set()
const manualIdClientLogs = []
let manualIdLogSubscriber = null

export function pushManualIdClientLog(event, payload = {}) {
  try {
    const ts = new Date().toISOString()
    let data = ''
    try {
      data = JSON.stringify(payload)
    } catch (e) {
      data = String(payload || '')
    }
    const line = `${ts} [MANUAL_ID_DEBUG] ${event}${data ? ` ${data}` : ''}`
    manualIdClientLogs.unshift(line)
    if (manualIdClientLogs.length > 500) manualIdClientLogs.length = 500
    if (typeof manualIdLogSubscriber === 'function') manualIdLogSubscriber(line)
  } catch (e) {}
}

export function mergeManualIdDebugLogs(serverLogs = '') {
  try {
    const base = String(serverLogs || '')
    if (!manualIdClientLogs.length) return base
    const local = manualIdClientLogs.join('\n')
    return local + (base ? `\n${base}` : '')
  } catch (e) {
    return String(serverLogs || '')
  }
}

export function manualIdDebugLog(_event, _payload = {}) {
  // debug logging disabled — was spamming logs for every mounted ManualIdInputs instance
}

export default function ManualIdInputs({ title, aliasTitles = [], filePath, isOpen, onToggle, onSaved, pushToast, inActions = false }) {
  const EMPTY_MANUAL_VALUES = { anilist: '', tmdb: '', tmdbType: '', tvdb: '', tvdbType: '', anidbEpisode: '' }
  const [values, setValues] = useState(EMPTY_MANUAL_VALUES)
  const [initialValues, setInitialValues] = useState(EMPTY_MANUAL_VALUES)
  const [loading, setLoading] = useState(false)
  const valuesRef = useRef(EMPTY_MANUAL_VALUES)
  const initialValuesRef = useRef(EMPTY_MANUAL_VALUES)
  const loadedForRef = useRef(null)
  const hasUnsavedChangesRef = useRef(false)
  const userEditingRef = useRef(false)
  const manualIdsCache = useRef(null)
  const hasLocalTypedValuesRef = useRef(false)

  const normalizeKey = (value) => {
    try { return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ') } catch (e) { return String(value || '').trim().toLowerCase() }
  }

  const normalizeManualValue = (value) => {
    try { return String(value || '').trim() } catch (e) { return String(value || '') }
  }

  const normalizePathKey = (value) => {
    try {
      let out = String(value || '').trim()
      try { out = decodeURIComponent(out) } catch (e) {}
      return out.replace(/\\+/g, '/').replace(/\/+/g, '/')
    } catch(e) { return String(value || '') }
  }

  const normalizedTitle = normalizeKey(title)
  const aliasTitleKey = Array.isArray(aliasTitles)
    ? aliasTitles.map((value) => normalizeKey(value)).filter(Boolean).join('|')
    : ''
  const normalizedFilePath = normalizePathKey(filePath)
  const loadTargetKey = normalizedFilePath ? `path:${normalizedFilePath}` : null

  useEffect(() => {
    if (!isOpen || !loadTargetKey) return
    const isDirty = (
      normalizeManualValue(values.anilist) !== normalizeManualValue(initialValues.anilist)
      || normalizeManualValue(values.tmdb) !== normalizeManualValue(initialValues.tmdb)
      || normalizeManualValue(values.tvdb) !== normalizeManualValue(initialValues.tvdb)
      || normalizeManualValue(values.anidbEpisode) !== normalizeManualValue(initialValues.anidbEpisode)
    )
    manualIdDraftCache.set(loadTargetKey, {
      values: { ...values },
      initialValues: { ...initialValues },
      isDirty
    })
    manualIdDebugLog('draft:sync', { key: loadTargetKey, isDirty, values })
  }, [isOpen, loadTargetKey, values, initialValues])

  // Track unsaved changes
  hasUnsavedChangesRef.current = (
    normalizeManualValue(values.anilist) !== normalizeManualValue(initialValues.anilist)
    || normalizeManualValue(values.tmdb) !== normalizeManualValue(initialValues.tmdb)
    || (values.tmdbType || '') !== (initialValues.tmdbType || '')
    || normalizeManualValue(values.tvdb) !== normalizeManualValue(initialValues.tvdb)
    || (values.tvdbType || '') !== (initialValues.tvdbType || '')
    || normalizeManualValue(values.anidbEpisode) !== normalizeManualValue(initialValues.anidbEpisode)
  )
  hasLocalTypedValuesRef.current = (
    normalizeManualValue(values.anilist) !== ''
    || normalizeManualValue(values.tmdb) !== ''
    || normalizeManualValue(values.tvdb) !== ''
    || normalizeManualValue(values.anidbEpisode) !== ''
  )
  valuesRef.current = values
  initialValuesRef.current = initialValues

  useEffect(() => {
    let active = true
    manualIdDebugLog('effect:start', { key: loadTargetKey, isOpen, filePath, title })
    if (!isOpen || !loadTargetKey) {
      // Reset transient refs when panel closes, but preserve draft/touched state
      // so transient close/remount events cannot wipe in-progress typing.
      if (!isOpen) {
        loadedForRef.current = null
        userEditingRef.current = false
        manualIdDebugLog('effect:closed', { key: loadTargetKey })
      }
      return undefined
    }
    
    // Create a stable key for current target. When filePath exists, ignore title churn.
    const cacheKey = loadTargetKey
    const hasLocalTypedValues = hasLocalTypedValuesRef.current

    if (manualIdTouchedKeys.has(cacheKey)) {
      userEditingRef.current = true
      loadedForRef.current = cacheKey
      manualIdDebugLog('hydrate:skip-touched', { key: cacheKey })
      return undefined
    }

    // If we have a dirty draft for this key, always use it and never reload over it.
    const dirtyDraft = manualIdDraftCache.get(cacheKey)
    if (dirtyDraft && dirtyDraft.values && dirtyDraft.isDirty) {
      userEditingRef.current = true
      setValues(dirtyDraft.values)
      setInitialValues(dirtyDraft.initialValues || EMPTY_MANUAL_VALUES)
      loadedForRef.current = cacheKey
      manualIdDebugLog('hydrate:dirty-draft', { key: cacheKey, values: dirtyDraft.values })
      return undefined
    }

    const draft = manualIdDraftCache.get(cacheKey)
    if (draft && draft.values) {
      userEditingRef.current = !!draft.isDirty
      setValues(draft.values)
      setInitialValues(draft.initialValues || EMPTY_MANUAL_VALUES)
      loadedForRef.current = cacheKey
      manualIdDebugLog('hydrate:draft', { key: cacheKey, isDirty: !!draft.isDirty, values: draft.values })
      return undefined
    }
    
    // Skip reload if we already loaded data for this specific item (prevents flickering)
    if (loadedForRef.current === cacheKey) {
      console.log('[ManualIdInputs] Skipping reload - already loaded')
      manualIdDebugLog('hydrate:skip-loaded', { key: cacheKey })
      return undefined
    }

    // Load data immediately from cache if available to prevent flash
    if (manualIdsCache.current) {
      const map = manualIdsCache.current
      const titleKey = normalizedTitle
      let seriesEntry = (titleKey && map[titleKey]) ? map[titleKey] : null
      if (!seriesEntry && Array.isArray(aliasTitles)) {
        for (const alias of aliasTitles) {
          const aliasKey = normalizeKey(alias)
          if (aliasKey && map[aliasKey]) {
            seriesEntry = map[aliasKey]
            break
          }
        }
      }
      
      // Check for episode-specific AniDB Episode ID
      const episodeEntry = (filePath && map[filePath]) ? map[filePath] : null
      
      const cachedValues = {
        anilist: seriesEntry?.anilist ? String(seriesEntry.anilist) : '',
        tmdb: seriesEntry?.tmdb ? String(seriesEntry.tmdb) : '',
        tmdbType: seriesEntry?.tmdbType ? String(seriesEntry.tmdbType) : '',
        tvdb: seriesEntry?.tvdb ? String(seriesEntry.tvdb) : '',
        tvdbType: seriesEntry?.tvdbType ? String(seriesEntry.tvdbType) : '',
        anidbEpisode: episodeEntry?.anidbEpisode ? String(episodeEntry.anidbEpisode) : ''
      }
      if (!manualIdTouchedKeys.has(cacheKey) && !hasLocalTypedValues) {
        userEditingRef.current = false
        setValues(cachedValues)
        setInitialValues(cachedValues)
        manualIdDebugLog('hydrate:cache', { key: cacheKey, cachedValues })
      } else {
        manualIdDebugLog('hydrate:cache-skipped', {
          key: cacheKey,
          touched: manualIdTouchedKeys.has(cacheKey),
          hasLocalTypedValues
        })
      }
    }

    // Mark as loaded BEFORE async call to prevent race condition where user types
    // while API call is in flight, then API response overwrites their input
    loadedForRef.current = cacheKey
    setLoading(true)
    manualIdDebugLog('fetch:start', { key: cacheKey })
    ;(async () => {
      try {
        const r = await axios.get(API('/manual-ids'))
        const map = (r && r.data && r.data.manualIds) ? r.data.manualIds : {}
        manualIdsCache.current = map
        manualIdDebugLog('fetch:ok', { key: cacheKey, mapSize: Object.keys(map || {}).length })
        
        const titleKey = normalizedTitle
        let seriesEntry = (titleKey && map[titleKey]) ? map[titleKey] : null
        if (!seriesEntry && Array.isArray(aliasTitles)) {
          for (const alias of aliasTitles) {
            const aliasKey = normalizeKey(alias)
            if (aliasKey && map[aliasKey]) {
              seriesEntry = map[aliasKey]
              break
            }
          }
        }
        
        // Check for episode-specific AniDB Episode ID
        const episodeEntry = (filePath && map[filePath]) ? map[filePath] : null

        const latestDraft = manualIdDraftCache.get(cacheKey)

        // Don't overwrite user's changes if they've started editing
        if (!active || hasUnsavedChangesRef.current || userEditingRef.current || (latestDraft && latestDraft.isDirty) || manualIdTouchedKeys.has(cacheKey) || hasLocalTypedValues) {
          console.log('[ManualIdInputs] Skipping value update - user has unsaved changes')
          manualIdDebugLog('fetch:skip-overwrite', {
            key: cacheKey,
            active,
            hasUnsaved: hasUnsavedChangesRef.current,
            editing: userEditingRef.current,
            dirtyDraft: !!(latestDraft && latestDraft.isDirty),
            touched: manualIdTouchedKeys.has(cacheKey),
            hasLocalTypedValues
          })
          if (active) loadedForRef.current = cacheKey
          return
        }
        
        const nextLoadedValues = {
          anilist: seriesEntry?.anilist ? String(seriesEntry.anilist) : '',
          tmdb: seriesEntry?.tmdb ? String(seriesEntry.tmdb) : '',
          tmdbType: seriesEntry?.tmdbType ? String(seriesEntry.tmdbType) : '',
          tvdb: seriesEntry?.tvdb ? String(seriesEntry.tvdb) : '',
          tvdbType: seriesEntry?.tvdbType ? String(seriesEntry.tvdbType) : '',
          anidbEpisode: episodeEntry?.anidbEpisode ? String(episodeEntry.anidbEpisode) : ''
        }
        userEditingRef.current = false
        setValues(nextLoadedValues)
        setInitialValues(nextLoadedValues)
        loadedForRef.current = cacheKey
        manualIdDebugLog('fetch:apply', { key: cacheKey, nextLoadedValues })
      } catch (e) {
        manualIdDebugLog('fetch:error', { key: cacheKey, error: String(e) })
        if (active) {
          // Keep current values on fetch errors so in-progress typing is never lost.
          // This prevents random input clearing when /manual-ids fails transiently.
          if (hasUnsavedChangesRef.current || userEditingRef.current) {
            loadedForRef.current = cacheKey
            manualIdDebugLog('fetch:error-preserve-edit', { key: cacheKey })
            return
          }
          loadedForRef.current = cacheKey
        }
      } finally {
        if (active) setLoading(false)
        manualIdDebugLog('fetch:done', { key: cacheKey })
      }
    })()
    return () => {
      active = false
      manualIdDebugLog('effect:cleanup', { key: cacheKey })
    }
  }, [isOpen, loadTargetKey])

  const hasChanges = (
    normalizeManualValue(values.anilist) !== normalizeManualValue(initialValues.anilist)
    || normalizeManualValue(values.tmdb) !== normalizeManualValue(initialValues.tmdb)
    || (values.tmdbType || '') !== (initialValues.tmdbType || '')
    || normalizeManualValue(values.tvdb) !== normalizeManualValue(initialValues.tvdb)
    || (values.tvdbType || '') !== (initialValues.tvdbType || '')
    || normalizeManualValue(values.anidbEpisode) !== normalizeManualValue(initialValues.anidbEpisode)
  )

  const handleValueChange = (field, value) => {
    if (!loadTargetKey) return
    userEditingRef.current = true
    manualIdTouchedKeys.add(loadTargetKey)
    const next = { ...valuesRef.current, [field]: value }
    manualIdDraftCache.set(loadTargetKey, {
      values: next,
      initialValues: { ...initialValuesRef.current },
      isDirty: true
    })
    manualIdDebugLog('input:change', { key: loadTargetKey, field, value, next })
    setValues(next)
  }

  const handleSave = async () => {
    if (!title) return
    if (!hasChanges) {
      pushToast && pushToast('Manual IDs', 'No changes to save')
      return
    }
    const nextPayload = {
      anilist: String(values.anilist || '').trim() || null,
      tmdb: String(values.tmdb || '').trim() || null,
      tmdbType: values.tmdbType || null,
      tvdb: String(values.tvdb || '').trim() || null,
      tvdbType: values.tvdbType || null,
      anidbEpisode: String(values.anidbEpisode || '').trim() || null
    }
    if (nextPayload.anidbEpisode && !filePath) {
      pushToast && pushToast('Manual IDs', 'Cannot save AniDB Episode ID without a file path')
      return
    }
    if (!nextPayload.anilist && !nextPayload.tmdb && !nextPayload.tvdb && !nextPayload.anidbEpisode) {
      pushToast && pushToast('Manual IDs', 'Enter at least one ID before saving')
      return
    }
    setLoading(true)
    manualIdDebugLog('save:start', { key: loadTargetKey, values })
    try {
      await axios.post(API('/manual-ids'), {
        title,
        aliasTitles,
        filePath,
        anilist: nextPayload.anilist,
        tmdb: nextPayload.tmdb,
        tmdbType: nextPayload.tmdbType,
        tvdb: nextPayload.tvdb,
        tvdbType: nextPayload.tvdbType,
        anidbEpisode: nextPayload.anidbEpisode
      })
      setInitialValues({
        anilist: nextPayload.anilist || '',
        tmdb: nextPayload.tmdb || '',
        tmdbType: nextPayload.tmdbType || '',
        tvdb: nextPayload.tvdb || '',
        tvdbType: nextPayload.tvdbType || '',
        anidbEpisode: nextPayload.anidbEpisode || ''
      })
      userEditingRef.current = false
      pushToast && pushToast('Manual IDs', 'Saved manual provider IDs')
      // Normalize payload for cache (ensure no nulls)
      const cachedPayload = {
        anilist: nextPayload.anilist || '',
        tmdb: nextPayload.tmdb || '',
        tmdbType: nextPayload.tmdbType || '',
        tvdb: nextPayload.tvdb || '',
        tvdbType: nextPayload.tvdbType || '',
        anidbEpisode: nextPayload.anidbEpisode || ''
      }

      // Update draft cache. Mark isDirty: true to prevent 'useEffect' API fetch from overwriting 
      // with potentially stale data (race condition). 'hasChanges' will still return false (clean UI)
      // because values match initialValues.
      manualIdDraftCache.set(loadTargetKey, {
        values: { ...cachedPayload },
        initialValues: { ...cachedPayload },
        isDirty: true
      })
      manualIdTouchedKeys.delete(loadTargetKey)
      manualIdDebugLog('save:success', { key: loadTargetKey, cachedPayload })

      // Reset loaded ref to ensure we use the draft data
      manualIdsCache.current = null
      loadedForRef.current = null

      // Collapse the panel immediately before the (potentially slow) rescan
      onToggle && onToggle(false)

      // Trigger callback to force rescan with new manual IDs, passing saved values
      if (onSaved) await onSaved(cachedPayload)
    } catch (e) {
      const msg = e && e.response && e.response.data && e.response.data.error ? e.response.data.error : 'Failed to save manual IDs'
      pushToast && pushToast('Manual IDs', msg)
      manualIdDebugLog('save:error', { key: loadTargetKey, error: msg })
    } finally {
      setLoading(false)
    }
  }

  const panelStyle = {
    marginTop: 10,
    padding: 10,
    background: 'var(--bg-800)',
    border: '1px solid var(--bg-600)',
    borderRadius: 10,
    display: 'flex',
    flexDirection: 'column',
    gap: 8
  }

  return (
    <div style={{ marginTop: inActions ? 0 : 8 }}>
      <button
        type="button"
        className="row-match-btn"
        onClick={(e) => { e.stopPropagation(); onToggle && onToggle(!isOpen) }}
      >
        {isOpen ? 'Hide Manual Provider IDs' : 'Set Manual Provider IDs'}
      </button>
      {isOpen ? (
        <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, alignItems: 'start' }}>
            <input
              className="form-input"
              placeholder="AniList ID"
              value={values.anilist}
              onChange={(e) => handleValueChange('anilist', e.target.value)}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <input
                className="form-input"
                placeholder="TMDB ID"
                value={values.tmdb}
                onChange={(e) => handleValueChange('tmdb', e.target.value)}
              />
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.8em', cursor: 'pointer', userSelect: 'none' }}>
                <input
                  type="checkbox"
                  checked={values.tmdbType === 'movie'}
                  onChange={(e) => handleValueChange('tmdbType', e.target.checked ? 'movie' : '')}
                />
                Movie
              </label>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <input
                className="form-input"
                placeholder="TVDB ID"
                value={values.tvdb}
                onChange={(e) => handleValueChange('tvdb', e.target.value)}
              />
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.8em', cursor: 'pointer', userSelect: 'none' }}>
                <input
                  type="checkbox"
                  checked={values.tvdbType === 'movie'}
                  onChange={(e) => handleValueChange('tvdbType', e.target.checked ? 'movie' : '')}
                />
                Movie
              </label>
            </div>
            <input
              className="form-input"
              placeholder="AniDB Episode ID"
              value={values.anidbEpisode}
              onChange={(e) => handleValueChange('anidbEpisode', e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="row-match-btn" onClick={() => onToggle && onToggle(false)} disabled={loading}>Cancel</button>
            <button
              type="button"
              className="row-match-btn"
              onClick={handleSave}
              disabled={loading}
            >
              Save IDs
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
