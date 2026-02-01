const https = require('https')

const authCache = new Map()

// Pre-compiled regex patterns for performance
const REGEX_WHITESPACE_COMPACT = /[\r\n]+/g
const REGEX_NON_ASCII = /[^\x20-\x7E]/g
const REGEX_LATIN_CHARS = /[A-Za-z]/
const REGEX_CJK_CHARS = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u
const REGEX_ALPHA_UNICODE = /[A-Za-z\p{L}]/gu
const REGEX_EPISODE_PATTERN = /^(?:episode|ep|e)\s*\d+$/i
const REGEX_PUNCTUATION = /[^a-z0-9\s]/g
const REGEX_WHITESPACE_SPLIT = /\s+/

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
  if (val == null) return ''
  try {
    const str = String(val)
    if (str.length <= limit && !REGEX_WHITESPACE_COMPACT.test(str) && !REGEX_NON_ASCII.test(str)) {
      return str // Fast path for clean strings
    }
    return str
      .replace(REGEX_WHITESPACE_COMPACT, ' ')
      .replace(REGEX_NON_ASCII, '?')
      .slice(0, limit)
  } catch (e) {
    return ''
  }
}

function safeJson(obj, limit = 400) {
  if (!obj) return ''
  try {
    const json = JSON.stringify(obj)
    return json.length <= limit ? json : json.slice(0, limit)
  } catch (e) {
    return ''
  }
}

