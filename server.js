const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const tvdb = require('./lib/tvdb');

// External API integration removed: TMDb-related helpers and https monkey-patch
// have been disabled to eliminate external HTTP calls. The metaLookup function
// below is a no-op stub that returns null so the rest of the server continues
// to operate without external provider lookups.

const app = express();
// Enable CORS but allow credentials so cookies can be sent from the browser (echo origin)
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
const bcrypt = require('bcryptjs');
const cookieSession = require('cookie-session');

// simple cookie session for auth
// cookie-session will be initialized after we ensure a persistent SESSION_KEY is available

// simple auth middleware helpers
function requireAuth(req, res, next) {
  try {
    if (req && req.session && req.session.username) return next();
    return res.status(401).json({ error: 'unauthenticated' });
  } catch (e) { return res.status(401).json({ error: 'unauthenticated' }) }
}

// (test helpers will be exported after the functions are defined)

function requireAdmin(req, res, next) {
  try {
    const username = req && req.session && req.session.username;
    if (!username) return res.status(401).json({ error: 'unauthenticated' });
    if (users && users[username] && users[username].role === 'admin') return next();
    return res.status(403).json({ error: 'forbidden' });
  } catch (e) { return res.status(403).json({ error: 'forbidden' }) }
}

const DATA_DIR = path.resolve(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// Persistent filenames used across the server. Define defaults relative to DATA_DIR.
const settingsFile = path.join(DATA_DIR, 'settings.json');
const usersFile = path.join(DATA_DIR, 'users.json');
const enrichStoreFile = path.join(DATA_DIR, 'enrich-store.json');
const parsedCacheFile = path.join(DATA_DIR, 'parsed-cache.json');
const scanStoreFile = path.join(DATA_DIR, 'scans.json');
const scanCacheFile = path.join(DATA_DIR, 'scan-cache.json');
const renderedIndexFile = path.join(DATA_DIR, 'rendered-index.json');
const logsFile = path.join(DATA_DIR, 'logs.txt');
// Wikipedia episode cache file (persistent)
const wikiEpisodeCacheFile = path.join(DATA_DIR, 'wiki-episode-cache.json');
const wikiSearchLogFile = path.join(DATA_DIR, 'wiki-search.log');

// ensure we have a persistent session signing key
const sessionKeyFile = path.join(DATA_DIR, 'session.key');
function ensureSessionKey() {
  try {
    if (!fs.existsSync(sessionKeyFile)) {
      const k = require('crypto').randomBytes(32).toString('hex');
      fs.writeFileSync(sessionKeyFile, k, { encoding: 'utf8' });
    }
    const key = fs.readFileSync(sessionKeyFile, 'utf8').trim();
    return key;
  } catch (e) {
    console.error('session key ensure failed', e && e.message);
    return null;
  }
}
const SESSION_KEY = ensureSessionKey();
// initialize cookie-session middleware now that SESSION_KEY is present
if (SESSION_KEY) {
  app.use(cookieSession({ name: 'mmp_sess', keys: [SESSION_KEY], maxAge: 7 * 24 * 60 * 60 * 1000 }));
} else {
  // No session key available; run without cookie-session middleware (best-effort)
  console.warn('SESSION_KEY missing; running without session middleware');
}
process.on('unhandledRejection', (reason, p) => {
  try { console.error('unhandledRejection', reason) } catch (e) {}
  try { appendLog(`UNHANDLED_REJECTION ${reason && reason.message ? reason.message : String(reason)}`) } catch (e) {}
})

// Ensure essential data files exist so server can write to them even when they're not in repo
function ensureFile(filePath, defaultContent) {
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, typeof defaultContent === 'string' ? defaultContent : JSON.stringify(defaultContent, null, 2), { encoding: 'utf8' });
    }
  } catch (e) {
    // best-effort
    console.error('ensureFile error', filePath, e && e.message);
  }
}

// load or initialize settings and users into memory
let serverSettings = {};
let users = {};
try { ensureFile(settingsFile, {}); serverSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8') || '{}') } catch (e) { serverSettings = {} }
try { ensureFile(usersFile, { admin: { username: 'admin', role: 'admin', passwordHash: null, settings: {} } }); users = JSON.parse(fs.readFileSync(usersFile, 'utf8') || '{}') } catch (e) { users = {} }

// Ensure basic persistent store files exist and load them into memory
try { ensureFile(enrichStoreFile, {}); } catch (e) {}
try { ensureFile(parsedCacheFile, {}); } catch (e) {}
try { ensureFile(scanStoreFile, {}); } catch (e) {}
try { ensureFile(scanCacheFile, {}); } catch (e) {}
try { ensureFile(renderedIndexFile, {}); } catch (e) {}
try { ensureFile(logsFile, ''); } catch (e) {}
try { ensureFile(wikiEpisodeCacheFile, {}); } catch (e) {}
try { ensureFile(wikiSearchLogFile, ''); } catch (e) {}

// Wikipedia episode cache (in-memory, persisted to wiki-episode-cache.json)
let wikiEpisodeCache = {};
try { wikiEpisodeCache = JSON.parse(fs.readFileSync(wikiEpisodeCacheFile, 'utf8') || '{}') } catch (e) { wikiEpisodeCache = {} }

// Normalize a title for use as a cache key: lowercase, remove punctuation, collapse spaces
function normalizeForCache(s) {
  try {
    if (!s) return ''
    return String(s).toLowerCase().replace(/[\._\-:]+/g,' ').replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim()
  } catch (e) { return String(s || '').toLowerCase().trim() }
}

// Lightweight migration: ensure existing keys are available under normalized forms as well
try {
  const migrated = {}
  for (const k of Object.keys(wikiEpisodeCache || {})) {
    try {
      const parts = String(k).split('|')
      const titlePart = parts && parts.length ? parts[0] : k
      const rest = parts && parts.length > 1 ? parts.slice(1).join('|') : ''
      const nk = (normalizeForCache(titlePart) || titlePart) + (rest ? '|' + rest : '')
      migrated[nk] = wikiEpisodeCache[k]
    } catch (e) { migrated[k] = wikiEpisodeCache[k] }
  }
  wikiEpisodeCache = migrated
} catch (e) {}

// lightweight per-purpose wiki search log
function writeWikiLog(line) {
  try {
    const ts = (new Date()).toISOString();
    if (wikiSearchLogFile && typeof wikiSearchLogFile === 'string') {
      try { fs.appendFileSync(wikiSearchLogFile, ts + ' ' + String(line) + '\n', { encoding: 'utf8' }) } catch (e) { /* best-effort */ }
    } else {
      try { console.log(ts + ' ' + String(line)) } catch (e) {}
    }
  } catch (e) { /* ignore */ }
}

// Initialize caches and DB if available
let db = null;
let enrichCache = {};
let parsedCache = {};
let scans = {};
let renderedIndex = {};
// Recent hide events for client polling: { ts, path, originalPath, modifiedScanIds }
let hideEvents = [];
// Require DB at startup. Fail fast if DB init or cache loads fail so we don't silently fall back to JSON files.
try {
  const dbLib = require('./lib/db');
  try {
    dbLib.init(path.join(DATA_DIR, 'scans.db'));
    db = dbLib;
    appendLog('DB_INIT_SUCCESS');
  } catch (e) {
    appendLog('DB_INIT_FAIL ' + (e && e.message ? e.message : String(e)));
    console.error('DB_INIT_FAIL', e && e.message ? e.message : e);
      // When server.js is required by tests, don't exit the process on DB init failure.
      if (require.main === module) process.exit(1);
  }
  if (db) {
    try {
      enrichCache = db.getKV('enrichCache') || {};
      parsedCache = db.getKV('parsedCache') || {};
      renderedIndex = db.getKV('renderedIndex') || {};
      hideEvents = db.getHideEvents() || [];
      scans = db.loadScansObject() || {};
    } catch (e) {
      appendLog('DB_LOAD_FAIL ' + (e && e.message ? e.message : String(e)));
      console.error('DB_LOAD_FAIL', e && e.message ? e.message : e);
      // When required as a module (tests), avoid exiting; let tests proceed.
      if (require.main === module) process.exit(1);
    }
  } else {
    try { appendLog('DB_SKIPPED_NO_DB'); } catch (e) {}
  }
} catch (e) {
  console.error('DB_MODULE_LOAD_FAIL', e && e.message ? e.message : e);
  appendLog('DB_MODULE_LOAD_FAIL ' + (e && e.message ? e.message : String(e)));
    if (require.main === module) process.exit(1);
}

if (!db) {
  try { enrichCache = JSON.parse(fs.readFileSync(enrichStoreFile, 'utf8') || '{}'); } catch (e) { enrichCache = {}; }
  try { parsedCache = JSON.parse(fs.readFileSync(parsedCacheFile, 'utf8') || '{}'); } catch (e) { parsedCache = {}; }
  try { renderedIndex = JSON.parse(fs.readFileSync(renderedIndexFile, 'utf8') || '{}'); } catch (e) { renderedIndex = {}; }
  try { scans = JSON.parse(fs.readFileSync(scanStoreFile, 'utf8') || '{}'); } catch (e) { scans = {}; }
  if (!Array.isArray(hideEvents)) hideEvents = [];
}

try { healCachedEnglishAndMovieFlags(); } catch (e) { try { appendLog(`ENRICH_CACHE_HEAL_INIT_FAIL err=${e && e.message ? e.message : String(e)}`); } catch (ee) {} }

// Initialize DB for scans if available
// (DB was initialized above; this later duplicate block removed)

// Track in-flight scans to prevent concurrent runs for same path/scanId
const activeScans = new Set();
// In-memory progress tracker for background refresh operations
const refreshProgress = {};

// Lightweight logging helper: append a timestamped line to data/logs.txt
function appendLog(line) {
  try {
    const ts = (new Date()).toISOString();
    // Avoid throwing when logsFile is undefined or DATA_DIR isn't writable (tests/environment)
    if (logsFile && typeof logsFile === 'string') {
      try {
        fs.appendFileSync(logsFile, ts + ' ' + String(line) + '\n', { encoding: 'utf8' });
      } catch (e) {
        // fallback to console when file write fails
        try { console.error('appendLog failed', e && e.message ? e.message : e); } catch (ee) {}
      }
    } else {
      try { console.log(ts + ' ' + String(line)) } catch (ee) {}
    }
  } catch (e) {
    try { console.error('appendLog failed', e && e.message ? e.message : e); } catch (ee) {}
  }
}

// Simple atomic JSON writer used throughout the server
function writeJson(filePath, obj) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), { encoding: 'utf8' });
  } catch (e) {
    try { console.error('writeJson failed', filePath, e && e.message ? e.message : e); } catch (ee) {}
  }
}

// Normalizer to ensure enrich entries have consistent shape used by the UI
function normalizeEnrichEntry(entry) {
  try {
    entry = entry || {};
    const out = Object.assign({}, entry);
    out.parsed = entry.parsed || (entry.parsedName || entry.title ? { title: entry.title || null, parsedName: entry.parsedName || null, season: entry.season != null ? entry.season : null, episode: entry.episode != null ? entry.episode : null } : null);
    out.provider = entry.provider || null;
    out.title = out.title || (out.provider && out.provider.title) || (out.parsed && out.parsed.title) || null;
  out.seriesTitle = entry.seriesTitle || (entry.extraGuess && entry.extraGuess.seriesTitle) || out.seriesTitle || out.title || null;
  out.seriesTitleExact = entry.seriesTitleExact || (entry.extraGuess && (entry.extraGuess.seriesTitleExact || entry.extraGuess.originalSeriesTitle)) || out.seriesTitleExact || null;
  out.seriesTitleEnglish = entry.seriesTitleEnglish || (entry.extraGuess && entry.extraGuess.seriesTitleEnglish) || (entry.provider && entry.provider.seriesTitleEnglish) || out.seriesTitleEnglish || null;
  out.seriesTitleRomaji = entry.seriesTitleRomaji || (entry.extraGuess && entry.extraGuess.seriesTitleRomaji) || (entry.provider && entry.provider.seriesTitleRomaji) || out.seriesTitleRomaji || null;
  if (typeof entry.isMovie === 'boolean') out.isMovie = entry.isMovie;
  else if (entry.extraGuess && typeof entry.extraGuess.isMovie === 'boolean') out.isMovie = entry.extraGuess.isMovie;
  if (!out.mediaFormat && entry.mediaFormat) out.mediaFormat = entry.mediaFormat;
  if (!out.mediaFormat && entry.extraGuess && entry.extraGuess.mediaFormat) out.mediaFormat = entry.extraGuess.mediaFormat;
    out.originalSeriesTitle = entry.originalSeriesTitle || (entry.extraGuess && entry.extraGuess.originalSeriesTitle) || out.originalSeriesTitle || null;
    if (!out.title && out.seriesTitle) out.title = out.seriesTitle;
    out.seriesLookupTitle = entry.seriesLookupTitle || (entry.extraGuess && entry.extraGuess.seriesLookupTitle) || out.seriesLookupTitle || null;
    if (typeof out.parentCandidate === 'undefined') {
      const parentGuess = entry.parentCandidate || (entry.extraGuess && entry.extraGuess.parentCandidate) || null;
      if (parentGuess) out.parentCandidate = parentGuess;
    }
    out.parsedName = out.parsedName || (out.parsed && out.parsed.parsedName) || null;
    out.season = (typeof out.season !== 'undefined' && out.season !== null) ? out.season : (out.parsed && typeof out.parsed.season !== 'undefined' ? out.parsed.season : null);
    out.episode = (typeof out.episode !== 'undefined' && out.episode !== null) ? out.episode : (out.parsed && typeof out.parsed.episode !== 'undefined' ? out.parsed.episode : null);
    out.timestamp = out.timestamp || Date.now();
    const normalizedFailure = normalizeProviderFailure(entry.providerFailure);
    out.providerFailure = normalizedFailure;
    if (out.provider && out.provider.matched) out.providerFailure = null;
    return out;
  } catch (e) {
    return entry || {};
  }
}

function normalizeProviderFailure(block) {
  try {
    if (!block) return null;
    const out = {};
    out.provider = block.provider || null;
    if (typeof block.reason !== 'undefined') out.reason = block.reason;
    if (typeof block.code !== 'undefined') out.code = block.code;
    const prevAttempts = Number.isFinite(block.attemptCount) ? Number(block.attemptCount) : parseInt(block.attemptCount, 10);
    out.attemptCount = Number.isFinite(prevAttempts) && prevAttempts > 0 ? prevAttempts : 1;
    const lastTsRaw = (block.lastAttemptAt != null) ? Number(block.lastAttemptAt) : Date.now();
    out.lastAttemptAt = Number.isFinite(lastTsRaw) && lastTsRaw > 0 ? lastTsRaw : Date.now();
    if (block.firstAttemptAt != null) {
      const firstTs = Number(block.firstAttemptAt);
      if (Number.isFinite(firstTs) && firstTs > 0) out.firstAttemptAt = firstTs;
    }
    if (!out.firstAttemptAt) out.firstAttemptAt = out.lastAttemptAt;
    if (block.lastError != null) out.lastError = String(block.lastError);
    if (block.lastSkipAt != null) {
      const skipTs = Number(block.lastSkipAt);
      if (Number.isFinite(skipTs) && skipTs > 0) out.lastSkipAt = skipTs;
    }
    if (block.skipCount != null) {
      const skipCount = Number(block.skipCount);
      if (Number.isFinite(skipCount) && skipCount >= 0) out.skipCount = skipCount;
    }
    return out;
  } catch (e) {
    return null;
  }
}

