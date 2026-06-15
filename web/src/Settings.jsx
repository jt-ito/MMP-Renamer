import React, { useState, useEffect, useMemo, useRef } from 'react'
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
function ActivityHistory({ pushToast }) {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchHistory = async () => {
    try {
      const r = await axios.get(API('/history'), { params: { limit: 50 } });
      setHistory(r.data.history || []);
    } catch(e) {}
    setLoading(false);
  };

  useEffect(() => {
    fetchHistory();
  }, []);

  const handleUndo = async (id) => {
    try {
      const r = await axios.post(API('/history/undo'), { id });
      pushToast && pushToast('Undo', `Reverted ${r.data.unapproved.length} item(s)`);
      if (r.data.unapproved.length > 0) {
        window.dispatchEvent(new CustomEvent('renamer:unapproved', { detail: { paths: r.data.unapproved } }));
      }
      fetchHistory();
    } catch(e) {
      pushToast && pushToast('Error', 'Undo failed');
    }
  };

  return (
    <div style={{marginTop:18}}>
      <label style={{fontSize:13, color:'var(--muted)'}}>Activity History (Undo Log)</label>
      <div style={{marginTop:8, background:'var(--bg-800)', borderRadius:8, overflow:'hidden', border:'1px solid var(--bg-600)'}}>
        {loading ? <div style={{padding:16, fontSize:13, color:'var(--muted)'}}>Loading history...</div> : history.length === 0 ? <div style={{padding:16, fontSize:13, color:'var(--muted)'}}>No actions recorded yet.</div> : (
          <table style={{width:'100%', borderCollapse:'collapse', fontSize:12, textAlign:'left'}}>
            <thead>
              <tr style={{background:'var(--bg-700)', color:'var(--muted)'}}>
                <th style={{padding:'8px 12px'}}>Time</th>
                <th style={{padding:'8px 12px'}}>Original File</th>
                <th style={{padding:'8px 12px'}}>Resolved Path</th>
                <th style={{padding:'8px 12px', width:60}}>Action</th>
              </tr>
            </thead>
            <tbody>
              {history.map(item => (
                <tr key={item.id} style={{borderTop:'1px solid var(--bg-600)'}}>
                  <td style={{padding:'8px 12px', color:'var(--muted)', whiteSpace:'nowrap'}}>{new Date(item.timestamp).toLocaleString()}</td>
                  <td style={{padding:'8px 12px', color:'var(--accent)', wordBreak:'break-all'}}>{item.original_path.split(/[\/\\]/).pop()}</td>
                  <td style={{padding:'8px 12px', color:'var(--accent)', wordBreak:'break-all'}}>{item.resolved_path.split(/[\/\\]/).pop()}</td>
                  <td style={{padding:'8px 12px'}}>
                    {item.status === 'applied' ? (
                      <button className='btn-ghost' style={{padding:'4px 8px', fontSize:11, background:'#e74c3c33', color:'#ffb4b4', border:'1px solid #e74c3c66'}} onClick={() => handleUndo(item.id)}>Undo</button>
                    ) : (
                      <span style={{color:'var(--muted)', fontSize:11}}>Reverted</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div style={{display:'flex', gap:8, marginTop:12}}>
        <button className='btn-ghost' style={{ padding: '8px 12px', fontSize: 12 }} onClick={() => { window.location.hash = '#/hidden' }}>Review hidden items</button>
        <button className='btn-ghost' style={{ padding: '8px 12px', fontSize: 12 }} onClick={() => { window.location.hash = '#/duplicates' }}>Review duplicates</button>
      </div>
    </div>
  );
}

export default function Settings({ pushToast, cardParallax, setCardParallax }){
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
  const [customRegexes, setCustomRegexes] = useState([])
  const [customRegexesDirty, setCustomRegexesDirty] = useState([])
  const [testRegexInput, setTestRegexInput] = useState('')
  const [enableFolderWatch, setEnableFolderWatch] = useState(false)
  const [deleteHardlinksOnUnapprove, setDeleteHardlinksOnUnapprove] = useState(true)
  const [extractSubtitles, setExtractSubtitles] = useState(false)
  const [subtitleFormat, setSubtitleFormat] = useState('ass')
  const [copySidecarSubtitles, setCopySidecarSubtitles] = useState(false)
  const [hardsubEnabled, setHardsubEnabled] = useState(false)
  const [hardsubLanguage, setHardsubLanguage] = useState('eng')
  const [backfillJob, setBackfillJob] = useState(null) // { status, extracted, skipped, missing, errors, total }
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
          const extractPref = user.extract_subtitles
          const serverExtractPref = server.extract_subtitles
          const resolvedExtractPref = extractPref === undefined
            ? (serverExtractPref === true || serverExtractPref === 'true')
            : (extractPref === true || extractPref === 'true')
          setExtractSubtitles(resolvedExtractPref)
          setSubtitleFormat(user.extract_subtitle_format || server.extract_subtitle_format || 'ass')
          const sidecarPref = user.copy_sidecar_subtitles
          const serverSidecarPref = server.copy_sidecar_subtitles
          const resolvedSidecarPref = sidecarPref === undefined
            ? (serverSidecarPref === true || serverSidecarPref === 'true')
            : (sidecarPref === true || sidecarPref === 'true')
          setCopySidecarSubtitles(resolvedSidecarPref)
          const hardsubPref = user.hardsub_enabled
          const serverHardsubPref = server.hardsub_enabled
          const resolvedHardsubPref = hardsubPref === undefined
            ? (serverHardsubPref === true || serverHardsubPref === 'true')
            : (hardsubPref === true || hardsubPref === 'true')
          setHardsubEnabled(resolvedHardsubPref)
          setHardsubLanguage(user.hardsub_language || server.hardsub_language || 'eng')
          const folders = Array.isArray(user.output_folders) ? user.output_folders : []
          setOutputFolders(folders)
          setOutputFoldersDirty(new Array(folders.length).fill(false))
          const regexes = Array.isArray(user.custom_regexes) ? user.custom_regexes : []
          setCustomRegexes(regexes)
          setCustomRegexesDirty(new Array(regexes.length).fill(false))
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
        const storedExtractPref = localStorage.getItem('extract_subtitles')
        const extractPref = storedExtractPref != null
          ? storedExtractPref === 'true'
          : (server.extract_subtitles === true || server.extract_subtitles === 'true')
        const storedSubtitleFormat = localStorage.getItem('extract_subtitle_format') || server.extract_subtitle_format || 'ass'
        const storedSidecarPref = localStorage.getItem('copy_sidecar_subtitles')
        const sidecarPref = storedSidecarPref != null
          ? storedSidecarPref === 'true'
          : (server.copy_sidecar_subtitles === true || server.copy_sidecar_subtitles === 'true')
        const storedHardsubPref = localStorage.getItem('hardsub_enabled')
        const hardsubPref2 = storedHardsubPref != null
          ? storedHardsubPref === 'true'
          : (server.hardsub_enabled === true || server.hardsub_enabled === 'true')
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
        setExtractSubtitles(extractPref)
        setSubtitleFormat(storedSubtitleFormat)
        setCopySidecarSubtitles(sidecarPref)
        setHardsubEnabled(hardsubPref2)
        setHardsubLanguage(localStorage.getItem('hardsub_language') || server.hardsub_language || 'eng')
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
        const storedExtractPref2 = localStorage.getItem('extract_subtitles')
        const storedSubtitleFormat2 = localStorage.getItem('extract_subtitle_format') || 'ass'
        const storedSidecarPref2 = localStorage.getItem('copy_sidecar_subtitles')
        const storedHardsubPref2 = localStorage.getItem('hardsub_enabled')
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
        setExtractSubtitles(storedExtractPref2 === 'true')
        setSubtitleFormat(storedSubtitleFormat2)
        setCopySidecarSubtitles(storedSidecarPref2 === 'true')
        setHardsubEnabled(storedHardsubPref2 === 'true')
        setHardsubLanguage(localStorage.getItem('hardsub_language') || 'eng')
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
      localStorage.setItem('extract_subtitles', String(extractSubtitles))
      localStorage.setItem('extract_subtitle_format', subtitleFormat)
      localStorage.setItem('copy_sidecar_subtitles', String(copySidecarSubtitles))
      localStorage.setItem('hardsub_enabled', String(hardsubEnabled))
      localStorage.setItem('hardsub_language', hardsubLanguage)
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
          extract_subtitles: extractSubtitles,
          extract_subtitle_format: subtitleFormat,
          copy_sidecar_subtitles: copySidecarSubtitles,
          hardsub_enabled: hardsubEnabled,
          hardsub_language: hardsubLanguage,
          output_folders: outputFolders,
          custom_regexes: customRegexes,
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
        setCustomRegexesDirty(new Array(customRegexes.length).fill(false))
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
  setExtractSubtitles(false)
  setSubtitleFormat('ass')
  setCopySidecarSubtitles(false)
  setHardsubEnabled(false)
  setHardsubLanguage('eng')
  setOutputFolders([])
  setOutputFoldersDirty([])
  setCustomRegexes([])
  setCustomRegexesDirty([])
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
      localStorage.removeItem('extract_subtitles')
      localStorage.removeItem('extract_subtitle_format')
      localStorage.removeItem('copy_sidecar_subtitles')
      localStorage.removeItem('hardsub_enabled')
      localStorage.removeItem('hardsub_language')
  localStorage.removeItem('output_folders')
        localStorage.removeItem('client_os')
        localStorage.removeItem('log_timezone')
      localStorage.setItem('rename_template', '{title} - {epLabel} - {episodeTitle}')
  axios.post(API('/settings'), { tmdb_api_key: '', anilist_api_key: '', anidb_username: '', anidb_password: '', default_meta_provider: 'tmdb', metadata_provider_order: DEFAULT_PROVIDER_ORDER, tvdb_v4_api_key: '', tvdb_v4_user_pin: '', scan_input_path: '', scan_output_path: '', enable_folder_watch: false, rename_template: '{title} - {epLabel} - {episodeTitle}', output_folders: [], custom_regexes: [], log_timezone: '' }).catch(()=>{})
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

  async function runBackfill() {
    setBackfillJob({ status: 'running', total: null })
    try {
      const r = await axios.post(API('/jobs/backfill-subtitles'))
      const jobId = r.data && r.data.jobId
      const total = r.data && r.data.total != null ? r.data.total : null
      setBackfillJob({ status: 'running', total })
      if (!jobId) { setBackfillJob({ status: 'error', message: 'No job ID returned' }); return }
      // Poll until done
      const INTERVAL = 1500
      const TIMEOUT = 60 * 60 * 1000
      const start = Date.now()
      await new Promise((resolve) => {
        const t = setInterval(async () => {
          try {
            if (Date.now() - start > TIMEOUT) { clearInterval(t); setBackfillJob(prev => ({ ...prev, status: 'error', message: 'Timed out' })); resolve(); return }
            const jr = await axios.get(API(`/jobs/${jobId}`)).catch(() => null)
            if (!jr || !jr.data || !jr.data.job) return
            const job = jr.data.job
            setBackfillJob(prev => ({ ...prev, processedItems: job.processedItems, total: job.totalItems }))
            if (job.status === 'done' || job.status === 'error') {
              clearInterval(t)
              const result = (job.results && job.results[0]) || {}
              setBackfillJob({
                status: job.status,
                extracted: result.extracted ?? 0,
                skipped: result.skipped ?? 0,
                missing: result.missing ?? 0,
                errors: result.errors ?? 0,
                total: result.total ?? job.totalItems,
                message: job.error || null
              })
              resolve()
            }
          } catch (e) { /* keep polling */ }
        }, INTERVAL)
      })
    } catch (e) {
      setBackfillJob({ status: 'error', message: e && e.response && e.response.data && e.response.data.error ? e.response.data.error : (e.message || 'Failed') })
    }
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

        <div style={{marginTop:24}}>
          <h3 style={{ borderBottom: '1px solid var(--bg-700)', paddingBottom: 8, marginBottom: 16 }}>Custom Regex Parsing</h3>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 12 }}>
            Define custom regular expressions to extract data from difficult filenames using named capture groups: <code>(?&lt;title&gt;...)</code>, <code>(?&lt;season&gt;...)</code>, <code>(?&lt;episode&gt;...)</code>, <code>(?&lt;episodeTitle&gt;...)</code>. Evaluated in order.
          </div>
          {customRegexes.map((regexStr, index) => {
            const isDirty = !!customRegexesDirty[index]
            const handleChange = (value) => {
              setCustomRegexes(prev => {
                const next = [...prev]
                next[index] = value
                return next
              })
              setCustomRegexesDirty(prev => {
                const next = [...prev]
                next[index] = true
                return next
              })
              setDirty(true)
            }
            const handleRemove = () => {
              setCustomRegexes(prev => prev.filter((_, i) => i !== index))
              setCustomRegexesDirty(prev => prev.filter((_, i) => i !== index))
              setDirty(true)
            }
            
            let isValid = true
            let testMatch = null
            try {
              if (regexStr) {
                const re = new RegExp(regexStr, 'i')
                if (testRegexInput) testMatch = testRegexInput.match(re)
              }
            } catch(e) { isValid = false }

            return (
              <div key={`regex-${index}`} style={{ display:'flex', flexDirection:'column', gap:8, marginBottom: 16, background: 'var(--bg-800)', padding: 12, borderRadius: 8, border: `1px solid ${isDirty ? 'var(--accent)' : 'var(--bg-600)'}` }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type='text'
                    className='form-input'
                    style={{ flex: 1, fontFamily: 'monospace', borderColor: !isValid ? '#e74c3c' : undefined }}
                    placeholder='e.g., ^(?<title>.*?)\s*-\s*(?<episode>\d+)\.mkv$'
                    value={regexStr}
                    onChange={e => handleChange(e.target.value)}
                  />
                  <button className='btn-ghost' style={{ color: '#e74c3c', padding: '0 12px' }} onClick={handleRemove}>Remove</button>
                </div>
                {!isValid && <div style={{color:'#e74c3c', fontSize:12}}>Invalid Regular Expression</div>}
                {isValid && regexStr && testRegexInput && (
                  <div style={{ fontSize: 12, marginTop: 4, background: 'var(--bg-900)', padding: 8, borderRadius: 4, fontFamily: 'monospace' }}>
                    {testMatch && testMatch.groups ? (
                      <span style={{ color: '#2ecc71' }}>Matched: {JSON.stringify(testMatch.groups)}</span>
                    ) : (
                      <span style={{ color: '#e74c3c' }}>No match</span>
                    )}
                  </div>
                )}
              </div>
            )
          })}
          <button 
            className='btn-ghost' 
            onClick={() => {
              setCustomRegexes(prev => [...prev, ''])
              setCustomRegexesDirty(prev => [...prev, true])
              setDirty(true);
            }}
            style={{padding:'10px 14px'}}
          >+ Add Regex Rule</button>
          
          <div style={{ marginTop: 16 }}>
            <label style={{ fontSize: 12, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Test Filename (Optional)</label>
            <input
              type='text'
              className='form-input'
              placeholder='Paste a filename here to test your rules...'
              value={testRegexInput}
              onChange={e => setTestRegexInput(e.target.value)}
              style={{ width: '100%', fontFamily: 'monospace' }}
            />
          </div>
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
              className="settings-checkbox"
              checked={enableFolderWatch}
              onChange={e => { setEnableFolderWatch(e.target.checked); setDirty(true) }}
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
              className="settings-checkbox"
              checked={deleteHardlinksOnUnapprove}
              onChange={e => { setDeleteHardlinksOnUnapprove(e.target.checked); setDirty(true) }}
            />
            <span style={{fontSize:13, color:'var(--accent)', fontWeight:500}}>Delete hardlinks when unapproved</span>
          </label>
          <div style={{fontSize:12, color:'var(--muted)', marginTop:8, marginLeft:32}}>
            Removes generated hardlinks from any configured output folder when you unapprove an item. The original source file is never touched.
          </div>
        </div>

        <div style={{marginTop:18}}>
          <label style={{display:'flex', alignItems:'center', gap:12, cursor:'pointer', userSelect:'none'}}>
            <input
              type="checkbox"
              className="settings-checkbox"
              checked={extractSubtitles}
              onChange={e => { setExtractSubtitles(e.target.checked); setDirty(true) }}
            />
            <span style={{fontSize:13, color:'var(--accent)', fontWeight:500}}>Extract subtitles on approve</span>
          </label>
          <div style={{fontSize:12, color:'var(--muted)', marginTop:8, marginLeft:32}}>
            When approving a file, extracts embedded subtitle tracks from the source file using ffmpeg and saves them alongside the output. Requires ffmpeg in PATH. The source file is never modified.
          </div>
          {extractSubtitles && (
            <div style={{marginTop:12, marginLeft:32}}>
              <label style={{fontSize:12, color:'var(--accent)', display:'flex', alignItems:'center', gap:8, marginBottom:10}}>
                Output format:
                <select
                  value={subtitleFormat}
                  onChange={e => { setSubtitleFormat(e.target.value); setDirty(true) }}
                  style={{
                    fontSize:12, padding:'3px 6px', borderRadius:4,
                    background:'var(--card-bg,#1e1e1e)', color:'var(--accent)',
                    border:'1px solid var(--muted)', cursor:'pointer'
                  }}
                >
                  <option value="ass">ASS — Advanced SubStation Alpha (.ass)</option>
                  <option value="srt">SRT — SubRip Text (.srt)</option>
                  <option value="ssa">SSA — SubStation Alpha (.ssa)</option>
                  <option value="vtt">VTT — WebVTT (.vtt)</option>
                </select>
              </label>
              <button
                onClick={runBackfill}
                disabled={backfillJob && backfillJob.status === 'running'}
                style={{
                  padding:'6px 14px', fontSize:12, cursor: backfillJob && backfillJob.status === 'running' ? 'not-allowed' : 'pointer',
                  background:'var(--hunter-green)', color:'#fff', border:'none', borderRadius:4,
                  opacity: backfillJob && backfillJob.status === 'running' ? 0.6 : 1
                }}
              >
                {backfillJob && backfillJob.status === 'running' ? 'Running…' : 'Backfill missing subtitles'}
              </button>
              <span style={{fontSize:11, color:'var(--muted)', marginLeft:10}}>
                Scans all approved files and extracts subtitles for any that are missing a .srt file.
              </span>
              {backfillJob && backfillJob.status === 'running' && backfillJob.total != null && (
                <div style={{fontSize:11, color:'var(--muted)', marginTop:4}}>
                  Processing… {backfillJob.processedItems != null ? `${backfillJob.processedItems} / ${backfillJob.total}` : `${backfillJob.total} items`}
                </div>
              )}
              {backfillJob && backfillJob.status === 'done' && (
                <div style={{fontSize:11, color:'var(--accent)', marginTop:4}}>
                  Done — extracted: {backfillJob.extracted}, already had .srt: {backfillJob.skipped}, missing source/output: {backfillJob.missing}{backfillJob.errors > 0 ? `, errors: ${backfillJob.errors}` : ''}
                </div>
              )}
              {backfillJob && backfillJob.status === 'error' && (
                <div style={{fontSize:11, color:'#e74c3c', marginTop:4}}>
                  Error: {backfillJob.message || 'Unknown error'}
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{marginTop:18}}>
          <label style={{display:'flex', alignItems:'center', gap:12, cursor:'pointer', userSelect:'none'}}>
            <input
              type="checkbox"
              className="settings-checkbox"
              checked={copySidecarSubtitles}
              onChange={e => { setCopySidecarSubtitles(e.target.checked); setDirty(true) }}
            />
            <span style={{fontSize:13, color:'var(--accent)', fontWeight:500}}>Copy sidecar subtitle files on approve</span>
          </label>
          <div style={{fontSize:12, color:'var(--muted)', marginTop:8, marginLeft:32}}>
            When approving a file, copies any external subtitle files found in the same directory as the source (e.g. .srt, .ass, .vtt sidecars) into the output folder alongside the hardlink.
          </div>
        </div>

        <div style={{marginTop:18}}>
          <label style={{display:'flex', alignItems:'center', gap:12, cursor:'pointer', userSelect:'none'}}>
            <input
              type="checkbox"
              className="settings-checkbox"
              checked={hardsubEnabled}
              onChange={e => { setHardsubEnabled(e.target.checked); setDirty(true) }}
            />
            <span style={{fontSize:13, color:'var(--accent)', fontWeight:500}}>Hardcode embedded subtitles on approve</span>
          </label>
          <div style={{fontSize:12, color:'var(--muted)', marginTop:8, marginLeft:32}}>
            Burns subtitle tracks from the video container directly into the video stream on approve. Requires ffmpeg in PATH. The source file is never modified.
          </div>
          {hardsubEnabled && (
            <div style={{marginTop:12, marginLeft:32}}>
              <label style={{fontSize:12, color:'var(--accent)', display:'flex', alignItems:'center', gap:8}}>
                Subtitle language:
                <select
                  value={hardsubLanguage}
                  onChange={e => { setHardsubLanguage(e.target.value); setDirty(true) }}
                  style={{
                    fontSize:12, padding:'3px 6px', borderRadius:4,
                    background:'var(--card-bg,#1e1e1e)', color:'var(--accent)',
                    border:'1px solid var(--muted)', cursor:'pointer'
                  }}
                >
                  <option value="eng">English</option>
                  <option value="jpn">Japanese</option>
                  <option value="kor">Korean</option>
                  <option value="zho">Chinese (Simplified)</option>
                  <option value="zht">Chinese (Traditional)</option>
                  <option value="spa">Spanish</option>
                  <option value="fra">French</option>
                  <option value="deu">German</option>
                  <option value="por">Portuguese</option>
                  <option value="ita">Italian</option>
                  <option value="ara">Arabic</option>
                  <option value="rus">Russian</option>
                </select>
              </label>
            </div>
          )}
        </div>

        <div style={{marginTop:18}}>
          <label style={{display:'flex', alignItems:'center', gap:12, cursor:'pointer', userSelect:'none'}}>
            <input
              type="checkbox"
              className="settings-checkbox"
              checked={cardParallax !== false}
              onChange={e => { setCardParallax && setCardParallax(e.target.checked) }}
            />
            <span style={{fontSize:13, color:'var(--accent)', fontWeight:500}}>3D card parallax on Approved Series</span>
          </label>
          <div style={{fontSize:12, color:'var(--muted)', marginTop:8, marginLeft:32}}>
            Cards on the Approved Series page tilt in 3D following your cursor. Disable for reduced motion or performance.
          </div>
        </div>

        <ActivityHistory pushToast={pushToast} />
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
