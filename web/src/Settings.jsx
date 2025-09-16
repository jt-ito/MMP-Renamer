import React, { useState, useEffect } from 'react'
import axios from 'axios'

const API = (p) => `/api${p}`

function sanitizeForPreview(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '')
}

function renderPreviewSample(template) {
  const sample = {
    title: 'Example Show',
    basename: 'Example_Show_S01E02',
    year: '2023',
    epLabel: 'S01E02',
    episodeTitle: 'Pilot',
    season: '1',
    episode: '2',
    episodeRange: '01-02',
  tmdbId: '12345'
  }
  try {
    return String(template || '{title} - {epLabel} - {episodeTitle}')
      .replace('{title}', sanitizeForPreview(sample.title))
      .replace('{basename}', sanitizeForPreview(sample.basename))
      .replace('{year}', sample.year)
      .replace('{epLabel}', sample.epLabel)
      .replace('{episodeTitle}', sample.episodeTitle)
      .replace('{season}', sample.season)
      .replace('{episode}', sample.episode)
      .replace('{episodeRange}', sample.episodeRange)
  .replace('{tmdbId}', sample.tmdbId)
  } catch (e) { return template }
}

export default function Settings({ pushToast }){
  // keys: tmdb for TMDb (keep backward compatibility with tvdb_api_key)
  const [tmdbKey, setTmdbKey] = useState('')
  const [anilistKey, setAnilistKey] = useState('')
  const [defaultProvider, setDefaultProvider] = useState('tmdb')
  const [renameTemplate, setRenameTemplate] = useState('{title} - {epLabel} - {episodeTitle}')
  const [showTmdbKey, setShowTmdbKey] = useState(false)
  const [showAnilistKey, setShowAnilistKey] = useState(false)
  const [inputPath, setInputPath] = useState('')
  const [outputPath, setOutputPath] = useState('')
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    // prefer user-specific settings from server, fall back to localStorage
    axios.get(API('/settings')).then(r => {
      try {
        const user = (r.data && r.data.userSettings) ? r.data.userSettings : null
        if (user) {
          setTmdbKey(user.tmdb_api_key || user.tvdb_api_key || '')
          setAnilistKey(user.anilist_api_key || '')
          setDefaultProvider(user.default_meta_provider || 'tmdb')
          setRenameTemplate(user.rename_template || '{title} ({year}) - {epLabel} - {episodeTitle}')
          setInputPath(user.scan_input_path || '')
          setOutputPath(user.scan_output_path || '')
          return
        }
      } catch (e) {}
      try {
  const v = localStorage.getItem('tmdb_api_key') || localStorage.getItem('tvdb_api_key') || ''
  const a = localStorage.getItem('anilist_api_key') || ''
        const inp = localStorage.getItem('scan_input_path') || ''
        const out = localStorage.getItem('scan_output_path') || ''
        const dp = localStorage.getItem('default_meta_provider') || 'tmdb'
  setTmdbKey(v); setAnilistKey(a); setInputPath(inp); setOutputPath(out); setDefaultProvider(dp)
      } catch (e) {}
    }).catch(()=>{
      try {
        const v = localStorage.getItem('tmdb_api_key') || localStorage.getItem('tvdb_api_key') || ''
        const inp = localStorage.getItem('scan_input_path') || ''
        const out = localStorage.getItem('scan_output_path') || ''
        const dp = localStorage.getItem('default_meta_provider') || 'tmdb'
        setTmdbKey(v); setInputPath(inp); setOutputPath(out); setDefaultProvider(dp)
      } catch (e) {}
    })
  }, [])

  const [sessionUser, setSessionUser] = useState(null)
  useEffect(() => {
    axios.get(API('/session')).then(r => { if (r.data && r.data.authenticated) setSessionUser(r.data.username) }).catch(()=>{})
  }, [])

  const [inputExists, setInputExists] = useState(null)
  const [outputExists, setOutputExists] = useState(null)

  useEffect(() => {
    // initial validation for mounted values
    (async () => {
      if (inputPath) setInputExists((await checkPath(inputPath)).exists)
      if (outputPath) setOutputExists((await checkPath(outputPath)).exists)
    })()
  }, [])

  function save(){
    try {
      // save locally as fallback (tmdb)
      try { localStorage.setItem('tmdb_api_key', tmdbKey); localStorage.setItem('tvdb_api_key', tmdbKey) } catch (e) {}
  try { localStorage.setItem('anilist_api_key', anilistKey) } catch (e) {}
      try { localStorage.setItem('default_meta_provider', defaultProvider) } catch (e) {}
      localStorage.setItem('rename_template', renameTemplate)
      localStorage.setItem('scan_input_path', inputPath)
      localStorage.setItem('scan_output_path', outputPath)
      // persist server-side as per-user settings by default
  axios.post(API('/settings'), { tmdb_api_key: tmdbKey, tvdb_api_key: tmdbKey, anilist_api_key: anilistKey, default_meta_provider: defaultProvider, scan_input_path: inputPath, scan_output_path: outputPath, rename_template: renameTemplate })
        .then(() => pushToast && pushToast('Settings', 'Saved'))
        .catch(() => pushToast && pushToast('Settings', 'Saved locally; failed to save server-side'))
    } catch (e) { pushToast && pushToast('Error', 'Failed to save') }
  }

  function clearAll(){
    try {
      setTmdbKey('')
  setAnilistKey('')
      setDefaultProvider('tmdb')
      setInputPath('')
      setOutputPath('')
      localStorage.removeItem('tmdb_api_key')
      localStorage.removeItem('tvdb_api_key')
  localStorage.removeItem('anilist_api_key')
      localStorage.removeItem('default_meta_provider')
      localStorage.removeItem('scan_input_path')
      localStorage.removeItem('scan_output_path')
  axios.post(API('/settings'), { tmdb_api_key: '', anilist_api_key: '', default_meta_provider: 'tmdb', tvdb_api_key: '', scan_input_path: '', scan_output_path: '' }).catch(()=>{})
      pushToast && pushToast('Settings', 'Cleared')
    } catch (e) { pushToast && pushToast('Error', 'Failed to clear') }
  }

  async function checkPath(p) {
    try {
      if (!p) return { exists: false }
      const r = await axios.get(API('/path/exists'), { params: { path: p } })
      return r.data || { exists: false }
    } catch (e) { return { exists: false } }
  }

  return (
    <div style={{padding:16}}>
      <h2>Settings</h2>
      <div style={{marginTop:12}}>
        <div className="form-card">
          <div style={{display:'flex', flexDirection:'column', gap:12}}>

        <div>
          <label style={{fontSize:13, color:'var(--muted)'}}>TMDb API Key</label>
          <div style={{display:'flex', gap:8, marginTop:6}}>
            <input
              type={showTmdbKey ? 'text' : 'password'}
              value={tmdbKey}
              onChange={e=>{ setTmdbKey(e.target.value); setDirty(true) }}
              placeholder="Enter TMDb API key"
              style={{flex:1, padding:10, borderRadius:8, border:`1px solid var(--bg-600)`, background:'transparent', color:'var(--accent)'}}
            />
            <button className="btn-ghost" onClick={() => setShowTmdbKey(s => !s)}>{showTmdbKey ? 'Hide' : 'Show'}</button>
          </div>
          <div style={{fontSize:12, color:'var(--muted)', marginTop:8}}>TMDb is used for general TV/Movie lookups. The API key is obfuscated by default; toggle <strong>Show</strong> to reveal it temporarily.</div>
        </div>

        <div style={{marginTop:12}}>
          <label style={{fontSize:13, color:'var(--muted)'}}>AniList API Key</label>
          <div style={{display:'flex', gap:8, marginTop:6}}>
            <input
              type={showAnilistKey ? 'text' : 'password'}
              value={anilistKey}
              onChange={e=>{ setAnilistKey(e.target.value); setDirty(true) }}
              placeholder="Enter AniList API key (optional)"
              style={{flex:1, padding:10, borderRadius:8, border:`1px solid var(--bg-600)`, background:'transparent', color:'var(--accent)'}}
            />
            <button className="btn-ghost" onClick={() => setShowAnilistKey(s => !s)}>{showAnilistKey ? 'Hide' : 'Show'}</button>
          </div>
          <div style={{fontSize:12, color:'var(--muted)', marginTop:8}}>AniList is used to find anime series titles (preferred). The saved key is obfuscated by default; toggle <strong>Show</strong> to reveal it temporarily.</div>
        </div>

  {/* Input path moved below the template section per UX request */}

        <div>
          <label style={{fontSize:13, color:'var(--muted)'}}>Default rename template</label>
          <div style={{marginTop:8}}>
            <label style={{fontSize:13, color:'var(--muted)'}}>Preferred metadata provider</label>
            <div style={{display:'flex', gap:8, marginTop:6}}>
              <button className={defaultProvider === 'tmdb' ? 'btn-save' : 'btn-ghost'} onClick={() => { setDefaultProvider('tmdb'); setDirty(true) }}>TMDb</button>
            </div>
            <div style={{fontSize:12, color:'var(--muted)', marginTop:6}}>TMDb is the only external provider used for metadata lookups.</div>
          </div>
          <input value={renameTemplate} onChange={e=>{ setRenameTemplate(e.target.value); setDirty(true) }} placeholder="e.g. {title} ({year}) - {epLabel} - {episodeTitle}" style={{width:'100%', padding:10, borderRadius:8, border:`1px solid var(--bg-600)`, background:'transparent', color:'var(--accent)', marginTop:6}} />
          <div style={{fontSize:12, color:'var(--muted)', marginTop:8}}>Available tokens: <code>{'{title}'}</code>, <code>{'{basename}'}</code>, <code>{'{year}'}</code>, <code>{'{epLabel}'}</code>, <code>{'{episodeTitle}'}</code>, <code>{'{season}'}</code>, <code>{'{episode}'}</code>, <code>{'{episodeRange}'}</code>, <code>{'{tmdbId}'}</code> <span style={{opacity:0.8}}>({'{tmdbId}'} contains the TMDb id)</span></div>
          <div style={{marginTop:10, padding:10, borderRadius:8, background:'var(--bg-700)'}}>
            <strong style={{fontSize:13}}>Live preview</strong>
            <div style={{marginTop:8, fontSize:14}}>{renderPreviewSample(renameTemplate)}</div>
            <div style={{fontSize:12, color:'var(--muted)', marginTop:6}}>Preview uses a sample: Title="Example Show", S01E02, EpisodeTitle="Pilot"</div>
          </div>
        </div>

        <div>
          <label style={{fontSize:13, color:'var(--muted)'}}>Output path (hardlinks)</label>
          <input value={outputPath} onChange={e=>{ setOutputPath(e.target.value); setOutputExists(null); setDirty(true) }} onBlur={async () => setOutputExists((await checkPath(outputPath)).exists)} placeholder="e.g. D:\\JellyfinMedia\\TV" style={{width:'100%', padding:10, borderRadius:8, border:`1px solid var(--bg-600)`, background:'transparent', color:'var(--accent)', marginTop:6}} />
          <div style={{fontSize:12, color: outputExists === false ? '#ffb4b4' : 'var(--muted)', marginTop:6}}>
            {outputExists === false ? 'Output path does not exist — hardlink operations will fail until this is fixed.' : 'When a rename/hardlink operation is applied the tool will create hardlinks under this output path using a naming scheme compatible with Jellyfin. Example layout: '}<code>Show Title (Year)/Season 01/Show Title (Year) - S01E01 - Episode Title.ext</code>.
          </div>
        </div>

        <div style={{marginTop:12}}>
          <label style={{fontSize:13, color:'var(--muted)'}}>Input path (scanned)</label>
          <input value={inputPath} onChange={e=>{ setInputPath(e.target.value); setInputExists(null); setDirty(true) }} onBlur={async () => setInputExists((await checkPath(inputPath)).exists)} placeholder="e.g. C:\\Media\\TV" style={{width:'100%', padding:10, borderRadius:8, border:`1px solid var(--bg-600)`, background:'transparent', color:'var(--accent)', marginTop:6}} />
          <div style={{fontSize:12, color: inputExists === false ? '#ffb4b4' : 'var(--muted)', marginTop:6}}>{inputExists === false ? 'Path does not exist or is invalid' : 'Path that will be scanned for media files.'}</div>
        </div>

        <div style={{marginTop:18}}>
          <label style={{fontSize:13, color:'var(--muted)'}}>Unapprove (unhide) recent applied items</label>
          <div style={{display:'flex', gap:8, marginTop:8, alignItems:'center'}}>
            <select id='unapproveCount' defaultValue='10' className='form-input'>
              <option value='5'>Last 5</option>
              <option value='10'>Last 10</option>
              <option value='20'>Last 20</option>
              <option value='all'>All</option>
            </select>
            <button className='btn-ghost' style={{padding:'10px 14px'}} onClick={async () => {
              const v = document.getElementById('unapproveCount').value
              const n = v === 'all' ? 0 : parseInt(v,10)
              try {
                const r = await axios.post(API('/rename/unapprove'), { count: n })
                pushToast && pushToast('Unapprove', `Unapproved ${r.data.unapproved || 0} items`)
                try {
                  // notify app to refresh items that were unapproved
                  if (r.data && r.data.unapproved && Array.isArray(r.data.unapproved) && r.data.unapproved.length > 0) {
                    window.dispatchEvent(new CustomEvent('renamer:unapproved', { detail: { paths: r.data.unapproved } }))
                  }
                } catch (e) {}
              } catch (e) { pushToast && pushToast('Unapprove', 'Unapprove failed') }
            }}>Unapprove</button>
          </div>
          <div style={{fontSize:12, color:'var(--muted)', marginTop:8}}>Unapproving will mark recently applied items as visible again for rescans. Choose the number of recent applied items to unhide.</div>
        </div>

                <div style={{display:'flex', gap:8}}>
                  <button className={"btn-save" + (dirty ? '' : ' disabled')} onClick={save} disabled={!dirty}>Save</button>
                  <button className="btn-ghost" onClick={clearAll}>Clear</button>
                </div>
          </div>
        </div>

        <div style={{marginTop:24}}>
          <h3>Change password</h3>
          <div style={{marginTop:8}}>
            <div className="form-card">
              <div style={{display:'flex', flexDirection:'column', gap:10}}>
                <div>
                  <label className="form-label">Current password</label>
                  <input id='curpwd' className='form-input' placeholder='Current password' type='password' />
                </div>
                <div>
                  <label className="form-label">New password</label>
                  <input id='newpwd' className='form-input' placeholder='New password' type='password' />
                </div>
                <div style={{display:'flex', gap:8, justifyContent:'flex-end'}}>
                  <button className='btn-ghost' type='button' onClick={()=>{ document.getElementById('curpwd').value=''; document.getElementById('newpwd').value=''}} >Clear</button>
                  <button className={'btn-save' + (dirty ? '' : ' disabled')} onClick={async ()=>{
                    const cur = document.getElementById('curpwd').value
                    const nw = document.getElementById('newpwd').value
                    if (!sessionUser) { pushToast && pushToast('Auth','Not signed in'); return }
                    try {
                      await axios.post(API(`/users/${sessionUser}/password`), { currentPassword: cur, newPassword: nw })
                      pushToast && pushToast('Auth','Password changed')
                      document.getElementById('curpwd').value=''; document.getElementById('newpwd').value=''
                    } catch (err) { pushToast && pushToast('Auth','Change failed') }
                  }}>Change password</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