// Top-level helper: strip season-like suffix tokens that AniList might include in returned titles.
// Accepts optional rawPick (AniList media node) to allow confidence checks (seasonYear/season).
function stripAniListSeasonSuffix(name, rawPick) {
  try {
    if (!name) return name
    const orig = String(name)
    let out = orig
    // remove parenthetical Season tokens: " (Season 2)"
    out = out.replace(/\s*\(\s*Season\s*\d{1,2}(?:st|nd|rd|th)?\s*\)\s*$/i, '')
    // also remove parenthetical season tokens when followed by a year (e.g. 'Title (Season 2) 2025')
    // replace with a single space to avoid joining words and the year
    out = out.replace(/\s*\(\s*Season\s*\d{1,2}(?:st|nd|rd|th)?\s*\)\s*(?=\d{4}\b)/i, ' ')
    // remove trailing 'Season N' or 'Nth Season' or '2nd Season' forms
    out = out.replace(/\s+Season\s+\d{1,2}(?:st|nd|rd|th)?\s*$/i, '')
    out = out.replace(/\s+\d{1,2}(?:st|nd|rd|th)?\s+Season\s*$/i, '')
    // remove textual ordinal season tokens like 'Third Season' or 'Second Season'
    out = out.replace(/\s+(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+Season\s*$/i, '')
    out = out.replace(/\s+Season\s+(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s*$/i, '')
    // also strip textual ordinals if they are followed by a year token; leave a space
    out = out.replace(/\s+(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+Season\s*(?=\d{4}\b)/i, ' ')
    out = out.replace(/\s+Season\s+(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s*(?=\d{4}\b)/i, ' ')
    // remove trailing S## tokens (e.g., ' S02') or 'S02E03' if left at the end
    out = out.replace(/\s+S\d{1,2}(?:E\d{1,3})?\s*$/i, '')
    // Only remove ambiguous trailing numeric tokens if we have confidence it's a season token.
    // Only strip explicit season tokens (handled above). Avoid removing generic trailing
    // numeric tokens (e.g., 'No. 8') because many series include numbers as part of
    // their canonical title. We consider ourselves "confident" when AniList returned
    // season/seasonYear or the original string contained the word 'season', but we
    // don't remove standalone trailing digits even then.
    const confident = (!!rawPick && (rawPick.seasonYear || rawPick.season)) || /\bseason\b/i.test(orig)
  // collapse multiple spaces into one and trim
  out = out.replace(/\s{2,}/g, ' ').trim()
  try { if (out !== orig) { try { appendLog(`STRIP_ANILIST before=${orig.slice(0,200)} after=${out.slice(0,200)} confident=${!!confident}`) } catch (e) {} } } catch (e) {}
  return out
  } catch (e) { return name }
}


async function metaLookup(title, apiKey, opts = {}) {
  // Lightweight, rate-limited meta lookup using AniList -> Kitsu -> TMDb fallback.
  // Inputs: title (string), apiKey (tmdb key, optional), opts may include season, episode, parentCandidate, parentPath, _parentDirect
  // Output: Promise resolving to { name, raw, episode } or null
  if (!title) return Promise.resolve(null)

  const tvdbCreds = resolveTvdbCredentials(opts && opts.username ? opts.username : null, opts && opts.tvdbOverride ? opts.tvdbOverride : null)

  // Minimal per-host pacing to avoid hammering external APIs
  const hostPace = { 'graphql.anilist.co': 250, 'kitsu.io': 250, 'api.themoviedb.org': 300 } // ms
  const lastRequestAt = metaLookup._lastRequestAt = metaLookup._lastRequestAt || {}
  async function pace(host) {
    const now = Date.now()
    const last = lastRequestAt[host] || 0
    const wait = Math.max(0, (hostPace[host] || 300) - (now - last))
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
    lastRequestAt[host] = Date.now()
  }

  function normalize(s) { try { return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim() } catch (e) { return String(s || '') } }
  function wordOverlap(a,b){
    try {
      const wa = normalize(a).split(' ').filter(Boolean)
      const wb = normalize(b).split(' ').filter(Boolean)
      if (!wa.length || !wb.length) return 0
      const common = wa.filter(x => wb.indexOf(x) !== -1)
      if (!common.length) return 0
      const recall = common.length / wa.length
      const precision = common.length / wb.length
      // emphasize covering all query tokens (recall) but retain some precision signal so generic matches don't dominate
      return (recall * 0.75) + (precision * 0.25)
    } catch (e){ return 0 }
  }

  const MIN_ANILIST_MATCH_SCORE = 0.2

  function simpleNormalizeForMatch(s) {
    try { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '') } catch (e) { return String(s || '') }
  }

  function uniqueStrings(list) {
    const seen = new Set()
    const out = []
    for (const raw of Array.isArray(list) ? list : []) {
      const str = (raw == null) ? '' : String(raw)
      const trimmed = str.trim()
      if (!trimmed) continue
      if (seen.has(trimmed)) continue
      seen.add(trimmed)
      out.push(trimmed)
    }
    return out
  }

  function gatherAniListCandidateNames(res) {
    const names = []
    if (!res) return names
    try {
      if (res.name) names.push(res.name)
      if (res.title) {
        if (res.title.english) names.push(res.title.english)
        if (res.title.romaji) names.push(res.title.romaji)
        if (res.title.native) names.push(res.title.native)
      }
      if (res.raw && res.raw.title) {
        const rt = res.raw.title
        if (rt.english) names.push(rt.english)
        if (rt.romaji) names.push(rt.romaji)
        if (rt.native) names.push(rt.native)
      }
      const base = res.name || (res.title && (res.title.english || res.title.romaji || res.title.native))
      const stripped = base ? stripAniListSeasonSuffix(base, res.raw || res) : null
      if (stripped && (!base || stripped !== base)) names.push(stripped)
    } catch (e) { /* best-effort */ }
    return uniqueStrings(names)
  }

  const expectedSeriesNames = uniqueStrings([
    title,
    opts && opts.parentCandidate ? opts.parentCandidate : null
  ])

  function evaluateAniListCandidate(res, expectationList, queryVariant, contextLabel) {
    const candidates = gatherAniListCandidateNames(res)
    const expectations = uniqueStrings([
      ...(Array.isArray(expectationList) ? expectationList : []),
      ...(expectedSeriesNames || []),
      queryVariant
    ])
    if (!candidates.length || !expectations.length) {
      return { ok: true, bestScore: 1, bestName: candidates[0] || null, bestExpected: expectations[0] || null }
    }
    let bestScore = 0
    let bestName = null
    let bestExpected = null
    for (const cand of candidates) {
      for (const exp of expectations) {
        let score = wordOverlap(cand, exp)
        const simpleCand = simpleNormalizeForMatch(cand)
        const simpleExp = simpleNormalizeForMatch(exp)
        if (simpleCand && simpleExp) {
          if (simpleCand === simpleExp) score = Math.max(score, 1)
          else if (simpleCand.length >= 4 && simpleExp.length >= 4 && (simpleCand.includes(simpleExp) || simpleExp.includes(simpleCand))) {
            score = Math.max(score, 0.55)
          }
        }
        if (score > bestScore) {
          bestScore = score
          bestName = cand
          bestExpected = exp
        }
      }
    }
    if (bestScore < MIN_ANILIST_MATCH_SCORE) {
      try { appendLog(`META_ANILIST_MISMATCH context=${contextLabel} query=${queryVariant || '<none>'} candidate=${bestName ? bestName.slice(0,120) : '<none>'} expected=${bestExpected ? bestExpected.slice(0,120) : '<none>'} score=${bestScore.toFixed(2)}`) } catch (e) {}
      return { ok: false, bestScore, bestName, bestExpected }
    }
    return { ok: true, bestScore, bestName, bestExpected }
  }

  // Strip common episode tokens and trailing episode titles from candidate search strings
  function normalizeSearchQuery(s) {
    try {
      if (!s) return ''
      let out = String(s || '')
      // remove common episode markers: S01E02, S1E2, S01, E02, 1x02, Ep02, Episode 2
      out = out.replace(/\bS\d{1,2}E\d{1,3}\b/ig, ' ')
      out = out.replace(/\bS\d{1,2}\b/ig, ' ')
      out = out.replace(/\bE\d{1,3}\b/ig, ' ')
      out = out.replace(/\b\d{1,2}x\d{1,3}\b/ig, ' ')
      out = out.replace(/\bEp(?:isode)?\.?\s*\d{1,3}\b/ig, ' ')
      // remove bracketed version tokens and release tags
      out = out.replace(/\[[^\]]+\]/g, ' ')
    out = out.replace(/\([^\)]*\b(?:1080p|720p|2160p|x264|x265|webrip|web-dl|bluray|hdtv|aac|dual audio)\b[^\)]*\)/ig, ' ')
      // If there's a dash, assume left side may be series and right side episode title; prefer left side
      const dashSplit = out.split(/\s[-–—]\s/)
      if (dashSplit && dashSplit.length > 1) out = dashSplit[0]
      // remove trailing episode title heuristics: if string begins with season/episode marker, drop following words up to a capitalized stop? conservatively, remove leading ep tokens
      out = out.replace(/^\s*[:\-\_\s]+/, '')
      out = out.replace(/[^a-z0-9\s]/ig, ' ')
      out = out.replace(/\s+/g,' ').trim()
      return out
    } catch (e) { return String(s || '') }
  }

  // Build simple variants to try (original, cleaned, stripped parentheses, lowercase)
  function makeVariants(t){ const s = String(t || '').trim(); const variants = []; if (!s) return variants; variants.push(s); const cleaned = s.replace(/[._\-:]+/g,' ').replace(/\s+/g,' ').trim(); variants.push(cleaned); const stripped = cleaned.replace(/\s*[\[(].*?[\])]/g, '').replace(/\s+/g,' ').trim(); if (stripped && stripped !== cleaned) variants.push(stripped); variants.push(stripped.toLowerCase()); return [...new Set(variants)].slice(0,5) }

  // Use top-level stripAniListSeasonSuffix helper

  // Simple HTTP helpers
  const https = require('https')
  function httpRequest(options, body, timeoutMs = 4000) {
    // allow unit tests to inject a fake httpRequest via module.exports._test._httpRequest
    try {
      if (module && module.exports && module.exports._test && typeof module.exports._test._httpRequest === 'function') {
        return module.exports._test._httpRequest(options, body, timeoutMs)
      }
    } catch (e) { /* ignore and continue with real httpRequest */ }
    return new Promise((resolve, reject) => {
      let timed = false
      const req = https.request(options, (res) => {
        let sb = ''
        res.on('data', d => sb += d)
        res.on('end', () => {
          if (timed) return
          resolve({ statusCode: res.statusCode, headers: res.headers, body: sb })
        })
      })
      req.on('error', (err) => { if (timed) return; reject(err) })
      req.setTimeout(timeoutMs, () => { timed = true; try{ req.destroy() }catch(e){}; reject(new Error('timeout')) })
      if (body) req.write(body)
      req.end()
    })
  }

  // AniList GraphQL search
  async function searchAniList(q) {
    try {
      await pace('graphql.anilist.co')
      // Request relations/season/seasonYear so we can prefer season-specific media when available
      const query = `query ($search: String) { Page(page:1, perPage:8) { media(search: $search, type: ANIME) { id title { romaji english native } format episodes startDate { year } season seasonYear relations { nodes { id title { romaji english native } } } } } }`;
      // If the caller provided a season, try an AniList text search that includes the season (e.g. "Title Season 1")
      const wantedSeason = (opts && typeof opts.season !== 'undefined' && opts.season !== null) ? Number(opts.season) : null
      const baseQuery = String(q || '').trim()
      const tryQueries = []
      if (wantedSeason !== null) {
        tryQueries.push(String(q).trim() + ` Season ${wantedSeason}`)
        // also try a parenthetical form
        tryQueries.push(String(q).trim() + ` (Season ${wantedSeason})`)
      }
      tryQueries.push(baseQuery)

      // include AniList API key header when available (per-user or server)
      let anilistKey = null
      try {
        if (opts && opts.anilist_key) anilistKey = opts.anilist_key
        else if (opts && opts.username && users && users[opts.username] && users[opts.username].settings && users[opts.username].settings.anilist_api_key) anilistKey = users[opts.username].settings.anilist_api_key
        else if (serverSettings && serverSettings.anilist_api_key) anilistKey = serverSettings.anilist_api_key
      } catch (e) { anilistKey = null }
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' }
  if (anilistKey) headers['Authorization'] = `Bearer ${String(anilistKey)}`
  const opt = { hostname: 'graphql.anilist.co', path: '/', method: 'POST', headers }
          // perform queries in order (season-augmented first when available)
          let items = null
          const MIN_SEASON_QUERY_OVERLAP = 0.6
          function bestOverlapAgainstBase(list) {
            try {
              if (!Array.isArray(list) || !list.length) return 0
              let best = 0
              for (const it of list) {
                try {
                  const titles = []
                  if (it && it.title) titles.push(it.title.english, it.title.romaji, it.title.native)
                  if (it && it.relations && Array.isArray(it.relations.nodes)) {
                    for (const rn of it.relations.nodes) {
                      if (rn && rn.title) titles.push(rn.title.english, rn.title.romaji, rn.title.native)
                    }
                  }
                  for (const t of titles) {
                    if (!t) continue
                    const ov = wordOverlap(String(t), baseQuery)
                    if (ov > best) best = ov
                    if (best >= MIN_SEASON_QUERY_OVERLAP) return best
                  }
                } catch (e) { continue }
              }
              return best
            } catch (e) { return 0 }
          }
          for (const qtry of tryQueries) {
            try {
              try { appendLog(`META_ANILIST_TRY q=${qtry}`) } catch (e) {}
              const vars = JSON.stringify({ search: String(qtry || '') })
              const body = JSON.stringify({ query, variables: JSON.parse(vars) })
              const res = await httpRequest(opt, body, 3500)
              if (!res || !res.body) continue
              let j = null
              try { j = JSON.parse(res.body) } catch (e) { continue }
              const found = j && j.data && j.data.Page && Array.isArray(j.data.Page.media) ? j.data.Page.media : []
              if (found && found.length) {
                if (qtry !== baseQuery) {
                  const ov = bestOverlapAgainstBase(found)
                  if (ov < MIN_SEASON_QUERY_OVERLAP) {
                    try { appendLog(`META_ANILIST_TRY_SKIP_LOW_OVERLAP q=${qtry} overlap=${ov.toFixed(2)} base=${baseQuery}`) } catch (e) {}
                    continue
                  }
                }
                items = found;
                break
              }
            } catch (e) { /* try next */ }
          }
          try { appendLog(`META_ANILIST_TRY_RESULT qTried=${tryQueries.join('|')} matched=${items && items.length ? 'yes' : 'no'}`) } catch (e) {}
          if (!items || !items.length) return null
  // select preferred title: english -> romaji -> native
  items.sort((a,b)=> (wordOverlap(String(b.title.english||b.title.romaji||b.title.native||''), String(q)) - wordOverlap(String(a.title.english||a.title.romaji||a.title.native||''), String(q))));
  // If a season was requested, try to find a media entry or a related node that explicitly mentions that season number
  // or season-year. AniList's `season` field is an enum (e.g. "SUMMER") and not a numeric season index, but
  // AniList exposes `seasonYear` which we can compare against the requested year. We also fall back to extracting
  // season numbers from titles/related nodes.
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

  function isSpecialMedia(media) {
    try {
      if (!media) return false
      const fmt = media.format ? String(media.format).toUpperCase() : ''
      if (fmt === 'SPECIAL') return true
      const titles = []
      if (media.title) titles.push(media.title.english, media.title.romaji, media.title.native)
      for (const t of titles) {
        if (t && /\bspecial\b/i.test(String(t))) return true
      }
      return false
    } catch (e) { return false }
  }

  // Use top-level stripAniListSeasonSuffix helper

  // prefer items whose seasonYear or title/relations indicate the requested season/year
  let pick = null
  const requestWantsSpecial = ((opts && Number(opts.season) === 0)
    || (opts && opts.episode != null && String(opts.episode).includes('.'))
    || (typeof title === 'string' && /\bspecial\b/i.test(title))
    || (typeof q === 'string' && /\bspecial\b/i.test(q))) ? true : false
  const wantedYear = (opts && (typeof opts.seasonYear !== 'undefined' || typeof opts.year !== 'undefined')) ? Number((opts.seasonYear != null ? opts.seasonYear : opts.year)) : null
  if (wantedSeason !== null || wantedYear !== null) {
    for (const it of items) {
      try {
        // prefer match by AniList seasonYear when provided
        if (wantedYear !== null && it && typeof it.seasonYear !== 'undefined' && it.seasonYear !== null) {
          try { if (Number(it.seasonYear) === wantedYear) { pick = it; break } } catch (e) {}
        }
        // AniList `season` field is an enum (e.g. 'SUMMER') and not a numeric season index; attempt to
        // extract numeric season from titles/relations instead
        const candidates = []
        if (it && it.title) {
          candidates.push(it.title.english, it.title.romaji, it.title.native)
        }
        if (it && it.relations && Array.isArray(it.relations.nodes)) {
          for (const rn of it.relations.nodes) {
            if (rn && rn.title) candidates.push(rn.title.english, rn.title.romaji, rn.title.native)
          }
        }
        for (const c of candidates) {
          const sn = extractSeasonNumberFromTitle(c)
          if (sn && wantedSeason !== null && sn === wantedSeason) { pick = it; break }
        }
        if (pick) break
      } catch (e) {}
    }
  }
  // fallback to best lexical match
  if (!pick) {
    // Prefer a series-level entry when no explicit season was requested.
    // Many AniList entries are season-specific ("3rd Season") which we should avoid
    // when the caller is searching for the parent series (no wantedSeason).
    try {
      let nonSeason = null
      for (const it of items) {
        try {
          // build candidate title strings
          const candidates = []
          if (it && it.title) candidates.push(it.title.english, it.title.romaji, it.title.native)
          if (it && it.relations && Array.isArray(it.relations.nodes)) {
            for (const rn of it.relations.nodes) if (rn && rn.title) candidates.push(rn.title.english, rn.title.romaji, rn.title.native)
          }
          // if none of the candidate titles contain an explicit season number, treat as non-season
          let anySeason = false
          for (const c of candidates) {
            try { if (extractSeasonNumberFromTitle(c)) { anySeason = true; break } } catch (e) {}
          }
          if (!anySeason) {
            if (!requestWantsSpecial && isSpecialMedia(it)) continue
            nonSeason = it
            break
          }
        } catch (e) {}
      }
      if (nonSeason) pick = nonSeason
      else pick = items[0]
    } catch (e) { pick = items[0] }
  }
  if (!pick) return null
  // If the chosen AniList pick doesn't actually resemble the original query (low word overlap),
  // try to find a better candidate among the returned items. This prevents cases where a
  // loosely-related or popular show (e.g., Attack on Titan) is selected instead of a small
  // series that more closely matches the query tokens.
  try {
    const pickedTitle = (pick && pick.title) ? (pick.title.english || pick.title.romaji || pick.title.native || '') : ''
    const pickIsSpecial = isSpecialMedia(pick)
    const pickOverlap = wordOverlap(String(pickedTitle), String(q || ''))
    const MIN_ACCEPTABLE_OVERLAP = 0.35
    if (pickOverlap < MIN_ACCEPTABLE_OVERLAP) {
      let best = pickOverlap
      let better = null
      for (const it of items) {
        try {
          const candTitle = (it && it.title) ? (it.title.english || it.title.romaji || it.title.native || '') : ''
          const ov = wordOverlap(String(candTitle), String(q || ''))
          if (!requestWantsSpecial && !pickIsSpecial && isSpecialMedia(it)) continue
          if (ov > best) { best = ov; better = it }
        } catch (e) {}
      }
      if (better) {
        try { appendLog(`META_ANILIST_PICK_OVERRODE orig=${String(pickedTitle).slice(0,120)} new=${String(better && better.title && (better.title.english||better.title.romaji||better.title.native) || '').slice(0,120)} q=${String(q).slice(0,120)} ov=${best}`) } catch (e) {}
        pick = better
      }
    }
  } catch (e) { /* best-effort */ }
  if (!requestWantsSpecial && isSpecialMedia(pick)) {
    const fallback = items.find(it => !isSpecialMedia(it))
    if (fallback) pick = fallback
  }
  // pick English when available, otherwise romaji, otherwise native
  // If the selected pick itself is a season-specific entry (e.g. "3rd Season") but its relations include
  // a parent/series node that does NOT contain a season token, prefer returning that parent node instead
    try {
    if (wantedSeason !== null && pick && pick.title) {
      const pickCandidates = [pick.title.english, pick.title.romaji, pick.title.native]
      let pickSeasonNum = null
      for (const pc of pickCandidates) { try { const s = extractSeasonNumberFromTitle(pc); if (s) { pickSeasonNum = s; break } } catch (e) {} }
      // Only prefer a related parent when the picked media explicitly indicates a different season
      // than the requested one (e.g. AniList returned "3rd Season" but caller requested season=1).
      if (pickSeasonNum !== null && wantedSeason !== null && pickSeasonNum !== wantedSeason && pick.relations && Array.isArray(pick.relations.nodes)) {
        for (const rn of pick.relations.nodes) {
          try {
            const rCandidates = [rn && rn.title && rn.title.english, rn && rn.title && rn.title.romaji, rn && rn.title && rn.title.native]
            let anySeason = false
            for (const rc of rCandidates) { try { if (extractSeasonNumberFromTitle(rc)) { anySeason = true; break } } catch (e) {} }
            if (!anySeason) {
              // prefer this related parent node
              pick = rn
              break
            }
          } catch (e) {}
        }
      }
    }
  } catch (e) {}

  const rawName = (pick && pick.title) ? (pick.title.english || pick.title.romaji || pick.title.native) : (pick && (pick.romaji || pick.english || pick.native) ? (pick.english || pick.romaji || pick.native) : null)
  const name = stripAniListSeasonSuffix(rawName, pick)
  return { provider: 'anilist', id: pick.id, name: name, raw: pick }
    } catch (e) { return null }
  }

  // Kitsu: find anime by title, then fetch episode by number
  async function fetchKitsuEpisode(seriesTitle, episodeNumber) {
    try {
      if (episodeNumber == null) return null
      await pace('kitsu.io')
      const q = encodeURIComponent(String(seriesTitle || '').slice(0,200))
      const searchPath = `/api/edge/anime?filter[text]=${q}&page[limit]=1`
      const sres = await httpRequest({ hostname: 'kitsu.io', path: searchPath, method: 'GET', headers: { 'Accept': 'application/vnd.api+json' } }, null, 3000)
      if (!sres || !sres.body) return null
      let sj = null
      try { sj = JSON.parse(sres.body) } catch (e) { sj = null }
      const an = sj && sj.data && Array.isArray(sj.data) && sj.data.length ? sj.data[0] : null
      if (!an) return null
      const animeId = an.id
      // fetch episode by number
      await pace('kitsu.io')
      const epPath = `/api/edge/anime/${encodeURIComponent(animeId)}/episodes?filter[number]=${encodeURIComponent(String(episodeNumber))}&page[limit]=1`
      const eres = await httpRequest({ hostname: 'kitsu.io', path: epPath, method: 'GET', headers: { 'Accept': 'application/vnd.api+json' } }, null, 3000)
      if (!eres || !eres.body) return null
      let ej = null
      try { ej = JSON.parse(eres.body) } catch (e) { ej = null }
      const ep = ej && ej.data && Array.isArray(ej.data) && ej.data.length ? ej.data[0] : null
      if (!ep) return null
  // prefer explicit English title if available, then canonicalTitle, then Japanese variant
  const epTitle = ep && ep.attributes ? (ep.attributes.titles && (ep.attributes.titles.en || ep.attributes.titles.en_jp) ? (ep.attributes.titles.en || ep.attributes.titles.en_jp) : (ep.attributes.canonicalTitle || (ep.attributes.titles && (ep.attributes.titles.en_jp || ep.attributes.titles.ja_jp)))) : null
      return { name: epTitle, raw: ep }
    } catch (e) { return null }
  }

  // TMDb lightweight search + episode fetch (fallback)
  async function searchTmdbAndEpisode(q, tmdbKey, season, episode) {
    if (!tmdbKey) return null
    try {
      await pace('api.themoviedb.org')
      const qenc = encodeURIComponent(String(q || '').slice(0,200))
      const searchPath = `/3/search/tv?api_key=${encodeURIComponent(tmdbKey)}&query=${qenc}`
      const sres = await httpRequest({ hostname: 'api.themoviedb.org', path: searchPath, method: 'GET', headers: { 'Accept': 'application/json' } }, null, 3000)
      if (!sres || !sres.body) return null
      let sj = null
      try { sj = JSON.parse(sres.body) } catch (e) { sj = null }
      const hits = sj && sj.results && Array.isArray(sj.results) ? sj.results : []
      if (!hits.length) return null
      const top = hits[0]
      const name = top.name || top.original_name || top.title || null
      const raw = Object.assign({}, top, { source: 'tmdb' })
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
              if (!isPlaceholder && hasLatin) return { provider: 'tmdb', id: top.id, name, raw, episode: ej }

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
                      return { provider: 'tmdb', id: top.id, name, raw, episode: ej }
                    }
                  }
                }
              } catch (e) { /* ignore translation fetch errors */ }

              // If original was non-Latin but we couldn't find a translation, still return the raw
              // episode object (caller will decide whether to accept non-English titles).
              return { provider: 'tmdb', id: top.id, name, raw, episode: ej }
            }
          }
        } catch (e) {}
      }
      return { provider: 'tmdb', id: top.id, name, raw }
    } catch (e) { return null }
  }

  // Wikipedia episode title lookup using MediaWiki API (best-effort)
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
                          return { provider: 'tmdb', id: top.id, name, raw, episode: ej }
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

  // Try AniList variants, then parent, then TMDb fallback
  try {
    // normalize search title to avoid SxxEyy noise
    const variants = makeVariants(normalizeSearchQuery(title || ''))
    // try filename-derived variants first
    let aniListResult = null
    for (let i=0;i<Math.min(variants.length,3);i++) {
      const v = variants[i]
      const a = await searchAniList(v)
      try { appendLog(`META_ANILIST_SEARCH q=${v} found=${a ? 'yes' : 'no'}`) } catch (e) {}
      if (!a) continue
  const aniMatch = evaluateAniListCandidate(a, null, v, 'filename')
  if (!aniMatch.ok) continue
      // Attempt per-provider episode lookups in order: TVDB -> Wikipedia -> TMDb -> Kitsu.
      let ep = null;
      let tvdbInfo = null;
      let titleVariants = [];
      try {
        if (a && a.title) {
          if (a.title.english) titleVariants.push(a.title.english);
          if (a.title.romaji) titleVariants.push(a.title.romaji);
          if (a.title.native) titleVariants.push(a.title.native);
        }
        if (a && a.relations && Array.isArray(a.relations.nodes)) {
          for (const rn of a.relations.nodes) {
            if (rn && rn.title && rn.title.english) titleVariants.push(rn.title.english);
            if (rn && rn.title && rn.title.romaji) titleVariants.push(rn.title.romaji);
            if (rn && rn.title && rn.title.native) titleVariants.push(rn.title.native);
          }
        }
      } catch (e) { /* ignore and fall back below */ }
      const aniListName = (a && a.name) ? a.name : v;
      const strippedAniListName = (a && a.name) ? stripAniListSeasonSuffix(a.name, a.raw || a) : null;
      titleVariants = titleVariants
        .concat([aniListName, strippedAniListName, v])
        .map(s => String(s || '').trim())
        .filter(Boolean);
      if (!titleVariants.length) {
        titleVariants = [String(aniListName || v || '').trim()].filter(Boolean);
      }
      const uniqueTitleVariants = [...new Set(titleVariants)];
      let tmdbEpCheck = null;

      if (!ep && tvdbCreds && opts && opts.season != null && opts.episode != null) {
        try {
          const tvdbEpisode = await tvdb.fetchEpisode(tvdbCreds, uniqueTitleVariants, opts.season, opts.episode, {
            log: (line) => {
              try { appendLog(line) } catch (e) {}
            }
          });
          if (tvdbEpisode && tvdbEpisode.episodeTitle) {
            tvdbInfo = {
              seriesId: tvdbEpisode.seriesId,
              seriesName: tvdbEpisode.seriesName,
              episodeTitle: tvdbEpisode.episodeTitle,
              raw: tvdbEpisode.raw
            };
            ep = {
              name: tvdbEpisode.episodeTitle,
              title: tvdbEpisode.episodeTitle,
              localized_name: tvdbEpisode.episodeTitle,
              source: 'tvdb',
              raw: tvdbEpisode.raw && tvdbEpisode.raw.episode ? tvdbEpisode.raw.episode : tvdbEpisode.raw
            };
            try { ep.tvdb = { seriesId: tvdbEpisode.seriesId, seriesName: tvdbEpisode.seriesName }; } catch (e) {}
            try { appendLog(`META_TVDB_EP_AFTER_ANILIST q=${aniListName} epName=${String(tvdbEpisode.episodeTitle).slice(0,120)}`) } catch (e) {}
          } else {
            try { appendLog(`META_TVDB_EP_AFTER_ANILIST_NONE q=${aniListName}`) } catch (e) {}
          }
        } catch (e) {
          try { appendLog(`META_TVDB_EP_AFTER_ANILIST_ERROR q=${aniListName} err=${e && e.message ? e.message : String(e)}`) } catch (ee) {}
        }
      }

      if (!ep && apiKey) {
        const tmLookupName = strippedAniListName || aniListName || v;
        try { appendLog(`META_TMDB_EP_AFTER_ANILIST tmLookup=${tmLookupName} anilist=${aniListName} season=${opts && opts.season != null ? opts.season : '<none>'} episode=${opts && opts.episode != null ? opts.episode : '<none>'} usingKey=masked`) } catch (e) {}
        try {
          tmdbEpCheck = await searchTmdbAndEpisode(tmLookupName, apiKey, opts && opts.season != null ? opts.season : null, opts && opts.episode != null ? opts.episode : null);
        } catch (e) {
          tmdbEpCheck = null;
          try { appendLog(`META_TMDB_EP_AFTER_ANILIST_ERROR q=${aniListName} err=${e && e.message ? e.message : String(e)}`) } catch (ee) {}
        }
        if (tmdbEpCheck && tmdbEpCheck.episode) {
          const tmEpTitle = String(tmdbEpCheck.episode.name || tmdbEpCheck.episode.title || '').trim();
          try {
            const tmHasLatin = /[A-Za-z]/.test(tmEpTitle);
            if (isMeaningfulTitle(tmEpTitle) && !isPlaceholderTitle(tmEpTitle) && tmHasLatin) {
              ep = tmdbEpCheck.episode;
              try { appendLog(`META_TMDB_EP_AFTER_ANILIST_OK q=${aniListName} epName=${tmEpTitle}`) } catch (e) {}
            } else if (isMeaningfulTitle(tmEpTitle) && !isPlaceholderTitle(tmEpTitle)) {
              ep = tmdbEpCheck.episode;
              try { appendLog(`META_TMDB_EP_AFTER_ANILIST_OK_NONLATIN q=${aniListName} epName=${tmEpTitle}`) } catch (e) {}
            } else {
              try { appendLog(`META_TMDB_EP_AFTER_ANILIST_IGNORED_PLACEHOLDER q=${aniListName} tm=${tmEpTitle}`) } catch (e) {}
            }
          } catch (e) {
            ep = tmdbEpCheck.episode;
            try { appendLog(`META_TMDB_EP_AFTER_ANILIST_OK q=${aniListName} epName=${tmEpTitle}`) } catch (ee) {}
          }
        } else if (tmdbEpCheck) {
          try { appendLog(`META_TMDB_EP_AFTER_ANILIST_NONE q=${aniListName}`) } catch (e) {}
        } else {
          try { appendLog(`META_TMDB_EP_AFTER_ANILIST_NONE q=${aniListName}`) } catch (e) {}
        }
      }

      if (!ep) {
        try {
          const wikiEp = await lookupWikipediaEpisode(uniqueTitleVariants.map(normalizeSearchQuery), opts && opts.season != null ? opts.season : null, opts && opts.episode != null ? opts.episode : null, { force: !!(opts && opts.force), tmdbKey: apiKey });
          const intendedSeries = aniListName;
          let wikiParentMatch = false;
          if (wikiEp && (wikiEp.raw && (wikiEp.raw.page || wikiEp.raw.original) || wikiEp.name)) {
            try {
              const pageTitle = (wikiEp.raw && wikiEp.raw.page) ? String(wikiEp.raw.page) : null;
              const leadText = (wikiEp.raw && wikiEp.raw.original) ? String(wikiEp.raw.original) : '';
              for (const tv of uniqueTitleVariants) {
                try {
                  const ovTitle = pageTitle ? wordOverlap(pageTitle, tv) : 0;
                  const ovLead = leadText ? wordOverlap(leadText, tv) : 0;
                  if (ovTitle >= 0.45 || ovLead >= 0.45) { wikiParentMatch = true; break; }
                } catch (e) { continue; }
              }
              if (!wikiParentMatch && pageTitle) {
                const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
                const intendedNorm = norm(intendedSeries);
                const pageNorm = norm(pageTitle);
                if (pageNorm && intendedNorm && (pageNorm.indexOf(intendedNorm) !== -1 || intendedNorm.indexOf(pageNorm) !== -1)) wikiParentMatch = true;
              }
              if (!wikiParentMatch && leadText) {
                for (const tv of uniqueTitleVariants) {
                  try { if (String(leadText || '').toLowerCase().indexOf(String(tv||'').toLowerCase()) !== -1) { wikiParentMatch = true; break; } } catch (e) {}
                }
              }
            } catch (e) { /* best-effort */ }
          }
          if (wikiEp && wikiEp.name && wikiParentMatch) {
            if (apiKey) {
              try {
                let tmEpCheck = tmdbEpCheck;
                if (!tmEpCheck) {
                  const tmLookupName = strippedAniListName || aniListName || v;
                  tmEpCheck = await searchTmdbAndEpisode(tmLookupName, apiKey, opts && opts.season != null ? opts.season : null, opts && opts.episode != null ? opts.episode : null);
                  tmdbEpCheck = tmEpCheck;
                }
                if (tmEpCheck && tmEpCheck.episode && (tmEpCheck.episode.name || tmEpCheck.episode.title)) {
                  const tmNameCheck = String(tmEpCheck.episode.name || tmEpCheck.episode.title).trim();
                  const wikiGood = isMeaningfulTitle(wikiEp.name);
                  const tmHasLatin = /[A-Za-z]/.test(tmNameCheck);
                  const wikiHasLatin = /[A-Za-z]/.test(String(wikiEp.name || ''));
                  if (isMeaningfulTitle(tmNameCheck) && !isPlaceholderTitle(tmNameCheck) && tmHasLatin) {
                    ep = tmEpCheck.episode;
                    try { appendLog(`META_TMDB_VERIFIED_OVER_WIKI q=${aniListName} tm=${tmNameCheck}`) } catch (e) {}
                  } else if (wikiGood && wikiHasLatin) {
                    ep = { name: wikiEp.name };
                    try { appendLog(`META_WIKIPEDIA_PREFERRED_OVER_TM_PLACEHOLDER q=${aniListName} wiki=${wikiEp.name} tm=${tmNameCheck}`) } catch (e) {}
                  } else if (isMeaningfulTitle(tmNameCheck) && !isPlaceholderTitle(tmNameCheck)) {
                    ep = tmEpCheck.episode;
                    try { appendLog(`META_TMDB_VERIFIED_OVER_WIKI_NONLATIN q=${aniListName} tm=${tmNameCheck}`) } catch (e) {}
                  } else if (wikiGood) {
                    ep = { name: wikiEp.name };
                    try { appendLog(`META_WIKIPEDIA_FALLBACK_NONLATIN q=${aniListName} wiki=${wikiEp.name} tm=${tmNameCheck}`) } catch (e) {}
                  }
                } else {
                  ep = { name: wikiEp.name };
                  try { appendLog(`META_WIKIPEDIA_EP_AFTER_ANILIST_OK q=${aniListName} epName=${wikiEp.name}`) } catch (e) {}
                }
              } catch (e) {
                ep = { name: wikiEp.name };
                try { appendLog(`META_WIKIPEDIA_EP_AFTER_ANILIST_OK q=${aniListName} epName=${wikiEp.name}`) } catch (ee) {}
              }
            } else {
              ep = { name: wikiEp.name };
              try { appendLog(`META_WIKIPEDIA_EP_AFTER_ANILIST_OK q=${aniListName} epName=${wikiEp.name}`) } catch (e) {}
            }
          } else if (wikiEp && wikiEp.name && !wikiParentMatch) {
            try { appendLog(`META_WIKIPEDIA_PARENT_MISMATCH intended=${intendedSeries} gotPage=${wikiEp.raw && wikiEp.raw.page ? wikiEp.raw.page : '<none>'}`) } catch (e) {}
          }
        } catch (e) {}
      }

      // If still no episode title, try Kitsu as a fallback
      if (!ep) {
        if (!apiKey) { try { appendLog(`META_TMDB_SKIPPED_NO_KEY q=${aniListName}`) } catch (e) {} }
        ep = await fetchKitsuEpisode(strippedAniListName || aniListName || v, opts && opts.episode != null ? opts.episode : null)
        try { appendLog(`META_KITSU_EP q=${aniListName} ep=${opts && opts.episode != null ? opts.episode : '<none>'} found=${ep && (ep.name||ep.title) ? 'yes' : 'no'}`) } catch (e) {}
      }

      // capture result and break out of the loop
      const aniListRawPayload = Object.assign({}, a.raw, { id: a.id, source: 'anilist' })
      if (tvdbInfo) {
        try { aniListRawPayload.tvdb = { seriesId: tvdbInfo.seriesId, seriesName: tvdbInfo.seriesName } } catch (e) {}
      }
      aniListResult = { name: a.name, raw: aniListRawPayload, episode: ep }
      if (tvdbInfo) {
        try { aniListResult.tvdb = tvdbInfo } catch (e) {}
      }
      break
    }
    if (aniListResult) return aniListResult

    // try parent-derived candidate if provided or derivable
    let parentCandidate = opts && opts.parentCandidate ? String(opts.parentCandidate).trim() : null
    if (!parentCandidate && opts && opts.parentPath) {
      try {
        const pp = require('./lib/filename-parser')(path.basename(opts.parentPath))
        if (pp && pp.title) parentCandidate = pp.title
      } catch (e) {}
    }
    if (parentCandidate) {
      const pvars = makeVariants(parentCandidate)
      for (let i = 0; i < Math.min(pvars.length, 3); i++) {
        const a = await searchAniList(pvars[i])
        try { appendLog(`META_ANILIST_PARENT_SEARCH q=${pvars[i]} found=${a ? 'yes' : 'no'}`) } catch (e) {}
        if (!a) continue
  const parentMatch = evaluateAniListCandidate(a, [parentCandidate].filter(Boolean), pvars[i], 'parent')
  if (!parentMatch.ok) continue

        let ep = null;
        let tvdbInfoParent = null;
        let titleVariantsP = [];
        try {
          if (a && a.title) {
            if (a.title.english) titleVariantsP.push(a.title.english);
            if (a.title.romaji) titleVariantsP.push(a.title.romaji);
            if (a.title.native) titleVariantsP.push(a.title.native);
          }
          if (a && a.relations && Array.isArray(a.relations.nodes)) {
            for (const rn of a.relations.nodes) {
              if (rn && rn.title && rn.title.english) titleVariantsP.push(rn.title.english);
              if (rn && rn.title && rn.title.romaji) titleVariantsP.push(rn.title.romaji);
              if (rn && rn.title && rn.title.native) titleVariantsP.push(rn.title.native);
            }
          }
        } catch (e) { /* best-effort */ }
        const parentAniListName = (a && a.name) ? a.name : parentCandidate;
        const strippedParentName = (a && a.name) ? stripAniListSeasonSuffix(a.name, a.raw || a) : parentCandidate;
        titleVariantsP = titleVariantsP
          .concat([parentAniListName, strippedParentName, parentCandidate, pvars[i]])
          .map(s => String(s || '').trim())
          .filter(Boolean);
        if (!titleVariantsP.length) {
          titleVariantsP = [String(parentAniListName || parentCandidate || '').trim()].filter(Boolean);
        }
        const uniqueTitleVariantsP = [...new Set(titleVariantsP)];
        let tmdbEpCheckParent = null;

        if (!ep && tvdbCreds && opts && opts.season != null && opts.episode != null) {
          try {
            const tvdbEpisode = await tvdb.fetchEpisode(tvdbCreds, uniqueTitleVariantsP, opts.season, opts.episode, {
              log: (line) => {
                try { appendLog(line) } catch (e) {}
              }
            });
            if (tvdbEpisode && tvdbEpisode.episodeTitle) {
              tvdbInfoParent = {
                seriesId: tvdbEpisode.seriesId,
                seriesName: tvdbEpisode.seriesName,
                episodeTitle: tvdbEpisode.episodeTitle,
                raw: tvdbEpisode.raw
              };
              ep = {
                name: tvdbEpisode.episodeTitle,
                title: tvdbEpisode.episodeTitle,
                localized_name: tvdbEpisode.episodeTitle,
                source: 'tvdb',
                raw: tvdbEpisode.raw && tvdbEpisode.raw.episode ? tvdbEpisode.raw.episode : tvdbEpisode.raw
              };
              try { ep.tvdb = { seriesId: tvdbEpisode.seriesId, seriesName: tvdbEpisode.seriesName }; } catch (e) {}
              try { appendLog(`META_TVDB_EP_AFTER_PARENT q=${parentAniListName} epName=${String(tvdbEpisode.episodeTitle).slice(0,120)}`) } catch (e) {}
            } else {
              try { appendLog(`META_TVDB_EP_AFTER_PARENT_NONE q=${parentAniListName}`) } catch (e) {}
            }
          } catch (e) {
            try { appendLog(`META_TVDB_EP_AFTER_PARENT_ERROR q=${parentAniListName} err=${e && e.message ? e.message : String(e)}`) } catch (ee) {}
          }
        }

        if (!ep && apiKey) {
          const tmLookupName = strippedParentName || parentAniListName || parentCandidate;
          try { appendLog(`META_TMDB_EP_AFTER_ANILIST_PARENT tmLookup=${tmLookupName} anilist=${parentAniListName} season=${opts && opts.season != null ? opts.season : '<none>'} episode=${opts && opts.episode != null ? opts.episode : '<none>'} usingKey=masked`) } catch (e) {}
          try {
            tmdbEpCheckParent = await searchTmdbAndEpisode(tmLookupName, apiKey, opts && opts.season != null ? opts.season : null, opts && opts.episode != null ? opts.episode : null);
          } catch (e) {
            tmdbEpCheckParent = null;
            try { appendLog(`META_TMDB_EP_AFTER_ANILIST_PARENT_ERROR q=${parentAniListName} err=${e && e.message ? e.message : String(e)}`) } catch (ee) {}
          }
          if (tmdbEpCheckParent && tmdbEpCheckParent.episode) {
            const tmEpTitleParent = String(tmdbEpCheckParent.episode.name || tmdbEpCheckParent.episode.title || '').trim();
            try {
              const tmHasLatin = /[A-Za-z]/.test(tmEpTitleParent);
              if (isMeaningfulTitle(tmEpTitleParent) && !isPlaceholderTitle(tmEpTitleParent) && tmHasLatin) {
                ep = tmdbEpCheckParent.episode;
                try { appendLog(`META_TMDB_EP_AFTER_ANILIST_PARENT_OK q=${parentAniListName} epName=${tmEpTitleParent}`) } catch (e) {}
              } else if (isMeaningfulTitle(tmEpTitleParent) && !isPlaceholderTitle(tmEpTitleParent)) {
                ep = tmdbEpCheckParent.episode;
                try { appendLog(`META_TMDB_EP_AFTER_ANILIST_PARENT_OK_NONLATIN q=${parentAniListName} epName=${tmEpTitleParent}`) } catch (e) {}
              } else {
                try { appendLog(`META_TMDB_EP_AFTER_ANILIST_PARENT_IGNORED_PLACEHOLDER q=${parentAniListName} tm=${tmEpTitleParent}`) } catch (e) {}
              }
            } catch (e) {
              ep = tmdbEpCheckParent.episode;
              try { appendLog(`META_TMDB_EP_AFTER_ANILIST_PARENT_OK q=${parentAniListName} epName=${tmEpTitleParent}`) } catch (ee) {}
            }
          } else if (tmdbEpCheckParent) {
            try { appendLog(`META_TMDB_EP_AFTER_ANILIST_PARENT_NONE q=${parentAniListName}`) } catch (e) {}
          } else {
            try { appendLog(`META_TMDB_EP_AFTER_ANILIST_PARENT_NONE q=${parentAniListName}`) } catch (e) {}
          }
        }

        if (!ep) {
          try {
            const wikiEp = await lookupWikipediaEpisode(uniqueTitleVariantsP.map(normalizeSearchQuery), opts && opts.season != null ? opts.season : null, opts && opts.episode != null ? opts.episode : null, { force: !!(opts && opts.force), tmdbKey: apiKey });
            const intendedSeries = parentAniListName;
            let wikiParentMatch = false;
            if (wikiEp && wikiEp.raw && wikiEp.raw.page) {
              const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g,'').trim();
              const intendedNorm = norm(intendedSeries);
              const pageNorm = norm(wikiEp.raw.page);
              if (pageNorm.includes(intendedNorm) || intendedNorm.includes(pageNorm)) wikiParentMatch = true;
            }
            if (wikiEp && wikiEp.name && wikiParentMatch) {
              if (apiKey) {
                try {
                  let tmEpCheck = tmdbEpCheckParent;
                  if (!tmEpCheck) {
                    const tmLookupName = strippedParentName || parentAniListName || parentCandidate;
                    tmEpCheck = await searchTmdbAndEpisode(tmLookupName, apiKey, opts && opts.season != null ? opts.season : null, opts && opts.episode != null ? opts.episode : null);
                    tmdbEpCheckParent = tmEpCheck;
                  }
                  if (tmEpCheck && tmEpCheck.episode && (tmEpCheck.episode.name || tmEpCheck.episode.title)) {
                    const tmParentName = String(tmEpCheck.episode.name || tmEpCheck.episode.title).trim();
                    const tmHasLatin = /[A-Za-z]/.test(tmParentName);
                    const wikiHasLatin = /[A-Za-z]/.test(String(wikiEp.name || ''));
                    if (isMeaningfulTitle(tmParentName) && !isPlaceholderTitle(tmParentName) && tmHasLatin) {
                      ep = tmEpCheck.episode;
                      try { appendLog(`META_TMDB_VERIFIED_OVER_WIKI_PARENT q=${parentAniListName} tm=${tmParentName}`) } catch (e) {}
                    } else if (wikiHasLatin && isMeaningfulTitle(wikiEp.name)) {
                      ep = { name: wikiEp.name };
                      try { appendLog(`META_WIKIPEDIA_PREFERRED_PARENT_LATIN q=${parentAniListName} wiki=${wikiEp.name} tm=${tmParentName}`) } catch (e) {}
                    } else if (isMeaningfulTitle(tmParentName) && !isPlaceholderTitle(tmParentName)) {
                      ep = tmEpCheck.episode;
                      try { appendLog(`META_TMDB_VERIFIED_OVER_WIKI_PARENT_NONLATIN q=${parentAniListName} tm=${tmParentName}`) } catch (e) {}
                    } else {
                      ep = { name: wikiEp.name };
                      try { appendLog(`META_WIKIPEDIA_EP_AFTER_ANILIST_PARENT_OK q=${parentAniListName} epName=${wikiEp.name}`) } catch (e) {}
                    }
                  } else {
                    ep = { name: wikiEp.name };
                    try { appendLog(`META_WIKIPEDIA_EP_AFTER_ANILIST_PARENT_OK q=${parentAniListName} epName=${wikiEp.name}`) } catch (e) {}
                  }
                } catch (e) {
                  ep = { name: wikiEp.name };
                  try { appendLog(`META_WIKIPEDIA_EP_AFTER_ANILIST_PARENT_OK q=${parentAniListName} epName=${wikiEp.name}`) } catch (ee) {}
                }
              } else {
                ep = { name: wikiEp.name };
                try { appendLog(`META_WIKIPEDIA_EP_AFTER_ANILIST_PARENT_OK q=${parentAniListName} epName=${wikiEp.name}`) } catch (e) {}
              }
            } else if (wikiEp && wikiEp.name && !wikiParentMatch) {
              try { appendLog(`META_WIKIPEDIA_PARENT_MISMATCH intended=${intendedSeries} gotPage=${wikiEp.raw && wikiEp.raw.page ? wikiEp.raw.page : '<none>'}`) } catch (e) {}
            }
          } catch (e) {}
        }

        if (!ep) {
          if (!apiKey) { try { appendLog(`META_TMDB_SKIPPED_NO_KEY_PARENT q=${parentAniListName}`) } catch (e) {} }
          ep = await fetchKitsuEpisode(strippedParentName || parentAniListName || parentCandidate, opts && opts.episode != null ? opts.episode : null)
          try { appendLog(`META_KITSU_EP_PARENT q=${parentAniListName} ep=${opts && opts.episode != null ? opts.episode : '<none>'} found=${ep && (ep.name||ep.title) ? 'yes' : 'no'}`) } catch (e) {}
        }

        const parentRaw = Object.assign({}, a.raw, { id: a.id, source: 'anilist' })
        if (tvdbInfoParent) {
          try { parentRaw.tvdb = { seriesId: tvdbInfoParent.seriesId, seriesName: tvdbInfoParent.seriesName } } catch (e) {}
        }
        const parentRes = { name: a.name, raw: parentRaw, episode: ep }
        if (tvdbInfoParent) {
          try { parentRes.tvdb = tvdbInfoParent } catch (e) {}
        }
        return parentRes
      }
    }

    // When AniList lookups fail entirely, attempt a direct TVDB lookup before falling back to TMDb.
    if (tvdbCreds && opts && opts.season != null && opts.episode != null) {
      try {
        const fallbackCandidates = [...new Set(variants.concat(parentCandidate ? [parentCandidate] : []).map(s => String(s || '').trim()).filter(Boolean))]
        if (fallbackCandidates.length) {
          const tvdbFallback = await tvdb.fetchEpisode(tvdbCreds, fallbackCandidates, opts.season, opts.episode, {
            log: (line) => {
              try { appendLog(line) } catch (e) {}
            }
          })
          if (tvdbFallback && tvdbFallback.episodeTitle) {
            const providerRaw = { source: 'tvdb', id: tvdbFallback.seriesId, seriesName: tvdbFallback.seriesName, raw: tvdbFallback.raw }
            const episodeObj = {
              name: tvdbFallback.episodeTitle,
              title: tvdbFallback.episodeTitle,
              localized_name: tvdbFallback.episodeTitle,
              source: 'tvdb',
              raw: tvdbFallback.raw && tvdbFallback.raw.episode ? tvdbFallback.raw.episode : tvdbFallback.raw
            }
            const tvdbRes = { name: tvdbFallback.seriesName || fallbackCandidates[0], raw: providerRaw, episode: episodeObj, tvdb: tvdbFallback }
            try { appendLog(`META_TVDB_FALLBACK q=${fallbackCandidates[0]} epName=${String(tvdbFallback.episodeTitle).slice(0,120)}`) } catch (e) {}
            return tvdbRes
          } else {
            try { appendLog(`META_TVDB_FALLBACK_NONE candidates=${fallbackCandidates.slice(0,3).join('|')}`) } catch (e) {}
          }
        }
      } catch (e) {
        try { appendLog(`META_TVDB_FALLBACK_ERROR err=${e && e.message ? e.message : String(e)}`) } catch (ee) {}
      }
    }

    // AniList didn't find anything; try TMDb fallback (filename then parent)
    if (apiKey) {
      for (let i=0;i<Math.min(variants.length,3);i++) {
        const t = await searchTmdbAndEpisode(variants[i], apiKey, opts && opts.season != null ? opts.season : null, opts && opts.episode != null ? opts.episode : null)
        try { appendLog(`META_TMDB_SEARCH q=${variants[i]} found=${t ? 'yes' : 'no'}`) } catch (e) {}
        if (t) {
          // Attempt a Wikipedia lookup for the episode title and prefer it when meaningful.
          try {
            const wikiTryTitles = []
            if (t.name) wikiTryTitles.push(t.name)
            if (variants[i]) wikiTryTitles.push(variants[i])
            const wikiEp = await lookupWikipediaEpisode(wikiTryTitles.length ? wikiTryTitles : t.name, opts && opts.season != null ? opts.season : null, opts && opts.episode != null ? opts.episode : null, { tmdbKey: apiKey, force: false })
            if (wikiEp && wikiEp.name) {
              try { appendLog(`META_WIKIPEDIA_PREFERRED_AFTER_TMDB q=${t.name || variants[i]} wiki=${wikiEp.name}`) } catch (e) {}
              return { name: t.name, raw: Object.assign({}, t.raw || {}, { id: t.id, source: 'tmdb' }), episode: { name: wikiEp.name } }
            }
          } catch (e) { /* ignore wiki lookup errors and fall back to TMDb episode */ }
          return { name: t.name, raw: Object.assign({}, t.raw || {}, { id: t.id, source: 'tmdb' }), episode: t.episode || null }
        }
      }
      if (parentCandidate) {
        for (let i=0;i<Math.min(makeVariants(parentCandidate).length,3);i++) {
          const pv = makeVariants(parentCandidate)[i]
          const t = await searchTmdbAndEpisode(pv, apiKey, opts && opts.season != null ? opts.season : null, opts && opts.episode != null ? opts.episode : null)
          try { appendLog(`META_TMDB_PARENT_SEARCH q=${pv} found=${t ? 'yes' : 'no'}`) } catch (e) {}
          if (t) return { name: t.name, raw: Object.assign({}, t.raw || {}, { id: t.id, source: 'tmdb' }), episode: t.episode || null }
        }
      }
    }
  } catch (e) {
    try { appendLog(`META_LOOKUP_ERROR title=${String(title).slice(0,100)} err=${e && e.message ? e.message : String(e)}`) } catch (ee) {}
  }
  return null
}

