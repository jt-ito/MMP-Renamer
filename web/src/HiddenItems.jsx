import React, { useCallback, useEffect, useMemo, useState } from 'react'
import axios from 'axios'

const API = (p) => `/api${p}`

function formatTimestamp(ts) {
  if (!ts) return '-'
  try {
    const date = new Date(ts)
    if (Number.isNaN(date.getTime())) return String(ts)
    return date.toLocaleString()
  } catch (e) {
    return String(ts)
  }
}

export default function HiddenItems({ pushToast }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState({})
  const [bulkUnapproving, setBulkUnapproving] = useState(false)
  const [rowUnapproving, setRowUnapproving] = useState({})

  const fetchItems = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await axios.get(API('/rename/hidden'))
      const nextItems = Array.isArray(resp.data?.items) ? resp.data.items : []
      setItems(nextItems)
      setSelected(prev => {
        if (!prev || !Object.keys(prev).length) return prev || {}
        const allowed = new Set(nextItems.map(item => item.path))
        const next = {}
        for (const key of Object.keys(prev)) {
          if (prev[key] && allowed.has(key)) next[key] = true
        }
        return next
      })
      setError('')
    } catch (e) {
      setError('Failed to load hidden items')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchItems()
  }, [fetchItems])

  const selectedPaths = useMemo(() => Object.keys(selected || {}).filter(k => selected[k]), [selected])

  const toggleSelect = (path) => {
    setSelected(prev => {
      const next = { ...(prev || {}) }
      if (next[path]) delete next[path]
      else next[path] = true
      return next
    })
  }

  const selectAll = () => {
    if (!items.length) return
    const allSelected = selectedPaths.length === items.length
    if (allSelected) {
      setSelected({})
    } else {
      const next = {}
      for (const item of items) next[item.path] = true
      setSelected(next)
    }
  }

  async function unapprovePaths(paths, { single = false } = {}) {
    if (!paths || !paths.length) return
    if (single) {
      setRowUnapproving(prev => ({ ...prev, [paths[0]]: true }))
    } else {
      setBulkUnapproving(true)
    }
    try {
      const resp = await axios.post(API('/rename/unapprove'), { paths })
      const changed = Array.isArray(resp.data?.unapproved) ? resp.data.unapproved : []
      if (changed.length) {
        pushToast && pushToast('Unapprove', `Unapproved ${changed.length} item${changed.length === 1 ? '' : 's'}`)
        try {
          window.dispatchEvent(new CustomEvent('renamer:unapproved', { detail: { paths: changed } }))
        } catch (e) {}
      } else {
        pushToast && pushToast('Unapprove', 'No items were unapproved')
      }
      setSelected(prev => {
        if (!prev) return {}
        const next = { ...prev }
        for (const p of paths) delete next[p]
        return next
      })
      await fetchItems()
    } catch (e) {
      pushToast && pushToast('Unapprove', 'Unapprove failed')
    } finally {
      if (single) {
        setRowUnapproving(prev => {
          const next = { ...(prev || {}) }
          delete next[paths[0]]
          return next
        })
      } else {
        setBulkUnapproving(false)
      }
    }
  }

  return (
    <div style={{ padding: 16 }}>
      <h2>Hidden items</h2>
      <div style={{ marginTop: 8, fontSize: 14, color: 'var(--muted)' }}>
        Review applied or hidden entries and unapprove them individually or in bulk.
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button className='btn-ghost' onClick={fetchItems} disabled={loading}>Refresh</button>
        <button
          className={'btn-ghost' + (!selectedPaths.length ? ' disabled' : '')}
          onClick={() => unapprovePaths(selectedPaths)}
          disabled={!selectedPaths.length || bulkUnapproving}
        >Unapprove selected</button>
        <button className='btn-ghost' onClick={selectAll} disabled={!items.length}>
          {selectedPaths.length === items.length && items.length ? 'Clear selection' : 'Select all'}
        </button>
      </div>
      {loading ? (
  <div style={{ marginTop: 24 }}>Loading...</div>
      ) : error ? (
        <div style={{ marginTop: 24, color: '#ffb4b4' }}>{error}</div>
      ) : !items.length ? (
        <div style={{ marginTop: 24 }}>No hidden or applied items found.</div>
      ) : (
        <div className='form-card' style={{ marginTop: 24 }}>
          <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--bg-600)' }}>
                  <th style={{ width: 32 }}></th>
                  <th style={{ padding: '8px 12px' }}>Name</th>
                  <th style={{ padding: '8px 12px' }}>Status</th>
                  <th style={{ padding: '8px 12px' }}>Applied to</th>
                  <th style={{ padding: '8px 12px' }}>Applied at</th>
                  <th style={{ padding: '8px 12px' }}></th>
                </tr>
              </thead>
              <tbody>
                {items.map(item => {
                  const status = item.applied ? 'Applied' : 'Hidden'
                  const disabled = !!rowUnapproving[item.path]
                  const displayName = item.providerTitle || item.parsedTitle || item.basename || item.path
                  return (
                    <tr key={item.path} style={{ borderBottom: '1px solid var(--bg-700)' }}>
                      <td style={{ padding: '8px 12px' }}>
                        <input
                          type='checkbox'
                          checked={!!selected[item.path]}
                          onChange={() => toggleSelect(item.path)}
                        />
                      </td>
                      <td style={{ padding: '8px 12px', fontSize: 14 }}>
                        <div style={{ fontWeight: 500 }}>{displayName}</div>
                        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{item.path}</div>
                      </td>
                      <td style={{ padding: '8px 12px' }}>{status}</td>
                      <td style={{ padding: '8px 12px', fontSize: 13 }}>{item.appliedTo || '-'}</td>
                      <td style={{ padding: '8px 12px' }}>{formatTimestamp(item.appliedAt)}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                        <button
                          className={'btn-ghost' + (disabled ? ' disabled' : '')}
                          onClick={() => unapprovePaths([item.path], { single: true })}
                          disabled={disabled}
                        >Unapprove</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
