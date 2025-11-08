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
  const [anidbUsername, setAnidbUsername] = useState('')
  const [anidbPassword, setAnidbPassword] = useState('')
  const [tvdbV4ApiKey, setTvdbV4ApiKey] = useState('')
  const [tvdbV4UserPin, setTvdbV4UserPin] = useState('')
  const [defaultProvider, setDefaultProvider] = useState('tmdb')
  const [renameTemplate, setRenameTemplate] = useState('{title} - {epLabel} - {episodeTitle}')
  const [showTmdbKey, setShowTmdbKey] = useState(false)
  const [showAnilistKey, setShowAnilistKey] = useState(false)
  const [showAnidbUsername, setShowAnidbUsername] = useState(false)
  const [showAnidbPassword, setShowAnidbPassword] = useState(false)
  const [showTvdbV4ApiKey, setShowTvdbV4ApiKey] = useState(false)
  const [showTvdbV4UserPin, setShowTvdbV4UserPin] = useState(false)
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
          setAnidbUsername(user.anidb_username || '')
          setAnidbPassword(user.anidb_password || '')
          setTvdbV4ApiKey(user.tvdb_v4_api_key || '')
          setTvdbV4UserPin(user.tvdb_v4_user_pin || '')
          setDefaultProvider(user.default_meta_provider || 'tmdb')
          setRenameTemplate(user.rename_template || '{title} ({year}) - {epLabel} - {episodeTitle}')
          setInputPath(user.scan_input_path || '')
          setOutputPath(user.scan_output_path || '')
          return
        }
      } catch (e) {}
      try {
        const server = (r.data && r.data.serverSettings) ? r.data.serverSettings : {}
        const v = server.tmdb_api_key || localStorage.getItem('tmdb_api_key') || localStorage.getItem('tvdb_api_key') || ''
        const a = server.anilist_api_key || localStorage.getItem('anilist_api_key') || ''
        const anidbUser = server.anidb_username || localStorage.getItem('anidb_username') || ''
        const anidbPass = server.anidb_password || localStorage.getItem('anidb_password') || ''
        const tvV4Key = server.tvdb_v4_api_key || localStorage.getItem('tvdb_v4_api_key') || ''
        const tvV4Pin = server.tvdb_v4_user_pin || localStorage.getItem('tvdb_v4_user_pin') || ''
        const inp = localStorage.getItem('scan_input_path') || ''
        const out = localStorage.getItem('scan_output_path') || ''
        const dp = localStorage.getItem('default_meta_provider') || 'tmdb'
        setTmdbKey(v)
        setAnilistKey(a)
        setAnidbUsername(anidbUser)
        setAnidbPassword(anidbPass)
        setTvdbV4ApiKey(tvV4Key)
        setTvdbV4UserPin(tvV4Pin)
        setInputPath(inp)
        setOutputPath(out)
        setDefaultProvider(dp)
      } catch (e) {}
    }).catch(()=>{
      try {
        const v = localStorage.getItem('tmdb_api_key') || localStorage.getItem('tvdb_api_key') || ''
        const a = localStorage.getItem('anilist_api_key') || ''
        const anidbUser = localStorage.getItem('anidb_username') || ''
        const anidbPass = localStorage.getItem('anidb_password') || ''
        const tvV4Key = localStorage.getItem('tvdb_v4_api_key') || ''
        const tvV4Pin = localStorage.getItem('tvdb_v4_user_pin') || ''
        const inp = localStorage.getItem('scan_input_path') || ''
        const out = localStorage.getItem('scan_output_path') || ''
        const dp = localStorage.getItem('default_meta_provider') || 'tmdb'
        setTmdbKey(v)
        setAnilistKey(a)
        setAnidbUsername(anidbUser)
        setAnidbPassword(anidbPass)
        setTvdbV4ApiKey(tvV4Key)
        setTvdbV4UserPin(tvV4Pin)
        setInputPath(inp)
        setOutputPath(out)
        setDefaultProvider(dp)
      } catch (e) {}
    }).finally(() => { setDirty(false) })
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
      try { localStorage.setItem('anidb_username', anidbUsername) } catch (e) {}
      try { localStorage.setItem('anidb_password', anidbPassword) } catch (e) {}
      try { localStorage.setItem('tvdb_v4_api_key', tvdbV4ApiKey) } catch (e) {}
      try { localStorage.setItem('tvdb_v4_user_pin', tvdbV4UserPin) } catch (e) {}
      try { localStorage.setItem('default_meta_provider', defaultProvider) } catch (e) {}
      localStorage.setItem('rename_template', renameTemplate)
      localStorage.setItem('scan_input_path', inputPath)
      localStorage.setItem('scan_output_path', outputPath)
      // persist server-side as per-user settings by default
      axios.post(API('/settings'), {
        tmdb_api_key: tmdbKey,
        anilist_api_key: anilistKey,
        anidb_username: anidbUsername,
        anidb_password: anidbPassword,
        tvdb_v4_api_key: tvdbV4ApiKey,
        tvdb_v4_user_pin: tvdbV4UserPin,
        default_meta_provider: defaultProvider,
        scan_input_path: inputPath,
        scan_output_path: outputPath,
        rename_template: renameTemplate
      })
        .then(() => { pushToast && pushToast('Settings', 'Saved'); setDirty(false) })
        .catch(() => pushToast && pushToast('Settings', 'Saved locally; failed to save server-side'))
    } catch (e) { pushToast && pushToast('Error', 'Failed to save') }
  }

  function clearAll(){
    try {
      setTmdbKey('')
      setAnilistKey('')
      setAnidbUsername('')
      setAnidbPassword('')
      setTvdbV4ApiKey('')
      setTvdbV4UserPin('')
      setDefaultProvider('tmdb')
      setRenameTemplate('{title} - {epLabel} - {episodeTitle}')
      setInputPath('')
      setOutputPath('')
      localStorage.removeItem('tmdb_api_key')
      localStorage.removeItem('anilist_api_key')
      localStorage.removeItem('anidb_username')
      localStorage.removeItem('anidb_password')
      localStorage.removeItem('tvdb_api_key')
      localStorage.removeItem('tvdb_v4_api_key')
      localStorage.removeItem('tvdb_v4_user_pin')
      localStorage.removeItem('default_meta_provider')
      localStorage.removeItem('scan_input_path')
      localStorage.removeItem('scan_output_path')
      localStorage.setItem('rename_template', '{title} - {epLabel} - {episodeTitle}')
      axios.post(API('/settings'), { tmdb_api_key: '', anilist_api_key: '', anidb_username: '', anidb_password: '', default_meta_provider: 'tmdb', tvdb_v4_api_key: '', tvdb_v4_user_pin: '', scan_input_path: '', scan_output_path: '', rename_template: '{title} - {epLabel} - {episodeTitle}' }).catch(()=>{})
      setDirty(false)
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
          <label style={{fontSize:13, color:'var(--muted)'}}>TVDB v4 Credentials</label>
          <div style={{display:'flex', gap:8, marginTop:6}}>
            <input
              type={showTvdbV4ApiKey ? 'text' : 'password'}
              value={tvdbV4ApiKey}
              onChange={e=>{ setTvdbV4ApiKey(e.target.value); setDirty(true) }}
              placeholder="Project API key"
              style={{flex:1, padding:10, borderRadius:8, border:`1px solid var(--bg-600)`, background:'transparent', color:'var(--accent)'}}
            />
            <button className="btn-ghost" onClick={() => setShowTvdbV4ApiKey(s => !s)}>{showTvdbV4ApiKey ? 'Hide' : 'Show'}</button>
          </div>
          <div style={{display:'flex', gap:8, marginTop:10}}>
            <input
              type={showTvdbV4UserPin ? 'text' : 'password'}
              value={tvdbV4UserPin}
              onChange={e=>{ setTvdbV4UserPin(e.target.value); setDirty(true) }}
              placeholder="User PIN (optional)"
              style={{flex:1, padding:10, borderRadius:8, border:`1px solid var(--bg-600)`, background:'transparent', color:'var(--accent)'}}
            />
            <button className="btn-ghost" onClick={() => setShowTvdbV4UserPin(s => !s)}>{showTvdbV4UserPin ? 'Hide' : 'Show'}</button>
          </div>
          <div style={{fontSize:12, color:'var(--muted)', marginTop:8}}>Use theTVDB project API key and optional user PIN from your v4 account dashboard. Tokens automatically refresh once these values are set.</div>
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

        <div style={{marginTop:12}}>
          <label style={{fontSize:13, color:'var(--muted)'}}>AniDB Credentials (Anime File Hash Lookup)</label>
          <div style={{display:'flex', gap:8, marginTop:6}}>
            <input
              type={showAnidbUsername ? 'text' : 'password'}
              value={anidbUsername}
              onChange={e=>{ setAnidbUsername(e.target.value); setDirty(true) }}
              placeholder="AniDB Username"
              style={{flex:1, padding:10, borderRadius:8, border:`1px solid var(--bg-600)`, background:'transparent', color:'var(--accent)'}}
            />
            <button className="btn-ghost" onClick={() => setShowAnidbUsername(s => !s)}>{showAnidbUsername ? 'Hide' : 'Show'}</button>
          </div>
          <div style={{display:'flex', gap:8, marginTop:10}}>
            <input
              type={showAnidbPassword ? 'text' : 'password'}
              value={anidbPassword}
              onChange={e=>{ setAnidbPassword(e.target.value); setDirty(true) }}
              placeholder="AniDB Password"
              style={{flex:1, padding:10, borderRadius:8, border:`1px solid var(--bg-600)`, background:'transparent', color:'var(--accent)'}}
            />
            <button className="btn-ghost" onClick={() => setShowAnidbPassword(s => !s)}>{showAnidbPassword ? 'Hide' : 'Show'}</button>
          </div>
          <div style={{fontSize:12, color:'var(--muted)', marginTop:8, lineHeight:'1.6'}}>
            <div style={{marginBottom:8}}>
              <strong>Setup Instructions:</strong>
            </div>
            <ol style={{marginLeft:20, marginBottom:8, paddingLeft:0}}>
              <li>Create a free account at <a href="https://anidb.net/user/register" target="_blank" rel="noopener noreferrer" style={{color:'var(--accent)'}}>anidb.net</a></li>
              <li>Register this client at <a href="https://anidb.net/software/add" target="_blank" rel="noopener noreferrer" style={{color:'var(--accent)'}}>AniDB Software Registration</a>
                <ul style={{marginLeft:20, marginTop:4, fontSize:11, opacity:0.9}}>
                  <li>Client name: <code style={{background:'var(--bg-700)', padding:'2px 6px', borderRadius:4}}>mmprename</code></li>
                  <li>Version: <code style={{background:'var(--bg-700)', padding:'2px 6px', borderRadius:4}}>1</code></li>
                  <li>Purpose: "Anime file renaming and metadata lookup"</li>
                </ul>
              </li>
              <li>Wait for moderator approval (usually 1-2 days)</li>
              <li>Enter your AniDB username and password above</li>
            </ol>
            <div style={{marginTop:8, padding:8, background:'var(--bg-700)', borderRadius:6, fontSize:11}}>
              <strong>How it works:</strong> AniDB uses <strong>ED2K file hashing</strong> to identify anime episodes with 99% accuracy, even with bad filenames. 
              Rate-limited to respect AniDB guidelines (2.5s between requests). Falls back to AniList/TVDb if file not found or client not registered yet.
            </div>
          </div>
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
              <option value='1'>Last 1</option>
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
            <button
              className='btn-ghost'
              style={{ padding: '10px 14px', fontSize: 13, lineHeight: 1.2, whiteSpace: 'nowrap' }}
              onClick={() => { window.location.hash = '#/hidden' }}
            >Review hidden items</button>
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