// ...existing code...

async function externalEnrich(canonicalPath, providedKey, opts = {}) {
  try { console.log('DEBUG: externalEnrich START path=', canonicalPath, 'providedKeyPresent=', !!providedKey); } catch (e) {}
  const key = canonicalize(canonicalPath);
  const forceLookup = !!(opts && opts.force);
  const existingEntry = enrichCache[key] || null;
  if (existingEntry && existingEntry.providerFailure && !forceLookup) {
    try {
      const pf = existingEntry.providerFailure;
      appendLog(`META_PROVIDER_SKIP path=${key} reason=${pf && pf.reason ? pf.reason : 'cached-failure'} attempts=${pf && pf.attemptCount ? pf.attemptCount : 0}`);
    } catch (e) { /* logging best-effort */ }
    const updated = markProviderFailureSkip(key) || existingEntry;
    return Object.assign({}, updated || existingEntry || {});
  }
  let attemptedProvider = false;
  let providerResult = null;
  let providerError = null;
  let movieSignal = false;
  let seriesSignal = false;
  let detectedMediaFormat = null;
  function considerFormatCandidate(val) {
    try {
      if (!val) return;
      const str = String(val).trim();
      if (!str) return;
      if (!detectedMediaFormat) detectedMediaFormat = str;
      const upper = str.toUpperCase();
      if (upper.includes('MOVIE') || upper === 'FILM' || upper === 'FEATURE' || upper === 'THEATRICAL') movieSignal = true;
      if (upper.includes('TV') || upper.includes('SERIES') || upper === 'OVA' || upper === 'ONA' || upper === 'SPECIAL') seriesSignal = true;
    } catch (e) { /* ignore */ }
  }
  function analyzeRawForMedia(raw) {
    try {
      if (!raw || typeof raw !== 'object') return;
      if (raw.format) considerFormatCandidate(raw.format);
      if (raw.mediaFormat) considerFormatCandidate(raw.mediaFormat);
      if (raw.subType) considerFormatCandidate(raw.subType);
      if (raw.subtype) considerFormatCandidate(raw.subtype);
      const mediaType = raw.media_type || raw.mediaType || raw.type || raw.category;
      if (mediaType) {
        const norm = String(mediaType).toLowerCase();
        if (norm.includes('movie') || norm === 'film') movieSignal = true;
        if (norm.includes('tv') || norm.includes('series') || norm.includes('show')) seriesSignal = true;
      }
      if (raw.release_date && !raw.first_air_date) movieSignal = true;
      if (raw.first_air_date || raw.number_of_episodes || raw.episode_count || raw.episode_run_time) seriesSignal = true;
    } catch (e) { /* ignore */ }
  }
  // lightweight filename parser to strip common release tags and extract season/episode
  const base = path.basename(canonicalPath, path.extname(canonicalPath));
  const parseFilename = require('./lib/filename-parser');
  const parsed = parseFilename(base);
  const normSeason = (parsed.season == null && parsed.episode != null) ? 1 : parsed.season
  const normEpisode = parsed.episode
  if (normSeason != null || normEpisode != null || parsed.episodeRange) seriesSignal = true;

  // split series and episode title heuristically
  let seriesName = parsed.title || parsed.parsedName || base
  let episodeTitle = parsed.episodeTitle || ''

  const seriesTitleCandidates = []
  const seriesCandidateSeen = new Set()
  const addSeriesCandidate = (label, value, opts = {}) => {
    try {
      if (!value) return
      const trimmed = String(value).trim()
      if (!trimmed) return
      const keyCand = trimmed.toLowerCase()
      if (seriesCandidateSeen.has(keyCand)) return
      seriesCandidateSeen.add(keyCand)
      if (opts && opts.prepend) seriesTitleCandidates.unshift({ label, value: trimmed })
      else seriesTitleCandidates.push({ label, value: trimmed })
    } catch (e) { /* ignore candidate errors */ }
  }

  addSeriesCandidate('parsed.title', seriesName)

  function normalizeCapitalization(str) {
    try {
      if (!str) return str
      const original = String(str)
      const letters = original.replace(/[^A-Za-z]/g, '')
      if (!letters) return original
      if (letters !== letters.toUpperCase()) return original
      const shortUpper = new Set()
      original.replace(/\b[A-Z]{2,3}\b/g, (token) => { try { shortUpper.add(String(token || '').toLowerCase()) } catch (e) {} return token })
      let result = original.toLowerCase()
      result = result.replace(/\b([a-z])/g, (match, c) => c.toUpperCase())
      result = result.replace(/([A-Za-z])'([A-Z])/g, (match, left, right) => left + "'" + right.toLowerCase())
      if (shortUpper.size) {
        result = result.replace(/\b([A-Za-z]{2,3})\b/g, (match) => shortUpper.has(match.toLowerCase()) ? match.toUpperCase() : match)
      }
      return result
    } catch (e) { return str }
  }

  // If parsed title looks like an episode (e.g., filename only contains SxxEyy - Title), prefer a parent-folder as series title
  // Compute a parent-folder candidate but do NOT prefer it yet — we'll try filename first, then parent if TMDb fails.
  let parentCandidate = null
  try {
    const parent = path.dirname(canonicalPath)
    // normalize separators to '/' so splitting works for both Windows and POSIX-style input
    const parts = String(parent).replace(/\\/g,'/').split('/').filter(Boolean)
    const SKIP_FOLDER_TOKENS = new Set(['input','library','scan','local','media','video']);
    for (let i = parts.length - 1; i >= 0; i--) {
      try {
        const seg = parts[i]
        if (!seg) continue
        const pParsed = parseFilename(seg)
        let cand = pParsed && pParsed.title ? String(pParsed.title).trim() : ''
        if (!cand) continue
        // If the candidate begins with a common folder keyword (e.g. 'input 86'), strip it
        try {
          const toks = cand.split(/\s+/).filter(Boolean)
          if (toks.length > 1 && SKIP_FOLDER_TOKENS.has(String(toks[0]).toLowerCase())) {
            cand = toks.slice(1).join(' ')
          }
          // if after stripping it's still a skip token, ignore
          if (SKIP_FOLDER_TOKENS.has(String(cand).toLowerCase())) continue
        } catch (e) { /* ignore token cleanup errors */ }
        // If candidate is numeric-only but the original folder segment contains an explicit season marker
        // (e.g., 'S01' or '1x02'), accept the numeric series name. Otherwise skip episode-like or noisy candidates.
        const rawSeg = String(seg || '')
        const hasSeasonMarker = /\bS\d{1,2}([EPp]\d{1,3})?\b|\b\d{1,2}x\d{1,3}\b/i.test(rawSeg)
        if (isSeasonFolderToken(cand)) continue
        if (!(/^[0-9]+$/.test(String(cand).trim()) && hasSeasonMarker)) {
          if (isEpisodeTokenCandidate(cand) || isNoiseLike(cand)) continue
        }
        parentCandidate = cand
        break
      } catch (e) { /* ignore per-segment parse errors */ }
    }
  // Do not override seriesName from arbitrary parent path segments (e.g., '/mnt').
  // The parentCandidate variable above is sufficient; leave seriesName as parsed from filename.
  } catch (e) { /* ignore parent derivation errors */ }

  if (parentCandidate) addSeriesCandidate('parentCandidate', parentCandidate)

  const parsedTitleLooksEpisodeLike = !seriesName || isEpisodeTokenCandidate(seriesName) || /^episode\b/i.test(String(seriesName)) || /^part\b/i.test(String(seriesName))
  if (parentCandidate && parsedTitleLooksEpisodeLike) {
    try { appendLog(`META_PARENT_ELEVATED parsedTitle=${String(seriesName).slice(0,120)} parent=${parentCandidate} path=${String(canonicalPath).slice(0,200)}`) } catch (e) {}
    seriesName = parentCandidate
    addSeriesCandidate('parent.elevated', seriesName)
  }

    // Strip version-suffix tokens like 'v2', 'v3' that often follow episode markers (but preserve decimal episodes like 11.5)
    function stripVersionSuffix(s) {
      try {
        if (!s) return s
        let out = String(s)
        // Remove attached vN after episode tokens: S01E01v2, E01v2, 01v2
        out = out.replace(/\b((?:S\d{1,2}E\d{1,3})|(?:E\d{1,3})|(?:\d{1,3}))v\d+\b/ig, '$1')
        // Remove trailing standalone vN tokens like ' - v2' or ' v3'
        out = out.replace(/[-_\s]+v\d+\b/ig, '')
        // Also remove trailing 'v2' attached to words like 'Episodev2'
        out = out.replace(/v\d+\b/ig, '')
        return out.trim()
      } catch (e) { return s }
    }

    seriesName = stripVersionSuffix(seriesName)
    episodeTitle = stripVersionSuffix(episodeTitle)

  addSeriesCandidate('series.stripped', seriesName)

  function pad(n){ return String(n).padStart(2,'0') }
  let epLabel = ''
  if (parsed.episodeRange) {
    if (normSeason != null) epLabel = `S${pad(normSeason)}E${parsed.episodeRange}`
    else epLabel = `E${parsed.episodeRange}`
  } else if (normEpisode != null) {
    if (normSeason != null) epLabel = `S${pad(normSeason)}E${pad(normEpisode)}`
    else epLabel = `E${pad(normEpisode)}`
  }

  let formattedParsedName = seriesName
  if (epLabel) formattedParsedName += ' - ' + epLabel
  formattedParsedName = formattedParsedName.trim()

  const guess = { title: normalizeCapitalization(seriesName), parsedName: formattedParsedName, season: normSeason, episode: normEpisode, episodeTitle, parentCandidate: parentCandidate || null, seriesLookupTitle: null, seriesTitle: null };
  addSeriesCandidate('initial.guess', guess.title)
  try { console.log('DEBUG: externalEnrich parsed guess=', JSON.stringify(guess)); } catch (e) {}

  const tmdbKey = providedKey || (users && users.admin && users.admin.settings && users.admin.settings.tmdb_api_key) || (serverSettings && serverSettings.tmdb_api_key)
  const tvdbCredentials = resolveTvdbCredentials(opts && opts.username ? opts.username : null, opts && opts.tvdbOverride ? opts.tvdbOverride : null)
  let seriesLookupTitle = seriesName
  // determine username (if provided) so we can honor per-user default provider and track fallback counts
  const username = opts && opts.username ? opts.username : null
  // determine preferred provider: per-user -> server -> default to 'tmdb'
  let preferredProvider = 'tmdb'
  try {
    if (username && users[username] && users[username].settings && users[username].settings.default_meta_provider) preferredProvider = users[username].settings.default_meta_provider
    else if (serverSettings && serverSettings.default_meta_provider) preferredProvider = serverSettings.default_meta_provider
  } catch (e) { preferredProvider = 'tmdb' }
  // normalize preferred provider to tmdb (kitsu removed)
  preferredProvider = 'tmdb'
  if (tmdbKey || preferredProvider) {
    attemptedProvider = true;
    let res = null;
    try {
      const parentPath = path.resolve(path.dirname(canonicalPath))
      // Ensure we search the series title first. If the parsed `seriesName` still contains
      // episode tokens (e.g. 'S01E11.5 ...' or leading 'S01P01'), strip those episode-like
      // tokens out so TMDb receives a clean series candidate. We keep the original parsed
      // episode/season in opts so metaLookup can still perform episode-level lookup once the
      // series is matched.
      function stripEpisodeTokens(s) {
        try {
          if (!s) return s
          let out = String(s)
          // remove leading episode markers like 'S01E01', 'S01E11.5', 'S01P01', 'E01', '01'
          out = out.replace(/^\s*(?:S0*\d{1,2}[EPp]0*\d{1,3}(?:\.\d+)?|S0*\d{1,2}|E0*\d{1,3}|0*\d{1,3})[\s\-_:]+/i, '')
          // also remove trailing episode markers e.g. ' - S01E01' or ' S01E01'
          out = out.replace(/[\s\-_:]+(?:S0*\d{1,2}[EPp]0*\d{1,3}(?:\.\d+)?|S0*\d{1,2}|E0*\d{1,3}|0*\d{1,3})\s*$/i, '')
          // collapse leftover separators and trim
          out = out.replace(/[_\.\-\s]+/g, ' ').trim()
          return out
        } catch (e) { return s }
      }

  // Only strip episode tokens for special-like episodes so regular SxxEyy lookups
  // remain untouched. A special candidate is either season 0 or a decimal episode
  // number (e.g., 11.5). For non-special episodes, forward the original seriesName
  // so TMDb can match the show by its usual title.
  const epStrForSpecial = String(normEpisode != null ? normEpisode : '')
  const isSpecialCandidate = (Number(normSeason) === 0) || (epStrForSpecial.indexOf('.') !== -1)
  if (isSpecialCandidate) {
    // For specials, prefer the parent folder (series) title so we locate the show first,
    // then lookup the special within that series. Only fall back to stripping episode
    // tokens from the filename-derived title if no parent candidate was found.
    if (parentCandidate) {
      try { appendLog(`META_PARENT_PREFERRED_FOR_SPECIAL parent=${parentCandidate} path=${parentPath || ''}`) } catch (e) {}
      seriesLookupTitle = parentCandidate
    } else {
      seriesLookupTitle = stripEpisodeTokens(seriesName) || seriesName
    }
  } else {
    seriesLookupTitle = seriesName
  }
  addSeriesCandidate('series.lookup', seriesLookupTitle)
  try { console.log('DEBUG: externalEnrich will attempt metaLookup seriesLookupTitle=', seriesLookupTitle, 'tmdbKeyPresent=', !!tmdbKey); } catch (e) {}
  // For specials, do not pass season/episode to the provider lookup so we can
  // perform name-based matching against TMDb's season-0 specials list. However
  // keep the parsed episode/season locally so the UI and hardlink names still
  // reflect the filename-derived numbers.
  const metaOpts = { year: parsed.year, preferredProvider, parsedEpisodeTitle: episodeTitle, parentCandidate: parentCandidate, parentPath, force: (opts && opts.force) ? true : false };
  if (opts && opts.tvdbOverride) metaOpts.tvdbOverride = opts.tvdbOverride;
  // include requesting username so metaLookup may use per-user keys
  if (opts && opts.username) metaOpts.username = opts.username
  if (!isSpecialCandidate) {
    metaOpts.season = normSeason;
    metaOpts.episode = normEpisode;
  }
  res = await metaLookup(seriesLookupTitle, tmdbKey, metaOpts)
  try { console.log('DEBUG: externalEnrich metaLookup returned res=', !!res); } catch (e) {}
  // Diagnostic: log a trimmed version of the metaLookup response so we can
  // see whether the provider returned series/episode data before parent fallback.
  try {
    const shortRaw = (res && res.raw) ? JSON.stringify(res.raw).slice(0,400).replace(/\n/g,' ') : ''
    appendLog(`META_LOOKUP_RAW title=${seriesLookupTitle} found=${res && res.name ? 'yes' : 'no'} resName=${res && res.name ? res.name : '<none>'} raw=${shortRaw}`)
  } catch (e) { try { console.log('DEBUG: append META_LOOKUP_RAW failed', e && e.message) } catch (e) {} }
  // If no provider result found for the filename-derived title, and we have a
  // parent folder candidate, attempt a secondary lookup using the parent title
  // (do not allow parent to override parsed season/episode; we still keep
  // filename-derived numbers locally). This ensures we fall back to parent
  // folder name when the filename title fails to match.
    if (!res && parentCandidate) {
    try { appendLog(`META_PARENT_FALLBACK trying parentCandidate=${parentCandidate}`) } catch (e) {}
    try {
      // Ensure we explicitly pass season/episode when invoking parent-based lookup
      // so TMDb will perform an episode-level lookup once the series is matched.
      const parentMetaOpts = Object.assign({}, metaOpts || {}, { season: normSeason, episode: normEpisode, parentCandidate: parentCandidate, parentPath: parentPath, _parentDirect: true });
      try { appendLog(`META_PARENT_FALLBACK invoking metaLookup parentCandidate=${parentCandidate} optsSeason=${parentMetaOpts.season != null ? parentMetaOpts.season : '<none>'} optsEpisode=${parentMetaOpts.episode != null ? parentMetaOpts.episode : '<none>'}`) } catch (e) {}
      const pRes = await metaLookup(parentCandidate, tmdbKey, parentMetaOpts)
      if (pRes) {
        try { appendLog(`META_PARENT_FALLBACK success parentCandidate=${parentCandidate}`) } catch (e) {}
        res = pRes
      } else {
        try { appendLog(`META_PARENT_FALLBACK none parentCandidate=${parentCandidate}`) } catch (e) {}
      }
    } catch (e) {
      try { appendLog(`META_PARENT_FALLBACK error parentCandidate=${parentCandidate} err=${e && e.message ? e.message : String(e)}`) } catch (e) {}
    }
  }
      if (res && res.name) {
        // Map TMDb response into our guess structure explicitly
        try {
          const raw = res.raw || {}
          analyzeRawForMedia(raw)
          // Title (series/movie)
          // Prefer AniList-provided English title, then romaji, then fallback to provider name fields
          let providerTitleRaw = String(res.name || raw.name || raw.title || '').trim()
          let anilistEnglish = null
          let anilistRomaji = null
          try {
            if (res && res.title) {
              if (res.title.english) anilistEnglish = String(res.title.english).trim()
              if (res.title.romaji) anilistRomaji = String(res.title.romaji).trim()
            }
            if (!anilistEnglish && res && res.raw && res.raw.title && res.raw.title.english) anilistEnglish = String(res.raw.title.english).trim()
            if (!anilistRomaji && res && res.raw && res.raw.title && res.raw.title.romaji) anilistRomaji = String(res.raw.title.romaji).trim()
          } catch (e) { /* best-effort */ }
          const providerPreferred = (anilistEnglish && anilistEnglish.length) ? anilistEnglish : ((anilistRomaji && anilistRomaji.length) ? anilistRomaji : providerTitleRaw)
          if (providerPreferred) {
            guess.originalSeriesTitle = providerPreferred
            guess.seriesTitleExact = providerPreferred
            // store English/romaji separately for later preference logic
            if (anilistEnglish) guess.seriesTitleEnglish = anilistEnglish
            if (anilistRomaji) guess.seriesTitleRomaji = anilistRomaji
            addSeriesCandidate('provider.original', providerPreferred, { prepend: true })
          }
          const mappedTitle = providerPreferred || String(raw.displayName || guess.title || seriesName || base).trim()
          if (mappedTitle) guess.title = mappedTitle

          // Episode-level data (when available)
          if (res.episode) {
            const ep = res.episode
            // prefer a TMDb-provided localized_name (from translations), then a Latin/English-looking name,
            // then fall back to raw provider fields (including native/Japanese). Wikipedia results are
            // already preferred earlier when available, so here we try to pick the best TMDb name.
            try {
              let chosen = null
              if (ep && ep.localized_name) chosen = String(ep.localized_name).trim()
              // if no localized_name, prefer ep.name/title that contains Latin letters
              if (!chosen) {
                const cand = String(ep.name || ep.title || (ep.attributes && ep.attributes.canonicalTitle) || '').trim()
                if (cand && /[A-Za-z]/.test(cand)) chosen = cand
              }
              // if still not chosen but ep.name exists (likely native script), keep it as fallback
              if (!chosen && ep && (ep.name || ep.title)) chosen = String(ep.name || ep.title).trim()

              if (chosen) {
                const epTrim = chosen.trim()
                if (/^episode\s*\d+/i.test(epTrim) || /^(?:e(?:p(?:isode)?)?|ep)\b[\s\.\:\/\-]*\d+/i.test(epTrim)) {
                  try { appendLog(`PROVIDER_EP_PLACEHOLDER path=${String(canonicalPath).slice(0,200)} epRaw=${epTrim}`) } catch (e) {}
                  // leave guess.episodeTitle undefined so callers treat it as missing
                } else {
                  guess.episodeTitle = normalizeCapitalization(epTrim).trim()
                }
              }
            } catch (e) {
              try {
                const fallbackEp = String(ep && (ep.localized_name || ep.name || ep.title) || '').trim()
                guess.episodeTitle = normalizeCapitalization(fallbackEp).trim()
              } catch (ee) { /* ignore */ }
            }
          }

          // Provider block - set provider name based on raw.source (tmdb or kitsu)
          const providerName = (raw && raw.source) ? String(raw.source).toLowerCase() : 'tmdb'
          guess.provider = { matched: true, provider: providerName, id: raw.id || null, title: (guess.seriesTitleExact || providerTitleRaw || mappedTitle) || null, raw: raw }

          // Back-compat: populate tmdb object only when provider is TMDb
          if (providerName === 'tmdb') {
            guess.tmdb = { matched: true, id: raw.id || null, raw: raw }
          } else {
            guess.tmdb = { matched: false }
          }

          // IMPORTANT: keep parsed episode/season strictly from filename.
          // Prevent parent-folder parsing or provider results from overriding
          // the episode/season numbers that were extracted from the filename.
          try {
            guess.season = normSeason;
            guess.episode = normEpisode;
          } catch (e) { /* best-effort */ }

          // Year extraction: prefer series-level start/first air date for regular episodes,
          // but for specials (season 0 or decimal episode numbers) prefer the episode
          // air_date when available. This avoids using a special's episode air year for
          // the whole series while still allowing specials to use episode-level dates.
          let dateStr = null
          try {
            if (typeof isSpecialCandidate !== 'undefined' && isSpecialCandidate) {
              // For specials: prefer episode air_date first
              if (res && res.episode) {
                dateStr = res.episode.air_date || res.episode.airDate || (res.episode.attributes && (res.episode.attributes.air_date || res.episode.attributes.airDate)) || null
              }
              if (!dateStr) {
                dateStr = raw.seasonAirDate || raw.first_air_date || raw.release_date || raw.firstAirDate || (raw.attributes && (raw.attributes.startDate || raw.attributes.releaseDate))
              }
            } else {
              // For regular episodes: prefer series/season-level dates first
              dateStr = raw.seasonAirDate || raw.first_air_date || raw.release_date || raw.firstAirDate || (raw.attributes && (raw.attributes.startDate || raw.attributes.releaseDate)) || null
              // If AniList-style nested startDate { year: YYYY } is present, prefer it as the series start year
              if (!dateStr) {
                try {
                  if (raw && raw.startDate && typeof raw.startDate === 'object' && raw.startDate.year) {
                    // set guess.year directly from the nested year and skip episode fallback
                    const ry2 = Number(raw.startDate.year)
                    if (!isNaN(ry2)) {
                      guess.year = String(ry2)
                    }
                  }
                } catch (e) {}
              }
              // If we didn't get a year yet, fall back to episode air_date when available
              if (!guess.year) {
                if (!dateStr) {
                  if (res && res.episode) {
                    dateStr = res.episode.air_date || res.episode.airDate || (res.episode.attributes && (res.episode.attributes.air_date || res.episode.attributes.airDate)) || null
                  }
                }
              }
            }
          } catch (e) { /* ignore */ }
          if (dateStr) {
            const y = new Date(String(dateStr)).getFullYear()
            if (!isNaN(y)) guess.year = String(y)
          } else {
            // Some providers (AniList) return nested startDate objects like { year: 2010 }
            try {
              if (raw && raw.startDate && typeof raw.startDate === 'object' && raw.startDate.year) {
                const ry = Number(raw.startDate.year)
                if (!isNaN(ry)) guess.year = String(ry)
              }
            } catch (e) {}
          }
        } catch (mapErr) {
          // Map error -> keep guess as-is but note tmdb not matched
          guess.tmdb = { matched: false }
        }
      } else {
  guess.tmdb = { matched: false }
      }
    } catch (e) {
  guess.tmdb = { error: e.message }
      providerError = e;
    }
    providerResult = res;
  }

    if (tvdbCredentials && normSeason != null && normEpisode != null) {
      try {
        let tvdbHit = null
        if (providerResult && providerResult.tvdb && providerResult.tvdb.episodeTitle) {
          tvdbHit = providerResult.tvdb
          try { appendLog(`META_TVDB_OVERRIDE_REUSE path=${canonicalPath} ep=${String(tvdbHit.episodeTitle).slice(0,200)}`) } catch (e) {}
        } else {
          const tvdbTitles = []
          if (providerResult && providerResult.name) tvdbTitles.push(providerResult.name)
          if (guess && guess.title) tvdbTitles.push(guess.title)
          if (seriesName) tvdbTitles.push(seriesName)
          if (parentCandidate) tvdbTitles.push(parentCandidate)
          if (seriesLookupTitle) tvdbTitles.push(seriesLookupTitle)
          const uniqueTitles = [...new Set(tvdbTitles.filter(Boolean))]
          tvdbHit = await tvdb.fetchEpisode(tvdbCredentials, uniqueTitles, normSeason, normEpisode, {
            log: (line) => {
              try { appendLog(line) } catch (e) {}
            }
          })
        }
        if (tvdbHit && tvdbHit.episodeTitle) {
          guess.episodeTitle = tvdbHit.episodeTitle
          guess.provider = {
            matched: true,
            provider: 'tvdb',
            id: tvdbHit.seriesId,
            title: tvdbHit.seriesName || guess.title,
            season: normSeason,
            episode: normEpisode,
            episodeTitle: tvdbHit.episodeTitle,
            raw: tvdbHit.raw
          }
          seriesSignal = true
          analyzeRawForMedia(tvdbHit && tvdbHit.raw && tvdbHit.raw.series)
          analyzeRawForMedia(tvdbHit && tvdbHit.raw && tvdbHit.raw.episode)
          if (tvdbHit.seriesName) addSeriesCandidate('tvdb.seriesName', tvdbHit.seriesName)
          guess.tvdb = { matched: true, id: tvdbHit.seriesId, raw: tvdbHit.raw }
          if (guess.tmdb && guess.tmdb.matched) guess.tmdb.matched = false
          guess.providerFailure = null
          clearProviderFailure(key)
          try { appendLog(`META_TVDB_OVERRIDE path=${canonicalPath} ep=${String(tvdbHit.episodeTitle).slice(0,200)}`) } catch (e) {}
          try {
            const safe = (val) => {
              return String(val == null ? '' : val)
                .replace(/[\r\n]+/g, ' ')
                .replace(/[^\x20-\x7E]/g, '?')
                .slice(0, 200);
            }
            const safeJson = (obj) => {
              try {
                if (!obj) return ''
                return safe(JSON.stringify(obj))
              } catch (e) { return '' }
            }
            const seriesInfo = tvdbHit && tvdbHit.raw ? safeJson(tvdbHit.raw.series) : ''
            const episodeInfo = tvdbHit && tvdbHit.raw ? safeJson(tvdbHit.raw.episode) : ''
            appendLog(
              `META_TVDB_OVERRIDE_DETAIL path=${canonicalPath} seriesId=${tvdbHit.seriesId || '<none>'} seriesName=${safe(tvdbHit.seriesName || '')} episodeTitle=${safe(tvdbHit.episodeTitle || '')} season=${normSeason != null ? normSeason : '<none>'} episode=${normEpisode != null ? normEpisode : '<none>'} rawSeries=${seriesInfo} rawEpisode=${episodeInfo}`
            )
          } catch (logErr) {
            try { console.log('DEBUG: META_TVDB_OVERRIDE_DETAIL failed', logErr && logErr.message ? logErr.message : logErr) } catch (ee) {}
          }
        }
      } catch (e) {
        try { appendLog(`META_TVDB_OVERRIDE_FAIL path=${canonicalPath} err=${e && e.message ? e.message : String(e)}`) } catch (ee) {}
      }
    }

  if (attemptedProvider) {
    if (providerResult && providerResult.name) {
      guess.providerFailure = null;
      clearProviderFailure(key);
    } else {
      const failureInfo = recordProviderFailure(key, {
        provider: 'tmdb',
        reason: providerError ? 'error' : 'no-match',
        code: providerError && (providerError.code || providerError.statusCode) ? (providerError.code || providerError.statusCode) : null,
        error: providerError && providerError.message ? providerError.message : null
      });
      guess.providerFailure = failureInfo || normalizeProviderFailure({
        provider: 'tmdb',
        reason: providerError ? 'error' : 'no-match',
        lastError: providerError && providerError.message ? providerError.message : null
      });
    }
  }

  if (detectedMediaFormat && !guess.mediaFormat) guess.mediaFormat = detectedMediaFormat;
  if (movieSignal) {
    if (!seriesSignal) {
      guess.isMovie = true;
    } else if (typeof guess.isMovie === 'undefined') {
      guess.isMovie = true;
    }
  } else if (seriesSignal && typeof guess.isMovie === 'undefined') {
    guess.isMovie = false;
  }

  {
    const candidateValues = seriesTitleCandidates.map(c => c.value)
    // Prefer AniList English title when available to avoid mixed romaji/english folders
    if (guess.seriesTitleEnglish) {
      guess.seriesTitle = String(guess.seriesTitleEnglish).trim()
    } else if (guess.seriesTitleExact) {
      // if exact exists but no explicit English field, use it
      guess.seriesTitle = String(guess.seriesTitleExact).trim()
    } else {
      const resolvedSeries = pickSeriesTitleFromCandidates(candidateValues, guess.episodeTitle || episodeTitle)
      if (resolvedSeries) guess.seriesTitle = String(resolvedSeries).trim()
      else guess.seriesTitle = normalizeCapitalization(seriesName).trim()
    }
  }
  if (!guess.seriesTitleExact && guess.seriesTitle) {
    guess.seriesTitleExact = String(guess.seriesTitle).trim();
  }
  if (!guess.originalSeriesTitle && guess.seriesTitleExact) {
    guess.originalSeriesTitle = guess.seriesTitleExact;
  }
  if (guess.seriesTitleExact) {
    guess.title = String(guess.seriesTitleExact).trim()
  } else if (guess.seriesTitle) {
    guess.title = guess.seriesTitle
  } else if (!guess.title) {
    guess.title = normalizeCapitalization(seriesName).trim()
  } else if (looksLikeEpisodeTitleCandidate(guess.title, guess.episodeTitle || episodeTitle)) {
    guess.title = normalizeCapitalization(seriesName).trim()
  }
  if (!guess.seriesLookupTitle) guess.seriesLookupTitle = seriesLookupTitle || null

  return {
    sourceId: 'mock:1',
    title: guess.title || base,
    seriesTitle: guess.seriesTitle || guess.title || base,
    seriesTitleExact: guess.seriesTitleExact || guess.originalSeriesTitle || null,
    seriesTitleEnglish: guess.seriesTitleEnglish || null,
    seriesTitleRomaji: guess.seriesTitleRomaji || null,
    originalSeriesTitle: guess.originalSeriesTitle || guess.seriesTitleExact || null,
    parentCandidate: guess.parentCandidate || parentCandidate || null,
    seriesLookupTitle: guess.seriesLookupTitle || seriesLookupTitle || null,
    year: guess.year || null,
    parsedName: guess.parsedName,
    episodeRange: parsed.episodeRange,
    season: guess.season,
    episode: guess.episode,
    episodeTitle: guess.episodeTitle,
  isMovie: (typeof guess.isMovie === 'boolean') ? guess.isMovie : null,
  mediaFormat: guess.mediaFormat || null,
    tmdb: guess.tmdb || null,
    provider: guess.provider || null,
    language: 'en',
    timestamp: Date.now(),
    extraGuess: guess
  };
}

// Diagnostic: log the final applied guess when externalEnrich is about to finish
// (inserted as a lightweight instrumentation - will not affect behavior)
try {
  // best-effort: append a short one-line summary to logs
  const _dbg = (typeof guess !== 'undefined') ? `META_APPLY_RESULT title=${guess.title || '<none>'} episodeTitle=${guess.episodeTitle || '<none>'} season=${guess.season != null ? guess.season : '<none>'} episode=${guess.episode != null ? guess.episode : '<none>'} provider=${(guess.provider && guess.provider.provider) ? guess.provider.provider : '<none>'}` : 'META_APPLY_RESULT guess=<undefined>'
  try { appendLog(_dbg) } catch (e) { /* ignore logging failure */ }
} catch (e) { /* ignore */ }

// Normalize path canonicalization (simple lower-case, resolve)
function canonicalize(p) {
  return path.resolve(p).replace(/\\/g, '/');
}

// Helper: decide whether a provider block is complete (no need to re-query)
function isProviderComplete(provider) {
  try {
    if (!provider) return false;
    const matched = !!provider.matched;
    const hasRendered = !!provider.renderedName;
    const episodeOk = (provider.episode == null) || (provider.episodeTitle && String(provider.episodeTitle).trim());
    return matched && hasRendered && episodeOk;
  } catch (e) { return false }
}

// Render provider-based filename using a template and provider data
function renderProviderName(data, key, session) {
  try {
    const userTemplate = (session && session.username && users[session.username] && users[session.username].settings && users[session.username].settings.rename_template) ? users[session.username].settings.rename_template : null;
    const baseNameTemplate = userTemplate || serverSettings.rename_template || '{title} ({year}) - {epLabel} - {episodeTitle}';
    const rawTitle = data.title || '';
    const providerIsMovie = determineIsMovie(data);
    // Only use an explicit year returned by provider; do not heuristically extract a year
    // from titles or filenames here — parsed-only results should not show a year.
    const yearToken = (providerIsMovie && data.year) ? data.year : '';
    function pad(n){ return String(n).padStart(2,'0') }
    let epLabel = '';
    if (data.episodeRange) epLabel = data.season != null ? `S${pad(data.season)}E${data.episodeRange}` : `E${data.episodeRange}`
    else if (data.episode != null) epLabel = data.season != null ? `S${pad(data.season)}E${pad(data.episode)}` : `E${pad(data.episode)}`
    const titleToken = cleanTitleForRender(rawTitle, epLabel, data.episodeTitle || '');
    const nameWithoutExtRaw = String(baseNameTemplate)
      .replace('{title}', sanitize(titleToken))
      .replace('{basename}', sanitize(path.basename(key, path.extname(key))))
      .replace('{year}', yearToken || '')
      .replace('{epLabel}', sanitize(epLabel))
      .replace('{episodeTitle}', sanitize(data.episodeTitle || ''))
      .replace('{season}', data.season != null ? String(data.season) : '')
      .replace('{episode}', data.episode != null ? String(data.episode) : '')
      .replace('{episodeRange}', data.episodeRange || '')
      .replace('{tmdbId}', (data.tmdb && data.tmdb.raw && (data.tmdb.raw.id || data.tmdb.raw.seriesId)) ? String(data.tmdb.raw.id || data.tmdb.raw.seriesId) : '')
    let providerRendered = String(nameWithoutExtRaw)
      .replace(/\s*\(\s*\)\s*/g, '')
      .replace(/\s*\-\s*(?:\-\s*)+/g, ' - ')
      .replace(/(^\s*\-\s*)|(\s*\-\s*$)/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return providerRendered;
  } catch (e) { return '' }
}

// Centralized parsed item processing used by scans: parse filename, update parsedCache & enrichCache
function resolveTvdbCredentials(username, override) {
  const hasValue = (value) => value !== undefined && value !== null && String(value).trim().length > 0;
  const normalize = (value) => String(value || '').trim();

  const extract = (source) => {
    if (!source) return null;
    const apiKey = source.tvdb_v4_api_key ?? source.tvdbV4ApiKey ?? source.v4ApiKey;
    if (!hasValue(apiKey)) return null;
    const userPinRaw = source.tvdb_v4_user_pin ?? source.tvdbV4UserPin ?? source.v4UserPin ?? null;
    return {
      mode: 'v4',
      apiKey: normalize(apiKey),
      userPin: hasValue(userPinRaw) ? normalize(userPinRaw) : null
    };
  };

  try {
    const fromOverride = extract(override);
    if (fromOverride) return fromOverride;

    if (username && users[username] && users[username].settings) {
      const fromUser = extract(users[username].settings);
      if (fromUser) return fromUser;
    }

    const fromServer = extract(serverSettings);
    if (fromServer) return fromServer;
  } catch (e) { /* ignore */ }
  return null;
}

function doProcessParsedItem(it, session) {
  try {
    const parseFilename = require('./lib/filename-parser');
    const base = path.basename(it.canonicalPath, path.extname(it.canonicalPath));
    const key = canonicalize(it.canonicalPath);
    const prior = parsedCache[key] || null;
    let parsed = null;
    try {
      const guess = parseFilename(base);
      parsed = { title: guess.title, parsedName: guess.parsedName, season: guess.season, episode: guess.episode, episodeRange: guess.episodeRange || null, timestamp: Date.now() };
    } catch (parseErr) {
      if (prior) {
        parsed = Object.assign({}, prior, { timestamp: Date.now() });
      } else {
        throw parseErr;
      }
    }
    if (parsed) {
      const now = Date.now();
      parsed.timestamp = now;
      try {
        // Always render using latest parser output so rescans pick up improvements.
        const userTemplate = (session && session.username && users[session.username] && users[session.username].settings && users[session.username].settings.rename_template) ? users[session.username].settings.rename_template : null;
        const baseNameTemplate = userTemplate || serverSettings.rename_template || '{title} ({year}) - {epLabel} - {episodeTitle}';
        function pad(n){ return String(n).padStart(2,'0') }
        let parsedEpLabel = '';
        if (parsed.episodeRange) parsedEpLabel = parsed.season != null ? `S${pad(parsed.season)}E${parsed.episodeRange}` : `E${parsed.episodeRange}`
        else if (parsed.episode != null) parsedEpLabel = parsed.season != null ? `S${pad(parsed.season)}E${pad(parsed.episode)}` : `E${pad(parsed.episode)}`
        const titleToken = cleanTitleForRender(parsed.title || '', parsedEpLabel, '');
        const nameWithoutExtRaw = String(baseNameTemplate)
          .replace('{title}', sanitize(titleToken))
          .replace('{basename}', sanitize(path.basename(key, path.extname(key))))
          .replace('{year}', parsed.year || '')
          .replace('{epLabel}', sanitize(parsedEpLabel))
          .replace('{episodeTitle}', '')
          .replace('{season}', parsed.season != null ? String(parsed.season) : '')
          .replace('{episode}', parsed.episode != null ? String(parsed.episode) : '')
          .replace('{episodeRange}', parsed.episodeRange || '')
          .replace('{tmdbId}', '')
        let parsedRendered = String(nameWithoutExtRaw).replace(/\s{2,}/g, ' ').trim();
        try { parsedRendered = parsedRendered.replace(/\s*\(\s*\)\s*/g, '').replace(/\s*[-–—]\s*$/g, '').replace(/\s{2,}/g, ' ').trim(); } catch (e) {}
        const parsedBlock = { title: parsed.title, parsedName: parsedRendered, season: parsed.season, episode: parsed.episode, episodeRange: parsed.episodeRange || null, timestamp: now };
        parsedCache[key] = Object.assign({}, parsedCache[key] || {}, parsedBlock);
        updateEnrichCache(key, Object.assign({}, enrichCache[key] || {}, { parsed: parsedBlock, sourceId: 'parsed-cache', cachedAt: now }));
      } catch (e) {
        updateEnrichCache(key, Object.assign({}, enrichCache[key] || {}, { sourceId: 'local-parser', title: parsed.title, parsedName: parsed.parsedName, season: parsed.season, episode: parsed.episode, episodeRange: parsed.episodeRange || null, episodeTitle: '', language: 'en', timestamp: now }));
      }
    }
  } catch (e) { appendLog(`PARSE_ITEM_FAIL path=${it && it.canonicalPath} err=${e && e.message ? e.message : String(e)}`) }
}

// Background enricher: enrich up to first N candidates, update caches and write progress
async function backgroundEnrichFirstN(scanId, enrichCandidates, session, libPath, lockKey, N = 12) {
  try {
    const first = (enrichCandidates && Array.isArray(enrichCandidates) ? enrichCandidates : (scans[scanId] && scans[scanId].items) || []).slice(0, N);
    const username = session && session.username;
    let tmdbKey = null;
    try { if (username && users[username] && users[username].settings && users[username].settings.tmdb_api_key) tmdbKey = users[username].settings.tmdb_api_key; else if (serverSettings && serverSettings.tmdb_api_key) tmdbKey = serverSettings.tmdb_api_key; } catch (e) { tmdbKey = null }
    const refreshProgressKey = `refreshScan:${scanId}`;
    try { refreshProgress[refreshProgressKey] = { processed: 0, total: first.length, lastUpdated: Date.now(), status: 'running' }; } catch (e) {}
    for (const it of first) {
      try {
        const key = canonicalize(it.canonicalPath);
        const existing = enrichCache[key] || null;
        const prov = existing && existing.provider ? existing.provider : null;
        if (isProviderComplete(prov)) { continue; }
        if (existing && existing.providerFailure) {
          try { appendLog(`BACKGROUND_ENRICH_SKIP_FAILURE path=${key}`); } catch (e) {}
          continue;
        }
        const data = await externalEnrich(key, tmdbKey, { username });
        if (!data) { continue; }
        try {
          const providerRendered = renderProviderName(data, key, session);
          const providerBlock = { title: data.title, year: data.year, season: data.season, episode: data.episode, episodeTitle: data.episodeTitle || '', raw: data.raw || data, renderedName: providerRendered, matched: !!data.title };
          try { logMissingEpisodeTitleIfNeeded(key, providerBlock) } catch (e) {}
          updateEnrichCache(key, Object.assign({}, enrichCache[key] || {}, { provider: providerBlock, sourceId: 'provider', cachedAt: Date.now() }));
        } catch (e) {
          updateEnrichCache(key, Object.assign({}, enrichCache[key] || {}, data, { sourceId: 'provider', cachedAt: Date.now() }));
        }
        try { if (db) db.setKV('enrichCache', enrichCache); else writeJson(enrichStoreFile, enrichCache); } catch (e) {}
        try { if (refreshProgress[refreshProgressKey]) { refreshProgress[refreshProgressKey].processed += 1; refreshProgress[refreshProgressKey].lastUpdated = Date.now(); } } catch (e) {}
      } catch (e) { appendLog(`BACKGROUND_ENRICH_FAIL path=${it && it.canonicalPath} err=${e && e.message ? e.message : String(e)}`); }
    }
    try { if (refreshProgress[refreshProgressKey]) { refreshProgress[refreshProgressKey].status = 'complete'; refreshProgress[refreshProgressKey].lastUpdated = Date.now(); } setTimeout(() => { try { delete refreshProgress[refreshProgressKey]; } catch (e) {} }, 30*1000) } catch (e) {}
    // release lock and persist scans after enrichment
    try { activeScans.delete(lockKey); appendLog(`SCAN_LOCK_RELEASED path=${libPath}`); } catch (e) {}
    try {
      const modified = [];
      const sids = Object.keys(scans || {});
      for (const sid of sids) {
        try {
          const s = scans[sid];
          if (!s || !Array.isArray(s.items)) continue;
          const before = s.items.length;
          s.items = s.items.map(it => (it && it.canonicalPath) ? Object.assign({}, it) : it).filter(it => {
            try {
              const k = canonicalize(it.canonicalPath);
              const e = enrichCache[k] || null;
              if (e && (e.hidden || e.applied)) return false;
              try { it.enrichment = enrichCache[k] || null } catch (ee) { it.enrichment = null }
              return true;
            } catch (e) { return true }
          });
          if (s.items.length !== before) { s.totalCount = s.items.length; modified.push(sid); } else {
            let anySnapshot = false; for (const it of s.items) { try { if (it && it.enrichment) { anySnapshot = true; break } } catch (e) {} }
            if (anySnapshot) modified.push(sid);
          }
        } catch (e) {}
      }
  if (modified.length) { try { if (db) db.saveScansObject(scans); else writeJson(scanStoreFile, scans); appendLog(`POST_BACKGROUND_ENRICH_SCANS_UPDATED ids=${modified.join(',')}`) } catch (e) {} }
    // Notify clients that scans were updated so UI can reconcile without manual refresh
    try {
      if (modified && modified.length && Array.isArray(hideEvents)) {
        const evt = { ts: Date.now(), path: libPath || null, originalPath: libPath || null, modifiedScanIds: modified.map(String) };
        hideEvents.push(evt);
        try { if (db) db.setHideEvents(hideEvents); } catch (e) {}
        // keep recent events bounded
        if (hideEvents.length > 200) hideEvents.splice(0, hideEvents.length - 200);
        appendLog(`HIDE_EVENTS_PUSH_BY_BACKGROUND_ENRICH ids=${modified.join(',')}`);
      }
    } catch (e) {}
    } catch (e) {}
  } catch (e) { appendLog(`BACKGROUND_FIRSTN_ENRICH_FAIL scan=${scanId} err=${e && e.message ? e.message : String(e)}`); }
}

// Endpoint: list libraries (just a sample folder picker)
app.get('/api/libraries', (req, res) => {
  // Let user choose an existing folder under cwd or provide custom path via config later
  res.json([{ id: 'local', name: 'Local folder', canonicalPath: path.resolve('.') }]);
});

// New diagnostic endpoint: provider/meta status (TMDb/Kitsu)
app.get('/api/meta/status', (req, res) => {
  try {
    // check server and user keys (mask)
    const serverKey = serverSettings && serverSettings.tmdb_api_key ? String(serverSettings.tmdb_api_key) : null
    const serverAnilistKey = serverSettings && serverSettings.anilist_api_key ? String(serverSettings.anilist_api_key) : null
    const serverMask = serverKey ? (serverKey.slice(0,6) + '...' + serverKey.slice(-4)) : null
    let userKey = null
    let userAnilistKey = null
    let userTvdbV4 = false
    try {
      const u = req.session && req.session.username && users[req.session.username]
      if (u && u.settings && u.settings.tmdb_api_key) userKey = String(u.settings.tmdb_api_key)
      if (u && u.settings && u.settings.anilist_api_key) userAnilistKey = String(u.settings.anilist_api_key)
      if (u && u.settings) {
        userTvdbV4 = !!u.settings.tvdb_v4_api_key
      }
    } catch (e) {}
    const userMask = userKey ? (userKey.slice(0,6) + '...' + userKey.slice(-4)) : null
    const userAnilistMask = userAnilistKey ? (userAnilistKey.slice(0,6) + '...' + userAnilistKey.slice(-4)) : null
    const serverTvdbV4 = !!(serverSettings && serverSettings.tvdb_v4_api_key)
    const serverTvdbV4Mask = serverSettings && serverSettings.tvdb_v4_api_key ? (String(serverSettings.tvdb_v4_api_key).slice(0,6) + '...' + String(serverSettings.tvdb_v4_api_key).slice(-4)) : null
    let userTvdbV4MaskVal = null
    if (userTvdbV4) {
      try {
        const u = req.session && req.session.username && users[req.session.username]
        if (u && u.settings && u.settings.tvdb_v4_api_key) {
          const raw = String(u.settings.tvdb_v4_api_key)
          userTvdbV4MaskVal = raw.slice(0,6) + '...' + raw.slice(-4)
        }
      } catch (e) { userTvdbV4MaskVal = null }
    }
  // recent META_LOOKUP logs (TMDb attempts and lookup requests)
  let recent = ''
    const relevantTokens = ['META_LOOKUP_REQUEST', 'META_TMDB_SEARCH', 'META_TMDB_ATTEMPT', 'META_ANILIST_SEARCH', 'TVDB_']
    try {
      recent = fs.readFileSync(logsFile, 'utf8').split('\n').filter(l => {
        if (!l) return false
        for (const token of relevantTokens) if (l.indexOf(token) !== -1) return true
        return false
      }).slice(-200).join('\n')
    } catch (e) { recent = '' }
    res.json({
      serverKeyPresent: !!serverKey,
      userKeyPresent: !!userKey,
      serverKeyMask: serverMask,
      userKeyMask: userMask,
      serverAnilistPresent: !!serverAnilistKey,
      userAnilistPresent: !!userAnilistKey,
      serverAnilistMask: serverAnilistKey ? (serverAnilistKey.slice(0,6) + '...' + serverAnilistKey.slice(-4)) : null,
      userAnilistMask,
      serverTvdbV4Present: serverTvdbV4,
  userTvdbV4Present: userTvdbV4,
  serverTvdbV4Mask,
  userTvdbV4Mask: userTvdbV4MaskVal,
      logs: recent
    })
  } catch (e) { res.json({ error: e.message }) }
})

// Backwards compatible endpoint for older clients
app.get('/api/tmdb/status', (req, res) => {
  return app._router.handle(req, res, () => {}, 'GET', '/api/meta/status')
})

// Trigger scan - performs full inventory then stores artifact
app.post('/api/scan', async (req, res) => {
  const { libraryId, path: libraryPath } = req.body || {};
  // Resolve chosen path in order: explicit request -> requesting user's per-user setting
  // Do NOT fallback to a global server setting here; admins are regular users with extra privileges
  let libPath = null;
  if (libraryPath) {
    libPath = path.resolve(libraryPath);
  } else if (req.session && req.session.username && users[req.session.username] && users[req.session.username].settings && users[req.session.username].settings.scan_input_path) {
    libPath = path.resolve(users[req.session.username].settings.scan_input_path);
  } else {
    return res.status(400).json({ error: 'library path required' });
  }
  // Validate chosen path: must exist, be a directory, and be readable.
  try {
    if (!fs.existsSync(libPath)) return res.status(400).json({ error: 'path does not exist', path: libPath });
    const st = fs.statSync(libPath);
    if (!st.isDirectory()) return res.status(400).json({ error: 'path is not a directory', path: libPath });
    try { fs.accessSync(libPath, fs.constants.R_OK); } catch (accErr) { return res.status(400).json({ error: 'path is not readable', path: libPath, detail: accErr.message }); }
  } catch (err) {
    appendLog(`SCAN_VALIDATION_ERROR path=${libPath} err=${err.message}`);
    return res.status(400).json({ error: 'invalid path', detail: err.message });
  }
  appendLog(`SCAN_START library=${libraryId || 'local'} path=${libPath}`);
  // perform filesystem walk synchronously but non-blocking via promises

  // directories to skip during scan to avoid crawling node_modules and VCS folders
  const IGNORED_DIRS = new Set(['node_modules', '.git', '.svn', '__pycache__']);
  const VIDEO_EXTS = ['mkv','mp4','avi','mov','m4v','mpg','mpeg','webm','wmv','flv','ts','ogg','ogv','3gp','3g2'];
  const extRe = new RegExp('\\.(' + VIDEO_EXTS.join('|') + ')$', 'i');

  function walkDir(dir) {
    let ent;
    try {
      ent = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      appendLog(`SCAN_DIR_SKIP dir=${dir} err=${e.message}`);
      return;
    }
    for (const e of ent) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        walkDir(full);
      } else {
        if (extRe.test(e.name)) {
          items.push({ id: uuidv4(), canonicalPath: canonicalize(full), scannedAt: Date.now() });
        }
      }
    }
  }

  // Delegate scan helpers to lib/scan.js
  const scanLib = require('./lib/scan');
  function loadScanCache() { return scanLib.loadScanCache(scanCacheFile); }
  function saveScanCache(obj) { return scanLib.saveScanCache(scanCacheFile, obj); }

  // Reusable per-item parsing + enrich-cache update logic (extracted from full scan flow)
  // Use central parsed-item processor (doProcessParsedItem)

  // Use scan library implementations
  function fullScanLibrary(libPath) { return scanLib.fullScanLibrary(libPath, { ignoredDirs: IGNORED_DIRS, videoExts: VIDEO_EXTS, canonicalize: canonicalize, uuidv4 }); }
  function incrementalScanLibrary(libPath) { return scanLib.incrementalScanLibrary(libPath, { scanCacheFile, ignoredDirs: IGNORED_DIRS, videoExts: VIDEO_EXTS, canonicalize: canonicalize, uuidv4 }); }

  let items = [];
  try {
    // Load prior scan cache to decide between full vs incremental scan
    const priorCache = loadScanCache();
    if (!priorCache || !priorCache.files || Object.keys(priorCache.files).length === 0) {
      // No prior cache - perform full scan to collect candidates
      try {
        items = fullScanLibrary(libPath);
      } catch (err) {
        appendLog(`SCAN_ERROR ${err.message}`);
        return res.status(500).json({ error: err.message });
      }
    } else {
      // We'll call incrementalScanLibrary later after acquiring lock; for now leave items empty
      items = [];
    }
  } catch (err) {
    appendLog(`SCAN_ERROR ${err && err.message ? err.message : String(err)}`);
    return res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
  // Prevent concurrent scans for the same resolved path
  const lockKey = `scanPath:${libPath}`;
  if (activeScans.has(lockKey)) {
    appendLog(`SCAN_CONFLICT path=${libPath}`);
    return res.status(409).json({ error: 'scan already in progress for this path' });
  }
  activeScans.add(lockKey);
  appendLog(`SCAN_LOCK_ACQUIRED path=${libPath}`);

  const scanId = uuidv4();
  // Run quick local parsing for each discovered item so the UI shows cleaned parsed names immediately
  let backgroundStarted = false;
  let incrementalNewItems = [];
  try {
    const session = req.session || {};
    const priorCache2 = loadScanCache();
    if (!priorCache2 || !priorCache2.files || Object.keys(priorCache2.files).length === 0) {
      // first full run - process everything
      for (const it of items) doProcessParsedItem(it, session);
      // build current cache map (files + dirs) and save
      const curFiles = {};
      const curDirs = {};
      for (const it of items) {
        try { const st = fs.statSync(it.canonicalPath); curFiles[it.canonicalPath] = st.mtimeMs; } catch (e) { curFiles[it.canonicalPath] = Date.now(); }
        try { const d = path.dirname(it.canonicalPath); const stD = fs.statSync(d); if (stD && stD.mtimeMs != null) curDirs[canonicalize(d)] = stD.mtimeMs; } catch (e) {}
      }
      // mark initial scan completion so subsequent runs can prefer incremental
      const cacheObj = { files: curFiles, dirs: curDirs, initialScanAt: Date.now() };
      saveScanCache(cacheObj);
      // ensure items includes canonicalPath/id entries for artifact
      // Filter out entries that are marked hidden or already applied in enrichCache so restored scans respect those flags
      items = items.map(it => ({ id: it.id || uuidv4(), canonicalPath: it.canonicalPath, scannedAt: it.scannedAt || Date.now() }))
        .filter(it => {
          try {
            const k = canonicalize(it.canonicalPath);
            const e = enrichCache[k] || null;
            if (e && (e.hidden || e.applied)) return false;
            return true;
          } catch (e) { return true; }
        });
    } else {
      // incremental scan: optimized walk to detect new/changed files and removals
      const { toProcess, currentCache, removed } = incrementalScanLibrary(libPath);
      incrementalNewItems = Array.isArray(toProcess) ? toProcess.slice(0) : [];
      // If incremental scan returned currentCache but lacks initialScanAt, preserve prior marker if present
      try {
        const prior = loadScanCache();
        if (prior && prior.initialScanAt && currentCache && !currentCache.initialScanAt) currentCache.initialScanAt = prior.initialScanAt;
      } catch (e) {}
      // remove stale entries
      for (const r of (removed || [])) { try { delete enrichCache[r]; delete parsedCache[r]; } catch (e) {} }
      // process new/changed items
      for (const it of (toProcess || [])) doProcessParsedItem(it, session);
      // persist current cache map (currentCache is { files, dirs })
      if (currentCache) saveScanCache(currentCache);
      // build items array for artifact from currentCache.files
      // Exclude items that are marked hidden or applied in the enrich cache so restored scans don't re-show them
      items = Object.keys((currentCache && currentCache.files) || {}).map(p => ({ id: uuidv4(), canonicalPath: p, scannedAt: Date.now() }))
        .filter(it => {
          try {
            const k = canonicalize(it.canonicalPath);
            const e = enrichCache[k] || null;
            if (e && (e.hidden || e.applied)) return false;
            return true;
          } catch (e) { return true; }
        });
    }
    try { if (db) db.setKV('parsedCache', parsedCache); else writeJson(parsedCacheFile, parsedCache); } catch (e) {}
    try { if (db) db.setKV('enrichCache', enrichCache); else writeJson(enrichStoreFile, enrichCache); } catch (e) {}
  } catch (e) { appendLog(`PARSE_MODULE_FAIL err=${e.message}`); }
  // Wrap the remainder of the request flow so we can release the lock if something fails
  try {

    // Determine enrichment candidates: when doing incremental scans we only want to
    // refresh metadata for new/changed items (toProcess). For full scans, use the
    // artifact items as before.
    const enrichCandidates = (Array.isArray(incrementalNewItems) && incrementalNewItems.length) ? incrementalNewItems : items;
    const artifact = { id: scanId, libraryId: libraryId || 'local', totalCount: items.length, items, generatedAt: Date.now() };
    scans[scanId] = artifact;
    // Persist scans and prune older scan artifacts so we keep only the two most recent scans.
    try {
      // write current set first including the new artifact
      if (db) db.saveScansObject(scans); else writeJson(scanStoreFile, scans);
      // prune: keep only the most recent N scans (current + previous)
      const KEEP = 2;
      const allIds = Object.keys(scans || {});
      if (allIds.length > KEEP) {
        // sort ids by generatedAt desc (most recent first)
        const sorted = allIds.map(id => ({ id, ts: (scans[id] && scans[id].generatedAt) ? Number(scans[id].generatedAt) : 0 }))
          .sort((a, b) => b.ts - a.ts)
          .map(x => x.id);
        const toKeep = new Set(sorted.slice(0, KEEP));
        const toRemove = sorted.slice(KEEP);
        if (toRemove.length) {
          for (const rid of toRemove) {
            try { delete scans[rid]; } catch (e) {}
          }
        }
      }
    } catch (e) {
      try { appendLog(`SCAN_PERSIST_PRUNE_FAIL scan=${scanId} err=${e && e.message ? e.message : String(e)}`); } catch (ee) {}
    }
    appendLog(`SCAN_COMPLETE id=${scanId} total=${items.length}`);
    // Auto-sweep stale enrich cache entries after a scan completes
    try { const removed = sweepEnrichCache(); if (removed && removed.length) appendLog(`AUTOSWEEP_AFTER_SCAN removed=${removed.length}`); } catch (e) {}
    res.json({ scanId, totalCount: items.length });
    // Launch background enrichment (first N items) using centralized helper. Keep behavior identical.
    try {
      backgroundStarted = true;
      void backgroundEnrichFirstN(scanId, enrichCandidates, req.session, libPath, lockKey, 12);
    } catch (e) { appendLog(`BACKGROUND_FIRSTN_LAUNCH_FAIL scan=${scanId} err=${e && e.message ? e.message : String(e)}`); activeScans.delete(lockKey); appendLog(`SCAN_LOCK_RELEASED path=${libPath}`); }
  } catch (err) {
    try { appendLog(`SCAN_HANDLER_FAIL scan=${scanId} err=${err && err.message ? err.message : String(err)}`); } catch (e) {}
    try { if (!backgroundStarted) { activeScans.delete(lockKey); appendLog(`SCAN_LOCK_RELEASED path=${libPath}`); } } catch (ee) {}
    return res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});

// Lightweight incremental scan trigger: prefer incremental scan behavior and avoid
// performing a full walk when a prior cache exists. This endpoint is used by the
// client when it wants to resync current files (detect additions/removals/changes)
// without forcing a full main scan that can be expensive.
app.post('/api/scan/incremental', async (req, res) => {
  const { libraryId, path: libraryPath } = req.body || {};
  let libPath = null;
  if (libraryPath) libPath = path.resolve(libraryPath);
  else if (req.session && req.session.username && users[req.session.username] && users[req.session.username].settings && users[req.session.username].settings.scan_input_path) libPath = path.resolve(users[req.session.username].settings.scan_input_path);
  if (!libPath) return res.status(400).json({ error: 'library path required' });
  try {
    if (!fs.existsSync(libPath)) return res.status(400).json({ error: 'path does not exist', path: libPath });
    const st = fs.statSync(libPath);
    if (!st.isDirectory()) return res.status(400).json({ error: 'path is not a directory', path: libPath });
    try { fs.accessSync(libPath, fs.constants.R_OK); } catch (accErr) { return res.status(400).json({ error: 'path is not readable', path: libPath, detail: accErr.message }); }
  } catch (err) { appendLog(`SCAN_VALIDATION_ERROR path=${libPath} err=${err.message}`); return res.status(400).json({ error: 'invalid path', detail: err.message }); }

  appendLog(`INCREMENTAL_SCAN_START library=${libraryId || 'local'} path=${libPath}`);
  const scanLib = require('./lib/scan');
  function loadScanCache() { return scanLib.loadScanCache(scanCacheFile); }
  function saveScanCache(obj) { return scanLib.saveScanCache(scanCacheFile, obj); }

  // if no prior cache exists, fall back to full scan to collect candidates
  let items = [];
  try {
    let prior = loadScanCache();
    // If scan cache is missing but we have a prior saved scan artifact, bootstrap
    // a prior cache from the latest scan so incremental scanning can proceed
    // without doing a full filesystem walk.
    if ((!prior || !prior.files || Object.keys(prior.files).length === 0) && scans && Object.keys(scans || {}).length) {
      try {
        // pick the most recent scan by generatedAt
        const allIds = Object.keys(scans || {}).map(k => scans[k]).filter(Boolean);
        allIds.sort((a,b) => (b.generatedAt || 0) - (a.generatedAt || 0));
        const recent = allIds[0];
        if (recent && Array.isArray(recent.items) && recent.items.length) {
          const priorFiles = {};
          for (const it of recent.items) {
            try {
              const p = it.canonicalPath;
              const stat = fs.statSync(p);
              priorFiles[p] = { mtime: stat.mtimeMs || Date.now(), size: stat.size || 0, id: (it.id || (String(stat.size || 0) + ':' + String(Math.floor((stat.mtimeMs||Date.now()))))) };
            } catch (e) {
              // if stat fails, still include an entry with timestamp now so incremental can compare
              try { priorFiles[it.canonicalPath] = { mtime: Date.now(), size: 0, id: it.id || String(Math.random()).slice(2) } } catch (ee) {}
            }
          }
          prior = { files: priorFiles, dirs: {} };
          try { saveScanCache(prior); appendLog(`BOOTSTRAPPED_SCAN_CACHE from_scan=${recent.id} entries=${Object.keys(priorFiles).length}`); } catch (e) {}
        }
      } catch (e) { /* best-effort */ }
    }

    if (!prior || !prior.files || Object.keys(prior.files).length === 0) {
      // fallback to full scan if we couldn't bootstrap prior cache
      items = scanLib.fullScanLibrary(libPath, { ignoredDirs: new Set(['node_modules','.git','.svn','__pycache__']), videoExts: ['mkv','mp4','avi','mov','m4v','mpg','mpeg','webm','wmv','flv','ts','ogg','ogv','3gp','3g2'], canonicalize, uuidv4 });
    } else {
      const inc = scanLib.incrementalScanLibrary(libPath, { scanCacheFile, ignoredDirs: new Set(['node_modules','.git','.svn','__pycache__']), videoExts: ['mkv','mp4','avi','mov','m4v','mpg','mpeg','webm','wmv','flv','ts','ogg','ogv','3gp','3g2'], canonicalize, uuidv4 });
      // incremental returns { toProcess, currentCache, removed }
      const { toProcess, currentCache, removed } = inc || {};
      changedItems = Array.isArray(toProcess) ? toProcess.slice(0) : [];
      // remove stale entries
      for (const r of (removed || [])) { try { delete enrichCache[r]; delete parsedCache[r]; } catch (e) {} }
      // do minimal parsing for new/changed entries
      for (const it of (toProcess || [])) doProcessParsedItem(it, req.session || {});
      // persist new cache and build items array from currentCache, prioritizing fresh items first
      if (currentCache) saveScanCache(currentCache);
      items = scanLib.buildIncrementalItems(currentCache, toProcess, uuidv4);
    }
  } catch (e) {
    appendLog(`INCREMENTAL_SCAN_FAIL err=${e && e.message ? e.message : String(e)}`);
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }

  // proceed to create artifact and background enrich similar to /api/scan
  const scanId = uuidv4();
  const artifact = { id: scanId, libraryId: libraryId || 'local', totalCount: items.length, items, generatedAt: Date.now() };
  scans[scanId] = artifact;
  try { if (db) db.saveScansObject(scans); else writeJson(scanStoreFile, scans); } catch (e) {}
  appendLog(`INCREMENTAL_SCAN_COMPLETE id=${scanId} total=${items.length}`);
  // include a small sample of first-page items to help clients refresh UI without
  // requiring an extra request. Clients may pass a 'limit' query param when
  // invoking incremental scan; default to 100.
  const sampleLimit = Number.isInteger(parseInt(req.query && req.query.limit)) ? parseInt(req.query.limit) : 100;
  const sample = items.slice(0, sampleLimit);
  res.json({ scanId, totalCount: items.length, items: sample, changedPaths: (changedItems || []).map(it => it && it.canonicalPath).filter(Boolean) });
  try { void backgroundEnrichFirstN(scanId, changedItems, req.session, libPath, `scanPath:${libPath}`, 12); } catch (e) { appendLog(`INCREMENTAL_BACKGROUND_FAIL scan=${scanId} err=${e && e.message ? e.message : String(e)}`); }
});

app.get('/api/scan/:scanId', (req, res) => { const s = scans[req.params.scanId]; if (!s) return res.status(404).json({ error: 'scan not found' }); res.json({ libraryId: s.libraryId, totalCount: s.totalCount, generatedAt: s.generatedAt }); });
app.get('/api/scan/:scanId/items', (req, res) => { const s = scans[req.params.scanId]; if (!s) return res.status(404).json({ error: 'scan not found' }); const offset = parseInt(req.query.offset || '0', 10); const limit = Math.min(parseInt(req.query.limit || '50', 10), 500); const slice = s.items.slice(offset, offset + limit); res.json({ items: slice, offset, limit, total: s.totalCount }); });

// Return the most recent scan artifact optionally filtered by libraryId. Useful when client lost lastScanId.
app.get('/api/scan/latest', (req, res) => {
  try {
    const lib = req.query.libraryId || null
    const all = Object.keys(scans || {}).map(k => scans[k]).filter(Boolean)
    let filtered = all
    if (lib) filtered = filtered.filter(s => s.libraryId === lib)
    if (!filtered.length) return res.status(404).json({ error: 'no scans' })
    filtered.sort((a,b) => (b.generatedAt || 0) - (a.generatedAt || 0))
    const pick = filtered[0]
    // Optionally include the first page of items when requested (clients can set includeItems=true)
    const include = (req.query && (req.query.includeItems === '1' || req.query.includeItems === 'true'))
    if (include) {
      const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 500)
      const items = Array.isArray(pick.items) ? pick.items.slice(0, limit) : []
      return res.json({ scanId: pick.id, libraryId: pick.libraryId, totalCount: pick.totalCount, generatedAt: pick.generatedAt, items })
    }
    return res.json({ scanId: pick.id, libraryId: pick.libraryId, totalCount: pick.totalCount, generatedAt: pick.generatedAt })
  } catch (e) { return res.status(500).json({ error: e.message }) }
})

// Search items within a scan without returning all items (server-side filter)
app.get('/api/scan/:scanId/search', (req, res) => {
  try {
    const s = scans[req.params.scanId];
    if (!s) return res.status(404).json({ error: 'scan not found' });
    const q = (req.query.q || req.query.query || '').trim();
    const offset = parseInt(req.query.offset || '0', 10) || 0;
    const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 500);
    if (!q) return res.json({ items: [], offset, limit, total: 0 });
    const needle = String(q).toLowerCase();
    // Filter on canonicalPath and basename to support filename searches
    // First pass: exact substring matches
    let matched = (s.items || []).filter(it => {
      try {
        const p = String(it.canonicalPath || '').toLowerCase();
        const b = (it.canonicalPath || '').split(/[\\/]/).pop().toLowerCase();
        return p.indexOf(needle) !== -1 || b.indexOf(needle) !== -1;
      } catch (e) { return false }
    });

    // If no exact matches, perform fuzzy scoring on basenames and include close matches
    if (matched.length === 0) {
      // levenshtein distance helper
      function levenshtein(a, b) {
        if (!a || !b) return Math.max(a ? a.length : 0, b ? b.length : 0)
        const al = a.length, bl = b.length
        const dp = Array.from({ length: al + 1 }, (_, i) => Array(bl + 1).fill(0))
        for (let i = 0; i <= al; i++) dp[i][0] = i
        for (let j = 0; j <= bl; j++) dp[0][j] = j
        for (let i = 1; i <= al; i++) {
          for (let j = 1; j <= bl; j++) {
            const cost = a[i-1] === b[j-1] ? 0 : 1
            dp[i][j] = Math.min(dp[i-1][j] + 1, dp[i][j-1] + 1, dp[i-1][j-1] + cost)
          }
        }
        return dp[al][bl]
      }
      const scored = []
      for (const it of (s.items || [])) {
        try {
          const b = (it.canonicalPath || '').split(/[\\/]/).pop().toLowerCase();
          const dist = levenshtein(needle, b)
          // normalize distance by length; allow matches with normalized distance < 0.4
          const norm = dist / Math.max(needle.length, b.length, 1)
          if (norm <= 0.4) scored.push({ it, score: norm })
        } catch (e) {}
      }
      scored.sort((a,b) => a.score - b.score)
      matched = scored.map(s => s.it)
    }
    const total = matched.length;
    const slice = matched.slice(offset, offset + limit);
    return res.json({ items: slice, offset, limit, total });
  } catch (e) { return res.status(500).json({ error: e.message }) }
})

