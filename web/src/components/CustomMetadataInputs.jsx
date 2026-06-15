import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { API } from '../constants';

export default function CustomMetadataInputs({ path, enrichment, isOpen, onToggle, onSaved, pushToast }) {
  const [values, setValues] = useState({ title: '', episodeTitle: '', season: '', episode: '', year: '', isMovie: false })
  const [loading, setLoading] = useState(false)
  const [renderedPreview, setRenderedPreview] = useState(null)
  const initializedFor = useRef(null)
  const enrichmentSnapshot = useRef(null)

  // Capture enrichment snapshot when form opens, don't react to changes while open
  useEffect(() => {
    if (isOpen && path) {
      enrichmentSnapshot.current = enrichment
    }
  }, [isOpen, path, enrichment])

  // Initialize form data only on first open for each file
  useEffect(() => {
    if (!isOpen) {
      // Reset initialized state when form closes
      initializedFor.current = null
      enrichmentSnapshot.current = null
      return
    }
    
    // Skip if already initialized for this path
    if (initializedFor.current === path) return
    initializedFor.current = path
    
    // Read from enrichment snapshot - ONLY use extraGuess or custom provider, NOT parsed
    const snapshot = enrichmentSnapshot.current
    const extra = snapshot?.extraGuess || null
    const provider = snapshot?.provider || null
    const isCustomProvider = provider && provider.source === 'custom'
    
    const isMovie = (extra && typeof extra.isMovie === 'boolean') ? extra.isMovie : 
                    (isCustomProvider && typeof provider.isMovie === 'boolean') ? provider.isMovie :
                    (snapshot && typeof snapshot.isMovie === 'boolean') ? snapshot.isMovie : false
    
    // Only pre-fill if there's existing custom metadata (extraGuess or custom provider)
    setValues({
      title: (extra && extra.title) ? String(extra.title) : 
             (isCustomProvider && provider.title) ? String(provider.title) : '',
      episodeTitle: (extra && extra.episodeTitle) ? String(extra.episodeTitle) : 
                    (isCustomProvider && provider.episodeTitle) ? String(provider.episodeTitle) : '',
      season: (extra && typeof extra.season !== 'undefined' && extra.season !== null) ? String(extra.season) : 
              (isCustomProvider && typeof provider.season !== 'undefined' && provider.season !== null) ? String(provider.season) : '',
      episode: (extra && typeof extra.episode !== 'undefined' && extra.episode !== null) ? String(extra.episode) : 
               (isCustomProvider && typeof provider.episode !== 'undefined' && provider.episode !== null) ? String(provider.episode) : '',
      year: (extra && extra.year) ? String(extra.year) : 
            (isCustomProvider && provider.year) ? String(provider.year) : '',
      isMovie
    })
    
    // Show rendered name preview if available
    if (isCustomProvider && provider.renderedName) {
      setRenderedPreview(provider.renderedName)
    } else {
      setRenderedPreview(null)
    }
  }, [isOpen, path])

  const handleSave = async () => {
    if (!path) return
    if (!values.title || !String(values.title).trim()) {
      pushToast && pushToast('Custom Metadata', 'Series/movie title is required')
      return
    }
    setLoading(true)
    try {
      const response = await axios.post(API('/enrich/custom'), {
        path,
        title: String(values.title || '').trim(),
        episodeTitle: values.isMovie ? '' : String(values.episodeTitle || '').trim(),
        season: values.isMovie ? null : (values.season !== '' && Number.isFinite(Number(values.season)) ? Number(values.season) : null),
        episode: values.isMovie ? null : (values.episode !== '' && Number.isFinite(Number(values.episode)) ? Number(values.episode) : null),
        year: String(values.year || '').trim() || null,
        isMovie: !!values.isMovie
      })
      const enrichment = response?.data?.enrichment
      const rendered = enrichment?.provider?.renderedName
      if (rendered) {
        setRenderedPreview(rendered)
      }
      pushToast && pushToast('Custom Metadata', 'Saved custom metadata')
      onSaved && onSaved(enrichment)
      onToggle && onToggle(false)
    } catch (e) {
      pushToast && pushToast('Custom Metadata', 'Failed to save custom metadata')
    } finally {
      setLoading(false)
    }
  }

  const panelStyle = {
    marginTop: 8,
    padding: 10,
    background: 'var(--bg-800)',
    border: '1px solid var(--bg-600)',
    borderRadius: 10,
    display: 'flex',
    flexDirection: 'column',
    gap: 8
  }

  return (
    <div style={{ marginTop: 6 }}>
      <button
        type="button"
        className="row-match-btn"
        onClick={(e) => { e.stopPropagation(); onToggle && onToggle(!isOpen) }}
      >
        {isOpen ? 'Hide Custom Metadata' : 'Set Custom Metadata'}
      </button>
      {renderedPreview && !isOpen ? (
        <div style={{ marginTop: 4, fontSize: 12, color: 'var(--accent)', fontStyle: 'italic' }}>
          New name: {renderedPreview}
        </div>
      ) : null}
      {isOpen ? (
        <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--muted)' }}>
            <input
              type="checkbox"
              checked={!!values.isMovie}
              onChange={(e) => setValues(prev => ({ ...prev, isMovie: e.target.checked }))}
            />
            Movie
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: values.isMovie ? '1fr 140px' : '1.2fr 120px 120px 120px', gap: 8 }}>
            <input
              className="form-input"
              placeholder={values.isMovie ? 'Movie title' : 'Series title'}
              value={values.title}
              onChange={(e) => setValues(prev => ({ ...prev, title: e.target.value }))}
            />
            {!values.isMovie ? (
              <>
                <input
                  className="form-input"
                  placeholder="Year"
                  value={values.year}
                  onChange={(e) => setValues(prev => ({ ...prev, year: e.target.value }))}
                />
                <input
                  className="form-input"
                  placeholder="Season"
                  value={values.season}
                  onChange={(e) => setValues(prev => ({ ...prev, season: e.target.value }))}
                />
                <input
                  className="form-input"
                  placeholder="Episode"
                  value={values.episode}
                  onChange={(e) => setValues(prev => ({ ...prev, episode: e.target.value }))}
                />
              </>
            ) : null}
            {values.isMovie ? (
              <input
                className="form-input"
                placeholder="Year"
                value={values.year}
                onChange={(e) => setValues(prev => ({ ...prev, year: e.target.value }))}
              />
            ) : null}
          </div>
          {!values.isMovie ? (
            <input
              className="form-input"
              placeholder="Episode title"
              value={values.episodeTitle}
              onChange={(e) => setValues(prev => ({ ...prev, episodeTitle: e.target.value }))}
            />
          ) : null}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="row-match-btn" onClick={() => onToggle && onToggle(false)} disabled={loading}>Cancel</button>
            <button type="button" className="row-match-btn" onClick={handleSave} disabled={loading}>Save Metadata</button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
