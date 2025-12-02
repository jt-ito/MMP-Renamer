import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react'
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
  const [searchQuery, setSearchQuery] = useState('')
  const lastClickedIndex = useRef(null)

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

  const filteredItems = useMemo(() => {
    if (!searchQuery) return items
    const q = searchQuery.toLowerCase()
    return items.filter(item => {
      const name = item.providerTitle || item.parsedTitle || item.basename || item.path || ''
      return name.toLowerCase().includes(q) || item.path.toLowerCase().includes(q)
    })
  }, [items, searchQuery])

  const selectedPaths = useMemo(() => Object.keys(selected || {}).filter(k => selected[k]), [selected])

  const toggleSelect = (path, val) => {
    setSelected(prev => {
      const next = { ...(prev || {}) }
      if (val === false) delete next[path]
      else if (val === true) next[path] = true
      else {
        if (next[path]) delete next[path]
        else next[path] = true
      }
      return next
    })
  }

  const selectAll = () => {
    if (!filteredItems.length) return
    const allSelected = filteredItems.every(it => selected[it.path])
    if (allSelected) {
      setSelected(prev => {
        const next = { ...prev }
        for (const item of filteredItems) delete next[item.path]
        return next
      })
    } else {
      setSelected(prev => {
        const next = { ...prev }
        for (const item of filteredItems) next[item.path] = true
        return next
      })
    }
  }

  const handleRowClick = (item, index, ev) => {
    // ignore clicks originating from action buttons or the checkbox container
    const interactive = ev.target.closest('button') || ev.target.closest('a') || ev.target.closest('input')
    if (interactive) return

    if (ev.shiftKey && lastClickedIndex.current !== null) {
      ev.preventDefault()
      const start = Math.min(lastClickedIndex.current, index)
      const end = Math.max(lastClickedIndex.current, index)
      const subset = filteredItems.slice(start, end + 1)
      setSelected(prev => {
        const next = { ...prev }
        subset.forEach(it => next[it.path] = true)
        return next
      })
    } else {
      toggleSelect(item.path)
      lastClickedIndex.current = index
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
    <div className='hidden-page' style={{ padding: 20 }}>
      <h2 style={{ margin: 0 }}>Hidden items</h2>
      <div style={{ marginTop: 10, fontSize: 14, color: 'var(--muted)' }}>
        Review applied or hidden entries and unapprove them individually or in bulk.
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' }}>
        <button className='btn-ghost small' onClick={fetchItems} disabled={loading}>Refresh</button>
        <button
          className={'btn-ghost small' + (!selectedPaths.length ? ' disabled' : '')}
          onClick={() => unapprovePaths(selectedPaths)}
          disabled={!selectedPaths.length || bulkUnapproving}
        >Unapprove selected</button>
        <button className='btn-ghost small' onClick={selectAll} disabled={!items.length}>
          {filteredItems.length > 0 && filteredItems.every(it => selected[it.path]) ? 'Clear' : 'Select all'}
        </button>
        <input
          type="text"
          placeholder="Search..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          style={{ marginLeft: 8, padding: '4px 8px', borderRadius: 4, border: '1px solid var(--bg-600)', background: 'var(--bg-700)', color: 'var(--fg)', fontSize: 13, width: 200 }}
        />
        <div style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--muted)' }}>{filteredItems.length} {filteredItems.length !== items.length ? `(of ${items.length})` : 'total'}</div>
      </div>
      {loading ? (
  <div style={{ marginTop: 24 }}>Loading...</div>
      ) : error ? (
        <div style={{ marginTop: 24, color: '#ffb4b4' }}>{error}</div>
      ) : !filteredItems.length ? (
        <div style={{ marginTop: 24 }}>No hidden or applied items found.</div>
      ) : (
        <div className='form-card hidden-list' style={{ marginTop: 18, padding: 14 }}>
          <div style={{ maxHeight: '64vh', overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--bg-600)' }}>
                  <th style={{ width: 36 }}></th>
                  <th style={{ padding: '12px 14px' }}>Name</th>
                  <th style={{ padding: '12px 14px' }}>Status</th>
                  <th style={{ padding: '12px 14px' }}>Applied to</th>
                  <th style={{ padding: '12px 14px' }}>Applied at</th>
                  <th style={{ padding: '12px 14px' }}></th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item, index) => {
                  const status = item.applied ? 'Applied' : 'Hidden'
                  const disabled = !!rowUnapproving[item.path]
                  const displayName = item.providerTitle || item.parsedTitle || item.basename || item.path
                  return (
                    <tr 
                      key={item.path} 
                      style={{ 
                        borderBottom: '1px solid var(--bg-700)', 
                        height: 68, 
                        cursor: 'pointer',
                        background: selected[item.path] ? 'rgba(96,165,250,0.14)' : 'transparent'
                      }}
                      onClick={(ev) => handleRowClick(item, index, ev)}
                    >
                      <td style={{ padding: '12px 14px' }}>
                        <input
                          type='checkbox'
                          checked={!!selected[item.path]}
                          onChange={() => toggleSelect(item.path)}
                          onClick={e => e.stopPropagation()}
                        />
                      </td>
                      <td style={{ padding: '12px 14px', fontSize: 15 }}>
                        <div style={{ fontWeight: 500 }}>{displayName}</div>
                        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{item.path}</div>
                      </td>
                      <td style={{ padding: '12px 14px' }}>{status}</td>
                      <td style={{ padding: '12px 14px', fontSize: 13 }}>{item.appliedTo || '-'}</td>
                      <td style={{ padding: '12px 14px' }}>{formatTimestamp(item.appliedAt)}</td>
                      <td style={{ padding: '12px 14px', textAlign: 'right' }}>
                        <button
                          className={'btn-ghost small' + (disabled ? ' disabled' : '')}
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