function resolveSeriesId(series) {
  if (!series) return null
  const candidateValues = [
    series.tvdb_id,
    series.tvdbId,
    series.tvdbID,
    series.id,
    series.seriesId,
    series.seriesID,
    series.series_id,
    series.slug,
    series.seriesSlug,
    series.series_slug,
    series.ids && series.ids.tvdb,
    series.ids && series.ids.id,
    series.ids && series.ids.series,
    series.ids && series.ids.seriesId,
    series.ids && series.ids.seriesID
  ]

  for (const cand of candidateValues) {
    if (cand == null) continue
    if (typeof cand === 'number' && Number.isFinite(cand)) return cand
    if (typeof cand === 'object') {
      const nested = resolveSeriesId(cand)
      if (nested != null) return nested
      continue
    }
    const str = String(cand).trim()
    if (!str) continue
    const digitsOnly = str.replace(/[^0-9]/g, '')
    if (digitsOnly) {
      const num = Number(digitsOnly)
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
  if (REGEX_EPISODE_PATTERN.test(title)) return false
  // Check if purely numeric
  let hasDigit = false, hasNonDigit = false
  for (let i = 0; i < title.length; i++) {
    const code = title.charCodeAt(i)
    if (code >= 48 && code <= 57) hasDigit = true
    else hasNonDigit = true
    if (hasDigit && hasNonDigit) break
  }
  if (hasDigit && !hasNonDigit) return false
  return REGEX_ALPHA_UNICODE.test(title)
}

function normalizeLang(val) {
  if (!val) return ''
  return String(val).trim().toLowerCase()
}

const LANGUAGE_CODE_TOKENS = new Set([
  'en','eng','en-us','en-gb','en-au','en-ca','ja','jpn','ja-jp','x-jat','ja-latn','de','deu','de-de','fr','fra','fr-fr','es','spa','es-es','es-la','it','ita','it-it','pt','por','pt-br','pt-pt','ru','rus','ko','kor','ko-kr','zh','zho','zh-cn','zh-hans','zh-hant','zh-tw','cmn','cht','chs','pl','pol','cs','ces','cze','hu','hun','nl','nld','dut','tr','tur','th','tha','vi','vie','id','ind','ms','msa','sv','swe','fi','fin','da','dan','no','nor','is','isl','sk','slk','sl','slv','lt','lit','lv','lav','et','est','ar','ara','he','heb','uk','ukr','bg','bul','ro','ron','rum','hr','hrv','sr','srp','hi','hin','bn','ben','ta','tam','te','tel','fa','per','prs','ur','urd','el','ell','gre','ga','gle','mt','mlt','af','afr','bs','bos','ca','cat','gl','glg','kk','kaz','mn','mon','ne','nep','pa','pan','si','sin','sw','swa','zu','zul'
])

function isLanguageCodeToken(text) {
  const norm = normalizeLang(text)
  if (!norm) return false
  if (norm.length <= 5 && LANGUAGE_CODE_TOKENS.has(norm)) return true
  return false
}

function detectScriptType(text) {
  const str = String(text || '').trim()
  if (!str) return 'unknown'
  const hasLatin = REGEX_LATIN_CHARS.test(str)
  const hasCjk = REGEX_CJK_CHARS.test(str)
  if (hasLatin) return hasCjk ? 'mixed' : 'latin'
  return hasCjk ? 'cjk' : 'other'
}

function classifyNameCandidate(text, lang, type) {
  const langCode = normalizeLang(lang)
  const typeCode = normalizeLang(type)
  const script = detectScriptType(text)

  if (langCode) {
    if (langCode === 'en' || langCode === 'eng' || langCode === 'english' || langCode.startsWith('en-')) return 'english'
    if (langCode === 'x-jat' || langCode === 'ja-latn' || langCode === 'ja-latin' || langCode === 'romaji') return 'romaji'
    if (langCode === 'ja' || langCode === 'jpn' || langCode === 'japanese' || langCode === 'ja-jp') {
      if (script === 'latin' || script === 'mixed') return 'romaji'
      return 'native'
    }
  }

  if (typeCode) {
    if (typeCode.includes('english')) return 'english'
    if (typeCode.includes('romaji') || typeCode.includes('romanji') || typeCode.includes('translit')) return 'romaji'
    if (typeCode.includes('native') || typeCode.includes('kanji')) return 'native'
  }

  if (!langCode) {
    if (script === 'latin') return 'romaji'
    if (script === 'cjk') return 'native'
  }

  return 'other'
}

function extractEpisodeTitle(ep) {
  if (!ep) return ''
  const buckets = { english: [], romaji: [], native: [], other: [] }
  const seen = new Set()
  let fastResult = null // Cache first good result for fast path

  const addCandidate = (value, bucketHint = null, lang = null, type = null) => {
    if (!value) return
    const trimmed = String(value).trim()
    if (!trimmed || !hasMeaningfulTitle(trimmed)) return
    const key = trimmed.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    const langNorm = lang ? normalizeLang(lang) : null
    if (isLanguageCodeToken(trimmed)) {
      if (!langNorm || isLanguageCodeToken(langNorm)) return
    }
    const valNorm = normalizeLang(trimmed)
    if (langNorm && valNorm === langNorm) return
    const bucket = bucketHint || classifyNameCandidate(trimmed, lang, type)
    const targetBucket = buckets[bucket] || buckets.other
    targetBucket.push(trimmed)
    if (bucket === 'english' && !fastResult) fastResult = trimmed
  }

  addCandidate(ep.englishTitle, 'english')
  addCandidate(ep.english_name, 'english')
  addCandidate(ep.nameEnglish, 'english')
  addCandidate(ep.titleEnglish, 'english')

  addCandidate(ep.episodeName)
  addCandidate(ep.name)
  addCandidate(ep.episode_name)
  addCandidate(ep.title)

  if (ep.translations) {
    if (Array.isArray(ep.translations)) {
      for (const tr of ep.translations) {
        if (!tr) continue
        const name = tr.name || tr.title || tr.value
        const lang = tr.language || tr.iso6391 || tr.iso6393 || tr.locale || tr.lang
        const type = tr.type || tr.translationType || tr.kind
        addCandidate(name, null, lang, type)
      }
    } else if (typeof ep.translations === 'object') {
      for (const [langKey, tr] of Object.entries(ep.translations)) {
        if (!tr) continue
        if (typeof tr === 'string') {
          addCandidate(tr, null, langKey)
          continue
        }
        const name = tr.name || tr.title || tr.value
        const lang = tr.language || tr.iso6391 || tr.iso6393 || tr.locale || tr.lang || langKey
        const type = tr.type || tr.translationType || tr.kind
        addCandidate(name, null, lang, type)
      }
    }
  }

  if (Array.isArray(ep.nameTranslations)) {
    for (const tr of ep.nameTranslations) {
      if (!tr) continue
      if (typeof tr === 'string') {
        addCandidate(tr)
      } else if (typeof tr === 'object') {
        const name = tr.name || tr.title || tr.value
        const lang = tr.language || tr.iso6391 || tr.iso6393 || tr.locale || tr.lang
        const type = tr.type || tr.translationType || tr.kind
        addCandidate(name, null, lang, type)
      }
    }
  }

  // Fast path: return cached English result if found
  if (fastResult) return fastResult
  
  // Standard path: check buckets in order
  return buckets.english[0] || buckets.romaji[0] || buckets.native[0] || buckets.other[0] || ''
}

function collectEpisodeLangCodes(ep) {
  const codes = new Set()
  if (!ep) return codes
  const push = (val) => {
    const norm = normalizeLang(val)
    if (norm) codes.add(norm)
  }
  if (Array.isArray(ep.nameTranslations)) {
    for (const tr of ep.nameTranslations) {
      if (!tr) continue
      if (typeof tr === 'string') {
        push(tr)
      } else if (typeof tr === 'object') {
        push(tr.language || tr.lang || tr.locale || tr.iso6391 || tr.iso6393)
      }
    }
  }
  if (ep.translations) {
    if (Array.isArray(ep.translations)) {
      for (const tr of ep.translations) {
        if (!tr) continue
        push(tr.language || tr.lang || tr.locale || tr.iso6391 || tr.iso6393)
      }
    } else if (typeof ep.translations === 'object') {
      for (const key of Object.keys(ep.translations)) push(key)
    }
  }
  push(ep.language)
  push(ep.originalLanguage)
  push(ep.airedLanguage)
  return codes
}

async function fetchEpisodeTranslation(creds, episodeId, lang, log) {
  if (!creds || !episodeId || !lang) return null
  const langCode = normalizeLang(lang)
  if (!langCode) return null
  if (log) {
    try { log(`TVDB_EP_TRANSLATION_FETCH mode=v4 episodeId=${episodeId} lang=${langCode}`) } catch (e) {}
  }
  const path = `/v4/episodes/${encodeURIComponent(episodeId)}/translations/${encodeURIComponent(langCode)}`
  const res = await apiRequest(path, creds, {}, log)
  if (!res || res.statusCode !== 200) {
    if (log) {
      try { log(`TVDB_EP_TRANSLATION_FETCH_RESULT mode=v4 episodeId=${episodeId} lang=${langCode} status=${res ? res.statusCode : '<none>'}`) } catch (e) {}
    }
    return null
  }
  let parsed
  try { parsed = JSON.parse(res.body || '{}') } catch (e) { parsed = null }
  if (!parsed) return null
  const candidates = []
  if (Array.isArray(parsed.data)) candidates.push(...parsed.data)
  else if (parsed.data) candidates.push(parsed.data)
  else if (Array.isArray(parsed.translations)) candidates.push(...parsed.translations)
  else if (parsed.translation) candidates.push(parsed.translation)
  for (const item of candidates) {
    if (!item) continue
    const name = item.name || item.title || item.value
    if (!name) continue
    const trimmed = String(name).trim()
    if (!trimmed) continue
    if (!hasMeaningfulTitle(trimmed)) continue
    if (log) {
      try { log(`TVDB_EP_TRANSLATION_FOUND mode=v4 episodeId=${episodeId} lang=${langCode} title=${safe(trimmed)}`) } catch (e) {}
    }
    return trimmed
  }
  return null
}

async function resolvePreferredEpisodeTitle(creds, ep, log) {
  if (!ep) return ''
  const best = { english: null, romaji: null, native: null, other: null }
  const consider = (value, langHint) => {
    if (!value) return
    const trimmed = String(value).trim()
    if (!trimmed) return
    if (!hasMeaningfulTitle(trimmed)) return
    const bucket = classifyNameCandidate(trimmed, langHint)
    if (best[bucket] == null) best[bucket] = trimmed
    else if (bucket === 'other' && best.other == null) best.other = trimmed
  }

  const initialTitle = extractEpisodeTitle(ep)
  consider(initialTitle)

  if (best.english) return best.english

  const available = collectEpisodeLangCodes(ep)
  const fetchSequence = []
  const queued = new Set()
  const enqueue = (codes) => {
    for (const raw of codes) {
      const norm = normalizeLang(raw)
      if (!norm) continue
      if (!available.has(norm)) continue
      if (queued.has(norm)) continue
      queued.add(norm)
      fetchSequence.push(norm)
      break
    }
  }

  enqueue(['eng'])
  enqueue(['en'])
  if (!best.romaji) enqueue(['x-jat','ja-latn','romaji'])

  for (const langCode of fetchSequence) {
    const translation = await fetchEpisodeTranslation(creds, ep.id || ep.episodeId || ep.episodeID, langCode, log)
    if (!translation) continue
    consider(translation, langCode)
    if (best.english) break
  }

  return best.english || best.romaji || best.native || best.other || ''
}

async function fetchSeriesTranslation(creds, seriesId, lang, log) {
  if (!creds || !seriesId || !lang) return null
  const langCode = normalizeLang(lang)
  if (!langCode) return null
  if (log) {
    try { log(`TVDB_SERIES_TRANSLATION_FETCH mode=v4 seriesId=${seriesId} lang=${langCode}`) } catch (e) {}
  }
  const path = `/v4/series/${encodeURIComponent(seriesId)}/translations/${encodeURIComponent(langCode)}`
  const res = await apiRequest(path, creds, {}, log)
  if (!res || res.statusCode !== 200) {
    if (log) {
      try { log(`TVDB_SERIES_TRANSLATION_FETCH_RESULT mode=v4 seriesId=${seriesId} lang=${langCode} status=${res ? res.statusCode : '<none>'}`) } catch (e) {}
    }
    return null
  }
  let parsed
  try { parsed = JSON.parse(res.body || '{}') } catch (e) { parsed = null }
  if (!parsed) return null
  const candidates = []
  if (Array.isArray(parsed.data)) candidates.push(...parsed.data)
  else if (parsed.data) candidates.push(parsed.data)
  else if (Array.isArray(parsed.translations)) candidates.push(...parsed.translations)
  else if (parsed.translation) candidates.push(parsed.translation)
  for (const item of candidates) {
    if (!item) continue
    const name = item.name || item.title || item.value
    if (!name || !String(name).trim()) continue
    const firstAiredRaw = item.firstAired || item.first_aired || item.firstAiredIso || item.first_aired_iso || null
    const firstAired = firstAiredRaw ? String(firstAiredRaw).trim() : null
    return {
      name: String(name).trim(),
      firstAired: firstAired || null,
      raw: item
    }
  }
  return null
}

async function fetchSeriesExtended(creds, seriesId, log) {
  if (!creds || !seriesId) return null
  if (log) {
    try { log(`TVDB_SERIES_EXTENDED_FETCH mode=v4 seriesId=${seriesId}`) } catch (e) {}
  }
  const path = `/v4/series/${encodeURIComponent(seriesId)}/extended`
  const res = await apiRequest(path, creds, {}, log)
  if (!res || res.statusCode !== 200) {
    if (log) {
      try { log(`TVDB_SERIES_EXTENDED_FETCH_RESULT mode=v4 seriesId=${seriesId} status=${res ? res.statusCode : '<none>'}`) } catch (e) {}
    }
    return null
  }
  let parsed
  try { parsed = JSON.parse(res.body || '{}') } catch (e) { parsed = null }
  if (!parsed || !parsed.data) return null
  
  const data = parsed.data
  const result = {
    id: data.id,
    name: data.name,
    parentSeries: null,
    parentSeriesId: null,
    year: null
  }
  
  // Extract year from firstAired or year field
  if (data.firstAired) {
    const yearMatch = String(data.firstAired).match(/^(\d{4})/);
    if (yearMatch) result.year = yearMatch[1];
  } else if (data.year) {
    result.year = String(data.year);
  }
  
  // Extract parent series information if available
  if (data.parentSeries && data.parentSeries.id) {
    result.parentSeriesId = data.parentSeries.id
    result.parentSeriesName = data.parentSeries.name || data.parentSeries.seriesName || null
    if (log) {
      try { log(`TVDB_PARENT_SERIES_DETECTED child=${safe(data.name)} parent=${safe(result.parentSeriesName)} parentId=${result.parentSeriesId}`) } catch (e) {}
    }
  }
  
  return result
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
    // Filter out obvious spinoffs/specials that contain location markers
    // e.g., "Restaurant to Another World in Singapore!" should not match "Restaurant to Another World"
    const itemName = String(item.name || item.seriesName || '').toLowerCase()
    if (itemName.includes(' in singapore') || itemName.includes(' in korea') || itemName.includes(' in japan')) {
      // Only filter if the search query doesn't also contain the location
      const queryLower = String(name || '').toLowerCase()
      if (!queryLower.includes(' in singapore') && !queryLower.includes(' in korea') && !queryLower.includes(' in japan')) {
        return false
      }
    }
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
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
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
      let score = overlapScore(norm, target)
      // Small boost for earlier results (TVDB returns more relevant series first)
      // This helps main series beat spinoffs when scores are close
      if (i === 0) score += 0.05
      else if (i === 1) score += 0.02
      if (log) {
        try { log(`TVDB_SERIES_SCORE mode=v4 candidate="${safe(t)}" target="${safe(name)}" score=${score.toFixed(3)} position=${i}`) } catch (e) {}
      }
      if (score > bestScore) { bestScore = score; best = item }
    }
  }
  const pick = best || list[0]
  if (log && pick) {
    try { log(`TVDB_SERIES_PICK mode=v4 id=${pick.id || '<none>'} name=${safe(pick.seriesName || pick.series_name || pick.name || name)} bestScore=${bestScore.toFixed(3)}`) } catch (e) {}
  }
  return pick
}

