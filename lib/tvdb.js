const https = require('https')

const authCache = new Map()

function cacheKey(creds) {
  if (!creds) return '::'
  return [String(creds.apiKey || ''), String(creds.username || ''), String(creds.userKey || '')].join('|')
}

function request(options, body, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')) })
    if (body) req.write(body)
    req.end()
  })
}

function safe(val, limit = 200) {
  try {
    return String(val == null ? '' : val)
      .replace(/[\r\n]+/g, ' ')
      .replace(/[^\x20-\x7E]/g, '?')
      .slice(0, limit)
  } catch (e) {
    return ''
  }
}

function safeJson(obj, limit = 400) {
  try {
    if (!obj) return ''
    return safe(JSON.stringify(obj), limit)
  } catch (e) {
    return ''
  }
}

async function ensureToken(creds, forceRefresh = false, log) {
  if (!creds || !creds.apiKey || !creds.username || !creds.userKey) return null
  const key = cacheKey(creds)
  const cached = authCache.get(key)
  const now = Date.now()
  if (!forceRefresh && cached && cached.token && (!cached.expiresAt || cached.expiresAt > now + 60000)) {
    if (log) {
      try { log(`TVDB_TOKEN_CACHE_HIT user=${safe(creds.username)} expiresInMs=${cached.expiresAt ? (cached.expiresAt - now) : '<none>'}`) } catch (e) {}
    }
    return cached.token
  }
  const body = JSON.stringify({ apikey: creds.apiKey, username: creds.username, userkey: creds.userKey })
  const res = await request({ hostname: 'api.thetvdb.com', path: '/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' } }, body, 6000)
  if (!res || res.statusCode !== 200) {
    authCache.delete(key)
    if (log) {
      try { log(`TVDB_LOGIN_FAIL status=${res ? res.statusCode : '<none>'} body=${safeJson(res && res.body ? res.body : '')}`) } catch (e) {}
    }
    return null
  }
  let parsed
  try { parsed = JSON.parse(res.body || '{}') } catch (e) { parsed = null }
  const token = parsed && parsed.token ? String(parsed.token) : null
  if (!token) {
    authCache.delete(key)
    if (log) {
      try { log('TVDB_LOGIN_FAIL tokenMissing=yes') } catch (e) {}
    }
    return null
  }
  authCache.set(key, { token, expiresAt: now + (23 * 60 * 60 * 1000) })
  if (log) {
    try { log(`TVDB_TOKEN_REFRESHED user=${safe(creds.username)} expiresAt=${new Date(now + (23 * 60 * 60 * 1000)).toISOString()}`) } catch (e) {}
  }
  return token
}

async function apiRequest(path, creds, options = {}, log) {
  const token = await ensureToken(creds, false, log)
  if (!token) return null
  const headers = Object.assign({ 'Accept': 'application/json', 'Authorization': `Bearer ${token}` }, options.headers || {})
  const res = await request({ hostname: 'api.thetvdb.com', path, method: options.method || 'GET', headers }, options.body || null, options.timeout || 6000)
  if (res && res.statusCode === 401 && options.retry !== false) {
    if (log) {
      try { log(`TVDB_API_401 path=${safe(path)} retrying=yes`) } catch (e) {}
    }
    await ensureToken(creds, true, log)
    return apiRequest(path, creds, Object.assign({}, options, { retry: false }), log)
  }
  if (log) {
    try { log(`TVDB_API_RESPONSE path=${safe(path)} status=${res ? res.statusCode : '<none>'}`) } catch (e) {}
  }
  return res
}

function hasMeaningfulTitle(name) {
  if (!name) return false
  const title = String(name).trim()
  if (!title) return false
  const alpha = (title.match(/[A-Za-z\p{L}]/gu) || []).length
  if (!alpha) return false
  if (/^(?:episode|ep|e)\s*\d+$/i.test(title)) return false
  const numericOnly = title.replace(/[^0-9]/g, '')
  if (numericOnly && numericOnly.length === title.length) return false
  return true
}

