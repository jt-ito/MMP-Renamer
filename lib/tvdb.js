const https = require('https')

const authCache = new Map()

function cacheKey(creds) {
  if (!creds) return '::'
  return ['v4', String(creds.apiKey || ''), String(creds.userPin || '')].join('|')
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

function resolveSeriesId(series) {
  if (!series) return null
  const candidates = [
    series.tvdb_id,
    series.id,
    series.seriesId,
    series.slug,
    series.seriesSlug
  ]
  for (const cand of candidates) {
    if (cand == null) continue
    if (typeof cand === 'number' && Number.isFinite(cand)) return cand
    const str = String(cand).trim()
    if (!str) continue
    const matchDigits = str.match(/(\d+)\b/g)
    if (matchDigits && matchDigits.length) {
      const num = Number(matchDigits[matchDigits.length - 1])
      if (Number.isFinite(num)) return num
    }
  }
  return null
}

async function ensureTokenV4(creds, forceRefresh = false, log) {
  if (!creds || !creds.apiKey) return null
  const key = cacheKey(creds)
  const cached = authCache.get(key)
  const now = Date.now()
  if (!forceRefresh && cached && cached.token && (!cached.expiresAt || cached.expiresAt > now + 60000)) {
    if (log) {
      try { log(`TVDB_TOKEN_CACHE_HIT mode=v4 expiresInMs=${cached.expiresAt ? (cached.expiresAt - now) : '<none>'}`) } catch (e) {}
    }
    return cached.token
  }
  const payload = { apikey: creds.apiKey }
  if (creds.userPin) payload.pin = creds.userPin
  const res = await request({ hostname: 'api4.thetvdb.com', path: '/v4/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' } }, JSON.stringify(payload), 6000)
  if (!res || res.statusCode !== 200) {
    authCache.delete(key)
    if (log) {
      try { log(`TVDB_LOGIN_FAIL mode=v4 status=${res ? res.statusCode : '<none>'} body=${safeJson(res && res.body ? res.body : '')}`) } catch (e) {}
    }
    return null
  }
  let parsed
  try { parsed = JSON.parse(res.body || '{}') } catch (e) { parsed = null }
  const token = parsed && parsed.data && parsed.data.token ? String(parsed.data.token) : null
  if (!token) {
    authCache.delete(key)
    if (log) {
      try { log('TVDB_LOGIN_FAIL mode=v4 tokenMissing=yes') } catch (e) {}
    }
    return null
  }
  authCache.set(key, { token, expiresAt: now + (23 * 60 * 60 * 1000) })
  if (log) {
    try { log(`TVDB_TOKEN_REFRESHED mode=v4 expiresAt=${new Date(now + (23 * 60 * 60 * 1000)).toISOString()}`) } catch (e) {}
  }
  return token
}

async function ensureToken(creds, forceRefresh = false, log) {
  if (!creds || !creds.apiKey) return null
  return ensureTokenV4(creds, forceRefresh, log)
}

