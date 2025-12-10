import React, { useEffect, useMemo, useState } from 'react'
import axios from 'axios'

const API = (p) => `/api${p}`

export default function Duplicates({ pushToast }) {
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')

  const fetchGroups = async () => {
    setLoading(true)
    try {
      const resp = await axios.get(API('/rename/duplicates'))
      const g = Array.isArray(resp.data?.groups) ? resp.data.groups : []
      setGroups(g)
      setError('')
    } catch (e) {
      setError('Failed to load duplicates')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchGroups()
  }, [])

  const filtered = useMemo(() => {
    if (!search) return groups
    const q = search.toLowerCase()
    return groups.filter(g => {
      if ((g.previewName || '').toLowerCase().includes(q)) return true
      if ((g.hash || '').toLowerCase().includes(q)) return true
      return (g.items || []).some(it => (it.path || '').toLowerCase().includes(q))
    })
  }, [groups, search])

  return (
    <div className="hidden-page" style={{ padding: 20 }}>
      <h2 style={{ margin: 0 }}>Duplicates</h2>
      <div style={{ marginTop: 8, fontSize: 14, color: 'var(--muted)' }}>
        Groups sharing either the same preview name (case-insensitive) or the same ED2K hash.
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' }}>
        <button className="btn-ghost small" onClick={fetchGroups} disabled={loading}>Refresh</button>
        <input
          type="text"
          placeholder="Search by name, hash, or path..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid var(--bg-600)', background: 'var(--bg-700)', color: 'var(--fg)', fontSize: 13, width: 260 }}
        />
        <div style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--muted)' }}>{filtered.length} groups</div>
      </div>

      {loading ? (
        <div style={{ marginTop: 24 }}>Loading...</div>
      ) : error ? (
        <div style={{ marginTop: 24, color: '#ffb4b4' }}>{error}</div>
      ) : !filtered.length ? (
        <div style={{ marginTop: 24 }}>No duplicates found.</div>
      ) : (
        <div className="form-card hidden-list" style={{ marginTop: 18, padding: 14 }}>
          <div style={{ maxHeight: '64vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
            {filtered.map((group, idx) => (
              <div key={`${group.previewKey || group.hash || group.previewName || idx}`} style={{ border: '1px solid var(--bg-600)', borderRadius: 8, padding: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{group.previewName || '(no preview name)'}</div>
                  {group.hash ? <div style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--muted)' }}>{group.hash}</div> : null}
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>Count: {group.items?.length || 0}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', padding: '2px 6px', border: '1px solid var(--bg-600)', borderRadius: 6 }}>
                    {group.groupType === 'hash' ? 'Hash match' : 'Preview name match'}
                  </div>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--bg-600)' }}>
                      <th style={{ padding: '8px 6px' }}>Path</th>
                      <th style={{ padding: '8px 6px' }}>Status</th>
                      <th style={{ padding: '8px 6px' }}>Applied to</th>
                      <th style={{ padding: '8px 6px' }}>Applied at</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(group.items || []).map((it) => {
                      const status = it.applied ? 'Applied' : (it.hidden ? 'Hidden' : 'Pending')
                      return (
                        <tr key={it.path} style={{ borderBottom: '1px solid var(--bg-700)' }}>
                          <td style={{ padding: '8px 6px', fontSize: 13 }}>
                            <div style={{ fontWeight: 500 }}>{it.basename || it.providerTitle || it.parsedTitle || it.path}</div>
                            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{it.path}</div>
                          </td>
                          <td style={{ padding: '8px 6px', fontSize: 13 }}>{status}</td>
                          <td style={{ padding: '8px 6px', fontSize: 13 }}>{it.appliedTo || '-'}</td>
                          <td style={{ padding: '8px 6px', fontSize: 13 }}>{it.appliedAt ? new Date(it.appliedAt).toLocaleString() : '-'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