function overlapScore(candidate, target) {
  // Exact match gets highest score
  if (candidate === target) return 1000
  
  const candidateTokens = candidate.replace(REGEX_PUNCTUATION, ' ').split(REGEX_WHITESPACE_SPLIT).filter(Boolean)
  const targetTokens = target.replace(REGEX_PUNCTUATION, ' ').split(REGEX_WHITESPACE_SPLIT).filter(Boolean)
  if (!candidateTokens.length || !targetTokens.length) return 0
  
  // Use Set for O(1) lookup instead of array.includes O(n)
  const candidateSet = new Set(candidateTokens)
  let common = 0
  for (let i = 0; i < targetTokens.length; i++) {
    if (candidateSet.has(targetTokens[i])) common++
  }
  
  // Base score: coverage of target tokens
  const coverage = common / targetTokens.length
  
  // Penalize extra words: if candidate has more tokens than target, reduce score heavily
  // This prevents "Restaurant to Another World in Singapore!" from scoring higher than "Restaurant to Another World"
  // Use 0.25 penalty per extra token to ensure spinoffs/specials don't win over main series
  const lengthPenalty = Math.max(0, candidateTokens.length - targetTokens.length) * 0.25
  
  return coverage - lengthPenalty
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
          const title = await resolvePreferredEpisodeTitle(creds, ep, log)
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

    // Prefer English alias over potentially non-English primary name
    let preferredName = seriesName
    if (series.aliases && Array.isArray(series.aliases)) {
      const englishAlias = series.aliases.find(alias => alias && typeof alias === 'string' && /[A-Za-z]/.test(alias) && alias.length > 2)
      if (englishAlias) {
        preferredName = englishAlias
      }
    }

    let seriesTranslation = null
    let seriesFirstAired = series.firstAired || series.first_aired || null
    const needsEnglish = !/[A-Za-z]/.test(String(preferredName || ''))
    if (needsEnglish || !seriesFirstAired) {
      seriesTranslation = await fetchSeriesTranslation(creds, seriesId, 'eng', log)
      if (seriesTranslation) {
        if (needsEnglish && seriesTranslation.name) {
          preferredName = seriesTranslation.name
        }
        if (!seriesFirstAired && seriesTranslation.firstAired) {
          seriesFirstAired = seriesTranslation.firstAired
        }
      }
    }

    const episodeData = await fetchEpisodeBySeries(creds, seriesId, season, episode, log)
    if (!episodeData) continue
    
    // Fetch extended series information to check for parent series
    let parentSeriesName = null
    let parentSeriesId = null
    try {
      const extendedData = await fetchSeriesExtended(creds, seriesId, log)
      if (extendedData && extendedData.parentSeriesName) {
        parentSeriesName = extendedData.parentSeriesName
        parentSeriesId = extendedData.parentSeriesId
      }
    } catch (extErr) {
      if (log) {
        try { log(`TVDB_EXTENDED_FETCH_ERROR seriesId=${seriesId} error=${safe(extErr.message)}`) } catch (e) {}
      }
    }
    
    if (log) {
      try { log(`TVDB_FETCH_SUCCESS mode=v4 seriesId=${seriesId} seriesName=${safe(preferredName)} title=${safe(episodeData.episodeTitle)} parentSeries=${parentSeriesName ? safe(parentSeriesName) : 'none'}`) } catch (e) {}
    }
    return {
      seriesId,
      seriesName: preferredName,
      seriesFirstAired,
      episodeTitle: episodeData.episodeTitle,
      parentSeriesName,
      parentSeriesId,
      raw: { series, episode: episodeData.episode, seriesTranslation: seriesTranslation ? seriesTranslation.raw : null }
    }
  }
  if (log) {
    try { log(`TVDB_FETCH_EMPTY mode=v4 season=${season} episode=${episode}`) } catch (e) {}
  }
  return null
}

