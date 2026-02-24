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
  const [showLogs, setShowLogs] = useState(false)
  const [logs, setLogs] = useState('')
  const observedRef = useRef(new Set())
  const queuedRef = useRef(new Set())
  const inFlightRef = useRef(new Set())
  const queueTimerRef = useRef(null)
  const logsTimerRef = useRef(null)

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
    setSavingSource((prev) => ({ ...prev, [outputKey]: true }))
    try {
      const resp = await axios.post(API('/approved-series/source'), { outputKey, source })
      const savedSource = resp && resp.data && resp.data.source ? resp.data.source : source
      setOutputs((prev) => prev.map((o) => o.key === outputKey ? { ...o, source: savedSource, sourceConfigured: true } : o))
      pushToast && pushToast('Approved Series', `Saved image source: ${savedSource}`)
      // Clear cache and reload series data for this output
      await axios.post(API('/approved-series/clear-cache'), { outputKey })
      await load()
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
    if (!outputKey || !seriesName || !cardKey) return;
    if (queuedRef.current.has(cardKey) || inFlightRef.current.has(cardKey)) return;
    queuedRef.current.add(cardKey);
    setAutoFetching((prev) => ({ ...prev, [cardKey]: true }));
    if (queueTimerRef.current) return;
    queueTimerRef.current = setInterval(async () => {
      const nextKey = queuedRef.current.values().next().value;
      if (!nextKey) {
        clearInterval(queueTimerRef.current);
        queueTimerRef.current = null;
        return;
      }
      const [okey, sname] = nextKey.split('::');
      queuedRef.current.delete(nextKey);
      inFlightRef.current.add(nextKey);
      try {
        // Use the source from the current active output
        const activeOutput = outputs.find((o) => o.key === okey);
        const source = activeOutput && activeOutput.source ? activeOutput.source : 'anilist';
        await axios.post(API('/approved-series/fetch-image'), {
          outputKey: okey,
          seriesName: sname,
          source
        });
        // After fetching, reload the series data for this output
        await load()
      } catch (e) {
        // Keep silent for background fetch to avoid toast spam
      } finally {
        inFlightRef.current.delete(nextKey);
        setAutoFetching((prev) => {
          const next = { ...prev };
          delete next[nextKey];
          return next;
        });
      }
    }, AUTO_FETCH_INTERVAL_MS);
  }

  const fetchLogs = async () => {
    try {
      const r = await axios.get(API('/logs/recent?lines=500&filter=approved_series'))
      const allLogs = r.data.logs || ''
      
      // Filter logs by output key if activeOutput is set
      if (activeOutput && activeOutput.key) {
        const outputKey = activeOutput.key;
        const lines = allLogs.split('\n');
        // Show any log mentioning the output key (not just exact path matches)
        const filtered = lines.filter(line => line.includes(outputKey));
        setLogs(filtered.join('\n'));
      } else {
        setLogs(allLogs);
      }
    } catch (e) {
      // silent
    }
  }

  useEffect(() => {
    if (showLogs) {
      fetchLogs()
      logsTimerRef.current = setInterval(fetchLogs, 2000)
    } else {
      if (logsTimerRef.current) {
        clearInterval(logsTimerRef.current)
        logsTimerRef.current = null
      }
    }
    // Always fetch logs when (re)mounting or changing output
    fetchLogs()
    return () => {
      if (logsTimerRef.current) {
        clearInterval(logsTimerRef.current)
        logsTimerRef.current = null
      }
    }
  }, [showLogs, activeOutput])

  useEffect(() => {
    return () => {
      if (queueTimerRef.current) {
        clearInterval(queueTimerRef.current)
        queueTimerRef.current = null
      }
      if (logsTimerRef.current) {
        clearInterval(logsTimerRef.current)
        logsTimerRef.current = null
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
          <div style={{display:'flex',gap:8}}>
            <button className="row-match-btn" onClick={() => setShowLogs(!showLogs)}>{showLogs ? 'Hide Logs' : 'Show Logs'}</button>
            <button className="row-match-btn" onClick={load}>Refresh</button>
          </div>
        </div>

        {showLogs && (
          <div style={{
            marginBottom: 16,
            padding: 12,
            background: 'var(--card-bg)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            width: '100%',
            boxSizing: 'border-box'
          }}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
              <strong style={{fontSize:14}}>
                Logs {activeOutput ? `for ${activeOutput.path}` : '(all outputs)'}
              </strong>
              <button className="row-match-btn" onClick={fetchLogs}>Refresh</button>
            </div>
            <div style={{
              height: '300px',
              overflow: 'auto',
              background: '#1a1a1a',
              border: '1px solid #444',
              borderRadius: 3,
              padding: 8,
              width: '100%',
              boxSizing: 'border-box'
            }}>
              <pre style={{
                margin: 0,
                fontSize: 11,
                fontFamily: 'Consolas, Monaco, "Courier New", monospace',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color: '#e0e0e0',
                lineHeight: '1.5',
                overflowWrap: 'anywhere'
              }}>{logs || 'No logs yet'}</pre>
            </div>
          </div>
        )}

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