async function apiRequest(path, creds, options = {}, log) {
  if (!creds) return null
  const hostname = 'api4.thetvdb.com'
  const token = await ensureToken(creds, false, log)
  if (!token) return null
  const headers = Object.assign({ 'Accept': 'application/json', 'Authorization': `Bearer ${token}` }, options.headers || {})
  const res = await request({ hostname, path, method: options.method || 'GET', headers }, options.body || null, options.timeout || 8000)
  if (res && res.statusCode === 401 && options.retry !== false) {
    if (log) {
      try { log(`TVDB_API_401 mode=v4 path=${safe(path)} retrying=yes`) } catch (e) {}
    }
    await ensureToken(creds, true, log)
    return apiRequest(path, creds, Object.assign({}, options, { retry: false }), log)
  }
  if (log) {
    try { log(`TVDB_API_RESPONSE mode=v4 path=${safe(path)} status=${res ? res.statusCode : '<none>'}`) } catch (e) {}
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

function extractEpisodeTitle(ep) {
  if (!ep) return ''
  const candidates = []
  const push = (val, prioritize = false) => {
    if (!val) return
    const trimmed = String(val).trim()
    if (!trimmed) return
    if (prioritize) candidates.unshift(trimmed)
    else candidates.push(trimmed)
  }
  push(ep.episodeName)
  push(ep.name)
  push(ep.episode_name)
  if (ep.translations) {
    if (Array.isArray(ep.translations)) {
      for (const tr of ep.translations) {
        if (!tr) continue
        const lang = String(tr.language || tr.iso6391 || tr.iso6393 || '').toLowerCase()
        const prefer = lang === 'eng' || lang === 'en' || lang === 'english'
        push(tr.name || tr.title, prefer)
      }
    } else if (typeof ep.translations === 'object') {
      const entries = Object.entries(ep.translations)
      for (const [lang, tr] of entries) {
        if (!tr) continue
        const prefer = ['eng', 'en', 'english'].includes(String(lang).toLowerCase())
        push(tr.name || tr.title, prefer)
      }
    }
  }
  for (const candidate of candidates) {
    if (hasMeaningfulTitle(candidate)) return candidate
  }
  return ''
}

async function fetchSeries(creds, name, log) {
  if (!name) return null
  const query = encodeURIComponent(String(name).slice(0, 200))
  const path = `/v4/search?type=series&q=${query}`
  const res = await apiRequest(path, creds, {}, log)
  if (!res || res.statusCode !== 200) return null
  let parsed
  try { parsed = JSON.parse(res.body || '{}') } catch (e) { parsed = null }
  let list = parsed && parsed.data ? parsed.data : []
  if (!Array.isArray(list)) list = []
  list = list.filter(item => {
    if (!item) return false
    if (item.type && String(item.type).toLowerCase() !== 'series') return false
    return true
  })
  for (const item of list) {
    if (item && item.tvdb_id && item.id == null) item.id = item.tvdb_id
    if (item && item.name && !item.seriesName) item.seriesName = item.name
    if (item && item.slug && !item.seriesSlug) item.seriesSlug = item.slug
  }
  if (log) {
    try { log(`TVDB_SERIES_SEARCH mode=v4 name=${safe(name)} hits=${list.length}`) } catch (e) {}
  }
  if (!list.length) return null
  let best = null
  let bestScore = -Infinity
  const target = String(name).toLowerCase()
  for (const item of list) {
    if (!item) continue
    const titles = []
    const primary = item.seriesName || item.series_name || item.name
    if (primary) titles.push(primary)
    if (Array.isArray(item.aliases)) titles.push(...item.aliases)
    if (Array.isArray(item.alternateTitles)) titles.push(...item.alternateTitles)
    if (Array.isArray(item.translations)) {
      for (const tr of item.translations) {
        if (tr && (tr.name || tr.title)) titles.push(tr.name || tr.title)
      }
    }
    if (titles.length === 0) titles.push(name)
    for (const tRaw of titles) {
      const t = String(tRaw || '').trim()
      if (!t) continue
      const norm = t.toLowerCase()
      const score = overlapScore(norm, target)
      if (score > bestScore) { bestScore = score; best = item }
    }
  }
  const pick = best || list[0]
  if (log && pick) {
    try { log(`TVDB_SERIES_PICK mode=v4 id=${pick.id || '<none>'} name=${safe(pick.seriesName || pick.series_name || pick.name || name)}`) } catch (e) {}
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

async function fetchEpisodeBySeriesV4(creds, seriesId, season, episode, log) {
  const targetSeason = Number(season)
  const targetEpisode = Number(episode)
  if (!Number.isFinite(targetSeason) || !Number.isFinite(targetEpisode)) return null
  let page = 0
  let safety = 0
  while (safety < 10) {
    const path = `/v4/series/${encodeURIComponent(seriesId)}/episodes/default?page=${page}&season=${encodeURIComponent(targetSeason)}`
    const res = await apiRequest(path, creds, {}, log)
    if (!res || res.statusCode !== 200) return null
    let parsed
    try { parsed = JSON.parse(res.body || '{}') } catch (e) { parsed = null }
    let list = []
    if (parsed && Array.isArray(parsed.data)) list = parsed.data
    else if (parsed && parsed.data && Array.isArray(parsed.data.episodes)) list = parsed.data.episodes
    else if (parsed && parsed.data && Array.isArray(parsed.data.items)) list = parsed.data.items
    if (log) {
  try { log(`TVDB_EP_SEARCH mode=v4 seriesId=${seriesId} season=${season} episode=${episode} page=${page} hits=${list.length}`) } catch (e) {}
    }
    if (list.length) {
      for (const ep of list) {
        if (!ep) continue
        const s = Number(ep.seasonNumber != null ? ep.seasonNumber : (ep.airedSeason != null ? ep.airedSeason : ep.season))
        const eNum = Number(ep.number != null ? ep.number : (ep.airedEpisodeNumber != null ? ep.airedEpisodeNumber : ep.episodeNumber))
        if (Number.isFinite(s) && Number.isFinite(eNum) && s === targetSeason && eNum === targetEpisode) {
          const title = extractEpisodeTitle(ep)
          if (!hasMeaningfulTitle(title)) return null
          if (log) {
            try { log(`TVDB_EP_PICK mode=v4 seriesId=${seriesId} season=${season} episode=${episode} title=${safe(title)}`) } catch (e) {}
          }
          return { episodeTitle: title, episode: ep }
        }
      }
    }
    const next = parsed && parsed.links && parsed.links.next
    if (!Number.isFinite(Number(next))) break
    const nextPage = Number(next)
    if (nextPage === page) break
    page = nextPage
    safety += 1
  }
  return null
}

async function fetchEpisodeBySeries(creds, seriesId, season, episode, log) {
  if (!creds) return null
  return fetchEpisodeBySeriesV4(creds, seriesId, season, episode, log)
}

async function fetchEpisode(creds, titles, season, episode, options = {}) {
  if (!creds || season == null || episode == null) return null
  const log = typeof options.log === 'function' ? options.log : null
  if (log) {
    try {
      log(`TVDB_FETCH_REQUEST mode=v4 titles=${safe(Array.isArray(titles) ? titles.join('|') : titles)} season=${season} episode=${episode}`)
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
    const seriesId = resolveSeriesId(series)
    if (!series) {
      if (log) {
        try { log(`TVDB_SERIES_MISS mode=v4 name=${safe(cand)}`) } catch (e) {}
      }
      continue
    }
    if (seriesId == null) {
      if (log) {
        try { log(`TVDB_SERIES_ID_MISSING mode=v4 name=${safe(cand)}`) } catch (e) {}
      }
      continue
    }
    const seriesName = series.seriesName || series.series_name || series.name || cand
  const episodeData = await fetchEpisodeBySeries(creds, seriesId, season, episode, log)
    if (!episodeData) continue
    if (log) {
      try { log(`TVDB_FETCH_SUCCESS mode=v4 seriesId=${seriesId} seriesName=${safe(seriesName)} title=${safe(episodeData.episodeTitle)}`) } catch (e) {}
    }
    return {
      seriesId,
      seriesName,
      episodeTitle: episodeData.episodeTitle,
      raw: { series, episode: episodeData.episode }
    }
  }
  if (log) {
    try { log(`TVDB_FETCH_EMPTY mode=v4 season=${season} episode=${episode}`) } catch (e) {}
  }
  return null
}

module.exports = { fetchEpisode }
