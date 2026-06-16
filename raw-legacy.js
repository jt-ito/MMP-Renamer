
// --- RESTORED LEGACY FUNCTIONS ---

function normalizeForCache(s) {
  try {
    if (!s) return ''
    return String(s).toLowerCase().replace(/[\._\-:]+/g,' ').replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim()
  } catch (e) { return String(s || '').toLowerCase().trim() }
}

function sanitizeExtraGuess(extraGuess, fallback) {
  try {
    const safe = {};
    const skipKeys = new Set(['provider', 'parsed', 'extraGuess', 'raw', 'cachedAt', 'sourceId', 'renderedName', 'metadataFilename', 'applied', 'hidden']);
    if (extraGuess && typeof extraGuess === 'object') {
      for (const key of Object.keys(extraGuess)) {
        if (!Object.prototype.hasOwnProperty.call(extraGuess, key)) continue;
        if (skipKeys.has(key)) continue;
        const val = extraGuess[key];
        if (typeof val === 'function') continue;
        if (val && typeof val === 'object') {
          const cloned = safeCloneJson(val, `extraGuess.${key}`);
          if (cloned !== null) safe[key] = cloned;
        } else if (val !== undefined) {
          safe[key] = val;
        }
      }
    }
    if (fallback && typeof fallback === 'object') {
      const fallbackFields = [
        'seriesTitle',
        'seriesTitleExact',
        'seriesTitleEnglish',
        'seriesTitleRomaji',
        'originalSeriesTitle',
        'seriesLookupTitle',
        'parentCandidate',
        'mediaFormat',
        'episodeTitle',
        'episodeRange',
        'episode',
        'season',
        'title',
        'year'
      ];
      for (const field of fallbackFields) {
        if (Object.prototype.hasOwnProperty.call(safe, field)) continue;
        const value = fallback[field];
        if (value !== undefined && value !== null) safe[field] = value;
      }
      if (typeof safe.isMovie === 'undefined' && typeof fallback.isMovie === 'boolean') {
        safe.isMovie = fallback.isMovie;
      }
    }
    return Object.keys(safe).length ? safe : null;
  } catch (e) {
    return null;
  }
}

function cleanEnrichmentForClient(entry) {
  if (entry && entry.provider && entry.provider.renderedName) {
    // Keep renderedName for custom metadata so user sees exactly what they entered
    const isCustom = entry.provider.source === 'custom' || entry.sourceId === 'custom';
    if (isCustom) {
      return entry;
    }
    // For other sources, strip renderedName to save bandwidth (client can compute it)
    const cleaned = Object.assign({}, entry);
    cleaned.provider = Object.assign({}, entry.provider);
    delete cleaned.provider.renderedName;
    return cleaned;
  }
  return entry;
}

const hostPace = { 'graphql.anilist.co': 250, 'kitsu.io': 250, 'api.themoviedb.org': 300, 'en.wikipedia.org': 300 }

async function pace(host) {
    const now = Date.now()
    const last = lastRequestAt[host] || 0
    const wait = Math.max(0, (hostPace[host] || 300) - (now - last))
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
    lastRequestAt[host] = Date.now()
  }

function extractSeasonNumberFromTitle(t) {
    try {
      if (!t) return null
      const s = String(t)
      // Common patterns: "Season 2", "Season 01", "S02", "S2", "(Season 2)", ordinals like "3rd Season",
      // and textual ordinals like "Third Season". Support up to tenth.
      // Numeric with word 'season'
      let m = s.match(/season[^0-9a-z]{0,3}(\d{1,2})(?:st|nd|rd|th)?/i)
      if (m && m[1]) return parseInt(m[1],10)
      // Ordinal numeric forms: "3rd Season" or "Season 3rd"
      m = s.match(/(\d{1,2})(?:st|nd|rd|th)\s*(?:season)?/i)
      if (m && m[1]) return parseInt(m[1],10)
      // Single-letter S prefix: S02, S2
      m = s.match(/\bS(\d{1,2})\b/i)
      if (m && m[1]) return parseInt(m[1],10)
      // Textual ordinals up to tenth
      m = s.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/i)
      if (m && m[1]) {
        const map = { first:1, second:2, third:3, fourth:4, fifth:5, sixth:6, seventh:7, eighth:8, ninth:9, tenth:10 }
        const k = String(m[1] || '').toLowerCase()
        if (map[k]) return map[k]
      }
      // fallback: trailing digits like "Title 2" — only treat as season when
      // the title is short (likely an explicit season marker) or contains
      // only 1-2 words (e.g., "Show 2"). This avoids treating long series
      // names with sequel numerals (e.g., "Getsuyoubi no Tawawa 2") as seasons.
      m = s.match(/(?:[\(\[\- ]|\b)(\d{1,2})(?:[\)\]\- ]|\b)$/)
      if (m && m[1]) {
        try {
          const trimmed = s.trim();
          const words = trimmed.split(/\s+/).filter(Boolean);
          const trailingNum = parseInt(m[1], 10);
          if (Number.isNaN(trailingNum)) return null;
          if (trimmed.length <= 20 || words.length <= 2) {
            return trailingNum;
          }
          const precedingWord = words.length >= 2 ? words[words.length - 2].toLowerCase() : '';
          const blocked = new Set(['part','movie','film','volume','vol','chapter','episode','ep','ova','special','sp','disc']);
          const validSequel = trailingNum >= 2 && trailingNum <= 12 && words.length >= 3 && !blocked.has(precedingWord);
          if (validSequel) return trailingNum;
        } catch (e) { /* ignore and do not treat as season */ }
      }
    } catch (e) {}
    return null
  }

