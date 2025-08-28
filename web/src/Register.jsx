import React, { useState, useEffect } from 'react'
import axios from 'axios'

const API = (p) => `/api${p}`

export default function Register({ onRegistered, pushToast }){
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let mounted = true
    axios.get(API('/auth/status')).then(r => { if (!mounted) return; setOpen(!r.data.hasUsers) }).catch(() => {}).finally(()=>{ mounted = false })
    return () => { mounted = false }
  }, [])

  async function submit(e){
    e && e.preventDefault()
    if (!open) { pushToast && pushToast('Register','Registration is closed'); return }
    if (!username || !password) { pushToast && pushToast('Register','username and password required'); return }
    if (password !== confirm) { pushToast && pushToast('Register','Passwords do not match'); return }
    if (String(password).length < 6) { pushToast && pushToast('Register','Password too short (min 6)'); return }
    setLoading(true)
    try {
      const r = await axios.post(API('/register'), { username, password })
      setLoading(false)
      pushToast && pushToast('Register','Account created')
      onRegistered && onRegistered(r.data)
    } catch (err) {
      setLoading(false)
      pushToast && pushToast('Register','Registration failed')
    }
  }

  if (!open) return null

  return (
    <div className="centered-page">
      <div className="form-card">
        <h2 style={{margin:0, marginBottom:8}}>Create admin account</h2>
        <p style={{marginTop:0, color:'var(--muted)', marginBottom:12}}>This will create the initial admin account. Registration will be closed after the first user is created.</p>
        <form onSubmit={submit} style={{display:'flex',flexDirection:'column',gap:12}}>
          <div>
            <label className="form-label">Username</label>
            <input className="form-input" value={username} onChange={e=>setUsername(e.target.value)} />
          </div>

          <div>
            <label className="form-label">Password</label>
            <input className="form-input" type="password" value={password} onChange={e=>setPassword(e.target.value)} />
          </div>

          <div>
            <label className="form-label">Confirm Password</label>
            <input className="form-input" type="password" value={confirm} onChange={e=>setConfirm(e.target.value)} />
          </div>

          <div style={{display:'flex', gap:8, justifyContent:'flex-end'}}>
            <button className="btn-ghost" type="button" onClick={() => { setUsername(''); setPassword(''); setConfirm('') }}>Clear</button>
            <button className="btn-save" disabled={loading} onClick={submit} style={{minWidth:160}}>Create admin</button>
          </div>
        </form>
      </div>
    </div>
  )
}
