import React from 'react'

export default function ToastContainer({ toasts = [], remove }){
  return (
    <div style={{position:'fixed', right:16, top:16, zIndex:9999, display:'flex', flexDirection:'column', gap:8}}>
      {toasts.map(t => (
        <div key={t.id} className="toast" role="status">
          <div className="toast-title">{t.title}</div>
          <div className="toast-body">{t.message}</div>
          <button className="btn-ghost" onClick={() => remove(t.id)} style={{marginTop:8}}>Dismiss</button>
        </div>
      ))}
    </div>
  )
}