app.get('/api/enrich', (req, res) => {
  const { path: p } = req.query;
  const key = canonicalize(p || '');
  try {
    // If the underlying file no longer exists on disk, do not return cached enrichment
    try {
      if (key && !fs.existsSync(key)) {
        // Log and inform client that path is missing so UI can drop stale entries
        appendLog(`ENRICH_MISSING path=${key}`);
        return res.json({ cached: false, enrichment: null, missing: true });
      }
    } catch (e) { /* ignore fs errors and continue */ }
    const raw = enrichCache[key] || null;
    const normalized = normalizeEnrichEntry(raw);
    // If a provider block exists but is incomplete (e.g. missing renderedName or
    // missing episodeTitle for episode entries), treat it as not-cached so clients
    // will request an external lookup instead of assuming metadata is final.
    if (normalized) {
      const prov = normalized.provider || null;
      const providerComplete = prov && prov.matched && prov.renderedName && (prov.episode == null || (prov.episodeTitle && String(prov.episodeTitle).trim()));
      const enabled = Boolean(process.env.LOG_MISSING_EPISODE_TITLE) || (serverSettings && serverSettings.log_missing_episode_title);
      if (enabled && normalized.episode && !normalized.episodeTitle) {
        try {
          appendLog(`MISSING_EP_TITLE path=${key} providerTitle=${normalized.title || ''} season=${normalized.season || ''} episode=${normalized.episode || ''}`)
        } catch (e) {}
      }
      if (prov && !providerComplete) {
        return res.json({ cached: false, enrichment: normalized });
      }
      if (normalized.parsed || normalized.provider) return res.json({ cached: true, enrichment: normalized });
    }
    return res.json({ cached: false, enrichment: null });
  } catch (e) { return res.status(500).json({ error: e.message }) }
});