async function fetchSeriesById(creds, seriesId, log) {
  if (!creds || !seriesId) return null
  try {
    const token = await getToken(creds)
    if (!token) return null
    
    const path = `/v4/series/${encodeURIComponent(seriesId)}/extended`
    const options = {
      hostname: 'api4.thetvdb.com',
      path,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
    }
    
    if (log) {
      try { log(`TVDB_SERIES_BY_ID_REQUEST mode=v4 seriesId=${seriesId}`) } catch (e) {}
    }
    
    const res = await request(options, null, 5000)
    if (log) {
      try { log(`TVDB_API_RESPONSE mode=v4 path=${path} status=${res.statusCode}`) } catch (e) {}
    }
    
    if (!res || !res.body || res.statusCode !== 200) return null
    
    let json = null
    try { json = JSON.parse(res.body) } catch (e) { return null }
    
    const series = json && json.data ? json.data : null
    if (!series || !series.id) return null
    
    const seriesName = series.name || null
    if (!seriesName) return null
    
    return {
      seriesId: series.id,
      seriesName,
      raw: series
    }
  } catch (e) {
    if (log) {
      try { log(`TVDB_SERIES_BY_ID_ERROR seriesId=${seriesId} error=${safe(e.message || String(e), 200)}`) } catch (e) {}
    }
    return null
  }
}

