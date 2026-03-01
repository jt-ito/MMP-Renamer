import React, { useState, useEffect, useMemo } from 'react'
import axios from 'axios'

const API = (p) => `/api${p}`

const PROVIDERS = [
  { id: 'anidb', label: 'AniDB', description: 'ED2K hash lookup for anime (series and episodes).' },
  { id: 'anilist', label: 'AniList', description: 'Anime catalog titles (series metadata only).' },
  { id: 'tvdb', label: 'TVDB', description: 'Series and episode metadata with localized titles.' },
  { id: 'tmdb', label: 'TMDb', description: 'Series and episode metadata via The Movie Database.' },
  { id: 'wikipedia', label: 'Wikipedia', description: 'Episode titles from Wikipedia episode lists.' },
  { id: 'kitsu', label: 'Kitsu', description: 'Anime episode metadata from Kitsu.io.' }
]

const PROVIDER_IDS = PROVIDERS.map(p => p.id)
const DEFAULT_PROVIDER_ORDER = ['anidb', 'anilist', 'tvdb', 'tmdb']

function sanitizeProviderOrder(value) {
  if (!value) return [...DEFAULT_PROVIDER_ORDER]
  let arr = []
  if (Array.isArray(value)) arr = value
  else if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) arr = parsed
      else if (typeof parsed === 'string') arr = parsed.split(',')
    } catch (e) {
      arr = value.split(',')
    }
  }
  const seen = new Set()
  const out = []
  for (const raw of arr) {
    const id = String(raw || '').trim().toLowerCase()
    if (!id || !PROVIDER_IDS.includes(id)) continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  if (!out.length) return [...DEFAULT_PROVIDER_ORDER]
  return out
}

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
  const [anidbClientName, setAnidbClientName] = useState('mediabrowser')
  const [anidbClientVersion, setAnidbClientVersion] = useState('1')
  const [tvdbV4ApiKey, setTvdbV4ApiKey] = useState('')
  const [tvdbV4UserPin, setTvdbV4UserPin] = useState('')
  const [providerOrder, setProviderOrder] = useState([...DEFAULT_PROVIDER_ORDER])
  const [dragProvider, setDragProvider] = useState(null)
  const [dragOverIndex, setDragOverIndex] = useState(null)
  const [renameTemplate, setRenameTemplate] = useState('{title} - {epLabel} - {episodeTitle}')
  const [showTmdbKey, setShowTmdbKey] = useState(false)
  const [showAnilistKey, setShowAnilistKey] = useState(false)
  const [showAnidbUsername, setShowAnidbUsername] = useState(false)
  const [showAnidbPassword, setShowAnidbPassword] = useState(false)
  const [showTvdbV4ApiKey, setShowTvdbV4ApiKey] = useState(false)
  const [showTvdbV4UserPin, setShowTvdbV4UserPin] = useState(false)
  const [inputPath, setInputPath] = useState('')
  const [outputPath, setOutputPath] = useState('')
  const [outputFolders, setOutputFolders] = useState([])
  const [outputFoldersDirty, setOutputFoldersDirty] = useState([])
  const [enableFolderWatch, setEnableFolderWatch] = useState(false)
  const [deleteHardlinksOnUnapprove, setDeleteHardlinksOnUnapprove] = useState(true)
  const [dirty, setDirty] = useState(false)
  const [clientOS, setClientOS] = useState(typeof window !== 'undefined' ? (localStorage.getItem('client_os') || 'linux') : 'linux')
  const [logTimezone, setLogTimezone] = useState(typeof window !== 'undefined' ? (localStorage.getItem('log_timezone') || '') : '')

  const timezones = useMemo(() => {
    try {
      if (typeof Intl !== 'undefined' && typeof Intl.supportedValuesOf === 'function') {
        const tzs = Intl.supportedValuesOf('timeZone') || []
        if (Array.isArray(tzs) && tzs.length) return tzs
      }
    } catch (e) {}
    return [
      'UTC',
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Los_Angeles',
      'Europe/London',
      'Europe/Berlin',
      'Asia/Tokyo',
      'Asia/Seoul',
      'Asia/Shanghai',
      'Australia/Sydney'
    ]
  }, [])

  useEffect(() => {
    // prefer user-specific settings from server, fall back to localStorage
    axios.get(API('/settings')).then(r => {
      const server = (r.data && r.data.serverSettings) ? r.data.serverSettings : {}
      try {
        const user = (r.data && r.data.userSettings) ? r.data.userSettings : null
        if (user) {
          setTmdbKey(user.tmdb_api_key || user.tvdb_api_key || '')
          setAnilistKey(user.anilist_api_key || '')
          setAnidbUsername(user.anidb_username || '')
          setAnidbPassword(user.anidb_password || '')
          setAnidbClientName(user.anidb_client_name || 'mediabrowser')
          setAnidbClientVersion(user.anidb_client_version || '1')
          setTvdbV4ApiKey(user.tvdb_v4_api_key || '')
          setTvdbV4UserPin(user.tvdb_v4_user_pin || '')
          setProviderOrder(sanitizeProviderOrder(user.metadata_provider_order || user.default_meta_provider))
          setRenameTemplate(user.rename_template || '{title} ({year}) - {epLabel} - {episodeTitle}')
          setInputPath(user.scan_input_path || '')
          setOutputPath(user.scan_output_path || '')
          setEnableFolderWatch(user.enable_folder_watch === true || user.enable_folder_watch === 'true')
          const deleteLinksPref = user.delete_hardlinks_on_unapprove
          const serverDeletePref = server.delete_hardlinks_on_unapprove
          const resolvedDeletePref = deleteLinksPref === undefined
            ? (serverDeletePref === undefined ? true : (serverDeletePref === true || serverDeletePref === 'true'))
            : (deleteLinksPref === true || deleteLinksPref === 'true')
          setDeleteHardlinksOnUnapprove(resolvedDeletePref)
          const folders = Array.isArray(user.output_folders) ? user.output_folders : []
          setOutputFolders(folders)
          setOutputFoldersDirty(new Array(folders.length).fill(false))
          setLogTimezone(user.log_timezone || '')
          return
        }
      } catch (e) {}
      try {
        const v = server.tmdb_api_key || localStorage.getItem('tmdb_api_key') || localStorage.getItem('tvdb_api_key') || ''
        const a = server.anilist_api_key || localStorage.getItem('anilist_api_key') || ''
        const anidbUser = server.anidb_username || localStorage.getItem('anidb_username') || ''
        const anidbPass = server.anidb_password || localStorage.getItem('anidb_password') || ''
        const anidbClient = server.anidb_client_name || localStorage.getItem('anidb_client_name') || 'mediabrowser'
        const anidbVer = server.anidb_client_version || localStorage.getItem('anidb_client_version') || '1'
        const tvV4Key = server.tvdb_v4_api_key || localStorage.getItem('tvdb_v4_api_key') || ''
        const tvV4Pin = server.tvdb_v4_user_pin || localStorage.getItem('tvdb_v4_user_pin') || ''
        const inp = localStorage.getItem('scan_input_path') || ''
        const out = localStorage.getItem('scan_output_path') || ''
        const storedWatch = localStorage.getItem('enable_folder_watch') === 'true'
  const serverDeletePref = server.delete_hardlinks_on_unapprove
        const storedDeletePref = localStorage.getItem('delete_hardlinks_on_unapprove')
        const deletePref = storedDeletePref != null
          ? storedDeletePref !== 'false'
          : (serverDeletePref === undefined ? true : (serverDeletePref === true || serverDeletePref === 'true'))
        const storedOrder = localStorage.getItem('metadata_provider_order') || localStorage.getItem('default_meta_provider')
        const storedFolders = localStorage.getItem('output_folders')
        setTmdbKey(v)
        setAnilistKey(a)
        setAnidbUsername(anidbUser)
        setAnidbPassword(anidbPass)
        setAnidbClientName(anidbClient)
        setAnidbClientVersion(anidbVer)
        setTvdbV4ApiKey(tvV4Key)
        setTvdbV4UserPin(tvV4Pin)
        setInputPath(inp)
        setOutputPath(out)
        setEnableFolderWatch(storedWatch)
  setDeleteHardlinksOnUnapprove(deletePref)
          setLogTimezone(server.log_timezone || localStorage.getItem('log_timezone') || '')
        setProviderOrder(sanitizeProviderOrder(storedOrder))
        try {
          const parsedFolders = storedFolders ? JSON.parse(storedFolders) : []
          const normalizedFolders = Array.isArray(parsedFolders) ? parsedFolders : []
          setOutputFolders(normalizedFolders)
          setOutputFoldersDirty(new Array(normalizedFolders.length).fill(false))
        } catch (e) {
          setOutputFolders([])
          setOutputFoldersDirty([])
        }
      } catch (e) {}
    }).catch(()=>{
      try {
        const v = localStorage.getItem('tmdb_api_key') || localStorage.getItem('tvdb_api_key') || ''
        const a = localStorage.getItem('anilist_api_key') || ''
        const anidbUser = localStorage.getItem('anidb_username') || ''
        const anidbPass = localStorage.getItem('anidb_password') || ''
        const anidbClient = localStorage.getItem('anidb_client_name') || 'mediabrowser'
        const anidbVer = localStorage.getItem('anidb_client_version') || '1'
        const tvV4Key = localStorage.getItem('tvdb_v4_api_key') || ''
        const tvV4Pin = localStorage.getItem('tvdb_v4_user_pin') || ''
        const inp = localStorage.getItem('scan_input_path') || ''
        const out = localStorage.getItem('scan_output_path') || ''
  const storedOrder = localStorage.getItem('metadata_provider_order') || localStorage.getItem('default_meta_provider')
  const storedDeletePref = localStorage.getItem('delete_hardlinks_on_unapprove')
        const storedFolders = localStorage.getItem('output_folders')
        setTmdbKey(v)
        setAnilistKey(a)
        setAnidbUsername(anidbUser)
        setAnidbPassword(anidbPass)
        setAnidbClientName(anidbClient)
        setAnidbClientVersion(anidbVer)
        setTvdbV4ApiKey(tvV4Key)
        setTvdbV4UserPin(tvV4Pin)
        setInputPath(inp)
        setOutputPath(out)
        setProviderOrder(sanitizeProviderOrder(storedOrder))
  setDeleteHardlinksOnUnapprove(storedDeletePref == null ? true : storedDeletePref !== 'false')
          setLogTimezone(localStorage.getItem('log_timezone') || '')
        try {
          const parsedFolders = storedFolders ? JSON.parse(storedFolders) : []
          const normalizedFolders = Array.isArray(parsedFolders) ? parsedFolders : []
          setOutputFolders(normalizedFolders)
          setOutputFoldersDirty(new Array(normalizedFolders.length).fill(false))
          setClientOS(localStorage.getItem('client_os') || 'linux')
        } catch (e) {
          setOutputFolders([])
          setOutputFoldersDirty([])
        }
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

  async function save(){
    try {
      // save locally as fallback (tmdb)
      try { localStorage.setItem('tmdb_api_key', tmdbKey); localStorage.setItem('tvdb_api_key', tmdbKey) } catch (e) {}
      try { localStorage.setItem('anilist_api_key', anilistKey) } catch (e) {}
      try { localStorage.setItem('anidb_username', anidbUsername) } catch (e) {}
      try { localStorage.setItem('anidb_password', anidbPassword) } catch (e) {}
      try { localStorage.setItem('anidb_client_name', anidbClientName) } catch (e) {}
      try { localStorage.setItem('anidb_client_version', anidbClientVersion) } catch (e) {}
      try { localStorage.setItem('tvdb_v4_api_key', tvdbV4ApiKey) } catch (e) {}
      try { localStorage.setItem('tvdb_v4_user_pin', tvdbV4UserPin) } catch (e) {}
      try { localStorage.setItem('metadata_provider_order', JSON.stringify(providerOrder)) } catch (e) {}
      try { localStorage.setItem('default_meta_provider', providerOrder[0] || 'tmdb') } catch (e) {}
      localStorage.setItem('rename_template', renameTemplate)
      try { localStorage.setItem('client_os', clientOS) } catch (e) {}
      localStorage.setItem('scan_input_path', inputPath)
      localStorage.setItem('scan_output_path', outputPath)
      localStorage.setItem('enable_folder_watch', String(enableFolderWatch))
      localStorage.setItem('delete_hardlinks_on_unapprove', String(deleteHardlinksOnUnapprove))
      try { localStorage.setItem('output_folders', JSON.stringify(outputFolders)) } catch (e) {}
      try { localStorage.setItem('log_timezone', logTimezone) } catch (e) {}
      const firstProvider = providerOrder[0] || 'tmdb'
      try {
        await axios.post(API('/settings'), {
          tmdb_api_key: tmdbKey,
          anilist_api_key: anilistKey,
          anidb_username: anidbUsername,
          anidb_password: anidbPassword,
          anidb_client_name: anidbClientName,
          anidb_client_version: anidbClientVersion,
          tvdb_v4_api_key: tvdbV4ApiKey,
          tvdb_v4_user_pin: tvdbV4UserPin,
          default_meta_provider: firstProvider,
          metadata_provider_order: providerOrder,
          scan_input_path: inputPath,
          scan_output_path: outputPath,
          enable_folder_watch: enableFolderWatch,
          delete_hardlinks_on_unapprove: deleteHardlinksOnUnapprove,
          output_folders: outputFolders,
          rename_template: renameTemplate,
          client_os: clientOS,
          log_timezone: logTimezone
        })
        try {
          window.dispatchEvent(new CustomEvent('renamer:settings-log-timezone', {
            detail: { logTimezone }
          }))
        } catch (e) {}
        pushToast && pushToast('Settings', 'Saved')
        setDirty(false)
        setOutputFoldersDirty(new Array(outputFolders.length).fill(false))
      } catch (err) {
        pushToast && pushToast('Settings', 'Saved locally; failed to save server-side')
      }
    } catch (e) { if (pushToast) pushToast('Error', 'Failed to save') }
  }

  function clearAll(){
    try {
      setTmdbKey('')
      setAnilistKey('')
      setAnidbUsername('')
      setAnidbPassword('')
      setAnidbClientName('mediabrowser')
      setAnidbClientVersion('1')
      setTvdbV4ApiKey('')
      setTvdbV4UserPin('')
      setProviderOrder([...DEFAULT_PROVIDER_ORDER])
      setRenameTemplate('{title} - {epLabel} - {episodeTitle}')
      setInputPath('')
      setOutputPath('')
  setEnableFolderWatch(false)
  setDeleteHardlinksOnUnapprove(true)
  setOutputFolders([])
  setOutputFoldersDirty([])
      setLogTimezone('')
      localStorage.removeItem('tmdb_api_key')
      localStorage.removeItem('anilist_api_key')
      localStorage.removeItem('anidb_username')
      localStorage.removeItem('anidb_password')
      localStorage.removeItem('tvdb_api_key')
      localStorage.removeItem('tvdb_v4_api_key')
      localStorage.removeItem('tvdb_v4_user_pin')
      localStorage.removeItem('default_meta_provider')
      localStorage.removeItem('metadata_provider_order')
      localStorage.removeItem('scan_input_path')
      localStorage.removeItem('scan_output_path')
      localStorage.removeItem('enable_folder_watch')
  localStorage.removeItem('delete_hardlinks_on_unapprove')
  localStorage.removeItem('output_folders')
        localStorage.removeItem('client_os')
        localStorage.removeItem('log_timezone')
      localStorage.setItem('rename_template', '{title} - {epLabel} - {episodeTitle}')
  axios.post(API('/settings'), { tmdb_api_key: '', anilist_api_key: '', anidb_username: '', anidb_password: '', default_meta_provider: 'tmdb', metadata_provider_order: DEFAULT_PROVIDER_ORDER, tvdb_v4_api_key: '', tvdb_v4_user_pin: '', scan_input_path: '', scan_output_path: '', enable_folder_watch: false, rename_template: '{title} - {epLabel} - {episodeTitle}', output_folders: [], log_timezone: '' }).catch(()=>{})
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


  const providerDetails = useMemo(() => {
    const map = new Map()
    for (const p of PROVIDERS) map.set(p.id, p)
    return map
  }, [])

  const orderedProviders = useMemo(() => {
    const active = providerOrder
      .map(id => providerDetails.get(id))
      .filter(Boolean)
    const inactive = PROVIDERS.filter(p => !providerOrder.includes(p.id))
    return [...active, ...inactive]
  }, [providerDetails, providerOrder])

  return (
    <div className="settings-page-content">
      <h2>Settings</h2>
  <div className="settings-section-stack">
        
        {/* API Keys Section */}
  <div className="form-card">
          <h3 style={{marginTop:0, marginBottom:16, fontSize:16, fontWeight:600}}>API Keys</h3>
          <div style={{display:'flex', flexDirection:'column', gap:16}}>

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
          <div style={{display:'flex', gap:8, marginTop:10}}>
            <input
              type="text"
              value={anidbClientName}
              onChange={e=>{ setAnidbClientName(e.target.value); setDirty(true) }}
              placeholder="Client Name (default: mediabrowser)"
              style={{flex:1, padding:10, borderRadius:8, border:`1px solid var(--bg-600)`, background:'transparent', color:'var(--accent)'}}
            />
          </div>
          <div style={{display:'flex', gap:8, marginTop:10}}>
            <input
              type="text"
              value={anidbClientVersion}
              onChange={e=>{ setAnidbClientVersion(e.target.value); setDirty(true) }}
              placeholder="Client Version (default: 1)"
              style={{flex:1, padding:10, borderRadius:8, border:`1px solid var(--bg-600)`, background:'transparent', color:'var(--accent)'}}
            />
          </div>
          <div style={{fontSize:12, color:'var(--muted)', marginTop:8, lineHeight:'1.6'}}>
            <div style={{marginBottom:8}}>
              <strong>Setup Instructions:</strong>
            </div>
            <ol style={{marginLeft:20, marginBottom:8, paddingLeft:0}}>
              <li>Create a free account at <a href="https://anidb.net/user/register" target="_blank" rel="noopener noreferrer" style={{color:'var(--accent)'}}>anidb.net</a></li>
              <li>Register this client at <a href="https://anidb.net/software/add" target="_blank" rel="noopener noreferrer" style={{color:'var(--accent)'}}>AniDB Software Registration</a>
                <ul style={{marginLeft:20, marginTop:4, fontSize:11, opacity:0.9}}>
                  <li>Client name: <code style={{background:'var(--bg-700)', padding:'2px 6px', borderRadius:4}}>{anidbClientName || 'mediabrowser'}</code></li>
                  <li>Version: <code style={{background:'var(--bg-700)', padding:'2px 6px', borderRadius:4}}>{anidbClientVersion || '1'}</code></li>
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
          </div>
        </div>

  {/* Input path moved below the template section per UX request */}

        {/* Metadata & Paths Section */}
  <div className="form-card">
          <h3 style={{marginTop:0, marginBottom:16, fontSize:16, fontWeight:600}}>Metadata & File Paths</h3>
          <div style={{display:'flex', flexDirection:'column', gap:16}}>

        <div>
          <label style={{fontSize:13, color:'var(--muted)'}}>Default rename template</label>
          <div style={{marginTop:8}}>
            <label style={{fontSize:13, color:'var(--muted)'}}>Metadata providers</label>
            <div style={{fontSize:12, color:'var(--muted)', marginTop:4, marginBottom:8}}>
              Drag and drop to reorder providers. The first provider in the list is used first.
            </div>
            <div style={{display:'flex', gap:8, marginBottom:8}}>
              {providerOrder.map((id, index) => (
                <div key={`label-${id}`} className="slot-label">Slot {index + 1}</div>
              ))}
            </div>
            <div className="provider-slots-container">
              {providerOrder.map((id, index) => {
                const provider = providerDetails.get(id)
                if (!provider) return null
                const isDragging = dragProvider === provider.id
                return (
                  <div
                    key={id}
                    className={`provider-slot-item ${isDragging ? 'dragging' : ''} ${dragOverIndex === index ? 'drag-over' : ''}`}
                    draggable
                    onDragStart={() => setDragProvider(provider.id)}
                    onDragEnd={() => { setDragProvider(null); setDragOverIndex(null) }}
                    onDragOver={(e) => {
                      e.preventDefault()
                      setDragOverIndex(index)
                    }}
                    onDrop={() => {
                      if (dragProvider && dragProvider !== provider.id) {
                        const fromIndex = providerOrder.indexOf(dragProvider)
                        const toIndex = index
                        const updated = [...providerOrder]
                        const [moved] = updated.splice(fromIndex, 1)
                        updated.splice(toIndex, 0, moved)
                        setProviderOrder(updated)
                        setDirty(true)
                      }
                      setDragOverIndex(null)
                    }}
                  >
                    <button
                      className="provider-button active"
                      onClick={() => {
                        setProviderOrder(current => current.filter(pid => pid !== provider.id))
                        setDirty(true)
                      }}
                      type="button"
                      aria-pressed="true"
                    >
                      {provider.label}
                    </button>
                  </div>
                )
              })}
              {dragOverIndex === providerOrder.length && (
                <div className="provider-slot-item drag-over" />
              )}
            </div>

            <div style={{marginTop:16}}>
              <label style={{fontSize:13, color:'var(--muted)'}}>Inactive providers</label>
              <div style={{display:'flex', flexWrap:'wrap', gap:8, marginTop:8}}>
                {orderedProviders.map((provider) => {
                  if (providerOrder.includes(provider.id)) return null
                  return (
                    <button
                      key={provider.id}
                      className="provider-button inactive"
                      onClick={() => {
                        setProviderOrder(current => [...current, provider.id])
                        setDirty(true)
                      }}
                      type="button"
                      aria-pressed="false"
                    >
                      {provider.label}
                    </button>
                  )
                })}
              </div>
            </div>

            {providerOrder.length === 1 && providerOrder[0] === 'anilist' && (
              <div style={{marginTop:8, padding:8, borderRadius:8, background:'var(--bg-700)', color:'#ffc371', fontSize:12}}>
                AniList does not provide episode titles. Add another provider (e.g., TVDB or TMDb) if you need episode names.
              </div>
            )}
            <div style={{marginTop:12, fontSize:12, color:'var(--muted)'}}>
              {PROVIDERS.map(p => (
                <div key={p.id} style={{marginTop:4}}>
                  <strong>{p.label}:</strong> {p.description}
                </div>
              ))}
            </div>
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
          <label style={{fontSize:13, color:'var(--muted)'}}>Client OS (affects max filename lengths)</label>
          <select className='form-input' value={clientOS} onChange={e => { setClientOS(e.target.value); setDirty(true) }} style={{marginTop:8, maxWidth:320}}>
            <option value='linux'>Linux / Other (max filename 255)</option>
            <option value='mac'>macOS (max filename 255)</option>
            <option value='windows'>Windows (NTFS, max filename 255)</option>
          </select>
          <div style={{fontSize:12, color:'var(--muted)', marginTop:8}}>Choose the OS where files will be written so the tool can limit filename lengths to the platform's limits.</div>
        </div>

        <div style={{marginTop:18}}>
          <label style={{fontSize:13, color:'var(--muted)'}}>Log timestamp timezone</label>
          <select className='form-input' value={logTimezone} onChange={e => { setLogTimezone(e.target.value); setDirty(true) }} style={{marginTop:8, maxWidth:320}}>
            <option value=''>System default</option>
            {timezones.map((tz) => (
              <option key={tz} value={tz}>{tz}</option>
            ))}
          </select>
          <div style={{fontSize:12, color:'var(--muted)', marginTop:8}}>Applies to log timestamps in the UI only. Server logs remain in UTC.</div>
        </div>

        <div style={{marginTop:18}}>
          <label style={{fontSize:13, color:'var(--muted)'}}>Alternative Output Folders</label>
          <div style={{fontSize:12, color:'var(--muted)', marginTop:4, marginBottom:10}}>
            Add multiple output destinations. When applying items, you'll be prompted to choose which folder to use.
            <br/>
            <strong>Docker users:</strong> Mount a common parent directory containing both input and output paths. Docker treats each volume mount as a separate filesystem, preventing hardlinks between separately mounted paths even if they're on the same physical drive.
          </div>
          {outputFolders.map((folder, index) => {
            const folderDirty = !!outputFoldersDirty[index]
            const handleNameChange = (value) => {
              setOutputFolders(prev => {
                const updated = [...prev]
                updated[index] = { ...updated[index], name: value }
                return updated
              })
              setOutputFoldersDirty(prev => {
                const next = [...prev]
                next[index] = true
                return next
              })
              setDirty(true)
            }
            const handlePathChange = (value) => {
              setOutputFolders(prev => {
                const updated = [...prev]
                updated[index] = { ...updated[index], path: value }
                return updated
              })
              setOutputFoldersDirty(prev => {
                const next = [...prev]
                next[index] = true
                return next
              })
              setDirty(true)
            }
            const removeFolder = () => {
              setOutputFolders(prev => prev.filter((_, i) => i !== index))
              setOutputFoldersDirty(prev => prev.filter((_, i) => i !== index))
              setDirty(true)
            }
            return (
              <div key={index} style={{display:'flex', flexDirection:'column', gap:10, marginBottom:16}}>
                <div style={{display:'flex', gap:12, alignItems:'center'}}>
                  <input
                    value={folder.name || ''}
                    onChange={e => handleNameChange(e.target.value)}
                    placeholder="Folder name (e.g., Anime Library)"
                    style={{flex:1, padding:10, borderRadius:8, border:`1px solid var(--bg-600)`, background:'transparent', color:'var(--accent)'}}
                  />
                  <button
                    className={'btn-save' + (folderDirty ? '' : ' disabled')}
                    onClick={async () => { if (!folderDirty) return; await save(); }}
                    disabled={!folderDirty}
                    style={{padding:'8px 16px', height:'34px'}}
                  >
                    Save
                  </button>
                </div>
                <div style={{display:'flex', gap:12, alignItems:'center'}}>
                  <input
                    value={folder.path || ''}
                    onChange={e => handlePathChange(e.target.value)}
                    placeholder="Path (e.g., D:\\Media\\Anime)"
                    style={{flex:1, padding:10, borderRadius:8, border:`1px solid var(--bg-600)`, background:'transparent', color:'var(--accent)'}}
                  />
                  <button
                    className='btn-ghost'
                    onClick={removeFolder}
                    style={{padding:'8px 16px', height:'34px'}}
                  >
                    Remove
                  </button>
                </div>
              </div>
            )
          })}
          <button 
            className='btn-ghost' 
            onClick={() => {
              setOutputFolders(prev => [...prev, { name: '', path: '' }])
              setOutputFoldersDirty(prev => [...prev, true])
              setDirty(true);
            }}
            style={{padding:'10px 14px'}}
          >
            + Add Output Folder
          </button>
        </div>

        <div style={{marginTop:12}}>
          <label style={{fontSize:13, color:'var(--muted)'}}>Input path (scanned)</label>
          <input value={inputPath} onChange={e=>{ setInputPath(e.target.value); setInputExists(null); setDirty(true) }} onBlur={async () => setInputExists((await checkPath(inputPath)).exists)} placeholder="e.g. C:\\Media\\TV" style={{width:'100%', padding:10, borderRadius:8, border:`1px solid var(--bg-600)`, background:'transparent', color:'var(--accent)', marginTop:6}} />
          <div style={{fontSize:12, color: inputExists === false ? '#ffb4b4' : 'var(--muted)', marginTop:6}}>{inputExists === false ? 'Path does not exist or is invalid' : 'Path that will be scanned for media files.'}</div>
        </div>

        <div style={{marginTop:18}}>
          <label style={{display:'flex', alignItems:'center', gap:12, cursor:'pointer', userSelect:'none'}}>
            <input
              type="checkbox"
              checked={enableFolderWatch}
              onChange={e => { setEnableFolderWatch(e.target.checked); setDirty(true) }}
              style={{
                width:20,
                height:20,
                cursor:'pointer',
                accentColor:'var(--hunter-green)'
              }}
            />
            <span style={{fontSize:13, color:'var(--accent)', fontWeight:500}}>Enable folder watching</span>
          </label>
          <div style={{fontSize:12, color:'var(--muted)', marginTop:8, marginLeft:32}}>
            Automatically detect new files added to the input path and trigger scans. The watcher monitors for file additions and modifications in real-time.
          </div>
        </div>

        <div style={{marginTop:18}}>
          <label style={{display:'flex', alignItems:'center', gap:12, cursor:'pointer', userSelect:'none'}}>
            <input
              type="checkbox"
              checked={deleteHardlinksOnUnapprove}
              onChange={e => { setDeleteHardlinksOnUnapprove(e.target.checked); setDirty(true) }}
              style={{
                width:20,
                height:20,
                cursor:'pointer',
                accentColor:'var(--hunter-green)'
              }}
            />
            <span style={{fontSize:13, color:'var(--accent)', fontWeight:500}}>Delete hardlinks when unapproved</span>
          </label>
          <div style={{fontSize:12, color:'var(--muted)', marginTop:8, marginLeft:32}}>
            Removes generated hardlinks from any configured output folder when you unapprove an item. The original source file is never touched.
          </div>
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
            <button
              className='btn-ghost'
              style={{ padding: '10px 14px', fontSize: 13, lineHeight: 1.2, whiteSpace: 'nowrap' }}
              onClick={() => { window.location.hash = '#/duplicates' }}
            >Review duplicates</button>
          </div>
          <div style={{fontSize:12, color:'var(--muted)', marginTop:8}}>Unapproving will mark recently applied items as visible again for rescans. Choose the number of recent applied items to unhide.</div>
        </div>
          </div>
        </div>

  {/* Save/Clear Actions */}
  <div className="settings-actions">
          <button className={"btn-save" + (dirty ? '' : ' disabled')} onClick={save} disabled={!dirty}>Save</button>
          <button className="btn-ghost" onClick={clearAll}>Clear</button>
        </div>

        {/* Change password section */}
        <div>
          <h3>Change password</h3>
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
  )
}