// Lookup enrichment by rendered metadata filename (without extension)
app.get('/api/enrich/by-rendered', (req, res) => {
  try {
    const name = req.query.name || ''
    if (!name) return res.status(400).json({ error: 'name required' })
    const target = renderedIndex[name]
    if (!target) return res.json({ found: false })
    const e = enrichCache[target] || null
    if (!e) return res.json({ found: false })
    return res.json({ found: true, path: target, enrichment: e })
  } catch (e) { return res.status(500).json({ error: e.message }) }
})

// Bulk enrich lookup to reduce per-file GET traffic from the client during scan refreshes
app.post('/api/enrich/bulk', (req, res) => {
  try {
    const paths = Array.isArray(req.body && req.body.paths) ? req.body.paths : null
    if (!paths) return res.status(400).json({ error: 'paths array required' })
    const out = []
    for (const p of paths) {
      try {
        const key = canonicalize(p || '')
        const raw = enrichCache[key] || null
        const normalized = normalizeEnrichEntry(raw)
        // If provider block exists but incomplete, mark as not-cached so clients will fetch externally
        if (normalized) {
          const prov = normalized.provider || null
          const providerComplete = prov && prov.matched && prov.renderedName && (prov.episode == null || (prov.episodeTitle && String(prov.episodeTitle).trim()))
          if (prov && !providerComplete) {
            out.push({ path: p, cached: false, enrichment: normalized })
            continue
          }
          if (normalized.parsed || normalized.provider) { out.push({ path: p, cached: true, enrichment: normalized }); continue }
        }
        out.push({ path: p, cached: false, enrichment: null })
      } catch (e) { out.push({ path: p, error: e.message }) }
    }
    return res.json({ items: out })
  } catch (e) { return res.status(500).json({ error: e && e.message ? e.message : String(e) }) }
})