async function fetchSeries(creds, name, log) {
  if (!name) return null
  const path = `/search/series?name=${encodeURIComponent(String(name).slice(0, 200))}`
  const res = await apiRequest(path, creds, {}, log)
  if (!res || res.statusCode !== 200) return null
  let parsed
  try { parsed = JSON.parse(res.body || '{}') } catch (e) { parsed = null }
  const list = parsed && Array.isArray(parsed.data) ? parsed.data : []
  if (log) {
    try { log(`TVDB_SERIES_SEARCH name=${safe(name)} hits=${list.length}`) } catch (e) {}
  }
  if (!list.length) return null
  let best = null
  let bestScore = -Infinity
  for (const item of list) {
    const seriesName = item && (item.seriesName || item.series_name || item.name) ? String(item.seriesName || item.series_name || item.name) : ''
    const aliases = Array.isArray(item && item.aliases) ? item.aliases : []
    const titles = [seriesName, ...aliases]
    for (const t of titles) {
      if (!t) continue
      const norm = String(t).toLowerCase()
      const score = overlapScore(norm, String(name).toLowerCase())
      if (score > bestScore) { bestScore = score; best = item }
    }
  }
  const pick = best || list[0]
  if (log && pick) {
    try { log(`TVDB_SERIES_PICK id=${pick.id || '<none>'} name=${safe(pick.seriesName || pick.series_name || pick.name || name)}`) } catch (e) {}
  }
  return pick
}

function overlapScore(a, b) {
  const aTokens = a.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
  const bTokens = b.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
  if (!aTokens.length || !bTokens.length) return 0
  let common = 0
  for (const token of aTokens) if (bTokens.includes(token)) common += 1
  return common / aTokens.length
}

async function fetchEpisodeBySeries(creds, seriesId, season, episode, log) {
  const path = `/series/${encodeURIComponent(seriesId)}/episodes/query?airedSeason=${encodeURIComponent(season)}&airedEpisode=${encodeURIComponent(episode)}`
  const res = await apiRequest(path, creds, {}, log)
  if (!res || res.statusCode !== 200) return null
  let parsed
  try { parsed = JSON.parse(res.body || '{}') } catch (e) { parsed = null }
  const list = parsed && Array.isArray(parsed.data) ? parsed.data : []
  if (log) {
    try { log(`TVDB_EP_SEARCH seriesId=${seriesId} season=${season} episode=${episode} hits=${list.length}`) } catch (e) {}
  }
  if (!list.length) return null
  let pick = null
  for (const ep of list) {
    if (!ep) continue
    const s = Number(ep.airedSeason != null ? ep.airedSeason : ep.season)
    const eNum = Number(ep.airedEpisodeNumber != null ? ep.airedEpisodeNumber : ep.episodeNumber)
    if (Number.isFinite(s) && Number.isFinite(eNum) && s === Number(season) && eNum === Number(episode)) { pick = ep; break }
  }
  if (!pick) pick = list[0]
  const title = pick && (pick.episodeName || pick.name || pick.episode_name) ? String(pick.episodeName || pick.name || pick.episode_name).trim() : ''
  if (!hasMeaningfulTitle(title)) return null
  if (log) {
    try { log(`TVDB_EP_PICK seriesId=${seriesId} season=${season} episode=${episode} title=${safe(title)}`) } catch (e) {}
  }
  return { episodeTitle: title, episode: pick }
}

async function fetchEpisode(creds, titles, season, episode, options = {}) {
  if (!creds || season == null || episode == null) return null
  const log = typeof options.log === 'function' ? options.log : null
  if (log) {
    try {
      log(`TVDB_FETCH_REQUEST titles=${safe(Array.isArray(titles) ? titles.join('|') : titles)} season=${season} episode=${episode}`)
    } catch (e) {}
  }
  const tried = new Set()
  const titleList = Array.isArray(titles) ? titles : [titles]
  for (const title of titleList) {
    const cand = String(title || '').trim()
    if (!cand) continue
    const key = cand.toLowerCase()
    if (tried.has(key)) continue
    tried.add(key)
    const series = await fetchSeries(creds, cand, log)
    if (!series || !series.id) {
      if (log) {
        try { log(`TVDB_SERIES_MISS name=${safe(cand)}`) } catch (e) {}
      }
      continue
    }
    const seriesName = series.seriesName || series.series_name || series.name || cand
    const episodeData = await fetchEpisodeBySeries(creds, series.id, season, episode, log)
    if (!episodeData) continue
    if (log) {
      try { log(`TVDB_FETCH_SUCCESS seriesId=${series.id} seriesName=${safe(seriesName)} title=${safe(episodeData.episodeTitle)}`) } catch (e) {}
    }
    return {
      seriesId: series.id,
      seriesName,
      episodeTitle: episodeData.episodeTitle,
      raw: { series, episode: episodeData.episode }
    }
  }
  if (log) {
    try { log(`TVDB_FETCH_EMPTY season=${season} episode=${episode}`) } catch (e) {}
  }
  return null
}

module.exports = { fetchEpisode }
