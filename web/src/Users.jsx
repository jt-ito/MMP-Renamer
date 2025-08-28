import React, { useEffect, useState } from 'react'
import axios from 'axios'

const API = (p) => `/api${p}`

export default function Users({ pushToast }){
  const [users, setUsers] = useState([])
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('user')

  async function fetchUsers(){
    try {
      const r = await axios.get(API('/users'))
      setUsers(r.data.users || [])
    } catch (err) { pushToast && pushToast('Users', 'Failed to load users') }
  }

  useEffect(() => { fetchUsers() }, [])

  async function add(){
    try {
      await axios.post(API('/users'), { username, password, role })
      pushToast && pushToast('Users', 'Created')
      setUsername(''); setPassword(''); setRole('user')
      fetchUsers()
    } catch (err) { pushToast && pushToast('Users', 'Create failed') }
  }

  async function remove(u){
    try {
      await axios.delete(API(`/users/${u}`))
      pushToast && pushToast('Users', 'Deleted')
      fetchUsers()
    } catch (err) { pushToast && pushToast('Users', 'Delete failed') }
  }

  async function changePassword(u, newPassword) {
    try {
      await axios.post(API(`/users/${u}/password`), { newPassword })
      pushToast && pushToast('Users', 'Password changed')
    } catch (err) { pushToast && pushToast('Users', 'Change failed') }
  }

  return (
    <div style={{padding:16}}>
      <h2>Users</h2>
      <div style={{display:'flex', gap:12, alignItems:'center'}}>
        <input className='form-input' placeholder='username' value={username} onChange={e=>setUsername(e.target.value)} style={{width:160}} />
        <input className='form-input' placeholder='password' type='password' value={password} onChange={e=>setPassword(e.target.value)} style={{width:200}} />
        <select value={role} onChange={e=>setRole(e.target.value)} style={{padding:8, borderRadius:10, border:'1px solid var(--bg-600)', background:'transparent', color:'var(--accent)'}}><option value='user'>user</option><option value='admin'>admin</option></select>
        <button className='btn-save' onClick={add}>Add</button>
      </div>

      <div style={{marginTop:12}}>
        <table style={{width:'100%'}}>
          <thead><tr><th>Username</th><th>Role</th><th></th></tr></thead>
          <tbody>
            {users.map(u => (
              <tr key={u.username}>
                <td>{u.username}</td>
                <td>{u.role}</td>
                <td style={{display:'flex',gap:8,alignItems:'center'}}>
                  {u.username !== 'admin' && <button className='btn-ghost' onClick={()=>remove(u.username)}>Delete</button>}
                  <input placeholder='new password' type='password' className='form-input' style={{marginLeft:8, width:200}} onKeyDown={async (e)=>{ if(e.key==='Enter'){ await changePassword(u.username, e.target.value); e.target.value=''; } }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
