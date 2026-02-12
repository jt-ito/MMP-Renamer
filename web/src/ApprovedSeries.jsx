import React, { useEffect, useMemo, useState } from 'react'
import axios from 'axios'

const API = (p) => `/api${p}`

export default function ApprovedSeries({ pushToast }) {
  const [loading, setLoading] = useState(true)
  const [outputs, setOutputs] = useState([])
  const [activeOutputKey, setActiveOutputKey] = useState('')
  const [fetchingOutput, setFetchingOutput] = useState({})
  const [savingSource, setSavingSource] = useState({})

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
      await axios.post(API('/approved-series/source'), { outputKey, source })
      setOutputs((prev) => prev.map((o) => o.key === outputKey ? { ...o, source } : o))
      pushToast && pushToast('Approved Series', 'Saved image source preference')
    } catch (e) {
      pushToast && pushToast('Approved Series', 'Failed to save image source')
    } finally {
      setSavingSource((prev) => ({ ...prev, [outputKey]: false }))
    }
  }

  const fetchImagesForOutput = async (outputKey) => {
    const selected = outputs.find((o) => o.key === outputKey)
    const source = selected && selected.source ? selected.source : 'anilist'
    setFetchingOutput((prev) => ({ ...prev, [outputKey]: true }))
    try {
      const r = await axios.post(API('/approved-series/fetch-images'), { outputKey, source })
      const data = r && r.data ? r.data : {}
      const fetched = Number(data.fetched || 0)
      const skipped = Number(data.skipped || 0)
      pushToast && pushToast('Approved Series', `Image refresh done (${fetched} fetched, ${skipped} skipped)`)
      await load()
    } catch (e) {
      pushToast && pushToast('Approved Series', 'Failed to fetch images')
    } finally {
      setFetchingOutput((prev) => ({ ...prev, [outputKey]: false }))
    }
  }

  if (loading) {
    return (
      <div className="settings-page-content">
        <div className="form-card approved-series-page">
          <h2>Approved Series</h2>
          <p className="small-muted">Loading approved series...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="settings-page-content">
      <div className="form-card approved-series-page">
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
                  onClick={() => setActiveOutputKey(output.key)}
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
                  </select>
                  <button
                    className="btn-cta"
                    onClick={() => fetchImagesForOutput(activeOutput.key)}
                    disabled={!!fetchingOutput[activeOutput.key]}
                  >
                    {fetchingOutput[activeOutput.key] ? 'Pulling...' : 'Pull & Cache Images'}
                  </button>
                </div>

                <div className="approved-series-grid">
                  {activeOutput.series && activeOutput.series.length ? activeOutput.series.map((series) => (
                    <article className="approved-series-card" key={`${activeOutput.key}:${series.key}`}>
                      <div className="approved-series-cover-wrap">
                        {series.imageUrl ? (
                          <img className="approved-series-cover" src={series.imageUrl} alt={series.name} loading="lazy" />
                        ) : (
                          <div className="approved-series-cover approved-series-cover-placeholder">No image</div>
                        )}
                      </div>
                      <div className="approved-series-body">
                        <h3 className="approved-series-title">{series.name}</h3>
                        <p className="approved-series-summary">{series.summary || `${series.appliedCount || 0} approved items`}</p>
                        <div className="approved-series-meta">{series.appliedCount || 0} approved item{(series.appliedCount || 0) === 1 ? '' : 's'}</div>
                      </div>
                    </article>
                  )) : (
                    <p className="small-muted">No approved series found for this output.</p>
                  )}
                </div>
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