async function fetchEpisodeBySeriesId(creds, seriesId, season, episode, options = {}) {
  if (!creds || !seriesId || season == null || episode == null) return null
  const log = options.log || null
  
  try {
    const token = await getToken(creds)
    if (!token) return null
    
    // Search for episode using series ID
    const seasonStr = String(season)
    const episodeStr = String(episode)
    const path = `/v4/series/${encodeURIComponent(seriesId)}/episodes/default?season=${encodeURIComponent(seasonStr)}&episodeNumber=${encodeURIComponent(episodeStr)}`
    const opts = {
      hostname: 'api4.thetvdb.com',
      path,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
    }
    
    if (log) {
      try { log(`TVDB_EPISODE_BY_SERIES_ID_REQUEST mode=v4 seriesId=${seriesId} season=${season} episode=${episode}`) } catch (e) {}
    }
    
    const res = await request(opts, null, 5000)
    if (log) {
      try { log(`TVDB_API_RESPONSE mode=v4 path=${path} status=${res.statusCode}`) } catch (e) {}
    }
    
    if (!res || !res.body || res.statusCode !== 200) return null
    
    let json = null
    try { json = JSON.parse(res.body) } catch (e) { return null }
    
    const episodes = json && json.data && json.data.episodes ? json.data.episodes : null
    if (!episodes || !episodes.length) return null
    
    const ep = episodes[0]
    const episodeTitle = extractEpisodeTitle(ep)
    if (!episodeTitle) return null
    
    // Get series name from series ID
    const seriesInfo = await fetchSeriesById(creds, seriesId, log)
    const seriesName = seriesInfo ? seriesInfo.seriesName : null
    
    return {
      episodeId: ep.id || null,
      episodeTitle,
      seriesId,
      seriesName,
      tvdb: { episodeId: ep.id, episodeTitle, seriesId, seriesName, raw: ep }
    }
  } catch (e) {
    if (log) {
      try { log(`TVDB_EPISODE_BY_SERIES_ID_ERROR seriesId=${seriesId} season=${season} episode=${episode} error=${safe(e.message || String(e), 200)}`) } catch (e) {}
    }
    return null
  }
}

module.exports = { fetchEpisode, extractEpisodeTitle, fetchSeriesExtended, fetchSeriesById, fetchEpisodeBySeriesId, fetchEpisodeBySeries }
