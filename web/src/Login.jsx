import React, { useState } from 'react'
import axios from 'axios'

const API = (p) => `/api${p}`

export default function Login({ onLogin, pushToast }){
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(e){
    e && e.preventDefault()
    setLoading(true)
    try {
      const r = await axios.post(API('/login'), { username, password })
      setLoading(false)
      pushToast && pushToast('Auth', 'Logged in')
      onLogin && onLogin(r.data)
    } catch (err) {
      setLoading(false)
      pushToast && pushToast('Auth', 'Login failed')
    }
  }

  return (
    <div className="centered-page">
      <div className="form-card">
        <h2 style={{margin:0, marginBottom:8}}>Sign in</h2>
        <p style={{marginTop:0, color:'var(--muted)', marginBottom:12}}>Enter your credentials to access the renamer.</p>
        <form onSubmit={submit} style={{display:'flex',flexDirection:'column',gap:12}}>
          <div>
            <label className="form-label">Username</label>
            <input className="form-input" value={username} onChange={e=>setUsername(e.target.value)} />
          </div>

          <div>
            <label className="form-label">Password</label>
            <input className="form-input" type="password" value={password} onChange={e=>setPassword(e.target.value)} />
          </div>

          <div style={{display:'flex', gap:8, justifyContent:'flex-end'}}>
            <button className="btn-ghost" type="button" onClick={() => { setUsername(''); setPassword('') }}>Clear</button>
            <button className="btn-save" disabled={loading} onClick={submit} style={{minWidth:110}}>Sign in</button>
          </div>
        </form>
      </div>
    </div>
  )
}