async function searchTmdbAndEpisode(q, tmdbKey, season, episode) {
    if (!tmdbKey) return null
    
    // Normalize apostrophes to straight ASCII before searching TMDB
    q = normalizeApostrophes(q)
    
    // Helper to swap Philosopher's <-> Sorcerer's Stone for Harry Potter
    const getAlternativeTitle = (title) => {
      if (!title) return null
      const titleStr = String(title)
      if (/philosopher'?s\s+stone/i.test(titleStr)) {
        return titleStr.replace(/philosopher'?s\s+stone/i, "Sorcerer's Stone")
      }
      if (/sorcerer'?s\s+stone/i.test(titleStr)) {
        return titleStr.replace(/sorcerer'?s\s+stone/i, "Philosopher's Stone")
      }
      return null
    }
    
    try {
      const isMovie = (season == null || episode == null)
      const searchType = isMovie ? 'movie' : 'tv'
      
      await pace('api.themoviedb.org')
      const qenc = encodeURIComponent(String(q || '').slice(0,200))
      const searchPath = `/3/search/${searchType}?api_key=${encodeURIComponent(tmdbKey)}&query=${qenc}`
      const sres = await httpRequest({ hostname: 'api.themoviedb.org', path: searchPath, method: 'GET', headers: { 'Accept': 'application/json' } }, null, 3000)
      if (!sres || !sres.body) {
        // Try alternative title if original search failed (e.g., Philosopher's <-> Sorcerer's Stone)
        const altTitle = getAlternativeTitle(q)
        if (altTitle) {
          try {
            await pace('api.themoviedb.org')
            const altQenc = encodeURIComponent(String(altTitle).slice(0,200))
            const altSearchPath = `/3/search/${searchType}?api_key=${encodeURIComponent(tmdbKey)}&query=${altQenc}`
            const altSres = await httpRequest({ hostname: 'api.themoviedb.org', path: altSearchPath, method: 'GET', headers: { 'Accept': 'application/json' } }, null, 3000)
            if (altSres && altSres.body) {
              let altSj = null
              try { altSj = JSON.parse(altSres.body) } catch (e) { altSj = null }
              const altHits = altSj && altSj.results && Array.isArray(altSj.results) ? altSj.results : []
              if (altHits.length) {
                try { appendLog(`META_TMDB_ALT_TITLE_SUCCESS original=${q} alternative=${altTitle} found=yes`) } catch (e) {}
                const top = altHits[0]
                let name = top.name || top.original_name || top.title || top.original_title || null
                // Strip colon before Part N in movie titles
                if (name && /:\s*Part\s+\d{1,2}\b/i.test(name)) {
                  name = name.replace(/:\s*(Part\s+\d{1,2}\b)/i, ' $1')
                }
                const raw = Object.assign({}, top, { source: 'tmdb', media_type: searchType })
                return { provider: 'tmdb', id: top.id, name, raw }
              }
            }
          } catch (e) { /* ignore alternative title search errors */ }
        }
        return null
      }
      
      let sj = null
      try { sj = JSON.parse(sres.body) } catch (e) { sj = null }
      const hits = sj && sj.results && Array.isArray(sj.results) ? sj.results : []
      
      if (!hits.length) {
        // Try alternative title if no results (e.g., Philosopher's <-> Sorcerer's Stone)
        const altTitle = getAlternativeTitle(q)
        if (altTitle) {
          try {
            await pace('api.themoviedb.org')
            const altQenc = encodeURIComponent(String(altTitle).slice(0,200))
            const altSearchPath = `/3/search/${searchType}?api_key=${encodeURIComponent(tmdbKey)}&query=${altQenc}`
            const altSres = await httpRequest({ hostname: 'api.themoviedb.org', path: altSearchPath, method: 'GET', headers: { 'Accept': 'application/json' } }, null, 3000)
            if (altSres && altSres.body) {
              let altSj = null
              try { altSj = JSON.parse(altSres.body) } catch (e) { altSj = null }
              const altHits = altSj && altSj.results && Array.isArray(altSj.results) ? altSj.results : []
              if (altHits.length) {
                try { appendLog(`META_TMDB_ALT_TITLE_SUCCESS original=${q} alternative=${altTitle} found=yes`) } catch (e) {}
                const top = altHits[0]
                let name = top.name || top.original_name || top.title || top.original_title || null
                // Strip colon before Part N in movie titles
                if (name && /:\s*Part\s+\d{1,2}\b/i.test(name)) {
                  name = name.replace(/:\s*(Part\s+\d{1,2}\b)/i, ' $1')
                }
                const raw = Object.assign({}, top, { source: 'tmdb', media_type: searchType })
                
                // For TV shows with season/episode, try to fetch episode details
                if (!isMovie && season != null && episode != null) {
                  try {
                    await pace('api.themoviedb.org')
                    const epPath = `/3/tv/${encodeURIComponent(top.id)}/season/${encodeURIComponent(season)}/episode/${encodeURIComponent(episode)}?api_key=${encodeURIComponent(tmdbKey)}`
                    const eres = await httpRequest({ hostname: 'api.themoviedb.org', path: epPath, method: 'GET', headers: { 'Accept': 'application/json' } }, null, 3000)
                    if (eres && eres.body) {
                      let ej = null
                      try { ej = JSON.parse(eres.body) } catch (e) { ej = null }
                      if (ej && (ej.name || ej.title)) {
                        const withEpisodeSource = (payload) => {
                          if (!payload || typeof payload !== 'object') return payload
                          if (payload.source === 'tmdb') return payload
                          return Object.assign({ source: 'tmdb' }, payload)
                        }
                        return { provider: 'tmdb', id: top.id, name, raw, episode: withEpisodeSource(ej) }
                      }
                    }
                  } catch (e) { /* ignore episode fetch errors */ }
                }
                
                return { provider: 'tmdb', id: top.id, name, raw }
              }
            }
          } catch (e) { /* ignore alternative title search errors */ }
        }
        return null
      }
      
      const top = hits[0]
      let name = top.name || top.original_name || top.title || top.original_title || null
      // Strip colon before Part N in movie titles
      if (name && /:\s*Part\s+\d{1,2}\b/i.test(name)) {
        name = name.replace(/:\s*(Part\s+\d{1,2}\b)/i, ' $1')
      }
      const raw = Object.assign({}, top, { source: 'tmdb', media_type: searchType })
      
      const withEpisodeSource = (payload) => {
        if (!payload || typeof payload !== 'object') return payload
        if (payload.source === 'tmdb') return payload
        return Object.assign({ source: 'tmdb' }, payload)
      }
      
      // For movies, just return the movie details
      if (isMovie) {
        return { provider: 'tmdb', id: top.id, name, raw }
      }
      
      // For TV shows with season/episode, fetch episode details
      if (season != null && episode != null) {
        try {
          await pace('api.themoviedb.org')
          const epPath = `/3/tv/${encodeURIComponent(top.id)}/season/${encodeURIComponent(season)}/episode/${encodeURIComponent(episode)}?api_key=${encodeURIComponent(tmdbKey)}`
          const eres = await httpRequest({ hostname: 'api.themoviedb.org', path: epPath, method: 'GET', headers: { 'Accept': 'application/json' } }, null, 3000)
          if (eres && eres.body) {
            let ej = null
            try { ej = JSON.parse(eres.body) } catch (e) { ej = null }
            if (ej && (ej.name || ej.title)) {
              const epNameRaw = String(ej.name || ej.title || '').trim()
              // basic placeholder detection
              const isPlaceholder = /^episode\s*\d+/i.test(epNameRaw) || /^ep\b\s*\d+/i.test(epNameRaw) || /^e\d+$/i.test(epNameRaw) || (!/[A-Za-z]/.test(epNameRaw) && /\d/.test(epNameRaw))
              // detect non-Latin/CJK-only titles (likely native-language titles)
              const hasLatin = /[A-Za-z]/.test(epNameRaw)
              const hasCJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(epNameRaw)

              // If title is meaningful and Latin (English-like), return it immediately
              if (!isPlaceholder && hasLatin) return { provider: 'tmdb', id: top.id, name, raw, episode: withEpisodeSource(ej) }

              // Otherwise attempt translations endpoint to find an English/localized title
              try {
                await pace('api.themoviedb.org')
                const tpath = `/3/tv/${encodeURIComponent(top.id)}/season/${encodeURIComponent(season)}/episode/${encodeURIComponent(episode)}/translations?api_key=${encodeURIComponent(tmdbKey)}`
                const tres = await httpRequest({ hostname: 'api.themoviedb.org', path: tpath, method: 'GET', headers: { 'Accept': 'application/json' } }, null, 3000)
                if (tres && tres.body) {
                  let tj = null
                  try { tj = JSON.parse(tres.body) } catch (e) { tj = null }
                  const translations = tj && (tj.translations || tj.translations && tj.translations.translations) ? (tj.translations || tj.translations.translations) : (tj && tj.translations ? tj.translations : [])
                  if (Array.isArray(translations) && translations.length) {
                    // prefer English translations, then any non-placeholder translation
                    let picked = null
                    for (const tr of translations) {
                      try {
                        const lang = String(tr.iso_639_1 || '').toLowerCase()
                        const data = tr.data || tr
                        const cand = data && (data.name || data.title) ? String(data.name || data.title).trim() : ''
                        if (!cand) continue
                        const candPlaceholder = /^episode\s*\d+/i.test(cand) || /^ep\b\s*\d+/i.test(cand) || /^e\d+$/i.test(cand) || (!/[A-Za-z]/.test(cand) && /\d/.test(cand))
                        if (lang === 'en' && !candPlaceholder) { picked = cand; break }
                        if (!picked && !candPlaceholder) picked = cand
                      } catch (e) { continue }
                    }
                    if (picked) {
                      // attach the localized name into episode data for caller
                      try { ej.localized_name = picked } catch (e) {}
                      return { provider: 'tmdb', id: top.id, name, raw, episode: withEpisodeSource(ej) }
                    }
                  }
                }
              } catch (e) { /* ignore translation fetch errors */ }

              // If original was non-Latin but we couldn't find a translation, still return the raw
              // episode object (caller will decide whether to accept non-English titles).
              return { provider: 'tmdb', id: top.id, name, raw, episode: withEpisodeSource(ej) }
            }
          }
        } catch (e) {}
      }
      return { provider: 'tmdb', id: top.id, name, raw }
    } catch (e) { return null }
  }

async function lookupWikipediaEpisode(seriesTitle, season, episode, options) {
    try {
      // reload persistent cache from disk to respect external test clears
      try { wikiEpisodeCache = JSON.parse(fs.readFileSync(wikiEpisodeCacheFile, 'utf8') || '{}') } catch (e) { wikiEpisodeCache = wikiEpisodeCache || {} }
      if (!seriesTitle || season == null || episode == null) return null
      const force = options && options.force ? true : false
      // Accept either a string title or an array/object of title variants
      let titleVariants = []
      if (Array.isArray(seriesTitle)) titleVariants = seriesTitle.map(x=>String(x||'').trim()).filter(Boolean)
      else if (typeof seriesTitle === 'object' && seriesTitle !== null) {
        // object could be an AniList media node: pick english/romaji/native
        try { if (seriesTitle.english) titleVariants.push(seriesTitle.english) } catch (e) {}
        try { if (seriesTitle.romaji) titleVariants.push(seriesTitle.romaji) } catch (e) {}
        try { if (seriesTitle.native) titleVariants.push(seriesTitle.native) } catch (e) {}
      } else {
        titleVariants = [String(seriesTitle || '').trim()]
      }
      // unique normalized variants
      titleVariants = [...new Set(titleVariants.map(s=>String(s||'').trim()).filter(Boolean))]

      // cache TTL and validation windows
      const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days
      const CACHE_VALIDATE_MS = 1000 * 60 * 60 * 24 * 7 // 7 days: validate older entries

      // helper: count episode numbers present in a parsed HTML section (best-effort)
      function countEpisodesInHtml(htmlSection) {
        try {
          if (!htmlSection) return 0
          const tableRe = /<table[\s\S]*?<\/table>/ig
          let maxEp = 0
          let tbl
          while ((tbl = tableRe.exec(htmlSection)) !== null) {
            const tHtml = tbl[0]
            const rowRe = /<tr[\s\S]*?<\/tr>/ig
            let rowm
            while ((rowm = rowRe.exec(tHtml)) !== null) {
              const r = rowm[0]
              const cellRe = /<(t[dh])\b[^>]*>([\s\S]*?)<\/\1>/ig
              const cells = Array.from(r.matchAll(cellRe)).map(x => x[2])
              for (const c of cells) {
                const txt = String(c).replace(/<[^>]+>/g, '').replace(/&nbsp;|\u00A0/g, ' ').replace(/\s+/g,' ').trim()
                const m = txt.match(/\b(\d{1,3})(?:\.\d+)?\b/)
                if (m && m[1]) {
                  const n = Number(m[1])
                  if (!isNaN(n) && n > maxEp) maxEp = n
                }
              }
            }
          }
          return maxEp
        } catch (e) { return 0 }
      }

      // helper: clean up raw episode title text, prefer quoted English title and strip transliteration/language suffixes
      function cleanEpisodeTitle(raw) {
        try {
          if (!raw) return raw
          let s = String(raw).trim()
          // prefer text inside double quotes (straight or curly)
          const quoteMatch = s.match(/["“”«»\u201C\u201D]([^"“”«»\u201C\u201D]+)["“”«»\u201C\u201D]/)
          if (quoteMatch && quoteMatch[1]) return quoteMatch[1].trim()
          // prefer single-quoted if double not found
          const singleMatch = s.match(/[\'‘’]([^\'‘’]+)[\'‘’]/)
          if (singleMatch && singleMatch[1]) return singleMatch[1].trim()
          // remove parenthetical Japanese/Language annotations
          s = s.replace(/\(\s*Japanese:[^\)]*\)/i, '').replace(/\(\s*Japanese language[^\)]*\)/i, '')
          // drop common transliteration markers and everything after them
          const splitRe = /\bTransliteration\b|\bRomanization\b|\bTranslit\b|\bTrans\.\b|\bTranscription\b|\bTranslation\b|\bOriginal\b/i
          const sp = s.split(splitRe)
          if (sp && sp.length) s = sp[0].trim()
          // also remove trailing language colon sections like 'Japanese: ...'
          s = s.replace(/\s*Japanese:\s*.*$/i, '').trim()
          // strip wrapping quotes if any remain
          s = s.replace(/^['"\u201C\u201D\u2018\u2019]+/, '').replace(/['"\u201C\u201D\u2018\u2019]+$/, '')
          // collapse spaces
          s = s.replace(/\s{2,}/g,' ').trim()
          return s
        } catch (e) { return raw }
      }

      // helper: determine whether a cleaned title seems like a real episode title (not a date or numeric-only)
      function isMeaningfulTitle(s) {
        try {
          if (!s) return false
          const t = String(s).trim()
          // must contain at least one letter (latin or CJK) and not be just a year/date
          if (!/[A-Za-z - - - - - - - - - - - - - -\p{L}]/u.test(t)) return false
          // reject common date patterns like 'June 30, 2020', '2025-09-28', '30 June 2020[12]', etc.
          const dateLike = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,\s*\d{4})?/i
          if (dateLike.test(t)) return false
          if (/\b\d{4}\b/.test(t) && /^[\d\s\-:,\/]+$/.test(t.replace(/\(.*?\)/g,''))) return false
          if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return false
          // reject if it's mostly numbers / punctuation (e.g., '2020[12]' or 'S01E01' alone)
          const alphaCount = (t.match(/[A-Za-z\p{L}]/gu) || []).length
          const totalCount = t.length
          if (totalCount > 0 && alphaCount / totalCount < 0.2) return false
          // otherwise assume it's meaningful
          return true
        } catch (e) { return true }
      }

      // helper: detect placeholder-style titles like "Episode 13", "Ep. 13", numeric-only labels
      function isPlaceholderTitle(s) {
        try {
          if (!s) return false
          const t = String(s).trim()
          // pure forms: "Episode 13", "Ep 13", "Ep.13", "E13" (short/placeholders)
          if (/^(?:e(?:p(?:isode)?)?|episode|ep)\b[\s\.\:\/\-]*\d+$/i.test(t)) return true
          // also detect strings that are essentially just a number or labelled number
          // but be conservative: if the string contains alphabetic words longer than 2 chars,
          // treat it as meaningful (e.g., 'Dying Service 1' should NOT be considered a placeholder).
          const alphaPart = t.replace(/[^A-Za-z\p{L}]+/gu, ' ').trim()
          const hasLongWord = alphaPart.split(/\s+/).some(w => w && w.length > 2)
          const stripped = t.replace(/\b(?:episode|ep|ep\.|no|number)\b/ig, '').replace(/[^0-9]/g, '').trim()
          if (!hasLongWord && stripped && /^[0-9]+$/.test(stripped) && stripped.length <= 4 && t.length < 30) return true
          return false
        } catch (e) { return false }
      }

      try {
        for (const tv of titleVariants) {
          const key = `${normalizeForCache(String(tv))}|s${Number(season)}|e${Number(episode)}`
          const entr = wikiEpisodeCache && wikiEpisodeCache[key] ? wikiEpisodeCache[key] : null
          if (entr && entr.name) {
            // if cached value doesn't look like a real title, evict and continue
            try {
              if (!isMeaningfulTitle(entr.name)) {
                try { writeWikiLog(`NON_TITLE_CACHE_REMOVED key=${key} name=${String(entr.name).slice(0,120)}`) } catch (e) {}
                delete wikiEpisodeCache[key]
                try { writeJson(wikiEpisodeCacheFile, wikiEpisodeCache) } catch (e) {}
                continue
              }
            } catch (e) {}
            const age = Date.now() - (entr.ts || 0)
            if (age < CACHE_TTL_MS) {
              // if entry older than validation window, attempt lightweight validation
              if (!force && age >= CACHE_VALIDATE_MS) {
                try {
                  const pageIdent = entr.raw && (entr.raw.page || entr.raw.pageid || entr.raw.pageId)
                  if (pageIdent) {
                    await pace('en.wikipedia.org')
                    const pidPath = `/w/api.php?action=parse&page=${encodeURIComponent(String(pageIdent))}&prop=text&format=json`;
                    try {
                      const pres = await httpRequest({ hostname: 'en.wikipedia.org', path: pidPath, method: 'GET', headers: { 'Accept': 'application/json', 'User-Agent': 'renamer/1.0' } }, null, 5000)
                      if (pres && pres.body) {
                        let pj = null
                        try { pj = JSON.parse(pres.body) } catch (e) { pj = null }
                        const html = pj && pj.parse && pj.parse.text && pj.parse.text['*'] ? pj.parse.text['*'] : null
                        if (html) {
                          const seasonRegex = Number(season) === 0 ? /Specials|Special episodes/i : new RegExp(`Season\\s*${Number(season)}|Series\\s*${Number(season)}|Season[^\\d]{0,6}${Number(season)}`, 'i')
                          let sectionHtml = null
                          const headingRe = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/ig
                          const heads = []
                          let m2
                          while ((m2 = headingRe.exec(html)) !== null) {
                            const inner = String(m2[1] || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|\s+/g, ' ').trim()
                            heads.push({ idx: m2.index, text: inner })
                          }
                          let headMatchIdx = -1
                          for (const hitem of heads) { try { if (seasonRegex.test(hitem.text)) { headMatchIdx = hitem.idx; break } } catch (e) {} }
                          if (headMatchIdx === -1) {
                            const h2 = html.match(seasonRegex)
                            if (h2 && typeof h2.index === 'number') headMatchIdx = h2.index
                          }
                          if (headMatchIdx !== -1) {
                            let nextHeadIdx = html.length
                            for (const hh of heads) { if (hh.idx > headMatchIdx) { nextHeadIdx = Math.min(nextHeadIdx, hh.idx); } }
                            sectionHtml = html.slice(headMatchIdx, nextHeadIdx)
                          } else {
                            sectionHtml = html
                          }
                          const maxEp = countEpisodesInHtml(sectionHtml)
                          try { writeWikiLog(`VALIDATE key=${key} currentMaxEp=${maxEp} requestedEp=${Number(episode)}`) } catch (e) {}
                          if (maxEp && maxEp < Number(episode)) {
                            try { appendLog(`META_WIKIPEDIA_CACHE_INVALID key=${key} maxEp=${maxEp} req=${episode}`) } catch (e) {}
                            try { writeWikiLog(`INVALIDATED key=${key} maxEp=${maxEp} req=${episode}`) } catch (e) {}
                            delete wikiEpisodeCache[key]
                            try { writeJson(wikiEpisodeCacheFile, wikiEpisodeCache) } catch (e) {}
                            continue
                          }
                        }
                      }
                    } catch (e) { /* ignore validation fetch errors and treat cache as valid */ }
                  }
                } catch (e) { /* ignore validation errors */ }
              }
              if (force) {
                try { appendLog(`META_WIKIPEDIA_CACHE_SKIPPED key=${key} forced=true`) } catch (e) {}
                try { writeWikiLog(`CACHE_SKIPPED key=${key} titleVariant=${tv} name=${entr.name}`) } catch (e) {}
                continue
              }
                try { appendLog(`META_WIKIPEDIA_CACHE_HIT key=${key} name=${String(entr.name).slice(0,120)}`) } catch (e) {}
                try { writeWikiLog(`CACHE_HIT key=${key} titleVariant=${tv} name=${entr.name}`) } catch (e) {}
                // Diagnostic: log cached page identifier and original raw title when available
                try { appendLog(`META_WIKIPEDIA_CACHE_PAGE key=${key} page=${(entr.raw && (entr.raw.page || entr.raw.pageid)) ? String(entr.raw.page || entr.raw.pageid).slice(0,120) : '<unknown>'} original=${String((entr.raw && entr.raw.original) || '').slice(0,140)}`) } catch (e) {}
                // If caller provided a TMDb key, attempt to verify and prefer TMDb episode title when present
                try {
                  if (options && options.tmdbKey) {
                    const tmCheck = await searchTmdbAndEpisode(tv, options.tmdbKey, season, episode)
                    if (tmCheck && tmCheck.episode && (tmCheck.episode.name || tmCheck.episode.title)) {
                      // ensure the TMDb-provided episode title is meaningful (not a placeholder like 'Episode 13')
                      const tmName = (tmCheck.episode.name || tmCheck.episode.title) ? String(tmCheck.episode.name || tmCheck.episode.title).trim() : ''
                      try {
                        if (isMeaningfulTitle(tmName) && !isPlaceholderTitle(tmName)) {
                          try { appendLog(`META_TMDB_VERIFIED_CACHE key=${key} tm=${tmName}`) } catch (e) {}
                          return Object.assign({}, tmCheck)
                        } else {
                          try { appendLog(`META_TMDB_VERIFIED_CACHE_IGNORED_PLACEHOLDER key=${key} tm=${tmName}`) } catch (e) {}
                        }
                      } catch (e) { /* fall through to wiki cached value */ }
                    }
                  }
                } catch (e) {}
                return { name: entr.name, raw: entr.raw || { source: 'wikipedia', cached: true, page: (entr.raw && entr.raw.page) ? entr.raw.page : null } }
            }
          }
        }
      } catch (e) { /* ignore cache read errors */ }

      await pace('en.wikipedia.org')
      // Build expanded candidate queries from each title variant
      const candidates = []
      for (const t of titleVariants) {
        candidates.push(`List of ${t} episodes`)
        candidates.push(`${t} episodes`)
        candidates.push(`${t} (season ${season})`)
        candidates.push(`${t} season ${season} episodes`)
        // also try shorter forms without punctuation
        candidates.push(`${t.replace(/[\._\-:]+/g,' ')} episodes`)
      }
      // de-duplicate and limit
      const uniqCandidates = [...new Set(candidates)].slice(0,12)
      for (const q of uniqCandidates) {
        try {
          try { appendLog(`META_WIKIPEDIA_SEARCH q=${q}`); writeWikiLog(`SEARCH q=${q} season=${season} episode=${episode}`) } catch (e) {}
          const path = `/w/api.php?action=query&format=json&list=search&srsearch=${encodeURIComponent(String(q).slice(0,250))}&srlimit=6`;
          const sres = await httpRequest({ hostname: 'en.wikipedia.org', path, method: 'GET', headers: { 'Accept': 'application/json', 'User-Agent': 'renamer/1.0' } }, null, 4000)
          if (!sres || !sres.body) continue
          let sj = null
          try { sj = JSON.parse(sres.body) } catch (e) { sj = null }
          const hits = sj && sj.query && Array.isArray(sj.query.search) ? sj.query.search : []
          if (!hits.length) continue
          // Try each hit: fetch parsed HTML and look for season section and episode row
          for (const h of hits) {
            try {
              const pid = h.pageid || h.docid || h.pageId
              if (!pid) continue
              // Diagnostic: log which Wikipedia page we're about to fetch for this search hit
              try { appendLog(`META_WIKIPEDIA_PAGE_FETCH q=${q} page=${pid} title=${String(h.title || h).slice(0,120)}`) } catch (e) {}
              await pace('en.wikipedia.org')
              const ppath = `/w/api.php?action=parse&pageid=${encodeURIComponent(pid)}&prop=text&format=json`;
              const pres = await httpRequest({ hostname: 'en.wikipedia.org', path: ppath, method: 'GET', headers: { 'Accept': 'application/json', 'User-Agent': 'renamer/1.0' } }, null, 5000)
              if (!pres || !pres.body) continue
              let pj = null
              try { pj = JSON.parse(pres.body) } catch (e) { pj = null }
              const html = pj && pj.parse && pj.parse.text && pj.parse.text['*'] ? pj.parse.text['*'] : null
              // Verify the page is for the intended series: check page title and lead paragraph
              try {
                const pageTitle = (pj && pj.parse && pj.parse.title) ? String(pj.parse.title).trim() : null
                const leadMatch = (html && html.slice(0, 2000)) ? String(html).slice(0, 2000).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim() : ''
                // normalize helper reused for cache; fallback to basic lower/strip
                const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim()
                let matchedPage = false
                try {
                  for (const tv of titleVariants) {
                    try {
                      const n = norm(tv)
                      if (!n) continue
                      if (pageTitle && norm(pageTitle).indexOf(n) !== -1) { matchedPage = true; break }
                      if (leadMatch && leadMatch.toLowerCase().indexOf(tv.toLowerCase()) !== -1) { matchedPage = true; break }
                    } catch (e) { continue }
                  }
                } catch (e) { matchedPage = false }
                if (!matchedPage) {
                  try { writeWikiLog(`SKIP_PAGE_MISMATCH page=${pageTitle || pid} candidates=${titleVariants.join('|')}`) } catch (e) {}
                  continue
                }
              } catch (e) { /* best-effort page verification - ignore failures */ }
              if (!html) continue
              // Find section matching season number (or 'Specials' when season==0)
              const seasonNum = Number(season)
              let sectionHtml = null
              // find heading tags (<h1>-<h6>) and test their inner text for a season match
              const headingRe = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/ig
              const heads = []
              let m
              while ((m = headingRe.exec(html)) !== null) {
                // m[1] contains inner HTML of heading; strip tags to get text
                const inner = String(m[1] || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|\s+/g, ' ').trim()
                heads.push({ idx: m.index, text: inner })
              }
              try { writeWikiLog(`DEBUG_HEADS count=${heads.length} previews=${heads.slice(0,6).map(h=>h.text.replace(/\s+/g,' ').slice(0,80)).join('||')}`) } catch (e) {}
              // fallback simple search: locate "Season X" text nearby
              const seasonRegex = seasonNum === 0 ? /Specials|Special episodes/i : new RegExp(`Season\\s*${seasonNum}|Series\\s*${seasonNum}|Season[^\\d]{0,6}${seasonNum}`, 'i')
              let headMatchIdx = -1
              for (const hitem of heads) {
                try {
                  if (seasonRegex.test(hitem.text)) { headMatchIdx = hitem.idx; break }
                } catch (e) {}
              }
              if (headMatchIdx === -1) {
                // last resort: search the whole document for a season header text
                const h2 = html.match(seasonRegex)
                if (h2 && typeof h2.index === 'number') headMatchIdx = h2.index
              }
              if (headMatchIdx !== -1) {
                // find next headline or end of document
                let nextHeadIdx = html.length
                for (const hh of heads) { if (hh.idx > headMatchIdx) { nextHeadIdx = Math.min(nextHeadIdx, hh.idx); } }
                sectionHtml = html.slice(headMatchIdx, nextHeadIdx)
              } else {
                // as a fallback, try to search entire HTML for episode rows
                sectionHtml = html
              }
              if (!sectionHtml) continue
              // find tables in section
              const tableRe = /<table[\s\S]*?<\/table>/ig
              let tbl
              while ((tbl = tableRe.exec(sectionHtml)) !== null) {
                try {
                  const tHtml = tbl[0]
                  // find rows
                  const rowRe = /<tr[\s\S]*?<\/tr>/ig
                  // detect header row to find episode-number column index (if present)
                  let headerIndex = -1
                  try {
                    const headerRowMatch = tHtml.match(/<tr[\s\S]*?<th[\s\S]*?<\/tr>/i)
                    if (headerRowMatch && headerRowMatch[0]) {
                      const hdr = headerRowMatch[0]
                      const thRe = /<th\b[^>]*>([\s\S]*?)<\/th>/ig
                      const ths = Array.from(hdr.matchAll(thRe)).map(x => String(x[1] || '').replace(/<[^>]+>/g,'').replace(/&nbsp;|\u00A0/g,' ').replace(/\s+/g,' ').trim())
                      for (let hi = 0; hi < ths.length; hi++) {
                        try {
                          if (/^\s*(?:no\.?|#|episode|ep\.?|number|titre|title)\b/i.test(ths[hi]) || /episode\b/i.test(ths[hi])) { headerIndex = hi; break }
                        } catch (e) {}
                      }
                    }
                  } catch (e) { headerIndex = -1 }
                  let rowm
                  while ((rowm = rowRe.exec(tHtml)) !== null) {
                    try {
                      const r = rowm[0]
                      // parse cells (<th> and <td>) to avoid accidental matches in dates
                      const cellRe = /<(t[dh])\b[^>]*>([\s\S]*?)<\/\1>/ig
                      const cells = Array.from(r.matchAll(cellRe)).map(x => ({ tag: x[1], html: x[2] }))
                      if (!cells.length) continue
                      function stripText(s) { try { return String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;|\u00A0/g, ' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g, "'").replace(/\s+/g,' ').trim() } catch (e) { return String(s || '').replace(/<[^>]+>/g,'').trim() } }
                      const plain = cells.map(c => stripText(c.html))
                      // canonical episode number regex
                      const epNumRegex = new RegExp(`^${Number(episode)}(?:\\.\\d+)?\\s*(?:\\(|$)`, '')
                      let numIdx = -1
                      if (headerIndex !== -1 && headerIndex < plain.length) {
                        // prefer numeric match in header-detected column, but if it doesn't match
                        // scan the rest of the cells so we don't miss episodes where numbering
                        // appears in a different column despite header labeling.
                        if (epNumRegex.test(plain[headerIndex])) numIdx = headerIndex
                        else {
                          for (let i = 0; i < plain.length; i++) {
                            if (epNumRegex.test(plain[i])) { numIdx = i; break }
                          }
                        }
                      } else {
                        // fall back: scan for numeric cell
                        for (let i = 0; i < plain.length; i++) {
                          if (epNumRegex.test(plain[i])) { numIdx = i; break }
                        }
                      }
                      if (numIdx === -1) {
                        // Require an explicit numeric episode cell to avoid false matches (dates, references).
                        try { writeWikiLog(`ROW_SKIPPED_no_numeric_cell series=${seriesTitle} season=${season} episode=${episode}`) } catch (e) {}
                        continue
                      }
                      // attempt to select title cell: prefer a cell with class="summary"
                      let titleHtml = null
                      const summaryMatch = r.match(/<td[^>]*class="summary"[^>]*>([\s\S]*?)<\/td>/i)
                      if (summaryMatch && summaryMatch[1]) titleHtml = summaryMatch[1]
                      if (!titleHtml && numIdx !== -1) {
                        // prefer the cell immediately to the right of the episode-number cell
                        for (let k = numIdx + 1; k < Math.min(plain.length, numIdx + 4); k++) {
                          if (plain[k] && /[A-Za-z\u00C0-\u024F\u3040-\u30FF\u4E00-\u9FFF\"'\u201C\u201D]/.test(plain[k])) {
                            titleHtml = cells[k].html; break
                          }
                        }
                      }
                      if (!titleHtml) {
                        // fallback: pick the first <td> that looks like a title
                        const tds = Array.from(r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/ig)).map(x=>x[1])
                        let pick = null
                        for (const td of tds) {
                          if (/\btitle\b/i.test(td) || /<i>|<em>|<a /i.test(td) || /"/.test(td)) { pick = td; break }
                        }
                        if (!pick && tds.length) pick = tds[Math.min(2, tds.length-1)]
                        titleHtml = pick
                      }
                      if (!titleHtml) continue
                      let rawTitle = stripText(titleHtml)
                      if (!rawTitle) continue
                      const cleaned = cleanEpisodeTitle(rawTitle)
                      // if cleaned title looks like a date or otherwise non-title, skip and continue to other hits
                      if (!isMeaningfulTitle(cleaned)) {
                        try { writeWikiLog(`SKIP_NON_TITLE series=${seriesTitle} season=${season} episode=${episode} raw=${rawTitle.slice(0,140)}`) } catch (e) {}
                        continue
                      }
                      try { appendLog(`META_WIKIPEDIA_OK series=${seriesTitle} season=${season} episode=${episode} title=${cleaned.slice(0,200)}`) } catch (e) {}
                      try { writeWikiLog(`HIT series=${seriesTitle} season=${season} episode=${episode} title=${cleaned.slice(0,200)}`) } catch (e) {}
                      // Diagnostic: record which page produced the hit and the raw extracted title
                      try { appendLog(`META_WIKIPEDIA_HIT_PAGE series=${seriesTitle} season=${season} episode=${episode} page=${String(h.title || pid).slice(0,120)} pageid=${pid} raw=${String(rawTitle || '').slice(0,140)}`) } catch (e) {}
                      // persist to cache (keep original raw for diagnostics)
                      try {
                        const key = `${normalizeForCache(String(seriesTitle))}|s${Number(season)}|e${Number(episode)}`.trim()
                        wikiEpisodeCache[key] = { name: cleaned, raw: { source: 'wikipedia', page: h.title || h, original: rawTitle }, ts: Date.now() }
                        try { writeJson(wikiEpisodeCacheFile, wikiEpisodeCache) } catch (e) {}
                      } catch (e) {}
                      return { name: cleaned, raw: { source: 'wikipedia', page: h.title || h, original: rawTitle } }
                    } catch (e) { continue }
                  }
                } catch (e) { continue }
              }
            } catch (e) { continue }
          }
        } catch (e) { continue }
      }
    } catch (e) { try { appendLog(`META_WIKIPEDIA_ERROR title=${seriesTitle} err=${e && e.message ? e.message : String(e)}`) } catch (e) {} }
    return null
  }

function isMeaningfulTitle(s) {
        try {
          if (!s) return false
          const t = String(s).trim()
          // must contain at least one letter (latin or CJK) and not be just a year/date
          if (!/[A-Za-z - - - - - - - - - - - - - -\p{L}]/u.test(t)) return false
          // reject common date patterns like 'June 30, 2020', '2025-09-28', '30 June 2020[12]', etc.
          const dateLike = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,\s*\d{4})?/i
          if (dateLike.test(t)) return false
          if (/\b\d{4}\b/.test(t) && /^[\d\s\-:,\/]+$/.test(t.replace(/\(.*?\)/g,''))) return false
          if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return false
          // reject if it's mostly numbers / punctuation (e.g., '2020[12]' or 'S01E01' alone)
          const alphaCount = (t.match(/[A-Za-z\p{L}]/gu) || []).length
          const totalCount = t.length
          if (totalCount > 0 && alphaCount / totalCount < 0.2) return false
          // otherwise assume it's meaningful
          return true
        } catch (e) { return true }
      }

function isPlaceholderTitle(s) {
        try {
          if (!s) return false
          const t = String(s).trim()
          // pure forms: "Episode 13", "Ep 13", "Ep.13", "E13" (short/placeholders)
          if (/^(?:e(?:p(?:isode)?)?|episode|ep)\b[\s\.\:\/\-]*\d+$/i.test(t)) return true
          // also detect strings that are essentially just a number or labelled number
          // but be conservative: if the string contains alphabetic words longer than 2 chars,
          // treat it as meaningful (e.g., 'Dying Service 1' should NOT be considered a placeholder).
          const alphaPart = t.replace(/[^A-Za-z\p{L}]+/gu, ' ').trim()
          const hasLongWord = alphaPart.split(/\s+/).some(w => w && w.length > 2)
          const stripped = t.replace(/\b(?:episode|ep|ep\.|no|number)\b/ig, '').replace(/[^0-9]/g, '').trim()
          if (!hasLongWord && stripped && /^[0-9]+$/.test(stripped) && stripped.length <= 4 && t.length < 30) return true
          return false
        } catch (e) { return false }
      }

function renderCustomMetadataName(data, session) {
  try {
    const userTemplate = (session && session.username && users[session.username] && users[session.username].settings && users[session.username].settings.rename_template) ? users[session.username].settings.rename_template : null;
    const baseNameTemplate = userTemplate || serverSettings.rename_template || '{title} ({year}) - {epLabel} - {episodeTitle}';
    
    // Use the title provided by user, apply title casing if all-caps
    let cleanTitle = String(data.title || '').trim();
    try {
      const letters = cleanTitle.replace(/[^a-zA-Z]/g, '');
      const isAllCaps = letters.length > 0 && letters === letters.toUpperCase();
      if (isAllCaps) cleanTitle = titleCase(cleanTitle);
    } catch (e) { /* ignore casing errors */ }
    
    // Format episode label
    function pad(n){ return String(n).padStart(2,'0') }
    let epLabel = '';
    if (data.episode != null) {
      epLabel = data.season != null ? `S${pad(data.season)}E${pad(data.episode)}` : `E${pad(data.episode)}`;
    }
    
    // Clean episode title
    let cleanEpisodeTitle = String(data.episodeTitle || '').trim();
    try {
      const letters = cleanEpisodeTitle.replace(/[^a-zA-Z]/g, '');
      const isAllCaps = letters.length > 0 && letters === letters.toUpperCase();
      if (isAllCaps) cleanEpisodeTitle = titleCase(cleanEpisodeTitle);
    } catch (e) { /* ignore */ }
    
    // Format year
    const yearStr = data.year ? String(data.year).trim() : '';
    
    // Build rendered name from template
    const rendered = String(baseNameTemplate)
      .replace('{title}', sanitize(cleanTitle))
      .replace('{year}', sanitize(yearStr))
      .replace('{epLabel}', sanitize(epLabel))
      .replace('{episodeTitle}', sanitize(cleanEpisodeTitle))
      .replace('{season}', data.season != null ? String(data.season) : '')
      .replace('{episode}', data.episode != null ? String(data.episode) : '')
      .replace(/\s*-\s*-\s*/g, ' - ')  // collapse double separators
      .replace(/\s+-\s*$/g, '')  // remove trailing separator
      .replace(/\s+/g, ' ')  // normalize whitespace
      .trim();
    
    return rendered;
  } catch (e) {
    return null;
  }
}

function resolveMetadataProviderOrder(username) {
  const tryLoad = (source) => {
    if (!source) return null;
    if (source.metadata_provider_order != null) return sanitizeMetadataProviderOrder(source.metadata_provider_order);
    if (source.default_meta_provider != null) return sanitizeMetadataProviderOrder([source.default_meta_provider]);
    return null;
  };
  try {
    if (username && users[username] && users[username].settings) {
      const userOrder = tryLoad(users[username].settings);
      if (userOrder && userOrder.length) return userOrder;
    }
    const serverOrder = tryLoad(serverSettings);
    if (serverOrder && serverOrder.length) return serverOrder;
  } catch (e) { /* ignore */ }
  return [...DEFAULT_METADATA_PROVIDER_ORDER];
}

const IGNORED_DIRS = new Set(['node_modules', '.git', '.svn', '__pycache__']);

const VIDEO_EXTS = ['mkv','mp4','avi','mov','m4v','mpg','mpeg','webm','wmv','flv','ts','ogg','ogv','3gp','3g2'];

function loadScanCache() { return scanLib.loadScanCache(scanCacheFile); }

function saveScanCache(obj) { return scanLib.saveScanCache(scanCacheFile, obj); }

function fullScanLibrary(libPath) { return scanLib.fullScanLibrary(libPath, { ignoredDirs: IGNORED_DIRS, videoExts: VIDEO_EXTS, canonicalize: canonicalize, uuidv4 }); }

function incrementalScanLibrary(libPath) { return scanLib.incrementalScanLibrary(libPath, { scanCacheFile, ignoredDirs: IGNORED_DIRS, videoExts: VIDEO_EXTS, canonicalize: canonicalize, uuidv4 }); }

function loadScanCache() { return scanLib.loadScanCache(scanCacheFile); }

function saveScanCache(obj) { return scanLib.saveScanCache(scanCacheFile, obj); }

function updateEnrichCacheInMemory(key, nextObj) {
  try {
    const prev = enrichCache[key] || {};
    const merged = Object.assign({}, prev, nextObj || {});
    if (merged && merged.provider && merged.provider.matched) {
      delete merged.providerFailure;
    }
    if (typeof merged.providerFailure !== 'undefined' && merged.providerFailure === null) {
      delete merged.providerFailure;
    }
    const normalized = normalizeEnrichEntry(merged);
    enrichCache[key] = preserveAppliedFlags(prev, normalized);
    // Persist sooner so rescans show updated values quickly (best-effort, debounced)
    try { schedulePersistEnrichCache(50); } catch (e) {}
    return enrichCache[key];
  } catch (e) { return nextObj; }
}

function sweepEnrichCache() {
  const removed = [];
  try {
    const keys = Object.keys(enrichCache || {});
    for (const k of keys) {
      try {
        if (!k) continue;
        if (!fs.existsSync(k)) {
          // Preserve entries that carry hidden/applied flags so approval state
          // survives even when the source file is moved or deleted.
          const entry = enrichCache[k];
          if (entry && (entry.hidden || entry.applied)) continue;
          removed.push(k);
          delete enrichCache[k];
        }
      } catch (e) { /* ignore per-key */ }
    }
    // Clean up renderedIndex entries that reference removed sources
    try {
      const rKeys = Object.keys(renderedIndex || {});
      for (const rk of rKeys) {
        try {
          const entry = renderedIndex[rk];
          if (entry && entry.source && removed.indexOf(entry.source) !== -1) {
            delete renderedIndex[rk];
          }
        } catch (e) {}
      }
    } catch (e) {}
    // persist
  try { if (db) db.setKV('enrichCache', enrichCache); else writeJson(enrichStoreFile, enrichCache); } catch (e) {}
  try { if (db) db.setKV('renderedIndex', renderedIndex); else writeJson(renderedIndexFile, renderedIndex); } catch (e) {}
    if (removed.length) appendLog(`ENRICH_SWEEP_AUTO removed=${removed.length}`);
  } catch (e) { appendLog('ENRICH_SWEEP_ERR ' + (e && e.message ? e.message : String(e))) }
  return removed;
}

function normalizeOutputKey(value) {
  try {
    if (!value) return '';
    return canonicalize(path.resolve(String(value)));
  } catch (e) {
    try { return String(value || '').replace(/\\+/g, '/').trim(); } catch (ee) { return String(value || '') }
  }
}

function normalizeApprovedSeriesSource(value) {
  const source = String(value || '').trim().toLowerCase();
  if (source === 'anilist' || source === 'tmdb' || source === 'anidb') return source;
  return 'anilist';
}

function getApprovedSeriesSourcePreferences(username) {
  try {
    if (!username || !users || !users[username]) return {};
    const settings = users[username].settings || {};
    const raw = settings.approved_series_image_source_by_output;
    if (!raw || typeof raw !== 'object') return {};
    return raw;
  } catch (e) { return {}; }
}

function resolveApprovedSeriesSourcePreference(sourcePrefs, outputKey) {
  try {
    if (!sourcePrefs || typeof sourcePrefs !== 'object') {
      return { source: 'anilist', configured: false };
    }
    const normalized = normalizeApprovedSeriesSourceKey(outputKey);
    if (!normalized) {
      return { source: 'anilist', configured: false };
    }
    const saved = sourcePrefs[normalized];
    if (saved) {
      const resolvedSource = normalizeApprovedSeriesSource(saved);
      return { source: resolvedSource, configured: true };
    }
  } catch (e) {
    try { appendLog(`APPROVED_SERIES_SOURCE_RESOLVE_ERR key=${outputKey} err=${e.message}`); } catch (ee) {}
  }
  return { source: 'anilist', configured: false };
}

function setApprovedSeriesSourcePreference(username, outputKey, source) {
  try {
    if (!username) {
      try { appendLog(`APPROVED_SERIES_SOURCE_SAVE_FAIL reason=no_username source=${source}`); } catch (e) {}
      return false;
    }
    users[username] = users[username] || { username, role: 'admin', passwordHash: null, settings: {} };
    users[username].settings = users[username].settings || {};
    const map = users[username].settings.approved_series_image_source_by_output && typeof users[username].settings.approved_series_image_source_by_output === 'object'
      ? users[username].settings.approved_series_image_source_by_output
      : {};
    const normalizedSource = normalizeApprovedSeriesSource(source);
    const normalizedKey = normalizeApprovedSeriesSourceKey(outputKey);
    if (!normalizedKey) {
      try { appendLog(`APPROVED_SERIES_SOURCE_SAVE_FAIL user=${username} reason=invalid_key source=${normalizedSource}`); } catch (e) {}
      return false;
    }
    const oldSource = map[normalizedKey] || null;
    map[normalizedKey] = normalizedSource;
    users[username].settings.approved_series_image_source_by_output = map;
    writeJson(usersFile, users);
    try { appendLog(`APPROVED_SERIES_SOURCE_SAVED user=${username} key=${normalizedKey.slice(0,80)} old=${oldSource||'none'} new=${normalizedSource}`); } catch (e) {}
    return true;
  } catch (e) { 
    try { appendLog(`APPROVED_SERIES_SOURCE_SAVE_FAIL user=${username} err=${e.message}`); } catch (ee) {}
    return false; 
  }
}

async function fetchAndCacheApprovedSeriesImage({ username, outputKey, source, seriesName, allowCooldown = true, force = false }) {
  const selectedSource = normalizeApprovedSeriesSource(source);
  const normalizedOutputKey = normalizeOutputKey(outputKey);
  const cleanSeriesName = String(seriesName || '').trim();
  const seriesKey = cleanSeriesName ? (normalizeForCache(cleanSeriesName) || cleanSeriesName.toLowerCase()) : '';
  if (!normalizedOutputKey) {
    try { appendLog(`APPROVED_SERIES_IMAGE_FETCH_FAIL reason=no_output_key series=${cleanSeriesName.slice(0,80)}`); } catch (e) {}
    return { ok: false, error: 'outputKey is required' };
  }
  if (!cleanSeriesName || !seriesKey) {
    try { appendLog(`APPROVED_SERIES_IMAGE_FETCH_FAIL reason=no_series_name output=${normalizedOutputKey.slice(0,80)}`); } catch (e) {}
    return { ok: false, error: 'seriesName is required' };
  }
  if (!['anilist', 'tmdb', 'anidb'].includes(selectedSource)) {
    try { appendLog(`APPROVED_SERIES_IMAGE_FETCH_FAIL reason=invalid_source source=${selectedSource} series=${cleanSeriesName.slice(0,80)}`); } catch (e) {}
    return { ok: false, error: 'invalid source' };
  }

  const cacheKey = `${normalizedOutputKey}::${seriesKey}`;
  // Force-refresh: evict the cached result and clear the in-flight lock so the fetch
  // proceeds unconditionally, bypassing both the positive and negative caches.
  if (force && cacheKey) {
    delete approvedSeriesImages[cacheKey];
    approvedSeriesImageFetchLocks.delete(`${username || 'anon'}::${normalizedOutputKey}::${seriesKey}`);
  }

  const existing = approvedSeriesImages && approvedSeriesImages[cacheKey] ? approvedSeriesImages[cacheKey] : null;

  // Negative cache hit: a previous fetch confirmed this series has no image anywhere.
  // Honour this for up to 7 days so we don't hammer APIs for series that will never have artwork.
  if (existing && existing.provider === 'none' &&
      existing.fetchedAt && (Date.now() - existing.fetchedAt) < APPROVED_SERIES_NEGATIVE_CACHE_TTL_MS) {
    try { appendLog(`APPROVED_SERIES_IMAGE_CACHE_HIT series=${cleanSeriesName.slice(0,80)} source=${selectedSource} cached_provider=none reason=no_image`); } catch (e) {}
    return { ok: true, cached: true, fetched: false, source: selectedSource, reason: 'no-image' };
  }

  // A cached provider is compatible with the requested source when they match exactly,
  // OR when the source is 'anidb' and the cache holds an 'anilist-fallback-from-anidb' result
  // (AniDB's own API returned no picture, so AniList was used as a deliberate fallback).
  const isCacheCompatible = (existing && existing.imageUrl) &&
    (existing.provider === selectedSource ||
     (selectedSource === 'anidb' && existing.provider === 'anilist-fallback-from-anidb'));
  if (isCacheCompatible) {
    try { appendLog(`APPROVED_SERIES_IMAGE_CACHE_HIT series=${cleanSeriesName.slice(0,80)} source=${selectedSource} cached_provider=${existing.provider}`); } catch (e) {}
    return { ok: true, cached: true, fetched: false, source: selectedSource, imageUrl: existing.imageUrl, summary: existing.summary || '' };
  }
  if (existing && !isCacheCompatible && existing.imageUrl) {
    try { appendLog(`APPROVED_SERIES_IMAGE_CACHE_PROVIDER_MISMATCH series=${cleanSeriesName.slice(0,80)} cached=${existing.provider} requested=${selectedSource}`); } catch (e) {}
  }

  const lockKey = `${username || 'anon'}::${normalizedOutputKey}::${seriesKey}`;
  const now = Date.now();
  const lockInfo = approvedSeriesImageFetchLocks.get(lockKey) || null;
  if (lockInfo && lockInfo.inFlight) {
    try { appendLog(`APPROVED_SERIES_IMAGE_SKIP series=${cleanSeriesName.slice(0,80)} reason=in_flight source=${selectedSource}`); } catch (e) {}
    return { ok: true, skipped: true, fetched: false, reason: 'in-flight', source: selectedSource };
  }
  if (allowCooldown && lockInfo && lockInfo.lastFetchedAt && (now - lockInfo.lastFetchedAt) < APPROVED_SERIES_FETCH_COOLDOWN_MS) {
    const remainingMs = APPROVED_SERIES_FETCH_COOLDOWN_MS - (now - lockInfo.lastFetchedAt);
    try { appendLog(`APPROVED_SERIES_IMAGE_SKIP series=${cleanSeriesName.slice(0,80)} reason=cooldown remaining_ms=${remainingMs} source=${selectedSource}`); } catch (e) {}
    return { ok: true, skipped: true, fetched: false, reason: 'cooldown', source: selectedSource };
  }

  try { appendLog(`APPROVED_SERIES_IMAGE_FETCH_ATTEMPT series=${cleanSeriesName.slice(0,80)} source=${selectedSource} output=${normalizedOutputKey.slice(0,80)}`); } catch (e) {}
  approvedSeriesImageFetchLocks.set(lockKey, { inFlight: true, lastFetchedAt: lockInfo && lockInfo.lastFetchedAt ? lockInfo.lastFetchedAt : 0 });
  try {
    const lookedUp = await fetchApprovedSeriesArtwork({ username, outputKey: normalizedOutputKey, source: selectedSource, seriesName: cleanSeriesName });
    approvedSeriesImageFetchLocks.set(lockKey, { inFlight: false, lastFetchedAt: Date.now() });

    if (!lookedUp || !lookedUp.imageUrl) {
      try { appendLog(`APPROVED_SERIES_IMAGE_FETCH_RESULT series=${cleanSeriesName.slice(0,80)} source=${selectedSource} result=none`); } catch (e) {}
      // Note: 'fallback=anilist' here means no image was found at all (negative cache stored).
      // The actual AniList fallback attempt (if any) already happened inside fetchAniDbSeriesArtwork.
      if (selectedSource !== 'anilist') {
        try { appendLog(`APPROVED_SERIES_IMAGE_FETCH_FALLBACK series=${cleanSeriesName.slice(0,80)} source=${selectedSource} fallback=anilist note=negative_cache_stored`); } catch (e) {}
      }
      // Persist a negative cache entry so this series is not retried on every page load.
      // The entry expires after APPROVED_SERIES_NEGATIVE_CACHE_TTL_MS (7 days).
      approvedSeriesImages[cacheKey] = { provider: 'none', imageUrl: null, fetchedAt: Date.now() };
      try { writeJson(approvedSeriesImagesFile, approvedSeriesImages); } catch (e) {}
      return { ok: true, fetched: false, skipped: true, source: selectedSource, reason: 'no-image' };
    }

    const actualProvider = lookedUp.provider || selectedSource;
    try { appendLog(`APPROVED_SERIES_IMAGE_FETCH_RESULT series=${cleanSeriesName.slice(0,80)} source=${selectedSource} provider=${actualProvider} result=success imageUrl=${lookedUp.imageUrl.slice(0,100)}`); } catch (e) {}
    const cachedSummary = lookedUp.summary || (existing && existing.summary) || '';
    approvedSeriesImages[cacheKey] = {
      provider: actualProvider,
      imageUrl: lookedUp.imageUrl,
      summary: cachedSummary,
      mediaId: lookedUp.id || null,
      fetchedAt: lookedUp.fetchedAt || Date.now()
    };
    try { writeJson(approvedSeriesImagesFile, approvedSeriesImages); } catch (e) {}
    return { ok: true, fetched: true, source: selectedSource, imageUrl: lookedUp.imageUrl, summary: cachedSummary };
  } catch (err) {
    approvedSeriesImageFetchLocks.set(lockKey, { inFlight: false, lastFetchedAt: Date.now() });
    try { appendLog(`APPROVED_SERIES_IMAGE_FETCH_EXCEPTION series=${cleanSeriesName.slice(0,80)} source=${selectedSource} err=${err.message}`); } catch (e) {}
    throw err;
  }
}

function deriveAppliedSeriesInfo(appliedPath) {
  try {
    const resolved = path.resolve(String(appliedPath || ''));
    const seasonFolder = path.dirname(resolved);
    const maybeSeriesFolder = path.dirname(seasonFolder);
    const seasonName = path.basename(seasonFolder || '');
    const isSeasonFolder = /^season\s+\d{1,2}$/i.test(seasonName) || /^specials?$/i.test(seasonName);
    const seriesFolder = isSeasonFolder ? maybeSeriesFolder : seasonFolder;
    const outputRoot = isSeasonFolder ? path.dirname(maybeSeriesFolder) : maybeSeriesFolder;
    const seriesName = path.basename(seriesFolder || '') || null;
    return {
      resolved,
      seriesFolder,
      outputRoot,
      seriesName
    };
  } catch (e) {
    return { resolved: null, seriesFolder: null, outputRoot: null, seriesName: null };
  }
}

function buildApprovedSeriesPayload(username) {
  const configuredOutputs = getConfiguredOutputRoots(username);
  const outputMap = new Map();
  const sourcePrefs = getApprovedSeriesSourcePreferences(username);

  const ensureOutputBucket = (key, displayPath) => {
    if (!key) return null;
    if (!outputMap.has(key)) {
      const resolvedPref = resolveApprovedSeriesSourcePreference(sourcePrefs, key);
      outputMap.set(key, {
        key,
        path: displayPath || key,
        source: resolvedPref.source,
        sourceConfigured: !!resolvedPref.configured,
        seriesMap: new Map()
      });
    }
    return outputMap.get(key);
  };

  for (const conf of configuredOutputs) {
    ensureOutputBucket(conf.key, conf.path);
  }

  const configuredSorted = [...configuredOutputs].sort((a, b) => b.key.length - a.key.length);
  const getOutputBucketForPath = (targetPath) => {
    const targetKey = normalizeOutputKey(targetPath);
    for (const conf of configuredSorted) {
      if (targetKey === conf.key || targetKey.startsWith(conf.key + '/')) {
        return ensureOutputBucket(conf.key, conf.path);
      }
    }
    const inferred = deriveAppliedSeriesInfo(targetPath);
    const inferredKey = normalizeOutputKey(inferred.outputRoot || path.dirname(path.dirname(targetPath || '')));
    return ensureOutputBucket(inferredKey, inferred.outputRoot || inferredKey);
  };

  for (const cacheKey of Object.keys(enrichCache || {})) {
    const entry = enrichCache[cacheKey];
    if (!entry || entry.applied !== true || !entry.appliedTo) continue;
    const targets = Array.isArray(entry.appliedTo) ? entry.appliedTo : [entry.appliedTo];
    for (const target of targets) {
      if (!target) continue;
      const bucket = getOutputBucketForPath(target);
      if (!bucket) continue;
      const info = deriveAppliedSeriesInfo(target);
      const seriesName = getSeriesNameForApprovedEntry(entry, target);
      const seriesKey = normalizeForCache(seriesName) || seriesName.toLowerCase();
      const map = bucket.seriesMap;
      if (!map.has(seriesKey)) {
        map.set(seriesKey, {
          key: seriesKey,
          name: seriesName,
          appliedCount: 0,
          latestAppliedAt: 0,
          samplePath: info.seriesFolder || target,
          summary: `${seriesName}`,
          imageUrl: null,
          imageProvider: null,
          imageFetchedAt: null
        });
      }
      const item = map.get(seriesKey);
      item.appliedCount += 1;
      item.latestAppliedAt = Math.max(item.latestAppliedAt || 0, Number(entry.appliedAt || 0));
      const imageCacheKey = `${bucket.key}::${seriesKey}`;
      const cached = approvedSeriesImages && approvedSeriesImages[imageCacheKey] ? approvedSeriesImages[imageCacheKey] : null;
      if (cached) {
        if (cached.imageUrl) item.imageUrl = cached.imageUrl;
        if (cached.summary) item.summary = cached.summary;
        if (cached.provider) item.imageProvider = cached.provider;
        if (cached.fetchedAt) item.imageFetchedAt = cached.fetchedAt;
      }
      if (!item.summary || item.summary === seriesName) {
        item.summary = `${item.appliedCount} approved item${item.appliedCount === 1 ? '' : 's'}`;
      }
    }
  }

  const outputs = Array.from(outputMap.values())
    .map((bucket) => {
      const series = Array.from(bucket.seriesMap.values())
        .map((item) => {
          // Treat 'anilist-fallback-from-anidb' as compatible with an 'anidb' source preference;
          // AniDB's API had no picture so AniList was used as an intentional fallback.
          const providerCompatible = !item || !item.imageProvider ||
            item.imageProvider === bucket.source ||
            (bucket.source === 'anidb' && item.imageProvider === 'anilist-fallback-from-anidb');
          if (!providerCompatible) {
            return Object.assign({}, item, {
              imageUrl: null,
              imageFetchedAt: null,
              imageProvider: null
            });
          }
          return item;
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        key: bucket.key,
        path: bucket.path,
        source: bucket.source || 'anilist',
        sourceConfigured: !!bucket.sourceConfigured,
        seriesCount: series.length,
        series
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  const totalSeries = outputs.reduce((sum, out) => sum + out.seriesCount, 0);
  return { outputs, totalSeries };
}

function createBgJob(type, totalItems) {
  const id = String(_bgJobIdCounter++);
  const job = { id, type, status: 'running', createdAt: Date.now(), completedAt: null,
                totalItems: totalItems || 0, processedItems: 0, results: [], error: null };
  bgJobs.set(id, job);
  // Keep at most 200 jobs to avoid unbounded memory growth
  if (bgJobs.size > 200) { const oldest = bgJobs.keys().next().value; bgJobs.delete(oldest); }
  return job;
}