app.get('/api/settings', (req, res) => { const userSettings = (req.session && req.session.username && users[req.session.username] && users[req.session.username].settings) ? users[req.session.username].settings : {}; res.json({ serverSettings: serverSettings || {}, userSettings }); });
// Diagnostic: expose current session and user presence to help debug auth issues (no secrets)
app.get('/api/debug/session', (req, res) => {
  try {
    const session = req.session || null;
    const username = session && session.username ? session.username : null;
    const userExists = username && users && users[username] ? true : false;
    const usersCount = users ? Object.keys(users).length : 0;
    // Do not leak password hashes; only surface counts and whether the user exists
    return res.json({ session, username, userExists, usersCount });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});
// Simple login endpoint used by the web client. Sets req.session.username on success.
app.post('/api/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username) return res.status(400).json({ error: 'username required' });
    const user = users[username];
    if (!user) return res.status(401).json({ error: 'invalid credentials' });
    // If no passwordHash is configured, allow login with empty password (bootstrap convenience)
    if (!user.passwordHash) {
      if (password && String(password).length) return res.status(401).json({ error: 'invalid credentials' });
      req.session.username = username;
      return res.json({ ok: true, username });
    }
    // compare hashed password
    bcrypt.compare(String(password || ''), String(user.passwordHash || ''), (err, same) => {
      if (err) return res.status(500).json({ error: 'compare error' });
      if (!same) return res.status(401).json({ error: 'invalid credentials' });
      req.session.username = username;
      return res.json({ ok: true, username });
    });
  } catch (e) { return res.status(500).json({ error: e && e.message ? e.message : String(e) }); }
});
app.post('/api/settings', requireAuth, (req, res) => {
  const body = req.body || {};
  const username = req.session && req.session.username;
  try {
    // if admin requested global update
    if (username && users[username] && users[username].role === 'admin' && body.global) {
      // Admins may set global server settings, but not a global scan_input_path (per-user only)
  const allowed = ['tmdb_api_key', 'anilist_api_key', 'scan_output_path', 'rename_template', 'default_meta_provider', 'tvdb_v4_api_key', 'tvdb_v4_user_pin'];
      for (const k of allowed) if (body[k] !== undefined) serverSettings[k] = body[k];
      writeJson(settingsFile, serverSettings);
      appendLog(`SETTINGS_SAVED_GLOBAL by=${username} keys=${Object.keys(body).join(',')}`);
      return res.json({ ok: true, settings: serverSettings });
    }

    // otherwise save per-user
    if (!username) return res.status(401).json({ error: 'unauthenticated' });
    users[username] = users[username] || {};
    users[username].settings = users[username].settings || {};
  const allowed = ['tmdb_api_key', 'anilist_api_key', 'scan_input_path', 'scan_output_path', 'rename_template', 'default_meta_provider', 'tvdb_v4_api_key', 'tvdb_v4_user_pin'];
    for (const k of allowed) { if (body[k] !== undefined) users[username].settings[k] = body[k]; }
    writeJson(usersFile, users);
    appendLog(`SETTINGS_SAVED_USER user=${username} keys=${Object.keys(body).join(',')}`);
    return res.json({ ok: true, userSettings: users[username].settings });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// Admin endpoint: force next scan to be full by clearing scan cache
app.post('/api/scan/force', requireAdmin, (req, res) => {
  try {
    // remove scan cache file so next /api/scan will perform a full walk
    try { if (fs.existsSync(scanCacheFile)) fs.unlinkSync(scanCacheFile); } catch (e) { appendLog(`SCAN_FORCE_UNLINK_FAIL err=${e && e.message ? e.message : String(e)}`); }
    appendLog(`SCAN_FORCE_CLEARED by=${req.session && req.session.username ? req.session.username : '<unknown>'}`);
    return res.json({ ok: true, forced: true });
  } catch (e) { return res.status(500).json({ error: e.message }) }
});

// Path existence check (used by the client to validate configured paths)
app.get('/api/path/exists', (req, res) => { const p = req.query.path || ''; try { const rp = path.resolve(p); const exists = fs.existsSync(rp); const stat = exists ? fs.statSync(rp) : null; res.json({ exists, isDirectory: stat ? stat.isDirectory() : false, resolved: rp }); } catch (err) { res.json({ exists: false, isDirectory: false, error: err.message }); } });

app.post('/api/enrich', async (req, res) => {
  const { path: p, tmdb_api_key: tmdb_override, force, tvdb_v4_api_key: tvdb_override_v4_api_key, tvdb_v4_user_pin: tvdb_override_v4_user_pin } = req.body;
  const key = canonicalize(p || '');
  appendLog(`ENRICH_REQUEST path=${key} force=${force ? 'yes' : 'no'}`);
  try {
    // prefer existing enrichment when present and not forcing
    // Only short-circuit to cached provider if it appears to be a complete provider hit
    // (i.e. provider.matched and provider.renderedName present). Additionally, when the
    // provider indicates an episode (season/episode present), require provider.episodeTitle
    // to be present as well so rescans will attempt to fetch missing episode metadata.
    const existingEarly = enrichCache[key] || null;
    const provEarly = existingEarly && existingEarly.provider ? existingEarly.provider : null;
    const providerCompleteEarly = provEarly && provEarly.matched && provEarly.renderedName && (provEarly.episode == null || (provEarly.episodeTitle && String(provEarly.episodeTitle).trim()));
    if (!force && providerCompleteEarly) {
      return res.json({ enrichment: enrichCache[key] });
    }
    if (!force && existingEarly && existingEarly.providerFailure) {
      try { appendLog(`ENRICH_REQUEST_SKIP_FAILURE path=${key}`); } catch (e) {}
      return res.json({ enrichment: existingEarly });
    }
    // Resolve an effective provider key early so we can decide whether to short-circuit to parsed-only
  let tmdbKeyEarly = null
    try {
  if (tmdb_override) tmdbKeyEarly = tmdb_override;
  else if (req.session && req.session.username && users[req.session.username] && users[req.session.username].settings && users[req.session.username].settings.tmdb_api_key) tmdbKeyEarly = users[req.session.username].settings.tmdb_api_key;
  else if (serverSettings && serverSettings.tmdb_api_key) tmdbKeyEarly = serverSettings.tmdb_api_key;
    } catch (e) { tmdbKeyEarly = null }

    // Masked diagnostic: did we resolve a TMDb key for this request?
    try { appendLog(`TMDB_KEY_RESOLVED usingKey=${tmdbKeyEarly ? 'yes' : 'no'}`) } catch (e) {}

    // If we have a parsedCache entry and not forcing a provider refresh, return a lightweight enrichment
    // unless an authoritative provider key is present — in that case perform an external lookup so provider results can override parsed.
  if (!force && parsedCache[key] && !tmdbKeyEarly) {
      const pc = parsedCache[key]
      const epTitle = (enrichCache[key] && enrichCache[key].provider && enrichCache[key].provider.episodeTitle) ? enrichCache[key].provider.episodeTitle : ''
      // build normalized entry
      const parsedBlock = { title: pc.title, parsedName: pc.parsedName, season: pc.season, episode: pc.episode, timestamp: Date.now() }
      const providerBlock = (enrichCache[key] && enrichCache[key].provider) ? enrichCache[key].provider : null
  const normalized = normalizeEnrichEntry(Object.assign({}, enrichCache[key] || {}, { parsed: parsedBlock, provider: providerBlock, sourceId: 'parsed-cache', cachedAt: Date.now() }));
  updateEnrichCache(key, normalized);
  try { if (db) db.setKV('enrichCache', enrichCache); else writeJson(enrichStoreFile, enrichCache); } catch (e) {}
      return res.json({ parsed: normalized.parsed || null, provider: normalized.provider || null })
    }

    // otherwise perform authoritative external enrich (used by rescan/force)
    let tmdbKey = null
    try {
      if (tmdb_override) tmdbKey = tmdb_override;
      else if (req.session && req.session.username && users[req.session.username] && users[req.session.username].settings && users[req.session.username].settings.tmdb_api_key) tmdbKey = users[req.session.username].settings.tmdb_api_key;
      else if (serverSettings && serverSettings.tmdb_api_key) tmdbKey = serverSettings.tmdb_api_key;
    } catch (e) { tmdbKey = null }
    const tvdbOverride = (tvdb_override_v4_api_key || tvdb_override_v4_user_pin)
      ? { v4ApiKey: tvdb_override_v4_api_key || '', v4UserPin: tvdb_override_v4_user_pin || null }
      : null;
    const data = await externalEnrich(key, tmdbKey, { username: req.session && req.session.username, tvdbOverride });
    // Use centralized renderer and updater so rendering logic is consistent
    try {
      if (data && data.title) {
        const providerRendered = renderProviderName(data, key, req.session);
        const providerBlock = { title: data.title, year: data.year, season: data.season, episode: data.episode, episodeTitle: data.episodeTitle || '', raw: data.raw || data, renderedName: providerRendered, matched: !!data.title };
        try { logMissingEpisodeTitleIfNeeded(key, providerBlock) } catch (e) {}
        updateEnrichCache(key, Object.assign({}, enrichCache[key] || {}, { provider: providerBlock, sourceId: 'provider', cachedAt: Date.now() }));
      } else {
        updateEnrichCache(key, Object.assign({}, { ...data, cachedAt: Date.now() }));
      }
    } catch (e) {
      updateEnrichCache(key, Object.assign({}, { ...data, cachedAt: Date.now() }));
    }
            // if provider returned authoritative title/parsedName, persist into parsedCache so subsequent scans use it
    try {
      if (data && data.title) {
        parsedCache[key] = parsedCache[key] || {}
        parsedCache[key].title = data.title
        parsedCache[key].parsedName = data.parsedName || parsedCache[key].parsedName
        parsedCache[key].season = data.season != null ? data.season : parsedCache[key].season
        parsedCache[key].episode = data.episode != null ? data.episode : parsedCache[key].episode
        parsedCache[key].timestamp = Date.now()
  try { if (db) db.setKV('parsedCache', parsedCache); else writeJson(parsedCacheFile, parsedCache); } catch (e) {}
      }
    } catch (e) {
      updateEnrichCache(key, Object.assign({}, enrichCache[key] || {}, data, { cachedAt: Date.now(), sourceId: 'provider' }));
    }
    res.json({ enrichment: enrichCache[key] });
  } catch (err) { appendLog(`ENRICH_FAIL path=${key} err=${err.message}`); res.status(500).json({ error: err.message }); }
});

// Hide a source item (mark hidden=true on the source canonical key)
app.post('/api/enrich/hide', requireAuth, async (req, res) => {
  try {
    const p = req.body && req.body.path ? req.body.path : null
    if (!p) return res.status(400).json({ error: 'path required' })
  const key = canonicalize(p)
  // Fast response path: update in-memory cache immediately so clients see instant hide
  try {
    updateEnrichCacheInMemory(key, Object.assign({}, enrichCache[key] || {}, { hidden: true }));
    // schedule a quick persist (debounced) so disk write is batched and fast
    schedulePersistEnrichCache(300);
  } catch (e) { appendLog(`HIDE_INMEM_FAIL path=${p} err=${e && e.message ? e.message : String(e)}`) }

  // respond immediately to the client so UI hides instantly
  res.json({ ok: true, path: key, enrichment: enrichCache[key] || null, modifiedScanIds: [] });

  // Background: remove this path from stored scan artifacts and record hide event
  (async () => {
    try {
      const modifiedScanIds = [];
      try {
        const scanIds = Object.keys(scans || {});
        for (const sid of scanIds) {
          try {
            const s = scans[sid];
            if (!s || !Array.isArray(s.items)) continue;
            const before = s.items.length;
            s.items = s.items.filter(it => {
              try { return canonicalize(it.canonicalPath) !== key } catch (e) { return true }
            });
            if (s.items.length !== before) {
              s.totalCount = s.items.length;
              modifiedScanIds.push(sid);
            }
          } catch (e) {}
        }
        // persist updated scans store if any modified
        if (modifiedScanIds.length) {
          try { if (db) db.saveScansObject(scans); else writeJson(scanStoreFile, scans); appendLog(`HIDE_UPDATED_SCANS path=${p} ids=${modifiedScanIds.join(',')}`) } catch (e) {}
        }
      } catch (e) {}

      appendLog(`HIDE path=${p}`)
      try {
        // Record hide event for clients to poll and reconcile UI
        hideEvents.push({ ts: Date.now(), path: key, originalPath: p, modifiedScanIds });
        try { if (db) db.setHideEvents(hideEvents); } catch (e) {}
        // keep recent events bounded
        if (hideEvents.length > 200) hideEvents.splice(0, hideEvents.length - 200);
      } catch (e) {}
    } catch (e) {
      appendLog(`HIDE_BG_FAIL path=${p} err=${e && e.message ? e.message : String(e)}`)
    }
  })();
  } catch (e) { return res.status(500).json({ error: e.message }) }
})

// Admin-only: Sweep enrich cache and remove entries whose source files no longer exist.
// This performs an atomic purge of stale cache entries and cleans up renderedIndex mappings
// that reference the removed source paths. Returns a summary of removals.
app.post('/api/enrich/sweep', requireAuth, requireAdmin, (req, res) => {
  try {
    const removed = [];
    const keys = Object.keys(enrichCache || {});
    for (const k of keys) {
      try {
        if (!k) continue;
        // if the file no longer exists on disk, remove from cache
        if (!fs.existsSync(k)) {
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
    appendLog(`ENRICH_SWEEP removed=${removed.length}`);
    return res.json({ ok: true, removedCount: removed.length, removed });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});
// Force-refresh metadata for all items in a completed scan (server-side enrichment)
app.post('/api/scan/:scanId/refresh', requireAuth, async (req, res) => {
  const s = scans[req.params.scanId];
  if (!s) return res.status(404).json({ error: 'scan not found' });
  const username = req.session && req.session.username;
  appendLog(`REFRESH_SCAN_REQUEST scan=${req.params.scanId} by=${username}`);
  // Prevent concurrent refreshes for the same scanId
  const refreshLockKey = `refreshScan:${req.params.scanId}`;
  if (activeScans.has(refreshLockKey)) {
    appendLog(`SCAN_CONFLICT refresh=${req.params.scanId}`);
    return res.status(409).json({ error: 'refresh already in progress for this scan' });
  }
  activeScans.add(refreshLockKey);
  appendLog(`SCAN_LOCK_ACQUIRED refresh=${req.params.scanId}`);
  // pick tmdb key if available
  const { tmdb_api_key: tmdb_override } = req.body || {};
  let tmdbKey = null
  try {
    if (tmdb_override) tmdbKey = tmdb_override;
    else if (username && users[username] && users[username].settings && users[username].settings.tmdb_api_key) tmdbKey = users[username].settings.tmdb_api_key;
    else if (serverSettings && serverSettings.tmdb_api_key) tmdbKey = serverSettings.tmdb_api_key;
  } catch (e) { tmdbKey = null }
  // launch refresh work in background and return immediately to avoid upstream timeouts
  // lightweight in-memory progress tracking for UI polling
  const refreshProgressKey = refreshLockKey; // reuse lock key as progress key
  refreshProgress[refreshProgressKey] = { processed: 0, total: s.items ? s.items.length : 0, lastUpdated: Date.now(), status: 'running' };

  const backgroundRun = async () => {
    const results = [];
    try {
      for (const it of s.items) {
        try {
          const key = canonicalize(it.canonicalPath);
          let lookup = null;
          let lookupError = null;
          try {
            doProcessParsedItem(it, req.session);
          } catch (parseErr) {
            try { appendLog(`REFRESH_ITEM_PARSE_FAIL path=${key} err=${parseErr && parseErr.message ? parseErr.message : String(parseErr)}`); } catch (logErr) {}
          }
          const entryAfterParse = enrichCache[key] || null;
          const fallbackProvider = entryAfterParse && entryAfterParse.provider ? Object.assign({}, entryAfterParse.provider) : null;
          const fallbackParsed = entryAfterParse && entryAfterParse.parsed ? Object.assign({}, entryAfterParse.parsed) : null;
          try { appendLog(`REFRESH_ITEM_FORCE_LOOKUP path=${key}`); } catch (e) {}
          try {
            lookup = await externalEnrich(key, tmdbKey, { username, force: true });
          } catch (err) {
            lookupError = err;
            try { appendLog(`REFRESH_ITEM_LOOKUP_ERR path=${key} err=${err && err.message ? err.message : String(err)}`); } catch (logErr) {}
          }
          if (!lookup && fallbackProvider) {
            const providerClone = Object.assign({}, fallbackProvider);
            lookup = {
              title: providerClone.title,
              year: providerClone.year,
              season: providerClone.season,
              episode: providerClone.episode,
              episodeTitle: providerClone.episodeTitle || '',
              provider: providerClone,
              raw: providerClone.raw || null,
              parsedName: (fallbackParsed && (fallbackParsed.parsedName || fallbackParsed.title)) || providerClone.renderedName || null
            };
          }
          if (!lookup && fallbackParsed) {
            lookup = {
              title: fallbackParsed.title || null,
              season: fallbackParsed.season,
              episode: fallbackParsed.episode,
              episodeRange: fallbackParsed.episodeRange,
              parsedName: fallbackParsed.parsedName || fallbackParsed.title || null
            };
          }
          try {
            if (lookup && lookup.title) {
              if (lookup.provider) {
                const providerRendered = renderProviderName(lookup, key, req.session);
                const providerBlock = {
                  title: lookup.title,
                  year: lookup.year,
                  season: lookup.season,
                  episode: lookup.episode,
                  episodeTitle: lookup.episodeTitle || '',
                  raw: (lookup.provider && lookup.provider.raw) || lookup.raw || lookup.provider,
                  renderedName: providerRendered || (lookup.provider && lookup.provider.renderedName) || '',
                  matched: lookup.provider && typeof lookup.provider.matched !== 'undefined' ? lookup.provider.matched : !!lookup.title
                };
                try { logMissingEpisodeTitleIfNeeded(key, providerBlock) } catch (e) {}
                updateEnrichCache(key, Object.assign({}, enrichCache[key] || {}, { provider: providerBlock, sourceId: 'provider', cachedAt: Date.now() }));
              } else {
                updateEnrichCache(key, Object.assign({}, { ...lookup, cachedAt: Date.now() }));
              }
            } else if (lookup) {
              updateEnrichCache(key, Object.assign({}, { ...lookup, cachedAt: Date.now() }));
            } else if (fallbackProvider) {
              updateEnrichCache(key, Object.assign({}, enrichCache[key] || {}, { provider: fallbackProvider, sourceId: 'provider', cachedAt: Date.now() }));
            }
          } catch (e) {
            if (lookup) {
              updateEnrichCache(key, Object.assign({}, { ...lookup, cachedAt: Date.now() }));
            } else if (fallbackProvider) {
              updateEnrichCache(key, Object.assign({}, enrichCache[key] || {}, { provider: fallbackProvider, sourceId: 'provider', cachedAt: Date.now() }));
            }
          }
          const resolvedTitle = (lookup && lookup.title) || (fallbackProvider && fallbackProvider.title) || (fallbackParsed && fallbackParsed.title) || null;
          const resolvedParsedName = (lookup && lookup.parsedName) || (fallbackParsed && fallbackParsed.parsedName) || null;
          if (lookup || fallbackProvider || fallbackParsed) {
            results.push({ path: key, ok: true, parsedName: resolvedParsedName, title: resolvedTitle });
            try { appendLog(`REFRESH_ITEM_OK path=${key} parsedName=${resolvedParsedName || ''}`); } catch (e) {}
          } else {
            results.push({ path: key, ok: false, error: lookupError && lookupError.message ? lookupError.message : 'lookup failed' });
          }
          // update progress
          try { if (refreshProgress[refreshProgressKey]) { refreshProgress[refreshProgressKey].processed += 1; refreshProgress[refreshProgressKey].lastUpdated = Date.now(); } } catch(e){}
        } catch (err) {
          try { appendLog(`REFRESH_ITEM_FAIL path=${it.canonicalPath} err=${err && err.message ? err.message : String(err)}`); } catch (e) {}
          try { appendLog(`REFRESH_ITEM_FAIL_STACK path=${it.canonicalPath} stack=${err && err.stack ? err.stack.replace(/\n/g,' | ') : ''}`); } catch (e) {}
          results.push({ path: it.canonicalPath, ok: false, error: err && err.message ? err.message : String(err) });
          // update progress even on fail
          try { if (refreshProgress[refreshProgressKey]) { refreshProgress[refreshProgressKey].processed += 1; refreshProgress[refreshProgressKey].lastUpdated = Date.now(); } } catch(e){}
        }
      }
      try { if (db) db.setKV('enrichCache', enrichCache); else writeJson(enrichStoreFile, enrichCache); } catch (e) {}
      try { if (db) db.setKV('parsedCache', parsedCache); else writeJson(parsedCacheFile, parsedCache); } catch (e) {}
      appendLog(`REFRESH_SCAN_COMPLETE scan=${req.params.scanId} items=${results.length}`);
      // Ensure stored scan artifacts reflect applied/hidden flags updated during refresh
      try {
        const modified = [];
        const sids = Object.keys(scans || {});
        for (const sid of sids) {
          try {
            const s = scans[sid];
            if (!s || !Array.isArray(s.items)) continue;
            const before = s.items.length;
            s.items = s.items.map(it => (it && it.canonicalPath) ? Object.assign({}, it) : it).filter(it => {
              try {
                const k = canonicalize(it.canonicalPath);
                const e = enrichCache[k] || null;
                if (e && (e.hidden || e.applied)) return false;
                try { it.enrichment = enrichCache[k] || null } catch (ee) { it.enrichment = null }
                return true
              } catch (e) { return true }
            });
            if (s.items.length !== before) {
              s.totalCount = s.items.length;
              modified.push(sid);
            } else {
              let anySnapshot = false
              for (const it of s.items) {
                try { if (it && it.enrichment) { anySnapshot = true; break } } catch (e) {}
              }
              if (anySnapshot) modified.push(sid)
            }
          } catch (e) {}
        }
        if (modified.length) {
          try { if (db) db.saveScansObject(scans); else writeJson(scanStoreFile, scans); appendLog(`POST_REFRESH_SCANS_UPDATED ids=${modified.join(',')}`) } catch (e) {}
        }
        // Notify clients that scans were updated by refresh so UI can reconcile
        try {
          if (modified && modified.length && Array.isArray(hideEvents)) {
            const evt = { ts: Date.now(), path: req.params && req.params.scanId ? `scan:${req.params.scanId}` : null, originalPath: null, modifiedScanIds: modified.map(String) };
            hideEvents.push(evt);
            try { if (db) db.setHideEvents(hideEvents); } catch (e) {}
            // keep recent events bounded
            if (hideEvents.length > 200) hideEvents.splice(0, hideEvents.length - 200);
            appendLog(`HIDE_EVENTS_PUSH_BY_REFRESH ids=${modified.join(',')}`);
          }
        } catch (e) {}
      } catch (e) {}
      // mark progress as complete
      try { if (refreshProgress[refreshProgressKey]) { refreshProgress[refreshProgressKey].status = 'complete'; refreshProgress[refreshProgressKey].lastUpdated = Date.now(); } } catch(e){}
      try { const removed2 = sweepEnrichCache(); if (removed2 && removed2.length) appendLog(`AUTOSWEEP_AFTER_REFRESH removed=${removed2.length}`); } catch (e) {}
    } catch (e) {
      try { appendLog(`REFRESH_SCAN_FAIL scan=${req.params.scanId} err=${e && e.message ? e.message : String(e)}`); } catch (ee) {}
      try { appendLog(`REFRESH_SCAN_FAIL_STACK scan=${req.params.scanId} stack=${e && e.stack ? e.stack.replace(/\n/g,' | ') : ''}`); } catch (ee) {}
      // mark progress as failed
      try { if (refreshProgress[refreshProgressKey]) { refreshProgress[refreshProgressKey].status = 'failed'; refreshProgress[refreshProgressKey].lastUpdated = Date.now(); } } catch(e){}
    } finally {
      try { activeScans.delete(refreshLockKey); appendLog(`SCAN_LOCK_RELEASED refresh=${req.params.scanId}`); } catch (ee) {}
      // clear progress entry after a short delay to allow client to read final state
      try { setTimeout(() => { try { delete refreshProgress[refreshProgressKey]; } catch(e){} }, 30*1000) } catch(e){}
    }
  }

  // start background work without awaiting so we return promptly to clients (prevents Cloudflare 504)
  void backgroundRun();
  // respond immediately to caller indicating background processing has started
  return res.status(202).json({ ok: true, background: true, message: 'refresh started' });
});

// Debug enrich: return cached enrichment and what externalEnrich would produce now
app.get('/api/enrich/debug', async (req, res) => { const p = req.query.path || ''; const key = canonicalize(p); const cached = enrichCache[key] || null; // pick tmdb key if available (use server setting only for debug)
  const tmdbKey = serverSettings && serverSettings.tmdb_api_key ? serverSettings.tmdb_api_key : null;
  let forced = null;
  try {
  forced = await externalEnrich(key, tmdbKey, { username: null });
  } catch (e) { forced = { error: e.message } }
  res.json({ key, cached, forced });
});

// Debug: return in-memory locks and last-modified times for key data files
app.get('/api/debug/locks', requireAuth, (req, res) => {
  try {
    const locks = Array.from(activeScans || []);
    const statFor = (p) => {
      try { const s = fs.statSync(p); return { exists: true, mtime: s.mtimeMs, size: s.size } } catch (e) { return { exists: false } }
    }
    const files = {
      enrichStoreFile: statFor(enrichStoreFile),
      parsedCacheFile: statFor(parsedCacheFile),
      renderedIndexFile: statFor(renderedIndexFile),
      scansFile: statFor(scansFile)
    }
    return res.json({ locks, files });
  } catch (e) { return res.status(500).json({ error: e && e.message ? e.message : String(e) }) }
})

// Client-side confirmation that it refreshed scans/items after a server-side change.
// This is best-effort and used for diagnostic logging only.
app.post('/api/debug/client-refreshed', requireAuth, (req, res) => {
  try {
    const info = req.body || {}
    const path = info.path || null
    const scanId = info.scanId || null
    if (path) appendLog(`CLIENT_REFRESHED path=${path}`)
    if (scanId) appendLog(`CLIENT_REFRESHED_SCAN id=${scanId}`)

    // Previously this endpoint attempted to correlate recent hide events and emit
    // reconciliation logs. That noisy behavior is disabled so the client simply
    // acknowledges the refresh without generating additional events or log spam.

    return res.json({ ok: true })
  } catch (e) { return res.status(500).json({ error: e && e.message ? e.message : String(e) }) }
})

// Lightweight health check for probes
app.get('/api/_health', (req, res) => {
  try {
    const lastHide = (Array.isArray(hideEvents) && hideEvents.length) ? hideEvents[hideEvents.length - 1].ts : null
    const logStat = fs.existsSync(logsFile) ? fs.statSync(logsFile) : null
    return res.json({ ok: true, lastHideEventTs: lastHide, logsSize: logStat ? logStat.size : 0 })
  } catch (e) { return res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) }) }
})

// Clients can poll this endpoint to receive recent hide events and reconcile UI.
// Query param: since (timestamp in ms) to receive events occurring after that timestamp.
// Use a light per-client cache to avoid log spam when clients poll frequently with the same since value.
const hideEventsClientCache = new Map(); // key -> { ts, resp, lastHit }
const HIDE_EVENTS_CACHE_WINDOW_MS = 5000; // 5 seconds - slightly larger to tolerate aggressive polling

app.get('/api/enrich/hide-events', requireAuth, (req, res) => {
  try {
    const since = parseInt(req.query.since || '0', 10) || 0
    const uname = req.session && req.session.username ? String(req.session.username) : '<anon>'
    const clientIp = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown'
    const clientKey = `${clientIp}|${uname}`

    const now = Date.now()
    try {
      const cached = hideEventsClientCache.get(clientKey)
      if (cached && cached.ts === since && (now - cached.lastHit) < HIDE_EVENTS_CACHE_WINDOW_MS) {
        // refresh lastHit and return cached response to avoid duplicate logs
        cached.lastHit = now
        return res.json(cached.resp)
      }
    } catch (e) { /* non-fatal cache read failure: continue */ }

    // Fast-path: if client asks since=0 and we have no recent hide events, return immediately
    // This avoids heavy logging and work when a misbehaving client polls aggressively with since=0
    try {
      if ((since === 0) && (!Array.isArray(hideEvents) || hideEvents.length === 0)) {
        const resp = { ok: true, events: [] }
        try { hideEventsClientCache.set(clientKey, { ts: since, resp, lastHit: now }) } catch (e) {}
        return res.json(resp)
      }
    } catch (e) { /* continue to normal path */ }

    try { appendLog(`HIDE_EVENTS_REQ user=${uname} since=${since} hideEventsLen=${Array.isArray(hideEvents) ? hideEvents.length : 'na'}`) } catch (e) {}

    // defensive: ensure hideEvents is an array
    const he = Array.isArray(hideEvents) ? hideEvents : []
    const ev = he.filter(e => (e && e.ts && e.ts > since))
    const resp = { ok: true, events: ev || [] }

    try { appendLog(`HIDE_EVENTS_RESP user=${uname} since=${since} matched=${(ev && ev.length) || 0}`) } catch (e) {}

    try { hideEventsClientCache.set(clientKey, { ts: since, resp, lastHit: now }) } catch (e) {}
    return res.json(resp)
  } catch (e) {
    try { appendLog(`HIDE_EVENTS_ERR err=${e && e.message ? e.message : String(e)}`) } catch (ee) {}
    try { console.error('hide-events failed', e && e.message ? e.message : e) } catch (ee) {}
    return res.status(500).json({ error: e && e.message ? e.message : String(e) })
  }
})

// Progress endpoint for long-running scan refreshes
app.get('/api/scan/:scanId/progress', requireAuth, (req, res) => {
  try {
    const key = `refreshScan:${req.params.scanId}`;
    const p = refreshProgress[key] || null;
    if (!p) return res.json({ ok: false, message: 'no progress', progress: null });
    return res.json({ ok: true, progress: { processed: p.processed, total: p.total, status: p.status, lastUpdated: p.lastUpdated } });
  } catch (e) { return res.status(500).json({ error: e && e.message ? e.message : String(e) }) }
})

// Rename preview (generate plan)
app.post('/api/rename/preview', (req, res) => {
  const { items, template, outputPath } = req.body || {};
  if (!items || !Array.isArray(items)) return res.status(400).json({ error: 'items required' });
  // resolve effective output path: request overrides per-user setting -> server setting
  let effectiveOutput = '';
  try {
    if (outputPath) {
      effectiveOutput = outputPath;
    } else {
      const username = req.session && req.session.username;
      if (username && users[username] && users[username].settings && users[username].settings.scan_output_path) {
        effectiveOutput = users[username].settings.scan_output_path;
      } else if (serverSettings && serverSettings.scan_output_path) {
        effectiveOutput = serverSettings.scan_output_path;
      } else {
        effectiveOutput = '';
      }
    }
    if (effectiveOutput) effectiveOutput = canonicalize(effectiveOutput);
  } catch (e) {
    effectiveOutput = outputPath || (serverSettings && serverSettings.scan_output_path) || '';
  }
  try { appendLog(`PREVIEW_EFFECTIVE_OUTPUT user=${req.session && req.session.username ? req.session.username : ''} effectiveOutput=${effectiveOutput || ''}`); } catch (e) {}
  const plans = items.map(it => {
    const fromPath = canonicalize(it.canonicalPath);
    const key = fromPath;
    const meta = enrichCache[fromPath] || {};
  // prefer enrichment title (provider token) -> parsed/title/basename
  const rawTitle = (meta && (meta.title || (meta.extraGuess && meta.extraGuess.title))) ? (meta.title || (meta.extraGuess && meta.extraGuess.title)) : path.basename(fromPath, path.extname(fromPath));
  // Only use explicit year from enrichment or extraGuess; do not fall back to filename heuristics here
  const year = (meta && (meta.year || (meta.extraGuess && meta.extraGuess.year))) ? (meta.year || (meta.extraGuess && meta.extraGuess.year)) : '';
    const ext = path.extname(fromPath);
  // support {year} token in template; choose effective template in order: request -> user setting -> server setting -> default
  const userTemplate = (req && req.session && req.session.username && users[req.session.username] && users[req.session.username].settings && users[req.session.username].settings.rename_template) ? users[req.session.username].settings.rename_template : null;
  const baseNameTemplate = template || userTemplate || serverSettings.rename_template || '{title}';
    // compute epLabel from enrichment metadata
    function pad(n){ return String(n).padStart(2,'0') }
    let epLabel = ''
    if (meta && meta.episodeRange) {
      epLabel = meta.season != null ? `S${pad(meta.season)}E${meta.episodeRange}` : `E${meta.episodeRange}`
    } else if (meta && meta.episode != null) {
      epLabel = meta.season != null ? `S${pad(meta.season)}E${pad(meta.episode)}` : `E${pad(meta.episode)}`
    }
  const episodeTitleToken = (meta && (meta.episodeTitle || (meta.extraGuess && meta.extraGuess.episodeTitle))) ? (meta.episodeTitle || (meta.extraGuess && meta.extraGuess.episodeTitle)) : '';

  // Support extra template tokens: {season}, {episode}, {episodeRange}, {tmdbId}
  const seasonToken = (meta && meta.season != null) ? String(meta.season) : '';
  const episodeToken = (meta && meta.episode != null) ? String(meta.episode) : '';
  const episodeRangeToken = (meta && meta.episodeRange) ? String(meta.episodeRange) : '';
  const tmdbIdToken = (meta && meta.tmdb && meta.tmdb.raw && (meta.tmdb.raw.id || meta.tmdb.raw.seriesId)) ? String(meta.tmdb.raw.id || meta.tmdb.raw.seriesId) : '';

  const episodeTitleTokenFromMeta = (meta && (meta.episodeTitle || (meta.extraGuess && meta.extraGuess.episodeTitle))) ? (meta.episodeTitle || (meta.extraGuess && meta.extraGuess.episodeTitle)) : '';
  const resolvedSeriesTitle = resolveSeriesTitle(meta, rawTitle, fromPath, episodeTitleTokenFromMeta, { preferExact: true });
  const englishSeriesTitle = extractEnglishSeriesTitle(meta);
  const renderBaseTitle = englishSeriesTitle || resolvedSeriesTitle || rawTitle;
  const title = cleanTitleForRender(renderBaseTitle, (meta && meta.episode != null) ? (meta.season != null ? `S${String(meta.season).padStart(2,'0')}E${String(meta.episode).padStart(2,'0')}` : `E${String(meta.episode).padStart(2,'0')}`) : '', episodeTitleTokenFromMeta);
  const isMovie = determineIsMovie(meta);
  const effectiveYear = (isMovie && year) ? year : '';
  const folderBaseTitle = renderBaseTitle || title;
  if (englishSeriesTitle || typeof isMovie === 'boolean') {
    try {
      const currentEnglish = meta && meta.seriesTitleEnglish ? String(meta.seriesTitleEnglish).trim() : null;
      const needsEnglishUpdate = !currentEnglish || currentEnglish !== englishSeriesTitle;
  const currentMovieFlag = (meta && typeof meta.isMovie === 'boolean') ? meta.isMovie : ((meta && meta.extraGuess && typeof meta.extraGuess.isMovie === 'boolean') ? meta.extraGuess.isMovie : null);
      const needsMovieUpdate = typeof isMovie === 'boolean' && currentMovieFlag !== isMovie;
      if (needsEnglishUpdate || needsMovieUpdate) {
        const updatedExtra = meta && meta.extraGuess && typeof meta.extraGuess === 'object' ? Object.assign({}, meta.extraGuess) : {};
  if (typeof isMovie === 'boolean') updatedExtra.isMovie = isMovie;
        const cacheUpdate = Object.assign({}, meta, {
          seriesTitleEnglish: englishSeriesTitle || currentEnglish || null,
          seriesTitle: englishSeriesTitle || meta.seriesTitle || null,
          seriesTitleExact: englishSeriesTitle || meta.seriesTitleExact || null,
          isMovie: (typeof isMovie === 'boolean') ? isMovie : (typeof currentMovieFlag === 'boolean' ? currentMovieFlag : meta && meta.isMovie),
          extraGuess: updatedExtra,
        });
        updateEnrichCacheInMemory(fromPath, cacheUpdate);
        schedulePersistEnrichCache(400);
      }
    } catch (e) { /* best-effort cache update */ }
  }
  let baseFolderName = String(folderBaseTitle || resolvedSeriesTitle || title || rawTitle || '').trim();
  if (!baseFolderName) baseFolderName = path.basename(fromPath, path.extname(fromPath)) || rawTitle || title;
  let sanitizedBaseFolder = sanitize(baseFolderName);
  if (!sanitizedBaseFolder) sanitizedBaseFolder = sanitize(title) || sanitize(rawTitle) || 'Untitled';
  const titleFolder = effectiveYear ? `${sanitizedBaseFolder} (${effectiveYear})` : sanitizedBaseFolder;
  const seasonFolder = (!isMovie && meta && meta.season != null) ? `Season ${String(meta.season).padStart(2,'0')}` : '';
  const folder = seasonFolder ? path.join(effectiveOutput, titleFolder, seasonFolder) : path.join(effectiveOutput, titleFolder);

  // Render template with preferência to enrichment-provided tokens.
  // If the provider returned a renderedName (TMDb), prefer that exact rendered string for preview.
  let nameWithoutExtRaw;
  if (meta && meta.provider && meta.provider.renderedName) {
    // strip any extension the provider might include and use the provider-rendered name verbatim
    nameWithoutExtRaw = String(meta.provider.renderedName).replace(/\.[^/.]+$/, '');
  } else {
    nameWithoutExtRaw = baseNameTemplate
  .replace('{title}', sanitize(title))
      .replace('{basename}', sanitize(path.basename(key, path.extname(key))))
  .replace('{year}', effectiveYear || '')
      .replace('{epLabel}', sanitize(epLabel))
      .replace('{episodeTitle}', sanitize(episodeTitleToken))
      .replace('{season}', sanitize(seasonToken))
      .replace('{episode}', sanitize(episodeToken))
      .replace('{episodeRange}', sanitize(episodeRangeToken))
  .replace('{tmdbId}', sanitize(tmdbIdToken));
  }
    // Clean up common artifact patterns from empty tokens: stray parentheses, repeated separators
    const nameWithoutExt = String(nameWithoutExtRaw)
      .replace(/\s*\(\s*\)\s*/g, '')
      .replace(/\s*\-\s*(?:\-\s*)+/g, ' - ')
      .replace(/(^\s*-\s*)|(\s*-\s*$)/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    const fileName = (nameWithoutExt + ext).trim();
    // If an output path is configured, plan a hardlink under that path preserving a Jellyfin-friendly layout
    let toPath;
    if (effectiveOutput) {
      let finalFileName = nameWithoutExt;
      finalFileName = (finalFileName + ext).replace(/\\/g, '/');
      toPath = path.join(folder, finalFileName).replace(/\\/g, '/');
    } else {
      toPath = path.join(path.dirname(fromPath), fileName).replace(/\\/g, '/');
    }
    const action = effectiveOutput ? 'hardlink' : (fromPath === toPath ? 'noop' : 'move');
  return { itemId: it.id, fromPath, toPath, actions: [{ op: action }], templateUsed: baseNameTemplate };
  });
  res.json({ plans });
});

function sanitize(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, '');
}

// Remove trailing year in parentheses, e.g. "Show (2022)" -> "Show"
function stripTrailingYear(s) {
  try {
    return String(s || '').replace(/\s*\(\s*\d{4}\s*\)\s*$/, '').trim();
  } catch (e) { return String(s || '').trim(); }
}

function isEpisodeTokenCandidate(value) {
  if (!value) return false;
  const str = String(value);
  if (/\bS\d{1,2}([EPp]\d{1,3})?\b/i.test(str)) return true;
  if (/\b\d{1,2}x\d{1,3}\b/i.test(str)) return true;
  if (/\bE\.?\d{1,3}\b/i.test(str)) return true;
  if (/episode/i.test(str)) return true;
  if (/^\d{1,3}$/.test(str.trim())) return true;
  return false;
}

function isNoiseLike(value) {
  if (!value) return false;
  const t = String(value).toLowerCase();
  const noise = ['1080p', '720p', '2160p', '4k', 'x264', 'x265', 'bluray', 'bdrip', 'webrip', 'web-dl', 'hdtv', 'dvdr', 'bdr', '10bit', '8bit', 'bit', 'bits'];
  if (/(19|20)\d{2}/.test(t)) return true;
  for (const n of noise) {
    if (t.indexOf(n) !== -1) return true;
  }
  return false;
}

function isSeasonFolderToken(value) {
  if (!value) return false;
  const norm = String(value).replace(/[\._\-]+/g, ' ').trim().toLowerCase();
  if (!norm) return false;
  if (/^(season|seasons|series)\s*\d{1,2}$/.test(norm)) return true;
  if (/^(season|series)\s*\d{1,2}\b/.test(norm) && norm.split(/\s+/).length <= 3) return true;
  if (/^s0*\d{1,2}$/.test(norm)) return true;
  return false;
}

function looksLikeEpisodeTitleCandidate(title, episodeTitle) {
  const candidate = String(title || '').trim();
  if (!candidate) return false;
  if (isEpisodeTokenCandidate(candidate)) return true;
  if (/\bS\d{1,2}[EPp]?\d{1,3}\b/i.test(candidate)) return true;
  if (/\b\d{1,2}x\d{1,3}\b/i.test(candidate)) return true;
  if (/^episode\s*\d+/i.test(candidate)) return true;
  if (/^part\s*\d+/i.test(candidate)) return true;
  if (candidate.length <= 2 && /\d/.test(candidate)) return true;
  if (episodeTitle) {
    const epNorm = String(episodeTitle).replace(/[^a-z0-9]/ig, '').toLowerCase();
    if (epNorm) {
      const candNorm = candidate.replace(/[^a-z0-9]/ig, '').toLowerCase();
      if (candNorm && candNorm === epNorm) return true;
    }
    const epTrim = String(episodeTitle).trim();
    if (epTrim) {
      try {
        const suffixRe = new RegExp(`(?:[\-–—:\s]+)?${escapeRegExp(epTrim)}$`, 'i');
        if (suffixRe.test(candidate)) return true;
      } catch (e) { /* ignore regex issues */ }
    }
  }
  return false;
}

function pickSeriesTitleFromCandidates(candidates, episodeTitle) {
  if (!Array.isArray(candidates)) return '';
  const seen = new Set();
  for (const cand of candidates) {
    const value = String(cand || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
  if (isSeasonFolderToken(value)) continue;
  if (looksLikeEpisodeTitleCandidate(value, episodeTitle)) continue;
    return value;
  }
  for (const cand of candidates) {
    const value = String(cand || '').trim();
    if (value) return value;
  }
  return '';
}

function extractEnglishSeriesTitle(meta) {
  try {
    const seen = new Set();
    const out = [];
    const push = (value) => {
      if (!value) return;
      const trimmed = String(value).trim();
      if (!trimmed) return;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(trimmed);
    };
    if (meta && typeof meta === 'object') {
      push(meta.seriesTitleEnglish);
      if (meta.extraGuess) {
        push(meta.extraGuess.seriesTitleEnglish);
      }
      if (meta.provider) {
        push(meta.provider.seriesTitleEnglish);
        push(meta.provider.titleEnglish);
        if (meta.provider.raw && typeof meta.provider.raw === 'object') {
          const rawTitle = meta.provider.raw.title;
          if (rawTitle && typeof rawTitle === 'object') {
            for (const key of Object.keys(rawTitle)) {
              if (key && key.toLowerCase().indexOf('english') !== -1) push(rawTitle[key]);
            }
          }
        }
      }
      const nestedTitleSources = [];
      if (meta.raw && typeof meta.raw === 'object') nestedTitleSources.push(meta.raw.title);
      if (meta.extraGuess && meta.extraGuess.provider && meta.extraGuess.provider.raw && typeof meta.extraGuess.provider.raw === 'object') {
        nestedTitleSources.push(meta.extraGuess.provider.raw.title);
      }
      for (const block of nestedTitleSources) {
        if (!block || typeof block !== 'object') continue;
        for (const key of Object.keys(block)) {
          if (key && key.toLowerCase().indexOf('english') !== -1) push(block[key]);
        }
      }
      if (meta.provider && meta.provider.renderedName) {
        let rendered = String(meta.provider.renderedName || '').replace(/\.[^/.]+$/, '');
        const dashSplit = rendered.split(/\s+-\s+S\d{1,2}/i);
        if (dashSplit.length > 1) rendered = dashSplit[0];
        rendered = rendered.replace(/\s+\(Season\s+\d{1,2}\)$/i, '').trim();
        if (rendered) push(rendered);
      }
      if (meta.title && typeof meta.title === 'string') {
        push(meta.title);
      }
      if (meta.extraGuess && meta.extraGuess.titleEnglish) push(meta.extraGuess.titleEnglish);
    }
    return out.length ? out[0] : null;
  } catch (e) {
    return null;
  }
}

function resolveSeriesTitle(meta, fallbackTitle, fromPath, episodeTitleOverride, options = {}) {
  try {
    const englishPreferred = extractEnglishSeriesTitle(meta);
    const episodeTitle = String(episodeTitleOverride || (meta && (meta.episodeTitle || (meta.extraGuess && meta.extraGuess.episodeTitle))) || '').trim();
    const candidates = [];
    const seen = new Set();
    const push = (value) => {
      if (!value) return;
      const trimmed = String(value).trim();
      if (!trimmed) return;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(trimmed);
    };
    const preferExact = options && options.preferExact;
    if (preferExact && englishPreferred) return englishPreferred;
    if (preferExact && meta) {
      const exacts = [];
      if (englishPreferred) exacts.push(englishPreferred);
      const pushExact = (value) => {
        const trimmed = String(value || '').trim();
        if (trimmed) exacts.push(trimmed);
      };
      pushExact(meta.seriesTitleExact);
      pushExact(meta.originalSeriesTitle);
      if (meta.extraGuess) {
        pushExact(meta.extraGuess.seriesTitleExact);
        pushExact(meta.extraGuess.originalSeriesTitle);
      }
      if (exacts.length) return exacts[0];
    }
    if (meta) {
      push(meta.seriesTitleExact);
      push(meta.seriesTitle);
      push(meta.title);
      push(meta.parentCandidate);
      push(meta.seriesLookupTitle);
      push(meta.originalSeriesTitle);
      if (meta.parsed && meta.parsed.title) push(meta.parsed.title);
      if (meta.extraGuess) {
        push(meta.extraGuess.seriesTitleExact);
        push(meta.extraGuess.seriesTitle);
        push(meta.extraGuess.title);
        push(meta.extraGuess.parentCandidate);
        push(meta.extraGuess.seriesLookupTitle);
        push(meta.extraGuess.parsedName);
        push(meta.extraGuess.seriesTitleEnglish);
      }
      if (meta.provider) {
        push(meta.provider.title);
        push(meta.provider.seriesTitle);
        push(meta.provider.name);
        push(meta.provider.seriesTitleEnglish);
        push(meta.provider.titleEnglish);
      }
      if (meta.raw) {
        push(meta.raw.title);
        push(meta.raw.name);
      }
    }
    push(englishPreferred);
    push(fallbackTitle);
    if (fromPath) {
      try {
        const parentDir = path.dirname(fromPath);
        const parentBase = parentDir ? path.basename(parentDir) : '';
        if (parentBase) {
          try {
            const parseFilename = require('./lib/filename-parser');
            const parsedParent = parseFilename(parentBase);
            if (parsedParent && parsedParent.title) push(parsedParent.title);
          } catch (e) { /* ignore parse errors */ }
          push(parentBase.replace(/[\._]/g, ' '));
        }
      } catch (e) { /* ignore */ }
    }
    const chosen = pickSeriesTitleFromCandidates(candidates, episodeTitle);
    if (chosen) return chosen;
    if (candidates.length) return candidates[0];
    return String(fallbackTitle || '').trim();
  } catch (e) {
    return String(fallbackTitle || '').trim();
  }
}

// Preserve applied/hidden and related metadata when overwriting enrichCache entries
function preserveAppliedFlags(prev, next) {
  try {
    prev = prev || {};
    next = next || {};
    if (prev.applied) next.applied = prev.applied;
    if (prev.hidden) next.hidden = prev.hidden;
    if (typeof prev.appliedAt !== 'undefined') next.appliedAt = prev.appliedAt;
    if (typeof prev.appliedTo !== 'undefined') next.appliedTo = prev.appliedTo;
    if (typeof prev.metadataFilename !== 'undefined') next.metadataFilename = prev.metadataFilename;
    if (typeof prev.renderedName !== 'undefined') next.renderedName = prev.renderedName;
    return next;
  } catch (e) { return next; }
}

// Centralized update helper: always preserve applied/hidden flags, normalize entry, and persist
function updateEnrichCache(key, nextObj) {
  try {
    const prev = enrichCache[key] || {};
    // merge with prev to keep any existing fields, then allow preserveAppliedFlags to copy applied/hidden
    const merged = Object.assign({}, prev, nextObj || {});
    if (merged && merged.provider && merged.provider.matched) {
      delete merged.providerFailure;
    }
    if (typeof merged.providerFailure !== 'undefined' && merged.providerFailure === null) {
      delete merged.providerFailure;
    }
    const normalized = normalizeEnrichEntry(merged);
    enrichCache[key] = preserveAppliedFlags(prev, normalized);
  try { if (db) db.setKV('enrichCache', enrichCache); else writeJson(enrichStoreFile, enrichCache); } catch (e) { /* best-effort persist */ }
    return enrichCache[key];
  } catch (e) {
    return nextObj;
  }
}

// Fast path updater: update in-memory enrichCache and debounce disk persistence.
let _enrichPersistTimeout = null;
function persistEnrichCacheNow() {
  try {
    if (db) db.setKV('enrichCache', enrichCache);
    else writeJson(enrichStoreFile, enrichCache);
  } catch (e) { /* best-effort */ }
  try { if (_enrichPersistTimeout) { clearTimeout(_enrichPersistTimeout); _enrichPersistTimeout = null; } } catch (e) {}
}

function schedulePersistEnrichCache(delayMs = 500) {
  try {
    if (_enrichPersistTimeout) clearTimeout(_enrichPersistTimeout);
    _enrichPersistTimeout = setTimeout(() => { try { persistEnrichCacheNow(); } catch (e) {} }, delayMs);
  } catch (e) { try { persistEnrichCacheNow(); } catch (ee) {} }
}

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
    return enrichCache[key];
  } catch (e) { return nextObj; }
}

function recordProviderFailure(key, info = {}) {
  try {
    const prev = enrichCache[key] || {};
    const prevFailure = prev.providerFailure || null;
    const now = Date.now();
    const attemptBase = prevFailure && Number.isFinite(prevFailure.attemptCount) ? prevFailure.attemptCount : (prevFailure && prevFailure.attemptCount ? Number(prevFailure.attemptCount) : 0);
    const attemptCount = (Number.isFinite(attemptBase) ? attemptBase : 0) + 1;
    const failure = Object.assign({}, prevFailure || {}, info || {});
    failure.provider = failure.provider || info.provider || (prevFailure && prevFailure.provider) || null;
    if (info.reason != null) failure.reason = info.reason;
    if (info.code != null) failure.code = info.code;
    if (info.error != null) failure.lastError = String(info.error);
    failure.attemptCount = attemptCount;
    failure.lastAttemptAt = now;
    failure.firstAttemptAt = prevFailure && prevFailure.firstAttemptAt ? prevFailure.firstAttemptAt : (info.firstAttemptAt || now);
    const normalized = normalizeProviderFailure(failure) || { provider: failure.provider || null, reason: failure.reason || null, attemptCount, lastAttemptAt: now, firstAttemptAt: failure.firstAttemptAt };
    normalized.attemptCount = attemptCount;
    normalized.lastAttemptAt = now;
    if (!normalized.firstAttemptAt) normalized.firstAttemptAt = now;
    updateEnrichCacheInMemory(key, Object.assign({}, prev, { providerFailure: normalized }));
    schedulePersistEnrichCache(600);
    return normalized;
  } catch (e) { return null; }
}

function markProviderFailureSkip(key) {
  try {
    const prev = enrichCache[key] || {};
    const prevFailure = prev.providerFailure || null;
    if (!prevFailure) return;
    const updated = Object.assign({}, prevFailure, {
      lastSkipAt: Date.now(),
      skipCount: Number.isFinite(prevFailure.skipCount) ? prevFailure.skipCount + 1 : ((prevFailure.skipCount ? Number(prevFailure.skipCount) : 0) + 1)
    });
    const merged = updateEnrichCacheInMemory(key, Object.assign({}, prev, { providerFailure: normalizeProviderFailure(updated) || updated }));
    schedulePersistEnrichCache(600);
    return merged;
  } catch (e) { /* best-effort */ }
}

function clearProviderFailure(key) {
  try {
    const prev = enrichCache[key] || {};
    if (!prev.providerFailure) return;
    const merged = updateEnrichCacheInMemory(key, Object.assign({}, prev, { providerFailure: null }));
    schedulePersistEnrichCache(600);
    return merged;
  } catch (e) { /* best-effort */ }
}

// Helper: clean series title to avoid duplicated episode label or episode title fragments
function escapeRegExp(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function cleanTitleForRender(t, epLabel, epTitle) {
  if (!t) return '';
  let s = String(t).trim();
  try {
    if (epLabel) {
      const lbl = String(epLabel).trim();
      if (lbl) s = s.replace(new RegExp('\\b' + escapeRegExp(lbl) + '\\b', 'i'), '').trim();
    }
    s = s.replace(/^\s*S\d{1,2}[\s_\-:\.]*[EPp]?(\d{1,3})?(?:\.\d+)?[\s_\-:\.]*/i, '').trim();
    if (epTitle) {
      const et = String(epTitle).trim();
      if (et) s = s.replace(new RegExp('[\-–—:\\s]*' + escapeRegExp(et) + '$', 'i'), '').trim();
    }
    s = s.replace(/^[\-–—:\s]+|[\-–—:\s]+$/g, '').trim();
  } catch (e) { /* best-effort */ }
  return s || String(t).trim();
}

function determineIsMovie(meta) {
  try {
    if (!meta) return false;
    const extra = meta.extraGuess || {};
    const explicitMeta = (typeof meta.isMovie === 'boolean') ? meta.isMovie : null;
    const explicitExtra = (extra && typeof extra.isMovie === 'boolean') ? extra.isMovie : null;
    let movie = explicitMeta === true || explicitExtra === true;
    let series = explicitMeta === false || explicitExtra === false;
    const considered = new Set();
    const markSeries = () => { series = true; };
    const markMovie = () => { movie = true; };
    if (meta.season != null || meta.episode != null || meta.episodeRange) markSeries();
    else if (extra && (extra.season != null || extra.episode != null || extra.episodeRange)) markSeries();
    const pushRaw = (raw) => {
      if (!raw || typeof raw !== 'object') return;
      if (considered.has(raw)) return;
      considered.add(raw);
      try {
        const formatCandidates = [raw.format, raw.mediaFormat, raw.subType, raw.subtype];
        for (const fmt of formatCandidates) {
          if (!fmt) continue;
          const up = String(fmt).toUpperCase();
          if (up.includes('MOVIE') || up === 'FILM' || up === 'FEATURE' || up === 'THEATRICAL') markMovie();
          if (up.includes('TV') || up.includes('SERIES') || up === 'OVA' || up === 'ONA' || up === 'SPECIAL') markSeries();
        }
        const mediaType = raw.media_type || raw.mediaType || raw.type || raw.category;
        if (mediaType) {
          const low = String(mediaType).toLowerCase();
          if (low.includes('movie') || low === 'film') markMovie();
          if (low.includes('tv') || low.includes('series') || low.includes('show')) markSeries();
        }
        const hasEpisodeCounts = raw.first_air_date || raw.firstAirDate || raw.number_of_episodes || raw.episode_count || raw.episode_run_time || raw.episodes || raw.total_episodes;
        if (hasEpisodeCounts) markSeries();
        // Treat release_date as movie signal only when no episode info exists
        if (!hasEpisodeCounts && raw.release_date && !raw.first_air_date && !raw.firstAirDate) markMovie();
      } catch (e) { /* ignore raw-level errors */ }
    };
    pushRaw(meta.raw);
    pushRaw(meta.provider && meta.provider.raw);
    if (extra && extra.provider) pushRaw(extra.provider.raw);
    pushRaw(meta.tmdb && meta.tmdb.raw);
    if (extra && extra.tmdb) pushRaw(extra.tmdb.raw);
    pushRaw(extra && extra.raw);
    pushRaw(extra && extra.anilist && extra.anilist.raw);
    const markSeriesFromBlock = (block) => {
      if (!block || typeof block !== 'object') return;
      if (block.episode != null || block.episodeRange || block.season != null || (block.seasons && block.seasons.length)) markSeries();
      if (block.type && /series|tv|show/i.test(String(block.type))) markSeries();
    };
    markSeriesFromBlock(meta);
    markSeriesFromBlock(meta.provider);
    markSeriesFromBlock(extra);
    if (extra && extra.provider) markSeriesFromBlock(extra.provider);
    if (meta.tmdb) markSeriesFromBlock(meta.tmdb);
    if (extra && extra.tmdb) markSeriesFromBlock(extra.tmdb);
    if (meta.mediaFormat) {
      const up = String(meta.mediaFormat).toUpperCase();
      if (up.includes('MOVIE') || up === 'FILM' || up === 'FEATURE') markMovie();
      if (up.includes('TV') || up.includes('SERIES') || up === 'OVA' || up === 'ONA' || up === 'SPECIAL') markSeries();
    }
    if (extra && extra.mediaFormat) {
      const up = String(extra.mediaFormat).toUpperCase();
      if (up.includes('MOVIE') || up === 'FILM' || up === 'FEATURE') markMovie();
      if (up.includes('TV') || up.includes('SERIES') || up === 'OVA' || up === 'ONA' || up === 'SPECIAL') markSeries();
    }
    if (series && !movie) return false;
    if (movie && !series) return true;
    if (series && movie) return false;
    if (typeof explicitMeta === 'boolean') return explicitMeta;
    if (typeof explicitExtra === 'boolean') return explicitExtra;
    return null;
  } catch (e) {
    return null;
  }
}

function healCachedEnglishAndMovieFlags() {
  try {
    const keys = Object.keys(enrichCache || {});
    if (!keys.length) return;
    const healed = [];
    for (const key of keys) {
      const meta = enrichCache[key];
      if (!meta || typeof meta !== 'object') continue;
      let updatedMeta = null;
      let extraGuess = null;
      try {
        const englishTitle = extractEnglishSeriesTitle(meta);
        const currentEnglish = meta.seriesTitleEnglish ? String(meta.seriesTitleEnglish).trim() : null;
        if (englishTitle && (!currentEnglish || currentEnglish !== englishTitle)) {
          updatedMeta = Object.assign({}, meta);
          extraGuess = Object.assign({}, meta.extraGuess || {});
          updatedMeta.seriesTitleEnglish = englishTitle;
          const existingSeries = meta.seriesTitle ? String(meta.seriesTitle).trim() : '';
          if (!existingSeries || existingSeries === currentEnglish) updatedMeta.seriesTitle = englishTitle;
          const existingExact = meta.seriesTitleExact ? String(meta.seriesTitleExact).trim() : '';
          if (!existingExact || existingExact === currentEnglish) updatedMeta.seriesTitleExact = englishTitle;
          extraGuess.seriesTitleEnglish = englishTitle;
        }
        const computedMovie = determineIsMovie(meta);
        if (computedMovie === true && meta.isMovie !== true) {
          if (!updatedMeta) updatedMeta = Object.assign({}, meta);
          extraGuess = extraGuess || Object.assign({}, meta.extraGuess || {});
          updatedMeta.isMovie = true;
          extraGuess.isMovie = true;
        }
        if (computedMovie === false && meta.isMovie !== false) {
          if (!updatedMeta) updatedMeta = Object.assign({}, meta);
          extraGuess = extraGuess || Object.assign({}, meta.extraGuess || {});
          updatedMeta.isMovie = false;
          if (extraGuess && Object.prototype.hasOwnProperty.call(extraGuess, 'isMovie')) delete extraGuess.isMovie;
        }
      } catch (e) { /* best-effort per entry */ }
      if (updatedMeta) {
        updatedMeta.extraGuess = extraGuess || Object.assign({}, meta.extraGuess || {});
        enrichCache[key] = updatedMeta;
        healed.push(key);
      }
    }
    if (healed.length) {
      try { if (db) db.setKV('enrichCache', enrichCache); else writeJson(enrichStoreFile, enrichCache); } catch (e) {}
      try { appendLog(`ENRICH_CACHE_HEAL applied=${healed.length}`); } catch (e) {}
    }
  } catch (e) {
    try { appendLog(`ENRICH_CACHE_HEAL_FAIL err=${e && e.message ? e.message : String(e)}`); } catch (ee) {}
  }
}

// Optional: log when provider returned season/episode but no episodeTitle (helps debug TMDb)
function logMissingEpisodeTitleIfNeeded(key, providerBlock) {
  try {
    if (!providerBlock) return;
    const hasEp = (providerBlock.episode != null);
    const hasSeason = (providerBlock.season != null);
    const hasTitle = providerBlock.episodeTitle && String(providerBlock.episodeTitle).trim();
    const enabled = Boolean(process.env.LOG_MISSING_EPISODE_TITLE) || (serverSettings && serverSettings.log_missing_episode_title);
    if (enabled && hasEp && (hasSeason || true) && !hasTitle) {
      try {
        appendLog(`MISSING_EP_TITLE path=${key} providerTitle=${providerBlock.title || ''} season=${providerBlock.season || ''} episode=${providerBlock.episode || ''}`)
      } catch (e) {}
    }
  } catch (e) { /* best-effort */ }
}

// Sweep helper: remove enrichCache entries whose source files no longer exist, clean renderedIndex
function sweepEnrichCache() {
  const removed = [];
  try {
    const keys = Object.keys(enrichCache || {});
    for (const k of keys) {
      try {
        if (!k) continue;
        if (!fs.existsSync(k)) {
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

function extractYear(meta, fromPath) {
  if (!meta) meta = {};
  // Prefer explicit episode air date -> season-level air date -> series-level dates -> meta.year fields
  try {
    // Episode-level (common shapes)
    const ep = meta.episode || (meta.raw && (meta.raw.episode || meta.raw.episodes && meta.raw.episodes[0])) || null
    if (ep) {
      const epDate = ep.air_date || ep.airDate || (ep.attributes && (ep.attributes.air_date || ep.attributes.airDate || ep.attributes.startDate)) || null
      if (epDate) {
        const y = new Date(String(epDate)).getUTCFullYear()
        if (!isNaN(y)) return String(y)
      }
    }
    // Season-level (TMDb attaches seasonAirDate earlier as seasonAirDate)
    const seasonDate = meta.seasonAirDate || (meta.raw && (meta.raw.seasonAirDate || (meta.raw.season && meta.raw.season.air_date))) || null
    if (seasonDate) {
      const y = new Date(String(seasonDate)).getUTCFullYear()
      if (!isNaN(y)) return String(y)
    }
    // Series-level typical fields
    const seriesDate = meta.first_air_date || meta.release_date || meta.firstAirDate || (meta.raw && (meta.raw.first_air_date || meta.raw.release_date || meta.raw.firstAirDate)) || null
    if (seriesDate) {
      const y = new Date(String(seriesDate)).getUTCFullYear()
      if (!isNaN(y)) return String(y)
    }
    // Provider-specific startDate shapes (AniList returns raw.startDate { year })
    try {
      if (meta.raw && meta.raw.startDate) {
        const sd = meta.raw.startDate
        if (sd && typeof sd === 'object' && sd.year) {
          const ry = Number(sd.year)
          if (!isNaN(ry)) return String(ry)
        } else if (sd && (typeof sd === 'string' || sd instanceof String)) {
          const y = new Date(String(sd)).getUTCFullYear()
          if (!isNaN(y)) return String(y)
        }
      }
      if (meta.raw && meta.raw.attributes && (meta.raw.attributes.startDate || meta.raw.attributes.releaseDate)) {
        const attrD = meta.raw.attributes.startDate || meta.raw.attributes.releaseDate
  const y = new Date(String(attrD)).getUTCFullYear()
  if (!isNaN(y)) return String(y)
      }
    } catch (e) {}
    // older/top-level year fields
    const candidates = [meta.year, meta.airedYear, meta.originalYear];
    for (const c of candidates) if (c && String(c).match(/^\d{4}$/)) return String(c);
    if (meta.timestamp) {
      try { const d = new Date(Number(meta.timestamp)); if (!isNaN(d)) return String(d.getUTCFullYear()) } catch (e) {}
    }
  } catch (e) { /* best-effort */ }
  // try to find a 4-digit year in title or parsedName
  const searchFields = [meta.title, meta.parsedName, path.basename(fromPath, path.extname(fromPath))];
  for (const f of searchFields) {
    if (!f) continue;
    const m = String(f).match(/(19|20)\d{2}/);
    if (m) return m[0];
  }
  return null;
}

// Apply rename plans (safe execution)
app.post('/api/rename/apply', requireAuth, (req, res) => {
  const { plans, dryRun } = req.body || {};
  if (!plans || !Array.isArray(plans)) return res.status(400).json({ error: 'plans required' });
  // Ensure cached movie/english flags are healed before applying rename plans so folder/year logic is correct
  try { healCachedEnglishAndMovieFlags(); } catch (e) { /* non-fatal */ }
  const results = [];
  for (const p of plans) {
    try {
      const from = p.fromPath;
      const to = p.toPath;
      if (from === to) {
        results.push({ itemId: p.itemId, status: 'noop' });
        continue;
      }
      // Prefer per-user configured output path, else server-wide setting
      let configuredOut = null;
      // Also determine configured input root (to prevent linking back into the input folders)
      let configuredInput = null;
      try {
        const username = req.session && req.session.username;
        if (username && users[username] && users[username].settings && users[username].settings.scan_output_path) configuredOut = canonicalize(users[username].settings.scan_output_path);
        else if (serverSettings && serverSettings.scan_output_path) configuredOut = canonicalize(serverSettings.scan_output_path);
        if (username && users[username] && users[username].settings && users[username].settings.scan_input_path) configuredInput = canonicalize(users[username].settings.scan_input_path);
        else if (serverSettings && serverSettings.scan_input_path) configuredInput = canonicalize(serverSettings.scan_input_path);
      } catch (e) { configuredOut = serverSettings && serverSettings.scan_output_path ? canonicalize(serverSettings.scan_output_path) : null; configuredInput = serverSettings && serverSettings.scan_input_path ? canonicalize(serverSettings.scan_input_path) : null }
      const toResolved = path.resolve(to);
      const resultsItem = { itemId: p.itemId };

      if (!dryRun) {
        // Determine if this plan explicitly requested a hardlink (preview sets actions: [{op:'hardlink'}])
        const requestedHardlink = (p.actions && Array.isArray(p.actions) && p.actions[0] && p.actions[0].op === 'hardlink') || false
        const targetUnderConfiguredOut = configuredOut && toResolved.startsWith(path.resolve(configuredOut))
  // If the plan explicitly requested a hardlink, require a configured output path; never hardlink into the input folder
  if (requestedHardlink && !configuredOut) {
    appendLog(`HARDLINK_FAIL_NO_OUTPUT from=${from} requestedHardlink=true`);
    throw new Error('Hardlink requested but no configured output path found. Set scan_output_path in settings.');
  }
          if (requestedHardlink || targetUnderConfiguredOut) {
          // create directories and attempt to create a hard link; do NOT move the original file
          try {
            // Prepare effective target path (default to provided toResolved). If rendering succeeds we'll replace it.
            let effectiveToResolved = toResolved;

            // Re-render filename from enrichment and template if available to ensure TMDb-based names are used
            try {
              const enrichment = enrichCache[from] || {};
              const key = from;
              const tmpl = (p.templateUsed) ? p.templateUsed : (enrichment && enrichment.extraGuess && enrichment.extraGuess.rename_template) || serverSettings.rename_template || '{title}';
              // build tokens similar to previewRename
              const ext2 = path.extname(from);
              function pad(n){ return String(n).padStart(2,'0') }
              let epLabel2 = ''
              if (enrichment && enrichment.episodeRange) {
                epLabel2 = enrichment.season != null ? `S${pad(enrichment.season)}E${enrichment.episodeRange}` : `E${enrichment.episodeRange}`
              } else if (enrichment && enrichment.episode != null) {
                epLabel2 = enrichment.season != null ? `S${pad(enrichment.season)}E${pad(enrichment.episode)}` : `E${pad(enrichment.episode)}`
              }
              let episodeTitleToken2 = enrichment && (enrichment.episodeTitle || (enrichment.extraGuess && enrichment.extraGuess.episodeTitle)) ? (enrichment.episodeTitle || (enrichment.extraGuess && enrichment.extraGuess.episodeTitle)) : ''
              // Fallback: if provider returned a renderedName that includes an episode suffix, try to extract it
              try {
                if (!episodeTitleToken2 && enrichment && enrichment.provider && enrichment.provider.renderedName) {
                  const pr = String(enrichment.provider.renderedName).replace(/\.[^/.]+$/, '');
                  // split on common separator and pick last segment if it looks like an episode title (not just ep label)
                  const parts = pr.split(/\s[-–—:]\s/);
                  if (parts && parts.length > 1) {
                    const cand = parts[parts.length - 1].trim();
                    if (cand && !isNoiseLike(cand) && !isEpisodeTokenCandidate(cand) && cand.length > 1) {
                      episodeTitleToken2 = cand;
                    }
                  }
                }
              } catch (e) { /* best-effort fallback */ }
              const seasonToken2 = (enrichment && enrichment.season != null) ? String(enrichment.season) : ''
              const episodeToken2 = (enrichment && enrichment.episode != null) ? String(enrichment.episode) : ''
              const episodeRangeToken2 = (enrichment && enrichment.episodeRange) ? String(enrichment.episodeRange) : ''
              const tmdbIdToken2 = (enrichment && enrichment.tmdb && enrichment.tmdb.raw && (enrichment.tmdb.raw.id || enrichment.tmdb.raw.seriesId)) ? String(enrichment.tmdb.raw.id || enrichment.tmdb.raw.seriesId) : ''
              const isMovie2 = determineIsMovie(enrichment)
              const rawTitle2 = (enrichment && (enrichment.title || (enrichment.extraGuess && enrichment.extraGuess.title))) ? (enrichment.title || (enrichment.extraGuess && enrichment.extraGuess.title)) : path.basename(from, ext2)
              // reuse cleaning logic from preview to avoid duplicated episode labels/titles in rendered filenames
              const resolvedSeriesTitle2 = resolveSeriesTitle(enrichment, rawTitle2, from, episodeTitleToken2, { preferExact: true });
              const englishSeriesTitle2 = extractEnglishSeriesTitle(enrichment);
              const renderBaseTitle2 = englishSeriesTitle2 || resolvedSeriesTitle2 || rawTitle2;
              const titleToken2 = cleanTitleForRender(renderBaseTitle2, (enrichment && enrichment.episode != null) ? (enrichment.season != null ? `S${String(enrichment.season).padStart(2,'0')}E${String(enrichment.episode).padStart(2,'0')}` : `E${String(enrichment.episode).padStart(2,'0')}`) : '', (enrichment && (enrichment.episodeTitle || (enrichment.extraGuess && enrichment.extraGuess.episodeTitle))) ? (enrichment.episodeTitle || (enrichment.extraGuess && enrichment.extraGuess.episodeTitle)) : '');
              const yearRaw2 = (enrichment && (enrichment.year || (enrichment.extraGuess && enrichment.extraGuess.year))) ? (enrichment.year || (enrichment.extraGuess && enrichment.extraGuess.year)) : ''
              const yearToken2 = (isMovie2 === true && yearRaw2) ? yearRaw2 : ''
              const outputRoot = configuredOut ? path.resolve(configuredOut) : path.resolve(path.dirname(toResolved))
              let baseFolderName2 = String(renderBaseTitle2 || titleToken2 || rawTitle2 || '').trim();
              if (!baseFolderName2) baseFolderName2 = path.basename(from, ext2) || rawTitle2 || titleToken2;
              let sanitizedBaseFolder2 = sanitize(baseFolderName2);
              if (!sanitizedBaseFolder2) sanitizedBaseFolder2 = sanitize(titleToken2) || sanitize(rawTitle2) || 'Untitled';
              const titleFolder2 = yearToken2 ? `${sanitizedBaseFolder2} (${yearToken2})` : sanitizedBaseFolder2;
              const seasonFolder2 = (isMovie2 === true || !(enrichment && enrichment.season != null)) ? '' : `Season ${String(enrichment.season).padStart(2,'0')}`;
              const targetFolder2 = seasonFolder2 ? path.join(outputRoot, titleFolder2, seasonFolder2) : path.join(outputRoot, titleFolder2);
              const nameWithoutExtRaw2 = String(tmpl || '{title}').replace('{title}', sanitize(titleToken2))
                .replace('{basename}', sanitize(path.basename(key, path.extname(key))))
                .replace('{year}', yearToken2)
                .replace('{epLabel}', sanitize(epLabel2))
                .replace('{episodeTitle}', sanitize(episodeTitleToken2))
                .replace('{season}', sanitize(seasonToken2))
                .replace('{episode}', sanitize(episodeToken2))
                .replace('{episodeRange}', sanitize(episodeRangeToken2))
  .replace('{tmdbId}', sanitize(tmdbIdToken2));
              const nameWithoutExt2 = String(nameWithoutExtRaw2)
                .replace(/\s*\(\s*\)\s*/g, '')
                .replace(/\s*\-\s*(?:\-\s*)+/g, ' - ')
                .replace(/(^\s*\-\s*)|(\s*\-\s*$)/g, '')
                .replace(/\s{2,}/g, ' ')
                .trim();
              const safeNameWithoutExt2 = nameWithoutExt2 || sanitize(titleToken2) || sanitize(path.basename(key, path.extname(key))) || 'Untitled';
              // build final basename with extension and set effective target
              try {
                const finalBasename2 = `${safeNameWithoutExt2}${ext2}`;
                effectiveToResolved = path.resolve(targetFolder2, finalBasename2);
              } catch (e) { /* ignore and leave effectiveToResolved as toResolved */ }
            } catch (renderErr) {
              // fallback: keep effectiveToResolved as toResolved
              effectiveToResolved = toResolved;
            }
            // helper: ensure source and destination live on the same filesystem/device
            function nearestExistingParent(dir) {
              let cur = dir;
              try {
                while (cur && !fs.existsSync(cur)) {
                  const parent = path.dirname(cur);
                  if (!parent || parent === cur) break;
                  cur = parent;
                }
              } catch (e) { cur = null }
              return cur && fs.existsSync(cur) ? cur : null;
            }
            function assertSameDevice(srcPath, destPath) {
              try {
                const srcStat = fs.statSync(srcPath);
                const destParent = nearestExistingParent(path.dirname(destPath));
                if (!destParent) return true; // cannot determine, allow attempt
                const destStat = fs.statSync(destParent);
                if (typeof srcStat.dev !== 'undefined' && typeof destStat.dev !== 'undefined') {
                  return srcStat.dev === destStat.dev;
                }
                return true;
              } catch (e) { return true }
            }

            // Defensive: never create provider-driven hardlinks inside the configured input path
            try {
              if (configuredInput) {
                const inpResolved = path.resolve(configuredInput);
                if (String(effectiveToResolved || '').startsWith(inpResolved)) {
                  appendLog(`HARDLINK_REFUSE_INPUT from=${from} to=${effectiveToResolved} configuredInput=${inpResolved}`);
                  throw new Error('Refusing to create hardlink inside configured input path');
                }
              }
            } catch (e) { throw e }

              // Ensure destination parent exists
              try {
                const parentDir = path.dirname(effectiveToResolved);
                if (parentDir && !fs.existsSync(parentDir)) {
                  try { fs.mkdirSync(parentDir, { recursive: true }); appendLog(`HARDLINK_MKDIR created parent=${parentDir}`); } catch (e) { appendLog(`HARDLINK_MKDIR_FAIL parent=${parentDir} err=${e && e.message ? e.message : String(e)}`); }
                }
              } catch (e) { appendLog(`HARDLINK_MKDIR_EXCEPTION effective=${effectiveToResolved} err=${e && e.message ? e.message : String(e)}`); }

              if (!fs.existsSync(effectiveToResolved)) {
              // fail early if cross-device (hardlinks won't work across mounts)
              if (!assertSameDevice(from, effectiveToResolved)) {
                appendLog(`HARDLINK_CROSS_DEVICE from=${from} to=${effectiveToResolved}`);
                const err = new Error('Cross-device link not supported: source and target are on different filesystems');
                throw err;
              }
              try {
                fs.linkSync(from, effectiveToResolved);
                resultsItem.status = 'hardlinked';
                resultsItem.to = effectiveToResolved;
                appendLog(`HARDLINK_OK from=${from} to=${effectiveToResolved}`);
              } catch (linkErr) {
                // Do NOT fallback to copy. Hardlink must succeed or the operation fails.
                appendLog(`HARDLINK_FAIL from=${from} to=${effectiveToResolved} linkErr=${linkErr && linkErr.message ? linkErr.message : String(linkErr)}`);
                // Additional diagnostics to help identify ENOENT / mount issues
                try {
                  const exists = fs.existsSync(from);
                  appendLog(`HARDLINK_DIAG_EXISTS from=${from} exists=${exists}`);
                  const resolvedFrom = path.resolve(from);
                  const canonicalFrom = canonicalize(from);
                  appendLog(`HARDLINK_DIAG_PATHS resolved=${resolvedFrom} canonical=${canonicalFrom}`);
                  const parentDir = path.dirname(from);
                  function findNearestExisting(dir) {
                    let cur = dir;
                    try {
                      while (cur && !fs.existsSync(cur)) {
                        const p = path.dirname(cur);
                        if (!p || p === cur) break;
                        cur = p;
                      }
                    } catch (e) { cur = null }
                    return cur && fs.existsSync(cur) ? cur : null;
                  }
                  const nearest = findNearestExisting(parentDir);
                  appendLog(`HARDLINK_DIAG_PARENT parentExists=${fs.existsSync(parentDir)} nearestExisting=${nearest}`);
                  if (nearest) {
                    try {
                      const list = fs.readdirSync(nearest).slice(0,40).join(', ');
                      appendLog(`HARDLINK_DIAG_NEAREST_LIST nearest=${nearest} sample=${list}`);
                    } catch (e) {}
                  }
                } catch (ee) {}
                throw linkErr;
              }
            } else {
              // target already exists
              resultsItem.status = 'exists';
              resultsItem.to = effectiveToResolved;
              appendLog(`HARDLINK_SKIP_EXISTS to=${effectiveToResolved}`);
            }

              // mark applied in enrich cache and persist (use canonicalized keys)
              try {
                const fromKey = canonicalize(from);
              enrichCache[fromKey] = enrichCache[fromKey] || {};
              enrichCache[fromKey].applied = true;
              enrichCache[fromKey].hidden = true;
              enrichCache[fromKey].appliedAt = Date.now();
              enrichCache[fromKey].appliedTo = effectiveToResolved || toResolved;
              const finalBasename = path.basename(effectiveToResolved || toResolved);
              enrichCache[fromKey].renderedName = finalBasename;
              // metadataFilename: rendered filename without the extension
              enrichCache[fromKey].metadataFilename = finalBasename.replace(new RegExp(path.extname(finalBasename) + '$'), '')
              // index target path as a lightweight mapping (do NOT copy applied/hidden flags)
              try {
                const targetKey = canonicalize(effectiveToResolved || toResolved)
                renderedIndex[targetKey] = {
                  source: from,
                  renderedName: finalBasename,
                  appliedTo: effectiveToResolved || toResolved,
                  metadataFilename: enrichCache[fromKey].metadataFilename,
                  provider: enrichCache[fromKey].provider || null,
                  parsed: enrichCache[fromKey].parsed || null
                };
                // record mapping metadataFilename -> targetKey for quick lookup
                try {
                  const metaName = enrichCache[fromKey].metadataFilename
                  if (metaName) renderedIndex[metaName] = targetKey
                } catch (e) {}
              } catch (e) {}
                try { if (db) db.setKV('enrichCache', enrichCache); else writeJson(enrichStoreFile, enrichCache); } catch (e) {}
              try { if (db) db.setKV('renderedIndex', renderedIndex); else writeJson(renderedIndexFile, renderedIndex); } catch (e) {}
            } catch (e) { appendLog(`HARDLINK_MARK_FAIL from=${from} err=${e.message}`) }
          } catch (err) {
            // bubble up to outer error handler
            throw err
          }
        } else {
          // default behavior: preserve original file; attempt to hardlink into target, fallback to copy
          try {
            const toDir2 = path.dirname(to);
            if (!fs.existsSync(toDir2)) fs.mkdirSync(toDir2, { recursive: true });
            if (!fs.existsSync(to)) {
              // fail early if cross-device (hardlinks won't work across mounts)
              function nearestExistingParent2(dir) {
                let cur = dir;
                try {
                  while (cur && !fs.existsSync(cur)) {
                    const parent = path.dirname(cur);
                    if (!parent || parent === cur) break;
                    cur = parent;
                  }
                } catch (e) { cur = null }
                return cur && fs.existsSync(cur) ? cur : null;
              }
              try {
                const srcStat2 = fs.statSync(from);
                const destParent2 = nearestExistingParent2(path.dirname(to));
                if (destParent2) {
                  const destStat2 = fs.statSync(destParent2);
                  if (typeof srcStat2.dev !== 'undefined' && typeof destStat2.dev !== 'undefined' && srcStat2.dev !== destStat2.dev) {
                    appendLog(`HARDLINK_CROSS_DEVICE from=${from} to=${to}`);
                    throw new Error('Cross-device link not supported: source and target are on different filesystems');
                  }
                }
              } catch (e) {
                // if we couldn't stat, proceed and let linkSync surface the error
              }

              // Defensive: refuse hardlink into configured input root
              try {
                if (configuredInput) {
                  const inpResolved2 = path.resolve(configuredInput);
                  const toResolved2 = path.resolve(to);
                  if (String(toResolved2).startsWith(inpResolved2)) {
                    appendLog(`HARDLINK_REFUSE_INPUT from=${from} to=${toResolved2} configuredInput=${inpResolved2}`);
                    throw new Error('Refusing to create hardlink inside configured input path');
                  }
                }
              } catch (e) { throw e }
              try {
                fs.linkSync(from, to);
                resultsItem.status = 'hardlinked';
                resultsItem.to = to;
                appendLog(`HARDLINK_OK from=${from} to=${to}`);
              } catch (linkErr2) {
                // Do NOT fallback to copy. Hardlink must succeed or the operation fails.
                appendLog(`HARDLINK_FAIL from=${from} to=${to} linkErr=${linkErr2 && linkErr2.message ? linkErr2.message : String(linkErr2)}`);
                // Diagnostics for ENOENT / mount problems
                try {
                  const exists = fs.existsSync(from);
                  appendLog(`HARDLINK_DIAG_EXISTS from=${from} exists=${exists}`);
                  const resolvedFrom = path.resolve(from);
                  const canonicalFrom = canonicalize(from);
                  appendLog(`HARDLINK_DIAG_PATHS resolved=${resolvedFrom} canonical=${canonicalFrom}`);
                  const parentDir = path.dirname(from);
                  function findNearestExisting2(dir) {
                    let cur = dir;
                    try {
                      while (cur && !fs.existsSync(cur)) {
                        const p = path.dirname(cur);
                        if (!p || p === cur) break;
                        cur = p;
                      }
                    } catch (e) { cur = null }
                    return cur && fs.existsSync(cur) ? cur : null;
                  }
                  const nearest = findNearestExisting2(parentDir);
                  appendLog(`HARDLINK_DIAG_PARENT parentExists=${fs.existsSync(parentDir)} nearestExisting=${nearest}`);
                  if (nearest) {
                    try { const list = fs.readdirSync(nearest).slice(0,40).join(', '); appendLog(`HARDLINK_DIAG_NEAREST_LIST nearest=${nearest} sample=${list}`); } catch (e) {}
                  }
                } catch (ee) {}
                throw linkErr2;
              }
            } else {
              resultsItem.status = 'exists';
              resultsItem.to = to;
              appendLog(`HARDLINK_SKIP_EXISTS to=${to}`);
            }

            // mark applied in enrich cache and persist (use canonicalized keys)
            try {
              const fromKey = canonicalize(from);
              enrichCache[fromKey] = enrichCache[fromKey] || {};
              enrichCache[fromKey].applied = true;
              enrichCache[fromKey].hidden = true;
              enrichCache[fromKey].appliedAt = Date.now();
              enrichCache[fromKey].appliedTo = to;
              const finalBasename = path.basename(to);
              enrichCache[fromKey].renderedName = finalBasename;
              enrichCache[fromKey].metadataFilename = finalBasename.replace(new RegExp(path.extname(finalBasename) + '$'), '')
              // index target path as a lightweight mapping (do NOT copy applied/hidden flags)
              try {
                const targetKey = canonicalize(to)
                renderedIndex[targetKey] = {
                  source: from,
                  renderedName: finalBasename,
                  appliedTo: to,
                  metadataFilename: enrichCache[fromKey].metadataFilename,
                  provider: enrichCache[fromKey].provider || null,
                  parsed: enrichCache[fromKey].parsed || null
                };
                // record mapping metadataFilename -> targetKey for quick lookup
                try {
                  const metaName = enrichCache[fromKey].metadataFilename
                  if (metaName) renderedIndex[metaName] = targetKey
                } catch (e) {}
              } catch (e) {}
              try { if (db) db.setKV('enrichCache', enrichCache); else writeJson(enrichStoreFile, enrichCache); } catch (e) {}
              try { if (db) db.setKV('renderedIndex', renderedIndex); else writeJson(renderedIndexFile, renderedIndex); } catch (e) {}
            } catch (e) { appendLog(`HARDLINK_MARK_FAIL from=${from} err=${e.message}`) }
          } catch (err) {
            throw err
          }
        }
      } else {
        resultsItem.status = 'dryrun';
        resultsItem.to = to;
      }

      results.push(resultsItem);
    } catch (err) {
      appendLog(`RENAME_FAIL item=${p.itemId} err=${err.message}`);
      results.push({ itemId: p.itemId, status: 'error', error: err.message });
    }
  }
  res.json({ results });
});
// Unapprove last N applied renames: mark applied->false and unhide
app.post('/api/rename/unapprove', requireAuth, requireAdmin, (req, res) => {
  try {
    const requestedPaths = (req.body && Array.isArray(req.body.paths)) ? req.body.paths : null
    const count = (!requestedPaths) ? (parseInt((req.body && req.body.count) || '10', 10) || 10) : null
    const changed = []

    if (requestedPaths && requestedPaths.length > 0) {
      // Unapprove exactly the provided canonical paths
      for (const p of requestedPaths) {
        try {
          if (enrichCache[p] && enrichCache[p].applied) {
            enrichCache[p].applied = false
            enrichCache[p].hidden = false
            delete enrichCache[p].appliedAt
            delete enrichCache[p].appliedTo
            changed.push(p)
          }
        } catch (e) {}
      }
    } else {
      // collect applied entries sorted by appliedAt desc and unapprove last N (existing behavior)
      const applied = Object.keys(enrichCache).map(k => ({ k, v: enrichCache[k] })).filter(x => x.v && x.v.applied).sort((a,b) => (b.v.appliedAt || 0) - (a.v.appliedAt || 0))
      const toUn = applied.slice(0, count)
      for (const item of toUn) {
        try {
          enrichCache[item.k].applied = false
          enrichCache[item.k].hidden = false
          delete enrichCache[item.k].appliedAt
          delete enrichCache[item.k].appliedTo
          changed.push(item.k)
        } catch (e) {}
      }
    }

  try { if (db) db.setKV('enrichCache', enrichCache); else writeJson(enrichStoreFile, enrichCache); } catch (e) {}
    appendLog(`UNAPPROVE count=${changed.length}`)
    res.json({ ok: true, unapproved: changed })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Logs endpoints
app.get('/api/logs/recent', (req, res) => {
  try {
    // Read only the last ~100KB from the logs file to avoid loading very large files into memory.
    if (!fs.existsSync(logsFile)) return res.json({ logs: '' })
    const stat = fs.statSync(logsFile)
    const maxBytes = 100 * 1024 // 100 KB
    const start = Math.max(0, stat.size - maxBytes)
    const stream = fs.createReadStream(logsFile, { start, end: stat.size })
    let sb = ''
    stream.setEncoding('utf8')
    stream.on('data', d => sb += d)
    stream.on('error', (err) => {
      try { console.error('logs/recent stream failed', err && err.message ? err.message : err) } catch (ee) {}
      try {
        const stat2 = fs.existsSync(logsFile) ? fs.statSync(logsFile) : null
        const info = stat2 ? { size: stat2.size, mtime: stat2.mtimeMs } : { size: 0 }
        return res.json({ logs: '', fallback: true, message: 'logs temporarily unavailable', info })
      } catch (ee) {
        return res.json({ logs: '', fallback: true, message: 'logs temporarily unavailable' })
      }
    })
    stream.on('end', () => {
      try {
        const tail = String(sb || '').split('\n').slice(-200).join('\n')
        return res.json({ logs: tail })
      } catch (e) {
        try { console.error('logs/recent post-process failed', e && e.message ? e.message : e) } catch (ee) {}
        return res.status(500).json({ error: e && e.message ? e.message : String(e) })
      }
    })
  } catch (e) {
    try { console.error('logs/recent read failed', e && e.message ? e.message : e) } catch (ee) {}
    return res.status(500).json({ error: e && e.message ? e.message : String(e) })
  }
});

app.post('/api/logs/clear', (req, res) => {
  fs.writeFileSync(logsFile, '');
  res.json({ ok: true });
});

// Debug trace endpoint: return recent logs and runtime state for diagnostics
app.get('/api/debug/trace', (req, res) => {
  try {
    const tail = fs.existsSync(logsFile) ? fs.readFileSync(logsFile, 'utf8').split('\n').slice(-500).join('\n') : '';
    const state = {
      pid: process.pid,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      hideEventsLen: Array.isArray(hideEvents) ? hideEvents.length : 0,
      enrichCacheSize: Object.keys(enrichCache || {}).length,
      refreshProgressKeys: Object.keys(refreshProgress || {}).length
    }
    return res.json({ ok: true, state, logs: tail })
  } catch (e) {
    try { appendLog(`TRACE_ERR err=${e && e.message ? e.message : String(e)}`) } catch (ee) {}
    return res.status(500).json({ error: e && e.message ? e.message : String(e) })
  }
})

// Backwards-compatible route: keep /api/tvdb/status as an alias for legacy clients (proxies to /api/meta/status)
app.get('/api/tvdb/status', (req, res) => {
  return app._router.handle(req, res, () => {}, 'GET', '/api/meta/status')
})

// Official TMDb status alias (preferred)
app.get('/api/tmdb/status', (req, res) => {
  return app._router.handle(req, res, () => {}, 'GET', '/api/meta/status')
})

// Serve web app static if built
app.use('/', express.static(path.join(__dirname, 'web', 'dist')));

const PORT = process.env.PORT || 5173;
// export helpers for test harnesses
module.exports = module.exports || {};
module.exports.externalEnrich = externalEnrich;
// Export metaLookup for test harnesses and debugging
module.exports.metaLookup = metaLookup;
// Export extractYear for unit testing
module.exports.extractYear = extractYear;
// Export normalization helper for unit tests
module.exports.normalizeEnrichEntry = normalizeEnrichEntry;
// Expose enrichCache for debugging/tests
module.exports.enrichCache = enrichCache;
module.exports.parsedCache = parsedCache;
// Export internal helpers for test harnesses (non-production)
module.exports._test = module.exports._test || {};
module.exports._test.fullScanLibrary = typeof fullScanLibrary !== 'undefined' ? fullScanLibrary : null;
// expose TMDb helper for debugging/tests
module.exports._test.searchTmdbAndEpisode = typeof searchTmdbAndEpisode !== 'undefined' ? searchTmdbAndEpisode : null;
module.exports._test.incrementalScanLibrary = typeof incrementalScanLibrary !== 'undefined' ? incrementalScanLibrary : null;
module.exports._test.loadScanCache = typeof loadScanCache !== 'undefined' ? loadScanCache : null;
module.exports._test.saveScanCache = typeof saveScanCache !== 'undefined' ? saveScanCache : null;
module.exports._test.processParsedItem = doProcessParsedItem;
module.exports._test.determineIsMovie = determineIsMovie;
module.exports._test.renderProviderName = renderProviderName;
module.exports._test.doProcessParsedItem = doProcessParsedItem;
// expose internal helpers for unit tests
module.exports._test.stripAniListSeasonSuffix = typeof stripAniListSeasonSuffix !== 'undefined' ? stripAniListSeasonSuffix : null;
module.exports._test.lookupWikipediaEpisode = typeof lookupWikipediaEpisode !== 'undefined' ? lookupWikipediaEpisode : null;
// expose wikiEpisodeCache for tests so unit tests can clear it
module.exports.wikiEpisodeCache = wikiEpisodeCache;

// Only start the HTTP server when this file is run directly, not when required as a module
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server listening on ${PORT}`);
  });
}




