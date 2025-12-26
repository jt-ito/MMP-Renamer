import React, { useEffect, useState } from 'react'

export default function Notifications() {
  const [notes, setNotes] = useState([])
  
  useEffect(() => {
    try { 
      const n = JSON.parse(localStorage.getItem('notifications') || '[]')
      setNotes(n) 
    } catch (e) { 
      setNotes([]) 
    }
  }, [])
  
  const clearAll = () => {
    try {
      localStorage.setItem('notifications', '[]')
      setNotes([])
    } catch (e) {}
  }
  
  const clearOne = (id) => {
    try {
      const updated = notes.filter(n => n.id !== id)
      localStorage.setItem('notifications', JSON.stringify(updated))
      setNotes(updated)
    } catch (e) {}
  }
  
  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Notifications</h2>
        {notes.length > 0 && (
          <button 
            onClick={clearAll}
            style={{
              background: 'transparent',
              border: '1px solid var(--bg-600)',
              color: 'var(--accent)',
              padding: '6px 12px',
              borderRadius: '8px',
              cursor: 'pointer',
              fontSize: '13px'
            }}
            title="Clear all notifications"
          >
            Clear All
          </button>
        )}
      </div>
      
      {notes.length === 0 ? (
        <div style={{ 
          color: 'var(--muted)', 
          textAlign: 'center', 
          padding: '40px 20px',
          background: 'var(--bg-700)',
          borderRadius: '8px',
          border: '1px solid var(--bg-600)'
        }}>
          No notifications yet
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {notes.map(n => (
            <div 
              key={n.id} 
              style={{
                background: 'var(--bg-700)', 
                padding: 16, 
                borderRadius: 10, 
                border: '1px solid var(--bg-600)',
                position: 'relative'
              }}
            >
              <button
                onClick={() => clearOne(n.id)}
                style={{
                  position: 'absolute',
                  top: 8,
                  right: 8,
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--muted)',
                  cursor: 'pointer',
                  padding: 4,
                  borderRadius: 4,
                  fontSize: '18px',
                  lineHeight: 1
                }}
                title="Dismiss notification"
              >
                ×
              </button>
              <div style={{ fontWeight: 600, fontSize: '15px', marginBottom: 4 }}>
                {n.title}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: 8 }}>
                {new Date(n.ts).toLocaleString()}
              </div>
              <div style={{ color: 'var(--accent)', fontSize: '14px' }}>
                {n.message}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
