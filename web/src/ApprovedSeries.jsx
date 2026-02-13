import React, { useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'

const API = (p) => `/api${p}`

export default function ApprovedSeries({ pushToast }) {
  const [loading, setLoading] = useState(true)
  const [outputs, setOutputs] = useState([])
  const [activeOutputKey, setActiveOutputKey] = useState('')
  const [savingSource, setSavingSource] = useState({})
  const [clearingCache, setClearingCache] = useState({})
  const [autoFetching, setAutoFetching] = useState({})
  const [sourcePromptOutput, setSourcePromptOutput] = useState(null)
  const observedRef = useRef(new Set())
  const queuedRef = useRef(new Set())
  const inFlightRef = useRef(new Set())
  const queueTimerRef = useRef(null)

  const AUTO_FETCH_INTERVAL_MS = 1200

  const load = async () => {
    setLoading(true)
    try {
      const r = await axios.get(API('/approved-series'))
      const payload = r && r.data ? r.data : {}
      const list = Array.isArray(payload.outputs) ? payload.outputs : []
      setOutputs(list)
      setActiveOutputKey((prev) => {
        if (prev && list.some((o) => o.key === prev)) return prev
        return list.length ? list[0].key : ''
      })
    } catch (e) {
      pushToast && pushToast('Approved Series', 'Failed to load approved series')
      setOutputs([])
      setActiveOutputKey('')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const activeOutput = useMemo(() => outputs.find((o) => o.key === activeOutputKey) || null, [outputs, activeOutputKey])

  const setOutputSource = async (outputKey, source) => {
    const currentOutput = outputs.find((o) => o.key === outputKey) || null
    setSavingSource((prev) => ({ ...prev, [outputKey]: true }))
    try {
      await axios.post(API('/approved-series/source'), { outputKey, outputPath: currentOutput ? currentOutput.path : '', source })
      setOutputs((prev) => prev.map((o) => o.key === outputKey ? { ...o, source, sourceConfigured: true } : o))
      pushToast && pushToast('Approved Series', 'Saved image source preference')
      return true
    } catch (e) {
      pushToast && pushToast('Approved Series', 'Failed to save image source')
      return false
    } finally {
      setSavingSource((prev) => ({ ...prev, [outputKey]: false }))
    }
  }

  const handleOutputTabClick = (output) => {
    if (!output || !output.key) return
    if (output.key === activeOutputKey) return
    if (!output.sourceConfigured) {
      setSourcePromptOutput(output)
      return
    }
    setActiveOutputKey(output.key)
  }

  const chooseSourceForOutput = async (source) => {
    if (!sourcePromptOutput || !sourcePromptOutput.key) return
    const outputKey = sourcePromptOutput.key
    const ok = await setOutputSource(outputKey, source)
    if (ok) {
      setActiveOutputKey(outputKey)
      setSourcePromptOutput(null)
    }
  }

  const clearOutputCache = async (output) => {
    if (!output || !output.key) return
    const confirmClear = window.confirm(`Clear cached images for this output only?\n\n${output.path}`)
    if (!confirmClear) return
    const outputKey = output.key
    setClearingCache((prev) => ({ ...prev, [outputKey]: true }))
    try {
      const r = await axios.post(API('/approved-series/clear-cache'), { outputKey })
      const removed = r && r.data && typeof r.data.removed === 'number' ? r.data.removed : 0
      pushToast && pushToast('Approved Series', `Cleared ${removed} cached image${removed === 1 ? '' : 's'} for this output`)
      await load()
    } catch (e) {
      pushToast && pushToast('Approved Series', 'Failed to clear output cache')
    } finally {
      setClearingCache((prev) => ({ ...prev, [outputKey]: false }))
    }
  }

  const enqueueAutoFetch = (outputKey, source, seriesName, cardKey) => {
    if (!outputKey || !seriesName || !cardKey) return
    if (queuedRef.current.has(cardKey) || inFlightRef.current.has(cardKey)) return
    queuedRef.current.add(cardKey)
    setAutoFetching((prev) => ({ ...prev, [cardKey]: true }))
    if (queueTimerRef.current) return
    queueTimerRef.current = setInterval(async () => {
      const nextKey = queuedRef.current.values().next().value
      if (!nextKey) {
        clearInterval(queueTimerRef.current)
        queueTimerRef.current = null
        return
      }
      const [okey, sname] = nextKey.split('::')
      queuedRef.current.delete(nextKey)
      inFlightRef.current.add(nextKey)
      try {
        await axios.post(API('/approved-series/fetch-image'), {
          outputKey: okey,
          source,
          seriesName: sname
        })
        setOutputs((prev) => prev.map((out) => {
          if (out.key !== okey || !Array.isArray(out.series)) return out
          return {
            ...out,
            series: out.series.map((item) => {
              if ((item && item.name ? item.name : '') !== sname) return item
              return { ...item, _autoFetched: true }
            })
          }
        }))
      } catch (e) {
        // Keep silent for background fetch to avoid toast spam
      } finally {
        inFlightRef.current.delete(nextKey)
        setAutoFetching((prev) => {
          const next = { ...prev }
          delete next[nextKey]
          return next
        })
      }
    }, AUTO_FETCH_INTERVAL_MS)
  }

  useEffect(() => {
    return () => {
      if (queueTimerRef.current) {
        clearInterval(queueTimerRef.current)
        queueTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!activeOutput || !Array.isArray(activeOutput.series)) return
    const source = activeOutput.source || 'anilist'
    if (!['anilist', 'tmdb', 'anidb'].includes(source)) return
    const cards = Array.from(document.querySelectorAll('.approved-series-card[data-series-key]'))
    if (!cards.length) return

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const el = entry.target
        const seriesName = el.getAttribute('data-series-name') || ''
        const outputKey = el.getAttribute('data-output-key') || ''
        const cardKey = el.getAttribute('data-series-key') || ''
        if (!seriesName || !outputKey || !cardKey) continue
        enqueueAutoFetch(outputKey, source, seriesName, cardKey)
      }
    }, { root: null, rootMargin: '280px 0px 280px 0px', threshold: 0.2 })

    cards.forEach((card) => {
      const key = card.getAttribute('data-series-key') || ''
      if (!key || observedRef.current.has(key)) return
      observedRef.current.add(key)
      observer.observe(card)
    })

    return () => {
      observer.disconnect()
      observedRef.current.clear()
    }
  }, [activeOutputKey, outputs])

  if (loading) {
    return (
      <div className="settings-page-content approved-series-layout">
        <div className="approved-series-page">
          <h2>Approved Series</h2>
          <p className="small-muted">Loading approved series...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="settings-page-content approved-series-layout">
      <div className="approved-series-page">
        <div className="approved-series-header">
          <div>
            <h2>Approved Series</h2>
            <p className="small-muted">Browse approved series by output folder and cache artwork/summary metadata.</p>
          </div>
          <button className="btn-ghost" onClick={load}>Refresh</button>
        </div>

        {!outputs.length ? (
          <p className="small-muted">No approved series found yet.</p>
        ) : (
          <>
            <div className="approved-output-tabs">
              {outputs.map((output) => (
                <button
                  key={output.key}
                  className={`approved-output-tab ${output.key === activeOutputKey ? 'active' : ''}`}
                  onClick={() => handleOutputTabClick(output)}
                  title={output.path}
                >
                  {output.path}
                  <span className="approved-output-count">{output.seriesCount}</span>
                </button>
              ))}
            </div>

            {activeOutput ? (
              <>
                <div className="approved-output-toolbar">
                  <label className="form-label" style={{ margin: 0 }}>Image Source</label>
                  <select
                    className="form-input approved-source-select"
                    value={activeOutput.source || 'anilist'}
                    onChange={(e) => setOutputSource(activeOutput.key, e.target.value)}
                    disabled={!!savingSource[activeOutput.key]}
                  >
                    <option value="anilist">AniList</option>
                    <option value="tmdb">TMDB</option>
                    <option value="anidb">AniDB</option>
                  </select>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => clearOutputCache(activeOutput)}
                    disabled={!!clearingCache[activeOutput.key]}
                  >
                    {clearingCache[activeOutput.key] ? 'Clearing…' : 'Clear Output Cache'}
                  </button>
                  <span className="small-muted">Images auto-fetch and cache while you scroll.</span>
                </div>

                <div className="approved-series-grid">
                  {activeOutput.series && activeOutput.series.length ? activeOutput.series.map((series) => (
                    <article
                      className="approved-series-card"
                      key={`${activeOutput.key}:${series.key}`}
                      data-output-key={activeOutput.key}
                      data-series-name={series.name}
                      data-series-key={`${activeOutput.key}::${series.name}`}
                    >
                      <div className="approved-series-cover-wrap">
                        {series.imageUrl ? (
                          <img className="approved-series-cover" src={series.imageUrl} alt={series.name} loading="lazy" />
                        ) : (
                          <div className="approved-series-cover approved-series-cover-placeholder">{autoFetching[`${activeOutput.key}::${series.name}`] ? 'Fetching…' : 'No image yet'}</div>
                        )}
                        <div className="approved-series-overlay">
                          <p className="approved-series-summary">{series.summary || `${series.appliedCount || 0} approved items`}</p>
                        </div>
                      </div>
                      <h3 className="approved-series-title" title={series.name}>{series.name}</h3>
                    </article>
                  )) : (
                    <p className="small-muted">No approved series found for this output.</p>
                  )}
                </div>
              </>
            ) : null}
          </>
        )}

        {sourcePromptOutput ? (
          <div className="approved-source-prompt-backdrop" role="dialog" aria-modal="true">
            <div className="approved-source-prompt-card">
              <h3>Choose Image Source</h3>
              <p className="small-muted">Pick a source for this output folder before loading posters.</p>
              <div className="approved-source-prompt-actions">
                <button type="button" className="btn-cta" onClick={() => chooseSourceForOutput('anilist')} disabled={!!savingSource[sourcePromptOutput.key]}>AniList</button>
                <button type="button" className="btn-ghost" onClick={() => chooseSourceForOutput('tmdb')} disabled={!!savingSource[sourcePromptOutput.key]}>TMDB</button>
                <button type="button" className="btn-ghost" onClick={() => chooseSourceForOutput('anidb')} disabled={!!savingSource[sourcePromptOutput.key]}>AniDB</button>
                <button type="button" className="btn-ghost" onClick={() => setSourcePromptOutput(null)} disabled={!!savingSource[sourcePromptOutput.key]}>Cancel</button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
