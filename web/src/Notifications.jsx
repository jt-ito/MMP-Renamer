import React, { useEffect, useState } from 'react'

export default function Notifications() {
  const [notes, setNotes] = useState([])
  useEffect(() => {
    try { const n = JSON.parse(localStorage.getItem('notifications') || '[]'); setNotes(n) } catch (e) { setNotes([]) }
  }, [])
  return (
    <div style={{padding:12}}>
      <h2>Notifications</h2>
      {notes.length === 0 ? <div style={{color:'var(--muted)'}}>No notifications</div> : (
      <div style={{display:'flex',flexDirection:'column'}}>
          {notes.map(n => (
            <div key={n.id} style={{background:'var(--bg-700)', padding:10, borderRadius:8, border:'1px solid var(--bg-600)'}}>
              <div style={{fontWeight:700}}>{n.title} <span style={{fontSize:12, color:'var(--muted)', marginLeft:8}}>{new Date(n.ts).toLocaleString()}</span></div>
              <div style={{color:'var(--muted)', marginTop:6}}>{n.message}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
