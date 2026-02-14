const express = require('express')
const helmet = require('helmet')
const cors = require('cors')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const https = require('https')
const { v4: uuidv4 } = require('uuid')
const tvdb = require('./lib/tvdb')
const chokidar = require('chokidar')
const { lookupMetadataWithAniDB, getAniDBCredentials } = require('./lib/meta-providers')
const { getAniDBUDPClient } = require('./lib/anidb-udp')
const { getAniDBClient } = require('./lib/anidb')
const bcrypt = require('bcryptjs')
const cookieParser = require('cookie-parser')
const cookieSession = require('cookie-session')
const titleCase = require('./lib/title-case')
const normalizeApostrophes = require('./lib/normalize-apostrophes')

// Pre-compiled regex patterns for performance optimization
const REGEX_NEWLINES = /[\r\n]+/g
const REGEX_MULTI_SPACE = /\s{2,}/g
const REGEX_WHITESPACE = /\s+/g
const REGEX_APOSTROPHES = /[\u2018\u2019\u201A\u201B\u2032\u2035\u275B\u275C\uFF07]/g
const REGEX_QUOTES = /[\u201C\u201D\u201E\u201F]/g
const REGEX_DOT_UNDER_DASH_COLON = /[\._\-:]+/g
const REGEX_NON_ALPHANUM_SPACE = /[^a-z0-9\s]/g
const REGEX_NON_ALPHANUM = /[^a-z0-9]/g
const REGEX_NON_ALPHANUM_SPLIT = /[^a-z0-9]+/
const REGEX_SEASON_PARENS = /\s*\(\s*Season\s*\d{1,2}(?:st|nd|rd|th)?\s*\)\s*$/i
const REGEX_SEASON_PARENS_YEAR = /\s*\(\s*Season\s*\d{1,2}(?:st|nd|rd|th)?\s*\)\s*(?=\d{4}\b)/i
const REGEX_SEASON_SUFFIX = /\s+Season\s+\d{1,2}(?:st|nd|rd|th)?\s*$/i
const REGEX_ORDINAL_SEASON = /\s+\d{1,2}(?:st|nd|rd|th)?\s+Season\s*$/i
const REGEX_WORD_SEASON = /\s+(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+Season\s*$/i
const REGEX_SEASON_WORD = /\s+Season\s+(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s*$/i
const REGEX_WORD_SEASON_YEAR = /\s+(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+Season\s*(?=\d{4}\b)/i
const REGEX_SEASON_WORD_YEAR = /\s+Season\s+(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s*(?=\d{4}\b)/i
const REGEX_SXX_SUFFIX = /\s+S\d{1,2}(?:E\d{1,3})?\s*$/i
const REGEX_SXXEXX = /\bS\d{1,2}E\d{1,3}\b/ig
const REGEX_SXX = /\bS\d{1,2}\b/ig
const REGEX_EXX = /\bE\d{1,3}\b/ig
const REGEX_NXN = /\b\d{1,2}x\d{1,3}\b/ig
const REGEX_EPISODE = /\bEp(?:isode)?\.?\s*\d{1,3}\b/ig
const REGEX_BRACKETS = /\[[^\]]+\]/g
const REGEX_SEASON_KEYWORD = /\bseason\b/i

// External API integration removed: TMDb-related helpers and https monkey-patch
// have been disabled to eliminate external HTTP calls. The metaLookup function
// below is a no-op stub that returns null so the rest of the server continues
// to operate without external provider lookups.

const METADATA_PROVIDER_IDS = ['anidb', 'anilist', 'tvdb', 'tmdb', 'wikipedia', 'kitsu'];
const DEFAULT_METADATA_PROVIDER_ORDER = ['anidb', 'anilist', 'tvdb', 'tmdb'];
const FOLDER_WATCH_RESTART_DELAY_MS = 5000;
const PROVIDER_DISPLAY_NAMES = {
  anidb: 'AniDB',
  anilist: 'AniList',
  tvdb: 'TVDB',
  tmdb: 'TMDB',
  wikipedia: 'Wikipedia',
  kitsu: 'Kitsu'
};
const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:5173'];
const CSRF_COOKIE_NAME = 'XSRF-TOKEN';
const CSRF_HEADER_NAME = 'X-CSRF-Token';
const SAFE_CSRF_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const app = express();
app.set('trust proxy', 1);

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

function coerceBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
  }
  if (typeof value === 'number') return value !== 0;
  return !!value;
}

function normalizeProviderId(value) {
  if (!value) return null;
  return String(value).trim().toLowerCase();
}

function truncateProviderDetail(value, maxLength = 120) {
  if (!value) return ''
  const clean = String(value)
    .replace(REGEX_NEWLINES, ' ')
    .replace(REGEX_MULTI_SPACE, ' ')
    .trim()
  if (!clean.length) return ''
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean
}

function assignProviderSourceMetadata(target, meta = {}) {
  try {
    if (!target || typeof target !== 'object') return;
    const buildEntry = (entry) => {
      if (!entry) return null;
      const id = normalizeProviderId(entry.id || entry.provider || entry.source);
      if (!id) return null;
      const display = PROVIDER_DISPLAY_NAMES[id] || (id.charAt(0).toUpperCase() + id.slice(1));
      const detail = truncateProviderDetail(entry.detail || entry.title || entry.name || '');
      return { id, display, detail };
    };
    const seriesEntry = buildEntry(meta.seriesProvider);
    const episodeEntry = buildEntry(meta.episodeProvider);
    const summaryParts = [];
    const pushSummary = (entry) => {
      if (!entry) return;
      const suffix = entry.detail ? ` (${entry.detail})` : '';
      summaryParts.push(`${entry.display}${suffix}`);
    };
    // avoid duplicate when series/episode entries are effectively identical
    if (seriesEntry) {
      pushSummary(seriesEntry);
    }
    if (episodeEntry) {
      const sameId = seriesEntry && episodeEntry && seriesEntry.id === episodeEntry.id;
      if (!sameId || !seriesEntry) {
        pushSummary(episodeEntry);
      }
    }
    const summary = summaryParts.join(' + ');
    try { target.sources = { series: seriesEntry || null, episode: episodeEntry || null }; } catch (e) {}
    if (summary) target.source = summary;
    else if (!target.source && seriesEntry) target.source = seriesEntry.display;
    else if (!target.source && episodeEntry) target.source = episodeEntry.display;
  } catch (e) { /* ignore */ }
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
// Manual provider ID overrides for series that can't be auto-matched
const manualIdsFile = path.join(DATA_DIR, 'manual-ids.json');
const approvedSeriesImagesFile = path.join(DATA_DIR, 'approved-series-images.json');
// Wikipedia episode cache file (persistent)
const wikiEpisodeCacheFile = path.join(DATA_DIR, 'wiki-episode-cache.json');
const wikiSearchLogFile = path.join(DATA_DIR, 'wiki-search.log');

// ensure we have a persistent session signing key
const sessionKeyFile = path.join(DATA_DIR, 'session.key');
function ensureSessionKey() {
  try {
    if (!fs.existsSync(sessionKeyFile)) {
      const k = crypto.randomBytes(32).toString('hex');
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
if (!SESSION_KEY) {
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

// Log approved series source preferences on startup
try {
  for (const username of Object.keys(users || {})) {
    const prefs = users[username] && users[username].settings && users[username].settings.approved_series_image_source_by_output;
    if (prefs && typeof prefs === 'object') {
      const keys = Object.keys(prefs);
      if (keys.length > 0) {
        for (const key of keys) {
          appendLog(`STARTUP_APPROVED_SERIES_SOURCE_PREF user=${username} key=${key.slice(0,80)} source=${prefs[key]}`);
        }
      }
    }
  }
} catch (e) {
  appendLog(`STARTUP_APPROVED_SERIES_PREF_LOG_FAIL err=${e.message}`);
}

// Load manual provider ID overrides
let manualIds = {};
function normalizeManualIdKey(value) {
  try {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  } catch (e) { return String(value || '').trim().toLowerCase(); }
}

function normalizeManualIdValue(value) {
  try {
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return Number(raw);
    return raw;
  } catch (e) { return null; }
}

function normalizeAniDbEpisodeId(value) {
  try {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const urlMatch = raw.match(/anidb\.net\/episode\/(\d+)/i);
    if (urlMatch && urlMatch[1]) return Number(urlMatch[1]);
    if (/^\d+$/.test(raw)) return Number(raw);
    return raw;
  } catch (e) { return null; }
}

function normalizeManualPathKey(value) {
  try {
    let out = String(value || '').trim();
    if (!out) return '';
    try { out = decodeURIComponent(out); } catch (e) {}
    out = out.replace(/\\+/g, '/').replace(/\/+/g, '/').trim();
    return out;
  } catch (e) { return String(value || '').trim(); }
}

function toLooseManualPath(value) {
  try {
    return normalizeManualPathKey(value).toLowerCase();
  } catch (e) { return String(value || '').trim().toLowerCase(); }
}

function loadManualIds() {
  try {
    ensureFile(manualIdsFile, {});
    const raw = fs.readFileSync(manualIdsFile, 'utf8') || '{}';
    const parsed = JSON.parse(raw);
    manualIds = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    manualIds = {};
  }
}

function getManualId(title, provider, filePath = null) {
  try {
    // For AniDB Episode IDs, check file path only (episode-specific)
    if (provider === 'anidbEpisode') {
      if (!filePath) {
        try { appendLog('MANUAL_ID_LOOKUP_EP_SKIP reason=no-filePath'); } catch (e) {}
        return null;
      }

      const candidates = [];
      const pushCandidate = (value) => {
        if (!value) return;
        if (!candidates.includes(value)) candidates.push(value);
      };

      const rawPath = String(filePath || '').trim();
      const normalizedPath = normalizeManualPathKey(rawPath);
      pushCandidate(rawPath);
      pushCandidate(normalizedPath);
      try { pushCandidate(canonicalize(rawPath)); } catch (e) {}
      try { pushCandidate(canonicalize(normalizedPath)); } catch (e) {}

      for (const key of candidates) {
        const entry = manualIds && manualIds[key];
        if (entry && entry.anidbEpisode) {
          try {
            appendLog(`MANUAL_ID_LOOKUP_EP_HIT key=${key} req=${normalizedPath} eid=${entry.anidbEpisode}`);
          } catch (e) {}
          return entry.anidbEpisode;
        }
      }

      const reqLoose = toLooseManualPath(normalizedPath);
      if (reqLoose && manualIds && typeof manualIds === 'object') {
        for (const key of Object.keys(manualIds)) {
          if (!manualIds[key] || manualIds[key].anidbEpisode == null) continue;
          if (toLooseManualPath(key) === reqLoose) {
            try {
              appendLog(`MANUAL_ID_LOOKUP_EP_HIT_LOOSE key=${key} req=${normalizedPath} eid=${manualIds[key].anidbEpisode}`);
            } catch (e) {}
            return manualIds[key].anidbEpisode;
          }
        }
      }

      try {
        const episodeKeyCount = Object.keys(manualIds || {}).filter((k) => manualIds[k] && manualIds[k].anidbEpisode != null).length;
        appendLog(`MANUAL_ID_LOOKUP_EP_MISS req=${normalizedPath} candidates=${candidates.length} storedEpisodeKeys=${episodeKeyCount}`);
      } catch (e) {}
      // Don't fall back to title-based lookup for episode IDs
      return null;
    }
    
    // For series-level IDs or fallback, check by title
    if (!title) return null;
    const key = normalizeManualIdKey(title);
    if (!key || !manualIds) return null;
    let entry = manualIds[key] || null;
    if (!entry) {
      const normalizeLoose = (value) => {
        try {
          return String(value || '')
            .toLowerCase()
            .replace(/\(\s*\d{4}\s*\)/g, ' ')
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        } catch (e) { return String(value || '').toLowerCase().trim(); }
      };
      const looseKey = normalizeLoose(title);
      if (looseKey) {
        for (const candidateKey of Object.keys(manualIds || {})) {
          if (!candidateKey) continue;
          const looseCandidate = normalizeLoose(candidateKey);
          if (!looseCandidate) continue;
          if (looseCandidate === looseKey || looseCandidate.includes(looseKey) || looseKey.includes(looseCandidate)) {
            entry = manualIds[candidateKey];
            break;
          }
        }
      }
    }
    if (!entry) return null;
    const raw = entry && provider ? entry[provider] : null;
    if (raw === undefined || raw === null || raw === '') return null;
    return raw;
  } catch (e) { return null; }
}

loadManualIds();

if (typeof serverSettings.delete_hardlinks_on_unapprove === 'undefined') {
  serverSettings.delete_hardlinks_on_unapprove = true;
}

const envAllowedOrigins = String(process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin && origin.trim())
  .filter(Boolean);
const configuredAllowedOrigins = Array.isArray(serverSettings.allowed_origins)
  ? serverSettings.allowed_origins.map((origin) => origin && String(origin).trim()).filter(Boolean)
  : [];
const allowedOrigins = Array.from(new Set([...(envAllowedOrigins || []), ...(configuredAllowedOrigins || [])].filter(Boolean)));
if (!allowedOrigins.length) {
  allowedOrigins.push(...DEFAULT_ALLOWED_ORIGINS);
}
const allowedOriginsNormalized = allowedOrigins.map((origin) => origin.toLowerCase());

const baseCorsOptions = {
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Requested-With', CSRF_HEADER_NAME],
  exposedHeaders: [CSRF_HEADER_NAME]
};

function isOriginTrusted(origin, req) {
  if (!origin) return true;
  const normalized = origin.toLowerCase();
  if (allowedOriginsNormalized.includes(normalized)) return true;
  try {
    const hostHeader = (req && req.headers && req.headers.host ? String(req.headers.host) : '').toLowerCase();
    if (!hostHeader) return false;
    const parsed = new URL(origin);
    const originHost = parsed.host ? parsed.host.toLowerCase() : '';
    // Direct match: origin host exactly matches Host header (same domain + port)
    if (originHost === hostHeader) return true;
    // Flexible match: same hostname, allowing different ports or protocol upgrades
    const originHostname = parsed.hostname ? parsed.hostname.toLowerCase() : '';
    const hostParts = hostHeader.split(':');
    const headerHostname = hostParts[0].toLowerCase();
    if (originHostname && originHostname === headerHostname) return true;
  } catch (err) {
    // fall through to rejection
  }
  return false;
}

const corsOptionsDelegate = (req, callback) => {
  try {
    const origin = req.headers && req.headers.origin ? String(req.headers.origin) : null;
    if (isOriginTrusted(origin, req)) {
      callback(null, baseCorsOptions);
    } else {
      callback(new Error('Origin not allowed by CORS policy'));
    }
  } catch (err) {
    callback(err);
  }
};

const resolvedSameSite = (() => {
  const candidate = String(process.env.SESSION_SAMESITE || 'lax').trim().toLowerCase();
  if (['lax', 'strict', 'none'].includes(candidate)) return candidate;
  return 'lax';
})();
let secureCookies = typeof process.env.SESSION_SECURE !== 'undefined'
  ? coerceBoolean(process.env.SESSION_SECURE)
  : process.env.NODE_ENV === 'production';
if (resolvedSameSite === 'none' && !secureCookies) {
  secureCookies = true;
  console.warn('SESSION_SECURE forced to true because sameSite="none" requires secure cookies');
}

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  frameguard: { action: 'sameorigin' },
  referrerPolicy: { policy: 'same-origin' }
}));
app.use((req, res, next) => { res.setHeader('Vary', 'Origin'); next(); });
app.use(cors(corsOptionsDelegate));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

if (SESSION_KEY) {
  app.use(cookieSession({
    name: 'mmp_sess',
    keys: [SESSION_KEY],
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: resolvedSameSite,
    secure: secureCookies
  }));
}

app.use(verifyCsrfToken);
app.use(attachCsrfToken);

function ensureCsrfToken(req) {
  if (req && req.session) {
    if (!req.session.csrfToken || typeof req.session.csrfToken !== 'string') {
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }
    return req.session.csrfToken;
  }
  if (!req._csrfFallbackToken) req._csrfFallbackToken = crypto.randomBytes(32).toString('hex');
  return req._csrfFallbackToken;
}

function verifyCsrfToken(req, res, next) {
  if (SAFE_CSRF_METHODS.has(req.method)) return next();
  try {
    const expected = req && req.session ? req.session.csrfToken : null;
    const provided = req.get(CSRF_HEADER_NAME) || (req.body && req.body._csrf) || (req.query && req.query._csrf);
    if (!expected || !provided) throw new Error('missing token');
    const expectedBuffer = Buffer.from(String(expected), 'utf8');
    const providedBuffer = Buffer.from(String(provided), 'utf8');
    if (expectedBuffer.length !== providedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
      throw new Error('token mismatch');
    }
    // Don't regenerate CSRF token on every request - keep it stable for the session
    // This prevents race conditions when multiple requests are in flight
    return next();
  } catch (err) {
    try { appendLog(`CSRF_REJECT path=${req && req.originalUrl ? req.originalUrl : req.url}`); } catch (e) {}
    return res.status(403).json({ error: 'invalid csrf token' });
  }
}

function attachCsrfToken(req, res, next) {
  try {
    const token = res.locals && res.locals.csrfToken ? res.locals.csrfToken : ensureCsrfToken(req);
    res.locals.csrfToken = token;
    res.cookie(CSRF_COOKIE_NAME, token, {
      httpOnly: false,
      sameSite: resolvedSameSite,
      secure: secureCookies
    });
    res.setHeader(CSRF_HEADER_NAME, token);
  } catch (err) {
    // best-effort; avoid failing the request if cookies cannot be set
  }
  next();
}

function resolveDeleteHardlinksSetting(username) {
  try {
    if (username && users && users[username] && users[username].settings && typeof users[username].settings.delete_hardlinks_on_unapprove !== 'undefined') {
      return coerceBoolean(users[username].settings.delete_hardlinks_on_unapprove);
    }
    if (serverSettings && typeof serverSettings.delete_hardlinks_on_unapprove !== 'undefined') {
      return coerceBoolean(serverSettings.delete_hardlinks_on_unapprove);
    }
  } catch (e) {}
  return true;
}

// Ensure basic persistent store files exist and load them into memory
try { ensureFile(enrichStoreFile, {}); } catch (e) {}
try { ensureFile(parsedCacheFile, {}); } catch (e) {}
try { ensureFile(scanStoreFile, {}); } catch (e) {}
try { ensureFile(scanCacheFile, {}); } catch (e) {}
try { ensureFile(renderedIndexFile, {}); } catch (e) {}
try { ensureFile(logsFile, ''); } catch (e) {}
try { ensureFile(manualIdsFile, {}); } catch (e) {}
try { ensureFile(approvedSeriesImagesFile, {}); } catch (e) {}
try { ensureFile(wikiEpisodeCacheFile, {}); } catch (e) {}
try { ensureFile(wikiSearchLogFile, ''); } catch (e) {}

// Wikipedia episode cache (in-memory, persisted to wiki-episode-cache.json)
let wikiEpisodeCache = {};
try { wikiEpisodeCache = JSON.parse(fs.readFileSync(wikiEpisodeCacheFile, 'utf8') || '{}') } catch (e) { wikiEpisodeCache = {} }

let approvedSeriesImages = {};
try { approvedSeriesImages = JSON.parse(fs.readFileSync(approvedSeriesImagesFile, 'utf8') || '{}') } catch (e) { approvedSeriesImages = {} }
const approvedSeriesImageFetchLocks = new Map();
const APPROVED_SERIES_FETCH_COOLDOWN_MS = 3000;
const APPROVED_SERIES_BACKGROUND_INTERVAL_MS = 25000;
const APPROVED_SERIES_BACKGROUND_BATCH_SIZE = 3;
let approvedSeriesBackgroundTimer = null;
let approvedSeriesBackgroundInFlight = false;

// Load optional series aliases to control canonical folder names for tricky titles
const CONFIG_DIR = path.resolve(__dirname, 'config');
if (!fs.existsSync(CONFIG_DIR)) {
  try { fs.mkdirSync(CONFIG_DIR) } catch (e) { /* ignore */ }
}
const seriesAliasesFile = path.join(CONFIG_DIR, 'series-aliases.json');
let seriesAliases = {};
try { ensureFile(seriesAliasesFile, {}); seriesAliases = JSON.parse(fs.readFileSync(seriesAliasesFile, 'utf8') || '{}') } catch (e) { seriesAliases = {} }

function getSeriesAlias(name) {
  try {
    if (!name) return null;
    const orig = String(name || '').trim();
    if (!orig) return null;

    // quick exact match for existing canonical entries
    if (seriesAliases && Object.prototype.hasOwnProperty.call(seriesAliases, orig)) return seriesAliases[orig];

    // Normalization helper: convert curly apostrophes to straight, normalize quotes,
    // collapse whitespace, trim, and use lowercase for matching.
    function normalizeSeriesKey(s) {
      try {
        if (!s) return '';
        let out = String(s || '').trim();
        // normalize curly/smart apostrophes and similar characters to straight apostrophe
        out = out.replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\u275B\u275C\uFF07]/g, "'");
        // normalize smart double quotes to straight double-quote
        out = out.replace(/[\u201C\u201D\u201E\u201F]/g, '"');
        // collapse multiple whitespace to single space
        out = out.replace(/\s+/g, ' ');
        out = out.trim();
        return out.toLowerCase();
      } catch (e) { return String(s || '').toLowerCase().trim(); }
    }

    const norm = normalizeSeriesKey(orig);

    // Try normalized-key lookup against alias map keys
    if (seriesAliases) {
      for (const k of Object.keys(seriesAliases)) {
        try {
          if (normalizeSeriesKey(k) === norm) return seriesAliases[k];
        } catch (e) { /* ignore per-key errors */ }
      }
    }

    // Legacy case-insensitive fallback (keeps previous behavior)
    try {
      const lower = orig.toLowerCase();
      for (const k of Object.keys(seriesAliases || {})) {
        if (String(k).toLowerCase() === lower) return seriesAliases[k];
      }
    } catch (e) { /* ignore */ }

    return null;
  } catch (e) { return null }
}

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
// Folder watchers by username: { [username]: watcher }
const folderWatchers = {};

function isFolderWatchEnabledForUser(username) {
  try {
    if (!username || !users || !users[username]) return false;
    return coerceBoolean(users[username].settings && users[username].settings.enable_folder_watch);
  } catch (e) { return false; }
}
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
}

try { healCachedEnglishAndMovieFlags(); } catch (e) { try { appendLog(`ENRICH_CACHE_HEAL_INIT_FAIL err=${e && e.message ? e.message : String(e)}`); } catch (ee) {} }

// Filter out applied/hidden items from loaded scans on startup
// (scans may have been persisted before items were applied/hidden)
try {
  let filteredCount = 0;
  const scanIds = Object.keys(scans || {});
  for (const sid of scanIds) {
    try {
      const scan = scans[sid];
      if (!scan || !Array.isArray(scan.items)) continue;
      const before = scan.items.length;
      scan.items = scan.items.filter(it => {
        try {
          const k = canonicalize(it.canonicalPath);
          const e = enrichCache[k] || null;
          if (e && (e.hidden || e.applied)) return false;
          return true;
        } catch (e) { return true; }
      });
      const removed = before - scan.items.length;
      if (removed > 0) {
        scan.totalCount = scan.items.length;
        filteredCount += removed;
      }
    } catch (e) { /* ignore per-scan errors */ }
  }
  if (filteredCount > 0) {
    try { if (db) db.saveScansObject(scans); else writeJson(scanStoreFile, scans); } catch (e) {}
    appendLog(`STARTUP_SCAN_FILTER removed=${filteredCount} applied/hidden items from persisted scans`);
  }
} catch (e) { appendLog(`STARTUP_SCAN_FILTER_FAIL err=${e && e.message ? e.message : String(e)}`); }

// Initialize DB for scans if available
// (DB was initialized above; this later duplicate block removed)

// Track in-flight scans to prevent concurrent runs for same path/scanId
const activeScans = new Set();
// In-memory progress tracker for background refresh operations
const refreshProgress = {};

// Folder watching helper: start watching a directory for changes
function startFolderWatcher(username, libPath) {
  try {
    // Stop existing watcher if any
    if (folderWatchers[username]) {
      try { folderWatchers[username].close(); } catch (e) {}
      delete folderWatchers[username];
    }

    if (!isFolderWatchEnabledForUser(username)) {
      appendLog(`WATCHER_SKIP_DISABLED username=${username}`);
      return;
    }
    if (!libPath) {
      appendLog(`WATCHER_SKIP_NO_PATH username=${username}`);
      return;
    }
    
    // Don't start watcher if path doesn't exist
    if (!fs.existsSync(libPath) || !fs.statSync(libPath).isDirectory()) {
      appendLog(`WATCHER_SKIP_INVALID_PATH username=${username} path=${libPath}`);
      return;
    }
    
    // Start new watcher with debounce
    let debounceTimer = null;
    const watcher = chokidar.watch(libPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 },
      depth: 10,
      ignorePermissionErrors: true
    });
    folderWatchers[username] = watcher;
    
    const triggerIncrementalScan = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        try {
          appendLog(`WATCHER_TRIGGER_SCAN username=${username} path=${libPath}`);
          const scanLib = require('./lib/scan');
          const loadScanCacheFn = () => scanLib.loadScanCache(scanCacheFile);
          const saveScanCacheFn = (obj) => scanLib.saveScanCache(scanCacheFile, obj);
          
          const result = scanLib.incrementalScanLibrary(libPath, { 
            scanCacheFile, 
            ignoredDirs: new Set(['node_modules','.git','.svn','__pycache__']), 
            videoExts: ['mkv','mp4','avi','mov','m4v','mpg','mpeg','webm','wmv','flv','ts','ogg','ogv','3gp','3g2'], 
            canonicalize, 
            uuidv4 
          });
          saveScanCacheFn(result.currentCache);
          
          // Parse new/changed items so they have basic metadata
          for (const it of (result.toProcess || [])) {
            doProcessParsedItem(it, { username });
          }
          
          // Filter out hidden/applied items before creating scan artifact
          const allItems = scanLib.buildIncrementalItems(result.scanCache, result.toProcess, uuidv4);
          const filteredItems = allItems.filter(it => {
            try {
              const k = canonicalize(it.canonicalPath);
              const e = enrichCache[k] || null;
              if (e && (e.hidden || e.applied)) return false;
              return true;
            } catch (e) { return true; }
          });
          
          const generatedAt = Date.now();
          const scanId = uuidv4();
          const scanObj = { id: scanId, libraryId: 'local', items: filteredItems, generatedAt, incrementalScanPath: libPath, username, totalCount: filteredItems.length };
          
          if (db) {
            try { db.saveScan(scanObj); } catch (e) {}
          }
          scans[scanId] = scanObj;
          if (!db) writeJson(scanStoreFile, scans);
          
          appendLog(`WATCHER_SCAN_COMPLETE username=${username} scanId=${scanId} items=${filteredItems.length} hidden_filtered=${allItems.length - filteredItems.length}`);
        } catch (err) {
          appendLog(`WATCHER_SCAN_ERROR username=${username} err=${err.message}`);
        }
      }, 3000); // 3 second debounce
    };
    
    let readyTriggered = false;
    watcher.on('ready', () => {
      try { appendLog(`WATCHER_READY username=${username} path=${libPath}`); } catch (e) {}
      if (!readyTriggered) {
        readyTriggered = true;
        triggerIncrementalScan();
      }
    });

    watcher.on('add', triggerIncrementalScan);
    watcher.on('change', triggerIncrementalScan);
    watcher.on('unlink', triggerIncrementalScan);
    watcher.on('addDir', triggerIncrementalScan);
    watcher.on('unlinkDir', triggerIncrementalScan);

    watcher.on('error', (err) => {
      try { appendLog(`WATCHER_ERROR username=${username} path=${libPath} err=${err && err.message ? err.message : String(err)}`); } catch (e) {}
      try { watcher.close(); } catch (closeErr) {}
      if (folderWatchers[username] === watcher) delete folderWatchers[username];
      if (isFolderWatchEnabledForUser(username)) {
        setTimeout(() => {
          if (isFolderWatchEnabledForUser(username)) startFolderWatcher(username, libPath);
        }, FOLDER_WATCH_RESTART_DELAY_MS);
      }
    });
    
    appendLog(`WATCHER_STARTED username=${username} path=${libPath}`);
  } catch (err) {
    appendLog(`WATCHER_START_ERROR username=${username} path=${libPath} err=${err.message}`);
  }
}

// Stop watcher for a user
function stopFolderWatcher(username) {
  try {
    if (folderWatchers[username]) {
      const watcher = folderWatchers[username];
      const pathInfo = watcher && watcher.getWatched ? Object.keys(watcher.getWatched() || {}).join('|') : '';
      try { watcher.close(); } catch (e) {}
      delete folderWatchers[username];
      appendLog(`WATCHER_STOPPED username=${username} watched=${pathInfo || '<unknown>'}`);
    }
  } catch (err) {
    appendLog(`WATCHER_STOP_ERROR username=${username} err=${err.message}`);
  }
}

// Initialize watchers for all users with scan_input_path on startup
function initializeAllWatchers() {
  try {
    for (const username in users) {
      const user = users[username];
      if (user && user.settings && user.settings.scan_input_path && isFolderWatchEnabledForUser(username)) {
        const libPath = path.resolve(user.settings.scan_input_path);
        startFolderWatcher(username, libPath);
      } else {
        stopFolderWatcher(username);
      }
    }
  } catch (err) {
    appendLog(`WATCHER_INIT_ALL_ERROR err=${err.message}`);
  }
}

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
      return (recall * 0.75) + (precision * 0.25);
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
    try { 
      console.error('writeJson failed', filePath, e && e.message ? e.message : e);
      appendLog(`WRITE_JSON_FAIL path=${filePath} err=${e.message}`);
    } catch (ee) {}
  }
}

// Persist all caches to disk/database immediately
// Used during graceful shutdown and critical operations to prevent data loss
function persistEnrichCacheNow() {
  try {
    if (db) {
      db.setKV('enrichCache', enrichCache);
      db.setKV('renderedIndex', renderedIndex);
      db.setKV('parsedCache', parsedCache);
      appendLog('CACHE_PERSIST_NOW db=true');
    } else {
      writeJson(enrichStoreFile, enrichCache);
      writeJson(renderedIndexFile, renderedIndex);
      writeJson(parsedCacheFile, parsedCache);
      appendLog('CACHE_PERSIST_NOW files=true');
    }
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    appendLog(`CACHE_PERSIST_ERROR ${msg}`);
    console.error('persistEnrichCacheNow failed:', e);
    throw e;
  }
}

function safeCloneJson(value, context) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value, (_key, val) => (typeof val === 'bigint' ? String(val) : val)));
  } catch (e) {
    if (context) {
      try { appendLog(`JSON_CLONE_FAIL context=${context} err=${e && e.message ? e.message : String(e)}`); } catch (ee) {}
    }
    return null;
  }
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

function buildExtraGuessSnapshot(source) {
  if (!source || typeof source !== 'object') return null;
  const base = (source.extraGuess && typeof source.extraGuess === 'object') ? source.extraGuess : null;
  return sanitizeExtraGuess(base, source);
}

function extractProviderRaw(data) {
  try {
    if (!data || typeof data !== 'object') return null;
    if (data.provider && data.provider.raw) return data.provider.raw;
    if (data.raw) return data.raw;
    return null;
  } catch (e) {
    return null;
  }
}

function cloneProviderRaw(raw) {
  if (!raw || typeof raw !== 'object') return raw || null;
  return safeCloneJson(raw, 'providerRaw');
}

// Helper to clean enrichment entries before returning to client
// Removes stale provider.renderedName so frontend computes it from current provider.title
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

// Normalizer to ensure enrich entries have consistent shape used by the UI
function normalizeEnrichEntry(entry) {
  try {
    entry = entry || {};
    const out = Object.assign({}, entry);
    const extraSnapshot = buildExtraGuessSnapshot(entry);
    const extraSource = extraSnapshot || (entry.extraGuess && typeof entry.extraGuess === 'object' ? entry.extraGuess : null);
    out.extraGuess = extraSnapshot;
    out.parsed = entry.parsed || (entry.parsedName || entry.title ? { title: entry.title || null, parsedName: entry.parsedName || null, season: entry.season != null ? entry.season : null, episode: entry.episode != null ? entry.episode : null } : null);
    out.provider = entry.provider || null;
    
    // DEFENSIVE FIX: If provider.source is an object (corrupted cache), fix it
    if (out.provider && out.provider.source && typeof out.provider.source === 'object') {
      // Try to extract a valid source string, otherwise set to null
      const srcObj = out.provider.source;
      out.provider.source = (typeof srcObj.source === 'string' ? srcObj.source : 
                              (typeof srcObj.provider === 'string' ? srcObj.provider : null));
    }
    
    // For multi-part movies, normalize the provider title by removing colons before "Part X"
    // e.g., "Harry Potter and the Deathly Hallows: Part 1" -> "Harry Potter and the Deathly Hallows Part 1"
    const parsedTitle = out.parsed && out.parsed.title;
    const providerTitle = out.provider && out.provider.title;
    
    // Strip colon separator before "Part X" in provider titles
    if (providerTitle && out.provider && /:\s*Part\s+\d{1,2}\b/i.test(providerTitle)) {
      out.provider.title = providerTitle.replace(/:\s*(Part\s+\d{1,2}\b)/i, ' $1');
    }
    
    out.title = out.title || (out.provider && out.provider.title) || (out.parsed && out.parsed.title) || null;
  out.seriesTitle = entry.seriesTitle || (extraSource && extraSource.seriesTitle) || out.seriesTitle || out.title || null;
  out.seriesTitleExact = entry.seriesTitleExact || (extraSource && (extraSource.seriesTitleExact || extraSource.originalSeriesTitle)) || out.seriesTitleExact || null;
  out.seriesTitleEnglish = entry.seriesTitleEnglish || (extraSource && extraSource.seriesTitleEnglish) || (entry.provider && entry.provider.seriesTitleEnglish) || out.seriesTitleEnglish || null;
  out.seriesTitleRomaji = entry.seriesTitleRomaji || (extraSource && extraSource.seriesTitleRomaji) || (entry.provider && entry.provider.seriesTitleRomaji) || out.seriesTitleRomaji || null;
  if (typeof entry.isMovie === 'boolean') out.isMovie = entry.isMovie;
  else if (extraSource && typeof extraSource.isMovie === 'boolean') out.isMovie = extraSource.isMovie;
  if (!out.mediaFormat && entry.mediaFormat) out.mediaFormat = entry.mediaFormat;
  if (!out.mediaFormat && extraSource && extraSource.mediaFormat) out.mediaFormat = extraSource.mediaFormat;
    out.originalSeriesTitle = entry.originalSeriesTitle || (extraSource && extraSource.originalSeriesTitle) || out.originalSeriesTitle || null;
    if (!out.title && out.seriesTitle) out.title = out.seriesTitle;
    out.seriesLookupTitle = entry.seriesLookupTitle || (extraSource && extraSource.seriesLookupTitle) || out.seriesLookupTitle || null;
    try {
      // Normalize apostrophes to straight single-quote for display fields
      if (out.title && typeof out.title === 'string') out.title = normalizeApostrophes(out.title);
      if (out.seriesTitle && typeof out.seriesTitle === 'string') out.seriesTitle = normalizeApostrophes(out.seriesTitle);
      if (out.seriesTitleEnglish && typeof out.seriesTitleEnglish === 'string') out.seriesTitleEnglish = normalizeApostrophes(out.seriesTitleEnglish);
      if (out.seriesTitleRomaji && typeof out.seriesTitleRomaji === 'string') out.seriesTitleRomaji = normalizeApostrophes(out.seriesTitleRomaji);
      if (out.originalSeriesTitle && typeof out.originalSeriesTitle === 'string') out.originalSeriesTitle = normalizeApostrophes(out.originalSeriesTitle);
      if (out.seriesLookupTitle && typeof out.seriesLookupTitle === 'string') out.seriesLookupTitle = normalizeApostrophes(out.seriesLookupTitle);

      // Also normalize parsed/title variants so parsed cache updates use straight apostrophes
      if (out.parsed && out.parsed.title && typeof out.parsed.title === 'string') out.parsed.title = normalizeApostrophes(out.parsed.title);
      if (out.parsed && out.parsed.parsedName && typeof out.parsed.parsedName === 'string') out.parsed.parsedName = normalizeApostrophes(out.parsed.parsedName);

      // Apply title casing after apostrophe normalization
      if (out.seriesTitle && typeof out.seriesTitle === 'string') out.seriesTitle = titleCase(out.seriesTitle);
      if (out.seriesTitleEnglish && typeof out.seriesTitleEnglish === 'string') out.seriesTitleEnglish = titleCase(out.seriesTitleEnglish);
      if (out.seriesTitleRomaji && typeof out.seriesTitleRomaji === 'string') out.seriesTitleRomaji = titleCase(out.seriesTitleRomaji);
      if (out.originalSeriesTitle && typeof out.originalSeriesTitle === 'string') out.originalSeriesTitle = titleCase(out.originalSeriesTitle);
      if (out.seriesLookupTitle && typeof out.seriesLookupTitle === 'string') out.seriesLookupTitle = titleCase(out.seriesLookupTitle);
      // If provider/title is all-caps, normalize to title case for display
      try {
        const isAllCaps = (s) => {
          if (!s) return false;
          const letters = String(s).replace(/[^a-zA-Z]/g, '');
          return letters.length > 0 && letters === letters.toUpperCase();
        }
        if (out.title && typeof out.title === 'string' && isAllCaps(out.title)) {
          out.title = titleCase(out.title);
        }
        if (out.provider && out.provider.title && typeof out.provider.title === 'string' && isAllCaps(out.provider.title)) {
          out.provider.title = titleCase(out.provider.title);
        }
      } catch (e) { /* ignore title-case errors */ }
    } catch (e) { /* ignore title-case errors */ }
    if (typeof out.parentCandidate === 'undefined') {
      const parentGuess = entry.parentCandidate || (extraSource && extraSource.parentCandidate) || null;
      if (parentGuess) out.parentCandidate = parentGuess;
    }
    out.parsedName = out.parsedName || (out.parsed && out.parsed.parsedName) || null;
    out.season = (typeof out.season !== 'undefined' && out.season !== null) ? out.season : (out.parsed && typeof out.parsed.season !== 'undefined' ? out.parsed.season : null);
    out.episode = (typeof out.episode !== 'undefined' && out.episode !== null) ? out.episode : (out.parsed && typeof out.parsed.episode !== 'undefined' ? out.parsed.episode : null);
    try {
      const providerRaw = out.provider && out.provider.raw && typeof out.provider.raw === 'object' ? out.provider.raw : null;
      const mediaType = providerRaw ? (providerRaw.media_type || providerRaw.mediaType || null) : null;
      if (!out.mediaFormat && mediaType) out.mediaFormat = String(mediaType);
      if (typeof out.isMovie !== 'boolean' && mediaType) {
        const mediaTypeNorm = String(mediaType).toLowerCase();
        if (mediaTypeNorm.includes('movie') || mediaTypeNorm === 'film') out.isMovie = true;
        else if (mediaTypeNorm.includes('tv') || mediaTypeNorm.includes('series') || mediaTypeNorm.includes('show')) out.isMovie = false;
      }
    } catch (e) { /* ignore media_type normalization errors */ }
    out.timestamp = out.timestamp || Date.now();
    const normalizedFailure = normalizeProviderFailure(entry.providerFailure);
    out.providerFailure = normalizedFailure;
    if (out.provider && out.provider.matched) out.providerFailure = null;

    // Prefer parsed/exact and child-relation matches over a parent-provider fallback when obvious.
    try {
      // Respect explicit aliases: do not alter if an alias exists
      const alias = getSeriesAlias(out.seriesTitle || out.title || '');
      const rawPick = (entry && entry.provider && entry.provider.raw) ? entry.provider.raw : null;
      // 1) If we have a provider raw with relation nodes, try to match a child relation to parsed title or parsedName
      try {
        const parsedTitle = out.parsed && out.parsed.title ? String(out.parsed.title).trim() : null;
        const parsedName = out.parsedName || null;
        const lookupCandidates = [];
        if (parsedTitle) lookupCandidates.push(parsedTitle);
        if (parsedName) lookupCandidates.push(parsedName);
        if (out.seriesLookupTitle) lookupCandidates.push(out.seriesLookupTitle);
        if (out.title) lookupCandidates.push(out.title);

        function normForCompare(s) { try { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g,''); } catch (e) { return String(s || '') } }

        if (!alias && rawPick) {
          // AniList-style relations: rawPick.relations.nodes or rawPick.relations.edges
          let nodes = null
          if (rawPick.relations && Array.isArray(rawPick.relations.nodes)) {
            nodes = rawPick.relations.nodes
          } else if (rawPick.relations && Array.isArray(rawPick.relations.edges)) {
            // Extract nodes from edges structure
            nodes = rawPick.relations.edges.map(e => e && e.node).filter(Boolean)
          } else if (rawPick.series && rawPick.series.relations && Array.isArray(rawPick.series.relations.nodes)) {
            nodes = rawPick.series.relations.nodes
          }
          
          if (nodes && nodes.length) {
            for (const node of nodes) {
              try {
                // gather possible names for the node
                const names = [];
                if (node.title && typeof node.title === 'object') {
                  if (node.title.english) names.push(node.title.english);
                  if (node.title.romaji) names.push(node.title.romaji);
                  if (node.title.native) names.push(node.title.native);
                }
                if (node.name) names.push(node.name);
                if (node.aliases && Array.isArray(node.aliases)) names.push(...node.aliases);
                const normNames = names.map(normForCompare).filter(Boolean);
                // helper: normalized levenshtein distance
                function levenshteinNorm(a,b) {
                  try {
                    const A = String(a||''); const B = String(b||'');
                    const al = A.length, bl = B.length;
                    if (al === 0) return bl;
                    if (bl === 0) return al;
                    const dp = Array.from({length: al+1}, () => Array(bl+1).fill(0));
                    for (let i=0;i<=al;i++) dp[i][0]=i;
                    for (let j=0;j<=bl;j++) dp[0][j]=j;
                    for (let i=1;i<=al;i++){
                      for (let j=1;j<=bl;j++){
                        const cost = A[i-1] === B[j-1] ? 0 : 1;
                        dp[i][j] = Math.min(dp[i-1][j] + 1, dp[i][j-1] + 1, dp[i-1][j-1] + cost);
                      }
                    }
                    const dist = dp[al][bl];
                    const norm = dist / Math.max(al, bl, 1);
                    return norm;
                  } catch (e) { return 1 }
                }
                for (const cand of lookupCandidates) {
                  const nc = normForCompare(cand);
                  if (!nc) continue;
                  for (const nn of normNames) {
                    if (nn && nc && (nn === nc || nn.indexOf(nc) !== -1 || nc.indexOf(nn) !== -1)) {
                      // match! prefer this node's english or romaji title
                      const chosen = (node.title && (node.title.english || node.title.romaji || node.title.native)) ? (node.title.english || node.title.romaji || node.title.native) : (names[0] || null);
                      if (chosen) {
                        try { appendLog(`PICK_RELATION_CHILD match=${String(cand).slice(0,120)} node=${String(chosen).slice(0,120)}`) } catch (e) {}
                        out.seriesTitle = chosen;
                        out.seriesTitleEnglish = (node.title && node.title.english) ? node.title.english : out.seriesTitleEnglish || null;
                        break;
                      }
                    } else {
                      // fuzzy heuristics: token overlap or small normalized edit distance
                      try {
                        // token overlap
                        const candTokens = String(cand || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
                        const nameTokens = String(names.join(' ') || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
                        const overlap = candTokens.filter(t => nameTokens.indexOf(t) !== -1);
                        if (overlap.length && overlap.some(t => t.length >= 3)) {
                          const chosen = (node.title && (node.title.english || node.title.romaji || node.title.native)) ? (node.title.english || node.title.romaji || node.title.native) : (names[0] || null);
                          if (chosen) {
                            try { appendLog(`PICK_RELATION_CHILD_FUZZY tokenOverlap=${overlap.join(',')} match=${String(cand).slice(0,120)} node=${String(chosen).slice(0,120)}`) } catch (e) {}
                            out.seriesTitle = chosen;
                            out.seriesTitleEnglish = (node.title && node.title.english) ? node.title.english : out.seriesTitleEnglish || null;
                            break;
                          }
                        }
                        // normalized edit distance check against each name
                        for (const rawName of names) {
                          const nnRaw = normForCompare(rawName || '');
                          const ncRaw = normForCompare(cand || '');
                          if (!nnRaw || !ncRaw) continue;
                          const nscore = levenshteinNorm(nnRaw, ncRaw);
                          if (nscore <= 0.35) {
                            const chosen = (node.title && (node.title.english || node.title.romaji || node.title.native)) ? (node.title.english || node.title.romaji || node.title.native) : (names[0] || null);
                            if (chosen) {
                              try { appendLog(`PICK_RELATION_CHILD_FUZZY_lev dist=${nscore.toFixed(3)} match=${String(cand).slice(0,120)} node=${String(chosen).slice(0,120)}`) } catch (e) {}
                              out.seriesTitle = chosen;
                              out.seriesTitleEnglish = (node.title && node.title.english) ? node.title.english : out.seriesTitleEnglish || null;
                              break;
                            }
                          }
                        }
                      } catch (e) { /* ignore fuzzy errors */ }
                    }
                  }
                  if (out.seriesTitle && out.seriesTitle === (node.title && (node.title.english || node.title.romaji || node.title.native))) break;
                }
                if (out.seriesTitle && out.seriesTitle === (node.title && (node.title.english || node.title.romaji || node.title.native))) break;
              } catch (e) { /* ignore node errors */ }
            }
          }
        }
        // 2) Prefer parsed/exact candidate when confident and when provider appears to be a parent fallback
        try {
          const parsedTitle = out.parsed && out.parsed.title ? String(out.parsed.title).trim() : null;
          // Removed looksLikeEpisodeTitleCandidate check - was causing valid subtitles to be stripped
          if (!alias && parsedTitle && parsedTitle.length > 2) {
            // if provider raw indicates relations (parent) or provider lacks a clear seriesTitleExact, prefer parsedTitle
            const providerLooksLikeParent = !!(rawPick && (rawPick.relations || (rawPick.series && rawPick.series.relations)));
            if (providerLooksLikeParent || !out.seriesTitleExact) {
              if (out.seriesTitle !== parsedTitle) {
                try { appendLog(`PICK_PARSED_OVER_PARENT parsed=${String(parsedTitle).slice(0,200)} prev=${String(out.seriesTitle).slice(0,200)}`) } catch (e) {}
                out.seriesTitle = parsedTitle;
              }
            }
          }
        } catch (e) {}
      } catch (e) { /* best-effort relation handling */ }

      // 3) Strip season-like suffixes from series/title when safe (use AniList-aware when raw present)
      // IMPORTANT: Skip this for movies to preserve "Part N" in multi-part movie titles
      try {
        if (!alias && !out.isMovie) {
          if (out.seriesTitle) {
            const before = out.seriesTitle;
            const after = rawPick ? stripAniListSeasonSuffix(before, rawPick) : stripSeasonNumberSuffix(before);
            if (after && after !== before) {
              try { appendLog(`STRIP_SEASON_NORMALIZED series before=${String(before).slice(0,200)} after=${String(after).slice(0,200)}`); } catch (e) {}
              out.seriesTitle = after;
            }
          }
          if (out.title) {
            const beforeT = out.title;
            const afterT = rawPick ? stripAniListSeasonSuffix(beforeT, rawPick) : stripSeasonNumberSuffix(beforeT);
            if (afterT && afterT !== beforeT) {
              try { appendLog(`STRIP_SEASON_NORMALIZED title before=${String(beforeT).slice(0,200)} after=${String(afterT).slice(0,200)}`); } catch (e) {}
              out.title = afterT;
            }
          }
        }
      } catch (e) { /* best-effort */ }
    } catch (e) { /* best-effort outer */ }
    
    // Preserve applied/hidden state flags
    if (typeof entry.applied === 'boolean') out.applied = entry.applied;
    if (typeof entry.hidden === 'boolean') out.hidden = entry.hidden;
    if (entry.appliedAt) out.appliedAt = entry.appliedAt;
    if (entry.appliedTo) out.appliedTo = entry.appliedTo;
    if (entry.hiddenAt) out.hiddenAt = entry.hiddenAt;
    
    // Note: provider.renderedName is preserved here for cache completeness checks
    // It will be removed by cleanEnrichmentForClient() when sending to frontend
    
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


function httpRequest(options, body, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function safeJsonParse(input) {
  try { return JSON.parse(input || '{}'); } catch (e) { return null; }
}

async function fetchAniListById(id) {
  if (!id) return null;
  const numericId = Number(String(id).trim());
  if (!Number.isFinite(numericId)) return null;
  const query = `query ($id: Int) { Media(id: $id) { id title { english romaji native } seasonYear startDate { year } format episodes nextAiringEpisode { episode airingAt } } }`;
  const payload = JSON.stringify({ query, variables: { id: numericId } });
  const res = await httpRequest({ hostname: 'graphql.anilist.co', path: '/', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, payload, 8000);
  if (!res || res.statusCode !== 200) return null;
  const parsed = safeJsonParse(res.body);
  const media = parsed && parsed.data && parsed.data.Media ? parsed.data.Media : null;
  if (!media) return null;
  
  // Apply intelligent title selection (same logic as searchAniList)
  let name = null;
  if (media.title) {
    const english = media.title.english ? String(media.title.english).trim() : null;
    const romaji = media.title.romaji ? String(media.title.romaji).trim() : null;
    const native = media.title.native ? String(media.title.native).trim() : null;
    
    // Helper to check if a string is all uppercase (ignoring non-letter characters)
    const isAllCaps = (str) => {
      if (!str) return false;
      const letters = String(str).replace(/[^a-zA-Z]/g, '');
      return letters.length > 0 && letters === letters.toUpperCase();
    };
    
    // Check if English and romaji are the same string aside from casing
    const areSameIgnoreCase = (str1, str2) => {
      if (!str1 || !str2) return false;
      return String(str1).toLowerCase() === String(str2).toLowerCase();
    };
    
    // If English exists and is all-caps
    if (english && isAllCaps(english)) {
      // If romaji is the same string with better casing, use romaji
      if (romaji && areSameIgnoreCase(english, romaji)) {
        name = romaji;
      } else {
        // Otherwise apply title-case to the English name
        name = titleCase(english);
      }
    } else {
      // Use standard priority: english > romaji > native
      name = english || romaji || native;
    }
  }
  
  const year = media.seasonYear || (media.startDate && media.startDate.year) || null;
  return { id: numericId, name, year, raw: media };
}

async function fetchTmdbById(id, apiKey, season, episode) {
  if (!id || !apiKey) return null;
  const tmdbId = String(id).trim();
  if (!tmdbId) return null;
  const baseHeaders = { 'Accept': 'application/json' };
  const tvPath = `/3/tv/${encodeURIComponent(tmdbId)}?api_key=${encodeURIComponent(apiKey)}&language=en-US`;
  let res = await httpRequest({ hostname: 'api.themoviedb.org', path: tvPath, method: 'GET', headers: baseHeaders }, null, 8000);
  let parsed = res && res.statusCode === 200 ? safeJsonParse(res.body) : null;
  let isMovie = false;
  if (!parsed) {
    const moviePath = `/3/movie/${encodeURIComponent(tmdbId)}?api_key=${encodeURIComponent(apiKey)}&language=en-US`;
    res = await httpRequest({ hostname: 'api.themoviedb.org', path: moviePath, method: 'GET', headers: baseHeaders }, null, 8000);
    parsed = res && res.statusCode === 200 ? safeJsonParse(res.body) : null;
    isMovie = true;
  }
  if (!parsed) return null;

  const name = parsed.name || parsed.title || null;
  const year = parsed.first_air_date || parsed.release_date || null;
  let episodePayload = null;
  if (!isMovie && season != null && episode != null) {
    const epPath = `/3/tv/${encodeURIComponent(tmdbId)}/season/${encodeURIComponent(season)}/episode/${encodeURIComponent(episode)}?api_key=${encodeURIComponent(apiKey)}&language=en-US`;
    const epRes = await httpRequest({ hostname: 'api.themoviedb.org', path: epPath, method: 'GET', headers: baseHeaders }, null, 8000);
    const epParsed = epRes && epRes.statusCode === 200 ? safeJsonParse(epRes.body) : null;
    if (epParsed && epParsed.name) episodePayload = { name: epParsed.name, source: 'tmdb', media_type: 'tv', raw: epParsed };
  }

  const raw = Object.assign({}, parsed, { id: tmdbId, source: 'tmdb', media_type: isMovie ? 'movie' : 'tv' });
  return { id: tmdbId, name, year, raw, episode: episodePayload };
}

async function fetchTvdbById(id, creds, season, episode, log) {
  if (!id || !creds) return null;
  const seriesId = String(id).trim();
  if (!seriesId) return null;
  const seriesExtended = await tvdb.fetchSeriesExtended(creds, seriesId, log);
  const seriesName = seriesExtended && (seriesExtended.name || seriesExtended.seriesName) ? (seriesExtended.name || seriesExtended.seriesName) : null;
  const episodeData = (season != null && episode != null) ? await tvdb.fetchEpisodeBySeries(creds, seriesId, season, episode, log) : null;
  return {
    id: seriesId,
    name: seriesName,
    year: seriesExtended && seriesExtended.year ? seriesExtended.year : null,
    raw: { series: seriesExtended || null, episode: episodeData || null },
    episodeTitle: episodeData ? episodeData.episodeTitle : null
  };
}

async function metaLookup(title, apiKey, opts = {}) {
  // Lightweight, rate-limited meta lookup using AniList -> Kitsu -> TMDb fallback.
  // Inputs: title (string), apiKey (tmdb key, optional), opts may include season, episode, parentCandidate, parentPath, _parentDirect
  // Output: Promise resolving to { name, raw, episode } or null
  if (!title) return Promise.resolve(null)

  const tvdbCreds = resolveTvdbCredentials(opts && opts.username ? opts.username : null, opts && opts.tvdbOverride ? opts.tvdbOverride : null)
  const providerOrderRaw = Array.isArray(opts.providerOrder) ? opts.providerOrder : (typeof opts.providerOrder === 'string' ? [opts.providerOrder] : null)
  const providerOrder = sanitizeMetadataProviderOrder(providerOrderRaw || DEFAULT_METADATA_PROVIDER_ORDER)
  const metaProvidersOrder = providerOrder.filter(id => id !== 'anidb')
  const metaProviderSet = new Set(metaProvidersOrder)
  const allowAniList = metaProviderSet.has('anilist')
  const allowTvdb = metaProviderSet.has('tvdb')
  const allowTmdb = metaProviderSet.has('tmdb')
  const allowWikipedia = metaProviderSet.has('wikipedia')
  const allowKitsu = metaProviderSet.has('kitsu')
  const indexInOrder = (id) => metaProvidersOrder.indexOf(id)
  const aniListIndex = indexInOrder('anilist')
  const tvdbIndex = indexInOrder('tvdb')
  const tmdbIndex = indexInOrder('tmdb')
  const wikipediaIndex = indexInOrder('wikipedia')
  const kitsuIndex = indexInOrder('kitsu')
  const hasEpisodeProviderAfterAniList = aniListIndex !== -1 && metaProvidersOrder.slice(aniListIndex + 1).some((p) => (
    p === 'tvdb' || p === 'tmdb' || p === 'wikipedia' || p === 'kitsu'
  ))

  // Manual provider ID overrides (skip AniDB when manual IDs are present)
  const manualAnilistId = getManualId(title, 'anilist')
  const manualTmdbId = getManualId(title, 'tmdb')
  const manualTvdbId = getManualId(title, 'tvdb')
  const manualAniDbEpisodeId = getManualId(title, 'anidbEpisode', opts.filePath || null)
  let manualAniDbEpisodeFetched = false
  let manualAniDbEpisodeData = null

  function buildManualAniDbEpisodePayload(info) {
    if (!info) return null
    const title = info.episodeTitle || null
    if (!title) return null
    return {
      name: title,
      title,
      localized_name: title,
      source: 'anidb',
      raw: info.raw || null
    }
  }

  async function fetchManualAniDbEpisode() {
    if (manualAniDbEpisodeFetched) return manualAniDbEpisodeData
    manualAniDbEpisodeFetched = true
    if (!manualAniDbEpisodeId) return null
    if (!opts || !opts.anidb_username || !opts.anidb_password) {
      try { appendLog(`MANUAL_ID_ANIDB_EP_SKIP reason=missing-credentials id=${manualAniDbEpisodeId} title=${title}`) } catch (e) {}
      return null
    }
    try {
      const clientName = opts.anidb_client_name || 'mmprename'
      const clientVersion = opts.anidb_client_version || 1
      const anidbClient = getAniDBUDPClient(opts.anidb_username, opts.anidb_password, clientName, clientVersion)
      const episodeInfo = await anidbClient.lookupEpisode(manualAniDbEpisodeId)
      if (!episodeInfo) {
        try { appendLog(`MANUAL_ID_ANIDB_EP_NONE id=${manualAniDbEpisodeId} title=${title}`) } catch (e) {}
        return null
      }
      const episodeTitle = String(episodeInfo.englishName || episodeInfo.romajiName || episodeInfo.kanjiName || '').trim()
      if (!episodeTitle) {
        try { appendLog(`MANUAL_ID_ANIDB_EP_EMPTY_TITLE id=${manualAniDbEpisodeId} title=${title}`) } catch (e) {}
        return null
      }
      manualAniDbEpisodeData = {
        episodeTitle,
        raw: Object.assign({}, episodeInfo || {}, { eid: manualAniDbEpisodeId })
      }
      try { appendLog(`MANUAL_ID_ANIDB_EP_OK id=${manualAniDbEpisodeId} title=${title} episodeTitle=${episodeTitle}`) } catch (e) {}
      return manualAniDbEpisodeData
    } catch (err) {
      try { appendLog(`MANUAL_ID_ANIDB_EP_ERROR id=${manualAniDbEpisodeId} title=${title} err=${err && err.message ? err.message : String(err)}`) } catch (e) {}
      return null
    }
  }

  let effectiveProvidersOrder = metaProvidersOrder
  if (manualAnilistId || manualTmdbId || manualTvdbId) {
    const manualProviders = metaProvidersOrder.filter((p) => (
      (p === 'anilist' && manualAnilistId) ||
      (p === 'tmdb' && manualTmdbId) ||
      (p === 'tvdb' && manualTvdbId)
    ))
    const remainingProviders = metaProvidersOrder.filter((p) => !manualProviders.includes(p))
    if (manualProviders.length) {
      effectiveProvidersOrder = [...manualProviders, ...remainingProviders]
      try { appendLog(`MANUAL_ID_PROVIDER_ORDER title=${title} order=${effectiveProvidersOrder.join('|')}`) } catch (e) {}
    }
  }

  // Minimal per-host pacing to avoid hammering external APIs
  const hostPace = { 'graphql.anilist.co': 250, 'kitsu.io': 250, 'api.themoviedb.org': 300, 'en.wikipedia.org': 300 } // ms
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

  let storedAniListResult = null
  let storedAniListVariants = null

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
    
    // When expectationList is null (filename-based search), trust AniList's search API.
    // AniList already matched this result via synonyms/aliases, so we don't need strict
    // word overlap validation. This prevents rejecting correct matches when the filename
    // uses shortened/alternate names (e.g., "sutetsuyo" for "Japan Anima(tor)'s Exhibition").
    const hasExplicitExpectations = Array.isArray(expectationList) && expectationList.length > 0;
    
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
    
    // Only enforce minimum score check when we have explicit expectations (parent candidate search).
    // For filename-based searches (no explicit expectations), trust AniList's search result.
    if (hasExplicitExpectations && bestScore < MIN_ANILIST_MATCH_SCORE) {
      try { appendLog(`META_ANILIST_MISMATCH context=${contextLabel} query=${queryVariant || '<none>'} candidate=${bestName ? bestName.slice(0,120) : '<none>'} expected=${bestExpected ? bestExpected.slice(0,120) : '<none>'} score=${bestScore.toFixed(2)}`) } catch (e) {}
      return { ok: false, bestScore, bestName, bestExpected }
    }
    
    // Log successful match for diagnostics
    if (!hasExplicitExpectations && bestScore < MIN_ANILIST_MATCH_SCORE) {
      try { appendLog(`META_ANILIST_ACCEPT_LOW_OVERLAP context=${contextLabel} query=${queryVariant || '<none>'} candidate=${bestName ? bestName.slice(0,120) : '<none>'} score=${bestScore.toFixed(2)} reason=trust_anilist_search`) } catch (e) {}
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
  // Filter out short/generic terms that would cause false matches
  function isValidSearchTerm(term) {
    if (!term || term.length < 4) return false;
    // Reject common generic words that appear in release tags and would match wrong series
    const GENERIC_WORDS = new Set(['app', 'the', 'and', 'for', 'with', 'from', 'this', 'that', 'they', 'them', 'have', 'more', 'been', 'into', 'time', 'will', 'than', 'all', 'out', 'two', 'can', 'may', 'sub', 'dub', 'raw', 'web', 'tv']);
    return !GENERIC_WORDS.has(term.toLowerCase());
  }
  function makeVariants(t){ const s = String(t || '').trim(); const variants = []; if (!s) return variants; variants.push(s); const cleaned = s.replace(/[._\-:]+/g,' ').replace(/\s+/g,' ').trim(); variants.push(cleaned); const stripped = cleaned.replace(/\s*[\[(].*?[\])]/g, '').replace(/\s+/g,' ').trim(); if (stripped && stripped !== cleaned) variants.push(stripped); variants.push(stripped.toLowerCase()); return [...new Set(variants)].filter(v => isValidSearchTerm(v)).slice(0,5) }

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
      // Include relation edges with relationType to identify parent/prequel relationships
      const query = `query ($search: String) { Page(page:1, perPage:8) { media(search: $search, type: ANIME) { id title { romaji english native } format episodes startDate { year } season seasonYear nextAiringEpisode { episode airingAt } relations { edges { relationType node { id title { romaji english native } format episodes } } } } } }`;
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
                  // Support both old nodes structure and new edges structure
                  if (it && it.relations) {
                    if (Array.isArray(it.relations.nodes)) {
                      for (const rn of it.relations.nodes) {
                        if (rn && rn.title) titles.push(rn.title.english, rn.title.romaji, rn.title.native)
                      }
                    }
                    if (Array.isArray(it.relations.edges)) {
                      for (const edge of it.relations.edges) {
                        if (edge && edge.node && edge.node.title) titles.push(edge.node.title.english, edge.node.title.romaji, edge.node.title.native)
                      }
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
      if (pickSeasonNum !== null && wantedSeason !== null && pickSeasonNum !== wantedSeason && pick.relations) {
        // Support both old nodes structure and new edges structure
        let relationNodes = null
        if (Array.isArray(pick.relations.nodes)) {
          relationNodes = pick.relations.nodes
        } else if (Array.isArray(pick.relations.edges)) {
          relationNodes = pick.relations.edges.map(e => e && e.node).filter(Boolean)
        }
        
        if (relationNodes && relationNodes.length) {
          for (const rn of relationNodes) {
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
    }
  } catch (e) {}

  // Select the best title, handling all-caps English titles intelligently
  let rawName = null
  if (pick && pick.title) {
    const english = pick.title.english ? String(pick.title.english).trim() : null
    const romaji = pick.title.romaji ? String(pick.title.romaji).trim() : null
    const native = pick.title.native ? String(pick.title.native).trim() : null
    
    // Helper to check if a string is all uppercase (ignoring non-letter characters)
    const isAllCaps = (str) => {
      if (!str) return false
      const letters = String(str).replace(/[^a-zA-Z]/g, '')
      return letters.length > 0 && letters === letters.toUpperCase()
    }
    
    // Check if English and romaji are the same string aside from casing
    const areSameIgnoreCase = (str1, str2) => {
      if (!str1 || !str2) return false
      return String(str1).toLowerCase() === String(str2).toLowerCase()
    }
    
    // If English exists and is all-caps
    if (english && isAllCaps(english)) {
      // If romaji is the same string with better casing, use romaji
      if (romaji && areSameIgnoreCase(english, romaji)) {
        rawName = romaji
      } else {
        // Otherwise apply title-case to the English name
        rawName = titleCase(english)
      }
    } else {
      // Use standard priority: english > romaji > native
      rawName = english || romaji || native
    }
  } else if (pick && (pick.romaji || pick.english || pick.native)) {
    rawName = pick.english || pick.romaji || pick.native
  }
  
  const name = stripAniListSeasonSuffix(rawName, pick)
  
  // Extract parent series information from relations (PREQUEL, PARENT, SOURCE)
  // This helps organize sequels/seasons under the parent series folder
  let parentSeriesTitle = null
  let parentSeriesId = null
  let detectedSeasonNumber = null
  
  try {
    // First, try to detect season number from the current title
    if (rawName) {
      detectedSeasonNumber = extractSeasonNumberFromTitle(rawName)
    }
    
    // Look for parent/prequel relationships
    if (pick && pick.relations && Array.isArray(pick.relations.edges)) {
      // Priority order: PARENT > PREQUEL > SOURCE
      const parentTypes = ['PARENT', 'PREQUEL', 'SOURCE']
      let bestParent = null
      
      for (const pType of parentTypes) {
        const edge = pick.relations.edges.find(e => e && e.relationType === pType)
        if (edge && edge.node) {
          bestParent = edge.node
          break
        }
      }
      
      if (bestParent && bestParent.title) {
        const parentTitle = bestParent.title.english || bestParent.title.romaji || bestParent.title.native
        if (parentTitle) {
          // Check if parent title doesn't have a season marker (indicating it's the root series)
          const parentSeasonNum = extractSeasonNumberFromTitle(parentTitle)
          if (!parentSeasonNum) {
            parentSeriesTitle = stripAniListSeasonSuffix(parentTitle, bestParent)
            parentSeriesId = bestParent.id
            try { appendLog(`META_ANILIST_PARENT_DETECTED child=${String(rawName).slice(0,80)} parent=${String(parentSeriesTitle).slice(0,80)} season=${detectedSeasonNumber || 'unknown'}`) } catch (e) {}
          }
        }
      }
    }
  } catch (e) {
    try { appendLog(`META_ANILIST_PARENT_EXTRACT_ERROR err=${e.message}`) } catch (e2) {}
  }
  
  return { 
    provider: 'anilist', 
    id: pick.id, 
    name: name, 
    raw: pick,
    parentSeriesTitle: parentSeriesTitle,
    parentSeriesId: parentSeriesId,
    detectedSeasonNumber: detectedSeasonNumber
  }
    } catch (e) { 
      try { appendLog(`META_ANILIST_SEARCH_ERROR err=${e.message} stack=${e.stack}`) } catch (e2) {}
      return null 
    }
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
      if (!epTitle) return null
      const trimmed = String(epTitle).trim()
      if (!trimmed) return null
      const payload = {
        name: trimmed,
        title: trimmed,
        localized_name: trimmed,
        source: 'kitsu',
        raw: ep
      }
      try { if (ep && ep.id) payload.id = ep.id } catch (e) {}
      return payload
    } catch (e) { return null }
  }

  // TMDb lightweight search + episode fetch (fallback) - supports both TV shows and movies
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

  // Try AniList variants, then parent, then TMDb fallback
  const variants = makeVariants(normalizeSearchQuery(title || ''))
  let parentCandidate = opts && opts.parentCandidate ? String(opts.parentCandidate).trim() : null
  if (!parentCandidate && opts && opts.parentPath) {
    try {
      const pp = require('./lib/filename-parser')(path.basename(opts.parentPath))
      if (pp && pp.title) parentCandidate = pp.title
    } catch (e) {}
  }

  async function attemptAniList() {
    if (!allowAniList) return null
    try {
      if (manualAnilistId) {
        try { appendLog(`MANUAL_ID_ANILIST_FETCH id=${manualAnilistId} title=${title}`) } catch (e) {}
        const manual = await fetchAniListById(manualAnilistId)
        if (manual) {
          const variantsFromManual = []
          try {
            if (manual.raw && manual.raw.title) {
              if (manual.raw.title.english) variantsFromManual.push(manual.raw.title.english)
              if (manual.raw.title.romaji) variantsFromManual.push(manual.raw.title.romaji)
              if (manual.raw.title.native) variantsFromManual.push(manual.raw.title.native)
            }
          } catch (e) {}
          if (manual.name) variantsFromManual.push(manual.name)
          const uniqueTitleVariants = [...new Set(variantsFromManual.map(s => String(s || '').trim()).filter(Boolean))]
          const rawPayload = Object.assign({}, manual.raw || {}, { id: manual.id, source: 'anilist' })
          const manualResult = { name: manual.name || title, raw: rawPayload, episode: null, provider: 'anilist', titleVariants: uniqueTitleVariants }
          storedAniListResult = Object.assign({}, manualResult, { titleVariants: uniqueTitleVariants })
          storedAniListVariants = uniqueTitleVariants
          if (!hasEpisodeProviderAfterAniList) return manualResult
        }
      }
      // normalize search title to avoid SxxEyy noise
      // try filename-derived variants first
      let aniListResult = null
      for (let i=0;i<Math.min(variants.length,3);i++) {
      const v = variants[i]
      let a = await searchAniList(v)
      try { appendLog(`META_ANILIST_SEARCH q=${v} found=${a ? 'yes' : 'no'}`) } catch (e) {}
      if (!a) continue
      
      // If we matched a sequel/continuation series that hasn't aired yet, but it has a parent series,
      // check if the requested episode has actually aired and use the parent instead if not
      try {
        if (a && a.raw && a.parentSeriesId && opts && opts.episode != null) {
          const hasAired = a.raw.startDate && a.raw.startDate.year != null
          const requestedEpisode = Number(opts.episode)
          
          // Check nextAiringEpisode to see what episode will air next
          // If nextAiringEpisode.episode is 5, then episodes 1-4 have aired
          let lastAiredEpisode = null
          if (a.raw.nextAiringEpisode && a.raw.nextAiringEpisode.episode != null) {
            lastAiredEpisode = Number(a.raw.nextAiringEpisode.episode) - 1
          }
          
          // Determine if we should use the parent series:
          // 1. Series hasn't aired at all (no year)
          // 2. Requested episode is beyond the last aired episode
          const shouldUseParent = !hasAired || (lastAiredEpisode != null && requestedEpisode > lastAiredEpisode)
          
          if (shouldUseParent) {
            try { appendLog(`META_ANILIST_SEQUEL_FALLBACK_TO_PARENT child=${String(a.name).slice(0,80)} parentId=${a.parentSeriesId} hasAired=${hasAired} lastAiredEp=${lastAiredEpisode != null ? lastAiredEpisode : 'unknown'} requestedEp=${requestedEpisode}`) } catch (e) {}
            
            // Fetch the parent series by ID
            const parentResult = await fetchAniListById(a.parentSeriesId)
            if (parentResult) {
              try { appendLog(`META_ANILIST_PARENT_FETCHED id=${a.parentSeriesId} name=${String(parentResult.name).slice(0,80)}`) } catch (e) {}
              a = parentResult
            }
          }
        }
      } catch (e) {
        try { appendLog(`META_ANILIST_PARENT_FALLBACK_ERROR err=${e.message}`) } catch (e2) {}
      }
      
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

      if (!ep && manualAniDbEpisodeId) {
        const manualEpisode = await fetchManualAniDbEpisode()
        const payload = buildManualAniDbEpisodePayload(manualEpisode)
        if (payload) ep = payload
      }

      if (!ep && allowTvdb && tvdbCreds && opts && opts.season != null && opts.episode != null) {
        try {
          const tvdbEpisode = await tvdb.fetchEpisode(tvdbCreds, uniqueTitleVariants, opts.season, opts.episode, {
            log: (line) => {
              try { appendLog(line) } catch (e) {}
            }
          });
          if (tvdbEpisode && tvdbEpisode.episodeTitle) {
            // Extract year from seriesFirstAired
            let seriesYear = null;
            if (tvdbEpisode.seriesFirstAired) {
              const yearMatch = String(tvdbEpisode.seriesFirstAired).match(/^(\d{4})/);
              if (yearMatch) seriesYear = yearMatch[1];
            }
            
            tvdbInfo = {
              seriesId: tvdbEpisode.seriesId,
              seriesName: tvdbEpisode.seriesName,
              seriesYear: seriesYear,
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

  if (!ep && allowTmdb && apiKey) {
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

  if (!ep && allowWikipedia) {
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
                    ep = { name: wikiEp.name, title: wikiEp.name, localized_name: wikiEp.name, source: 'wikipedia', raw: wikiEp.raw };
                    try { appendLog(`META_WIKIPEDIA_PREFERRED_OVER_TM_PLACEHOLDER q=${aniListName} wiki=${wikiEp.name} tm=${tmNameCheck}`) } catch (e) {}
                  } else if (isMeaningfulTitle(tmNameCheck) && !isPlaceholderTitle(tmNameCheck)) {
                    ep = tmEpCheck.episode;
                    try { appendLog(`META_TMDB_VERIFIED_OVER_WIKI_NONLATIN q=${aniListName} tm=${tmNameCheck}`) } catch (e) {}
                  } else if (wikiGood) {
                    ep = { name: wikiEp.name, title: wikiEp.name, localized_name: wikiEp.name, source: 'wikipedia', raw: wikiEp.raw };
                    try { appendLog(`META_WIKIPEDIA_FALLBACK_NONLATIN q=${aniListName} wiki=${wikiEp.name} tm=${tmNameCheck}`) } catch (e) {}
                  }
                } else {
                  ep = { name: wikiEp.name, title: wikiEp.name, localized_name: wikiEp.name, source: 'wikipedia', raw: wikiEp.raw };
                  try { appendLog(`META_WIKIPEDIA_EP_AFTER_ANILIST_OK q=${aniListName} epName=${wikiEp.name}`) } catch (e) {}
                }
              } catch (e) {
                ep = { name: wikiEp.name, title: wikiEp.name, localized_name: wikiEp.name, source: 'wikipedia', raw: wikiEp.raw };
                try { appendLog(`META_WIKIPEDIA_EP_AFTER_ANILIST_OK q=${aniListName} epName=${wikiEp.name}`) } catch (ee) {}
              }
            } else {
              ep = { name: wikiEp.name, title: wikiEp.name, localized_name: wikiEp.name, source: 'wikipedia', raw: wikiEp.raw };
              try { appendLog(`META_WIKIPEDIA_EP_AFTER_ANILIST_OK q=${aniListName} epName=${wikiEp.name}`) } catch (e) {}
            }
          } else if (wikiEp && wikiEp.name && !wikiParentMatch) {
            try { appendLog(`META_WIKIPEDIA_PARENT_MISMATCH intended=${intendedSeries} gotPage=${wikiEp.raw && wikiEp.raw.page ? wikiEp.raw.page : '<none>'}`) } catch (e) {}
          }
        } catch (e) {}
      }

      // If still no episode title, try Kitsu as a fallback
      if (!ep && allowKitsu) {
        if (allowTmdb && !apiKey) { try { appendLog(`META_TMDB_SKIPPED_NO_KEY q=${aniListName}`) } catch (e) {} }
        ep = await fetchKitsuEpisode(strippedAniListName || aniListName || v, opts && opts.episode != null ? opts.episode : null)
        try { appendLog(`META_KITSU_EP q=${aniListName} ep=${opts && opts.episode != null ? opts.episode : '<none>'} found=${ep && (ep.name||ep.title) ? 'yes' : 'no'}`) } catch (e) {}
      }

      // capture result and break out of the loop
      const aniListRawPayload = Object.assign({}, a.raw, { id: a.id, source: 'anilist' })
      if (tvdbInfo) {
        try { aniListRawPayload.tvdb = { seriesId: tvdbInfo.seriesId, seriesName: tvdbInfo.seriesName } } catch (e) {}
      }
      aniListResult = { name: a.name, raw: aniListRawPayload, episode: ep, provider: 'anilist', titleVariants: uniqueTitleVariants }
      if (tvdbInfo) {
        try { aniListResult.tvdb = tvdbInfo } catch (e) {}
      }
      break
    }
    if (aniListResult) {
      const variantsForStore = Array.isArray(aniListResult.titleVariants) ? aniListResult.titleVariants : []
      storedAniListResult = Object.assign({}, aniListResult, { titleVariants: variantsForStore })
      storedAniListVariants = variantsForStore
      const aniListIsMovie = (() => {
        try {
          const raw = aniListResult && aniListResult.raw ? aniListResult.raw : {}
          const format = raw && raw.format ? String(raw.format).toUpperCase() : ''
          return format === 'MOVIE'
        } catch (e) { return false }
      })()
      if (aniListIsMovie) {
        try { appendLog(`META_ANILIST_MOVIE_SKIP_EP_PROVIDERS title=${String(aniListResult.name || '').slice(0,120)}`) } catch (e) {}
        return aniListResult
      }
      if (!hasEpisodeProviderAfterAniList || (aniListResult && aniListResult.episode && (aniListResult.episode.name || aniListResult.episode.title))) {
        return aniListResult
      }
    }

    // try parent-derived candidate if provided or derivable
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
        const parentIsMovie = (() => {
          try {
            const raw = a && a.raw ? a.raw : {}
            const format = raw && raw.format ? String(raw.format).toUpperCase() : ''
            return format === 'MOVIE'
          } catch (e) { return false }
        })()
        if (parentIsMovie) {
          try { appendLog(`META_ANILIST_PARENT_MOVIE_SKIP_EP title=${String(parentAniListName || '').slice(0,120)}`) } catch (e) {}
        }

  if (!parentIsMovie && !ep && manualAniDbEpisodeId) {
          const manualEpisode = await fetchManualAniDbEpisode()
          const payload = buildManualAniDbEpisodePayload(manualEpisode)
          if (payload) ep = payload
        }

  if (!parentIsMovie && !ep && allowTvdb && tvdbCreds && opts && opts.season != null && opts.episode != null) {
          try {
            const tvdbEpisode = await tvdb.fetchEpisode(tvdbCreds, uniqueTitleVariantsP, opts.season, opts.episode, {
              log: (line) => {
                try { appendLog(line) } catch (e) {}
              }
            });
            if (tvdbEpisode && tvdbEpisode.episodeTitle) {
              // Extract year from seriesFirstAired
              let seriesYear = null;
              if (tvdbEpisode.seriesFirstAired) {
                const yearMatch = String(tvdbEpisode.seriesFirstAired).match(/^(\d{4})/);
                if (yearMatch) seriesYear = yearMatch[1];
              }
              
              tvdbInfoParent = {
                seriesId: tvdbEpisode.seriesId,
                seriesName: tvdbEpisode.seriesName,
                seriesYear: seriesYear,
                episodeTitle: tvdbEpisode.episodeTitle,
                parentSeriesName: tvdbEpisode.parentSeriesName || null,
                parentSeriesId: tvdbEpisode.parentSeriesId || null,
                raw: tvdbEpisode.raw
              };
              ep = {
                name: tvdbEpisode.episodeTitle,
                title: tvdbEpisode.episodeTitle,
                localized_name: tvdbEpisode.episodeTitle,
                source: 'tvdb',
                raw: tvdbEpisode.raw && tvdbEpisode.raw.episode ? tvdbEpisode.raw.episode : tvdbEpisode.raw
              };
              try { ep.tvdb = { seriesId: tvdbEpisode.seriesId, seriesName: tvdbEpisode.seriesName, parentSeriesName: tvdbEpisode.parentSeriesName, parentSeriesId: tvdbEpisode.parentSeriesId }; } catch (e) {}
              try { appendLog(`META_TVDB_EP_AFTER_PARENT q=${parentAniListName} epName=${String(tvdbEpisode.episodeTitle).slice(0,120)} parentSeries=${tvdbEpisode.parentSeriesName || 'none'}`) } catch (e) {}
            } else {
              try { appendLog(`META_TVDB_EP_AFTER_PARENT_NONE q=${parentAniListName}`) } catch (e) {}
            }
          } catch (e) {
            try { appendLog(`META_TVDB_EP_AFTER_PARENT_ERROR q=${parentAniListName} err=${e && e.message ? e.message : String(e)}`) } catch (ee) {}
          }
        }

  if (!parentIsMovie && !ep && allowTmdb && apiKey) {
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

  if (!parentIsMovie && !ep && allowWikipedia) {
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
                      ep = { name: wikiEp.name, title: wikiEp.name, localized_name: wikiEp.name, source: 'wikipedia', raw: wikiEp.raw };
                      try { appendLog(`META_WIKIPEDIA_PREFERRED_PARENT_LATIN q=${parentAniListName} wiki=${wikiEp.name} tm=${tmParentName}`) } catch (e) {}
                    } else if (isMeaningfulTitle(tmParentName) && !isPlaceholderTitle(tmParentName)) {
                      ep = tmEpCheck.episode;
                      try { appendLog(`META_TMDB_VERIFIED_OVER_WIKI_PARENT_NONLATIN q=${parentAniListName} tm=${tmParentName}`) } catch (e) {}
                    } else {
                      ep = { name: wikiEp.name, title: wikiEp.name, localized_name: wikiEp.name, source: 'wikipedia', raw: wikiEp.raw };
                      try { appendLog(`META_WIKIPEDIA_EP_AFTER_ANILIST_PARENT_OK q=${parentAniListName} epName=${wikiEp.name}`) } catch (e) {}
                    }
                  } else {
                    ep = { name: wikiEp.name, title: wikiEp.name, localized_name: wikiEp.name, source: 'wikipedia', raw: wikiEp.raw };
                    try { appendLog(`META_WIKIPEDIA_EP_AFTER_ANILIST_PARENT_OK q=${parentAniListName} epName=${wikiEp.name}`) } catch (e) {}
                  }
                } catch (e) {
                  ep = { name: wikiEp.name, title: wikiEp.name, localized_name: wikiEp.name, source: 'wikipedia', raw: wikiEp.raw };
                  try { appendLog(`META_WIKIPEDIA_EP_AFTER_ANILIST_PARENT_OK q=${parentAniListName} epName=${wikiEp.name}`) } catch (ee) {}
                }
              } else {
                ep = { name: wikiEp.name, title: wikiEp.name, localized_name: wikiEp.name, source: 'wikipedia', raw: wikiEp.raw };
                try { appendLog(`META_WIKIPEDIA_EP_AFTER_ANILIST_PARENT_OK q=${parentAniListName} epName=${wikiEp.name}`) } catch (e) {}
              }
            } else if (wikiEp && wikiEp.name && !wikiParentMatch) {
              try { appendLog(`META_WIKIPEDIA_PARENT_MISMATCH intended=${intendedSeries} gotPage=${wikiEp.raw && wikiEp.raw.page ? wikiEp.raw.page : '<none>'}`) } catch (e) {}
            }
          } catch (e) {}
        }

        if (!parentIsMovie && !ep && allowKitsu) {
          if (allowTmdb && !apiKey) { try { appendLog(`META_TMDB_SKIPPED_NO_KEY_PARENT q=${parentAniListName}`) } catch (e) {} }
          ep = await fetchKitsuEpisode(strippedParentName || parentAniListName || parentCandidate, opts && opts.episode != null ? opts.episode : null)
          try { appendLog(`META_KITSU_EP_PARENT q=${parentAniListName} ep=${opts && opts.episode != null ? opts.episode : '<none>'} found=${ep && (ep.name||ep.title) ? 'yes' : 'no'}`) } catch (e) {}
        }

        const parentRaw = Object.assign({}, a.raw, { id: a.id, source: 'anilist' })
        if (tvdbInfoParent) {
          try { parentRaw.tvdb = { seriesId: tvdbInfoParent.seriesId, seriesName: tvdbInfoParent.seriesName } } catch (e) {}
        }
        const parentRes = { name: a.name, raw: parentRaw, episode: ep, provider: 'anilist', titleVariants: uniqueTitleVariantsP }
        if (tvdbInfoParent) {
          try { parentRes.tvdb = tvdbInfoParent } catch (e) {}
        }
        storedAniListResult = Object.assign({}, parentRes, { titleVariants: uniqueTitleVariantsP })
        storedAniListVariants = uniqueTitleVariantsP
        if (parentIsMovie) {
          return parentRes
        }
        if (!hasEpisodeProviderAfterAniList || (parentRes && parentRes.episode && (parentRes.episode.name || parentRes.episode.title))) {
          return parentRes
        }
      }
    }
    } catch (e) {
      try { appendLog(`META_ANILIST_SEGMENT_ERROR err=${e && e.message ? e.message : String(e)}`) } catch (ee) {}
    }
    return null
  }

  async function attemptTvdb(baseResult = null) {
    if (!allowTvdb || !tvdbCreds || !(opts && opts.season != null && opts.episode != null)) return null
    try {
      if (manualTvdbId) {
        try { appendLog(`MANUAL_ID_TVDB_FETCH id=${manualTvdbId} title=${title}`) } catch (e) {}
        const manual = await fetchTvdbById(manualTvdbId, tvdbCreds, opts && opts.season, opts && opts.episode, (line) => { try { appendLog(line) } catch (e) {} })
        if (manual) {
          const episodeObj = manual.episodeTitle ? { name: manual.episodeTitle, title: manual.episodeTitle, localized_name: manual.episodeTitle, source: 'tvdb', raw: manual.raw && manual.raw.episode ? manual.raw.episode : manual.raw } : null
          if (baseResult) {
            const merged = Object.assign({}, baseResult, { episode: episodeObj })
            try {
              if (merged.raw && typeof merged.raw === 'object') {
                merged.raw.tvdb = { seriesId: manual.id, seriesName: manual.name }
              }
            } catch (e) {}
            try { merged.tvdb = manual } catch (e) {}
            return merged
          }
          return { name: manual.name || title, raw: { source: 'tvdb', id: manual.id, seriesName: manual.name }, episode: episodeObj, tvdb: manual }
        }
      }
      const candidatePool = []
      candidatePool.push(...variants)
      if (parentCandidate) candidatePool.push(parentCandidate)
      if (storedAniListVariants && storedAniListVariants.length) candidatePool.push(...storedAniListVariants)
      if (baseResult && baseResult.name) candidatePool.push(baseResult.name)
      const fallbackCandidates = [...new Set(candidatePool.map(s => String(s || '').trim()).filter(Boolean))]
      if (!fallbackCandidates.length) return null
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
        try { appendLog(`META_TVDB_FALLBACK q=${fallbackCandidates[0]} epName=${String(tvdbFallback.episodeTitle).slice(0,120)}`) } catch (e) {}
        if (baseResult) {
          const merged = Object.assign({}, baseResult, { episode: episodeObj })
          try {
            if (merged.raw && typeof merged.raw === 'object') {
              merged.raw.tvdb = { seriesId: tvdbFallback.seriesId, seriesName: tvdbFallback.seriesName }
            }
          } catch (e) { /* best-effort */ }
        try { merged.tvdb = tvdbFallback } catch (e) {}
          // capture fallback year from TVDB episode aired date (preferred) or series data for AniList base results
          try {
            if (merged.raw && !merged.raw._fallbackProviderYear) {
              // Prefer episode's aired date for accurate year, fall back to series date
              const maybe = (tvdbFallback.raw && tvdbFallback.raw.episode && (tvdbFallback.raw.episode.aired || tvdbFallback.raw.episode.firstAired || tvdbFallback.raw.episode.air_date)) || (tvdbFallback.raw && tvdbFallback.raw.series && (tvdbFallback.raw.series.first_air_date || tvdbFallback.raw.series.startDate)) || tvdbFallback.raw && (tvdbFallback.raw.first_air_date || tvdbFallback.raw.release_date) || null
              if (maybe) {
                const yy = new Date(String(maybe)).getFullYear()
                if (!Number.isNaN(yy) && yy > 0) merged.raw._fallbackProviderYear = String(yy)
              }
            }
          } catch (e) {}
          return merged
        }
        // when returning a pure TVDB-only result, populate a fallback year as well
        try {
          if (providerRaw && !providerRaw._fallbackProviderYear) {
            // Prefer episode's aired date for accurate year, fall back to series date
            const maybe = (tvdbFallback.raw && tvdbFallback.raw.episode && (tvdbFallback.raw.episode.aired || tvdbFallback.raw.episode.firstAired || tvdbFallback.raw.episode.air_date)) || (tvdbFallback.raw && tvdbFallback.raw.series && (tvdbFallback.raw.series.first_air_date || tvdbFallback.raw.series.startDate)) || tvdbFallback.raw && (tvdbFallback.raw.first_air_date || tvdbFallback.raw.release_date) || null
            if (maybe) {
              const yy = new Date(String(maybe)).getFullYear()
              if (!Number.isNaN(yy) && yy > 0) providerRaw._fallbackProviderYear = String(yy)
            }
          }
        } catch (e) {}
        return { name: tvdbFallback.seriesName || fallbackCandidates[0], raw: providerRaw, episode: episodeObj, tvdb: tvdbFallback }
      }
      try { appendLog(`META_TVDB_FALLBACK_NONE candidates=${fallbackCandidates.slice(0,3).join('|')}`) } catch (e) {}
    } catch (e) {
      try { appendLog(`META_TVDB_FALLBACK_ERROR err=${e && e.message ? e.message : String(e)}`) } catch (ee) {}
    }
    return null
  }

  async function attemptTmdb(baseResult = null) {
    if (!allowTmdb || !apiKey) return null

    const inferTmdbMediaType = (rawObj, hasEpisodeContext) => {
      try {
        if (rawObj && (rawObj.media_type || rawObj.mediaType)) return String(rawObj.media_type || rawObj.mediaType).toLowerCase()
        if (rawObj && rawObj.release_date && !rawObj.first_air_date) return 'movie'
        if (rawObj && (rawObj.first_air_date || rawObj.number_of_episodes || rawObj.episode_run_time)) return 'tv'
        return hasEpisodeContext ? 'tv' : 'movie'
      } catch (e) {
        return hasEpisodeContext ? 'tv' : 'movie'
      }
    }

    if (manualTmdbId) {
      try { appendLog(`MANUAL_ID_TMDB_FETCH id=${manualTmdbId} title=${title}`) } catch (e) {}
      const t = await fetchTmdbById(manualTmdbId, apiKey, opts && opts.season, opts && opts.episode)
      if (t) {
        const episodePayload = t.episode || null
        const hasEpisodeContext = (opts && opts.season != null && opts && opts.episode != null)
        const mediaType = inferTmdbMediaType(t.raw, hasEpisodeContext)
        const providerRaw = Object.assign({}, t.raw || {}, { id: t.id, source: 'tmdb', media_type: mediaType })
        if (baseResult) {
          const merged = Object.assign({}, baseResult, { episode: episodePayload })
          if (merged.raw && typeof merged.raw === 'object') {
            try { merged.raw.tmdb = { id: t.id, name: t.name, media_type: mediaType } } catch (e) {}
          }
          try { merged.tmdb = Object.assign({}, t, { raw: providerRaw }) } catch (e) {}
          try { appendLog(`TMDB_MEDIA_TYPE_RESOLVED path=manual id=${t.id} media_type=${mediaType}`) } catch (e) {}
          return merged
        }
        try { appendLog(`TMDB_MEDIA_TYPE_RESOLVED path=manual id=${t.id} media_type=${mediaType}`) } catch (e) {}
        return { provider: 'tmdb', id: t.id, name: t.name, raw: providerRaw, episode: episodePayload }
      }
    }
    const attemptLookup = async (query) => {
      if (!query) return null
      const t = await searchTmdbAndEpisode(query, apiKey, opts && opts.season != null ? opts.season : null, opts && opts.episode != null ? opts.episode : null)
      try { appendLog(`META_TMDB_SEARCH q=${query} found=${t ? 'yes' : 'no'}`) } catch (e) {}
      if (!t) return null
      let episodePayload = t.episode || null
      if (episodePayload && baseResult && episodePayload.name && !isMeaningfulTitle(episodePayload.name)) {
        episodePayload = null
      }
      // Attempt a Wikipedia lookup for the episode title and prefer it when meaningful.
      try {
        const wikiTryTitles = []
        if (t.name) wikiTryTitles.push(t.name)
        if (query) wikiTryTitles.push(query)
        const wikiEp = await lookupWikipediaEpisode(wikiTryTitles.length ? wikiTryTitles : t.name, opts && opts.season != null ? opts.season : null, opts && opts.episode != null ? opts.episode : null, { tmdbKey: apiKey, force: false })
        if (wikiEp && wikiEp.name) {
          try { appendLog(`META_WIKIPEDIA_PREFERRED_AFTER_TMDB q=${t.name || query} wiki=${wikiEp.name}`) } catch (e) {}
          episodePayload = { name: wikiEp.name }
        }
      } catch (e) { /* ignore wiki lookup errors and fall back to TMDb episode */ }

      const hasEpisodeContext = (opts && opts.season != null && opts && opts.episode != null)
      const mediaType = inferTmdbMediaType(t.raw, hasEpisodeContext)
      const providerRaw = Object.assign({}, t.raw || {}, { id: t.id, source: 'tmdb', media_type: mediaType })
      if (baseResult) {
        const merged = Object.assign({}, baseResult, { episode: episodePayload })
        if (merged.raw && typeof merged.raw === 'object') {
          try { merged.raw.tmdb = { id: t.id, name: t.name, media_type: mediaType } } catch (e) {}
        }
        try { merged.tmdb = Object.assign({}, t, { raw: providerRaw }) } catch (e) {}
        try { appendLog(`TMDB_MEDIA_TYPE_RESOLVED path=lookup id=${t.id} media_type=${mediaType}`) } catch (e) {}
        // If we merged TMDb into an AniList base result, capture a fallback year
        try {
          if (merged.raw && !merged.raw._fallbackProviderYear) {
            const maybe = providerRaw.first_air_date || providerRaw.release_date || (providerRaw.attributes && (providerRaw.attributes.startDate || providerRaw.attributes.releaseDate)) || null
            if (maybe) {
              const yy = new Date(String(maybe)).getFullYear()
              if (!Number.isNaN(yy) && yy > 0) merged.raw._fallbackProviderYear = String(yy)
            }
          }
        } catch (e) {}
        return merged
      }
      // when returning a pure TMDb-only result, populate a fallback year field as well
      try {
        if (providerRaw && !providerRaw._fallbackProviderYear) {
          const maybe = providerRaw.first_air_date || providerRaw.release_date || (providerRaw.attributes && (providerRaw.attributes.startDate || providerRaw.attributes.releaseDate)) || null
          if (maybe) {
            const yy = new Date(String(maybe)).getFullYear()
            if (!Number.isNaN(yy) && yy > 0) providerRaw._fallbackProviderYear = String(yy)
          }
        }
      } catch (e) {}
      try { appendLog(`TMDB_MEDIA_TYPE_RESOLVED path=lookup id=${t.id} media_type=${mediaType}`) } catch (e) {}
      return { provider: 'tmdb', id: t.id, name: t.name, raw: providerRaw, episode: episodePayload, tmdb: Object.assign({}, t, { raw: providerRaw }) }
    }

    for (let i = 0; i < Math.min(variants.length, 3); i++) {
      const res = await attemptLookup(variants[i])
      if (res) return res
    }
    if (parentCandidate) {
      const parentVariants = makeVariants(parentCandidate)
      for (let i = 0; i < Math.min(parentVariants.length, 3); i++) {
        const res = await attemptLookup(parentVariants[i])
        if (res) return res
      }
    }
    if (storedAniListVariants && storedAniListVariants.length) {
      for (let i = 0; i < Math.min(storedAniListVariants.length, 3); i++) {
        const res = await attemptLookup(storedAniListVariants[i])
        if (res) return res
      }
    }
    return null
  }

  let partialResult = null
  for (const providerId of effectiveProvidersOrder) {
    if (providerId === 'anilist') {
      const res = await attemptAniList()
      if (res) return res
      if (storedAniListResult) partialResult = storedAniListResult
      continue
    }
    if (providerId === 'tvdb') {
      const res = await attemptTvdb(partialResult || storedAniListResult || null)
      if (res) return res
      continue
    }
    if (providerId === 'tmdb') {
      const res = await attemptTmdb(partialResult || storedAniListResult || null)
      if (res) return res
      continue
    }
  }

  if (storedAniListResult) return storedAniListResult
  return null
}

// ...existing code...

async function externalEnrich(canonicalPath, providedKey, opts = {}) {
  try {
    console.log('DEBUG: externalEnrich START path=', canonicalPath, 'providedKeyPresent=', !!providedKey);
  } catch (e) {}
  
  try {
    // Main function body wrapped in try-catch to prevent crashes
    return await _externalEnrichImpl(canonicalPath, providedKey, opts);
  } catch (fatalErr) {
    console.error('[Server] FATAL ERROR in externalEnrich:', fatalErr);
    try {
      appendLog(`ENRICH_FATAL_ERROR path=${canonicalPath} error=${fatalErr.message || String(fatalErr)}`);
    } catch (logErr) {
      console.error('[Server] Failed to log fatal error:', logErr);
    }
    
    // Return a minimal valid enrichment object to prevent UI crashes
    const base = require('path').basename(canonicalPath);
    return {
      sourceId: 'error:fatal',
      title: base,
      seriesTitle: base,
      parsedName: base,
      season: null,
      episode: null,
      episodeTitle: null,
      provider: null,
      source: null,
      language: 'en',
      timestamp: Date.now()
    };
  }
}

async function _externalEnrichImpl(canonicalPath, providedKey, opts = {}) {
  
  // Strip the configured scan input path from canonicalPath BEFORE any parsing or parent derivation.
  // This ensures the library root (e.g., "/mnt/Tor") never appears in parsed segments or parent candidates.
  // Priority: per-user setting -> server setting -> env var.
  let strippedPath = canonicalPath;
  try {
    let configuredInput = null;
    if (opts && opts.username && users && users[opts.username] && users[opts.username].settings && users[opts.username].settings.scan_input_path) {
      configuredInput = String(users[opts.username].settings.scan_input_path);
    } else if (serverSettings && serverSettings.scan_input_path) {
      configuredInput = String(serverSettings.scan_input_path);
    } else if (process.env.SCAN_INPUT_PATH) {
      configuredInput = String(process.env.SCAN_INPUT_PATH);
    }
    if (configuredInput) {
      // Normalize separators and trailing slashes for consistent matching
      const configNorm = configuredInput.replace(/\\/g, '/').replace(/\/+$/, '');
      const pathNorm = String(canonicalPath).replace(/\\/g, '/');
      try { appendLog(`META_STRIP_LIBRARY_PATH username=${opts && opts.username || '<none>'} configuredInput=${configNorm} pathBefore=${pathNorm}`) } catch (e) {}
      // Case-insensitive prefix match (handles Windows drive letters)
      if (pathNorm.toLowerCase().startsWith(configNorm.toLowerCase())) {
        strippedPath = pathNorm.slice(configNorm.length);
        // Remove leading slash after stripping
        if (strippedPath.startsWith('/')) strippedPath = strippedPath.slice(1);
        try { appendLog(`META_STRIP_LIBRARY_PATH_RESULT pathAfter=${strippedPath}`) } catch (e) {}
      }
    }
  } catch (e) {
    try { appendLog(`META_STRIP_LIBRARY_PATH_ERROR err=${e && e.message ? e.message : String(e)}`) } catch (ee) {}
  }
  
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
  // Use strippedPath (library root already removed) instead of canonicalPath
  const base = path.basename(strippedPath, path.extname(strippedPath));
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
      // Use strippedPath (library root already removed at function entry) for parent derivation
      let parent = path.dirname(strippedPath)
      // normalize separators to '/' so splitting works for both Windows and POSIX-style input
      let parentNorm = String(parent).replace(/\\/g,'/');
      let parts = parentNorm.split('/').filter(Boolean)
      // Use the remaining path segments to derive a candidate.
      // Keep a conservative filter to avoid episode/season folders.
      const segments = parts;
    const SKIP_FOLDER_TOKENS = new Set(['input','library','scan','local','media','video']);
    for (let i = segments.length - 1; i >= 0; i--) {
      try {
        const seg = segments[i]
        if (!seg) continue
        
        // Check if the raw segment is a season folder before parsing
        // This catches "Season 1", "Season 01", "S01", etc.
        if (isSeasonFolderToken(seg)) {
          try { appendLog(`META_PARENT_SKIP_SEASON_FOLDER seg=${String(seg).slice(0,50)}`) } catch (e) {}
          continue
        }
        
        // Check if the raw segment is an extras/bonus folder before parsing
        // This catches "Featurettes", "Extras", "Bonus", "Behind the Scenes", etc.
        if (isExtrasFolderToken(seg)) {
          try { appendLog(`META_PARENT_SKIP_EXTRAS_FOLDER seg=${String(seg).slice(0,50)}`) } catch (e) {}
          continue
        }
        
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

  // Check if parsed title looks episode-like OR if it appears to be an episode title
  // (e.g., filename is "S02E08-Roast Beef, Cheesecake Again.mkv" where the parsed title
  // is "Roast Beef, Cheesecake Again" - this should use parent folder as series name)
  const parsedTitleLooksEpisodeLike = !seriesName || isEpisodeTokenCandidate(seriesName) || /^episode\b/i.test(String(seriesName)) || /^part\b/i.test(String(seriesName))
  
  // Check if the original filename (basename) starts with episode marker followed by dash/space
  // indicating the parsed title is likely an episode title, not series name
  // Use strippedPath to match the path used for parsing
  let filenameStartsWithEpisode = false;
  try {
    const bn = path.basename(strippedPath, path.extname(strippedPath));
    // Match patterns like: S01E01-, S01E01 -, E01-, 1x01-, etc. at start of filename
    // Also match if the basename is ONLY episode marker + title (no series name before it)
    if (/^(S\d{1,2}E\d{1,3}|E\d{1,3}|\d{1,2}x\d{1,3})\s*[-\s]/i.test(bn)) {
      filenameStartsWithEpisode = true;
      try { appendLog(`META_FILENAME_EPISODE_PATTERN basename=${String(bn).slice(0,100)}`) } catch (e) {}
    }
  } catch (e) {}
  
  if (parentCandidate && (parsedTitleLooksEpisodeLike || filenameStartsWithEpisode)) {
    try { appendLog(`META_PARENT_ELEVATED parsedTitle=${String(seriesName).slice(0,120)} parent=${parentCandidate} path=${String(canonicalPath).slice(0,200)} reason=${filenameStartsWithEpisode ? 'filename-starts-with-episode' : 'episode-like'}`) } catch (e) {}
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
  const providerOrder = resolveMetadataProviderOrder(username)
  if (providerOrder && providerOrder.length) {
    attemptedProvider = true;
    let res = null;
    try {
      // Use strippedPath (library root already removed) for parentPath derivation
      let parentPath = path.resolve(path.dirname(strippedPath))
      // If parentPath is empty (file is directly in library root after stripping), set to null
      if (!parentPath || parentPath === '.' || parentPath === '/') {
        parentPath = null;
      }
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
  const metaOpts = { year: parsed.year, parsedEpisodeTitle: episodeTitle, parentCandidate: parentCandidate, parentPath, force: (opts && opts.force) ? true : false };
  if (opts && opts.tvdbOverride) metaOpts.tvdbOverride = opts.tvdbOverride;
  // include requesting username so metaLookup may use per-user keys
  if (opts && opts.username) metaOpts.username = opts.username
  if (!isSpecialCandidate) {
    metaOpts.season = normSeason;
    metaOpts.episode = normEpisode;
  }
  
  // Prepare AniDB credentials for segments
  const anidbCreds = getAniDBCredentials(opts && opts.username ? opts.username : null, serverSettings, users);
  const metaLookupOpts = Object.assign({}, metaOpts, {
    anidb_username: anidbCreds.anidb_username,
    anidb_password: anidbCreds.anidb_password,
    anidb_client_name: anidbCreds.anidb_client_name,
    anidb_client_version: anidbCreds.anidb_client_version,
    tmdbApiKey: tmdbKey,
    filePath: canonicalPath || null
  });

  // Check for manual AniDB episode ID override
  try {
    const manualAnidbEpisodeId = getManualId(seriesLookupTitle, 'anidbEpisode', canonicalPath || null);
    if (manualAnidbEpisodeId) {
      metaLookupOpts.manualAnidbEpisodeId = manualAnidbEpisodeId;
      appendLog(`MANUAL_ANIDB_EPISODE_ID title=${seriesLookupTitle} eid=${manualAnidbEpisodeId}`);
    }
  } catch (manualIdErr) {
    console.error('[Server] Failed to check manual AniDB episode ID:', manualIdErr);
  }

  let sanitizedOrder = Array.isArray(providerOrder) ? providerOrder.filter(id => METADATA_PROVIDER_IDS.includes(id)) : [];
  // If skipAnimeProviders is enabled, filter out anidb and anilist from the provider order
  if (opts.skipAnimeProviders) {
    sanitizedOrder = sanitizedOrder.filter(id => id !== 'anidb' && id !== 'anilist');
    try { appendLog(`SKIP_ANIME_PROVIDERS enabled, filtered order: ${sanitizedOrder.join('|')}`); } catch (e) {}
  }
  const segments = [];
  let pendingMetaProviders = [];
  for (const providerId of sanitizedOrder) {
    if (providerId === 'anidb') {
      if (pendingMetaProviders.length) {
        segments.push({ type: 'meta', providers: pendingMetaProviders.slice() });
        pendingMetaProviders = [];
      }
      segments.push({ type: 'anidb' });
    } else {
      pendingMetaProviders.push(providerId);
    }
  }
  if (pendingMetaProviders.length) {
    segments.push({ type: 'meta', providers: pendingMetaProviders.slice() });
  }

  const combinedMetaProviders = sanitizedOrder.filter(id => id !== 'anidb');
  const realPath = canonicalPath;
  const anidbAvailable = anidbCreds.hasCredentials && realPath && fs.existsSync(realPath);
  let anidbAttempted = false;

  for (const segment of segments) {
    if (segment.type === 'anidb') {
      if (anidbAttempted) continue;
      anidbAttempted = true;
      try {
        appendLog(`ANIDB_CHECK hasCredentials=${anidbCreds.hasCredentials} realPath=${!!realPath} fileExists=${realPath ? fs.existsSync(realPath) : false} username=${anidbCreds.anidb_username ? 'set' : 'missing'}`);
      } catch (e) {}
      if (!anidbAvailable) {
        try { appendLog('ANIDB_SKIP reason=missing-credentials-or-file'); } catch (e) {}
        continue;
      }
      try {
        console.log('[Server] Attempting AniDB lookup for:', realPath);
        console.log('[Server] AniDB forceHash params - opts.forceHash:', opts.forceHash, 'opts.force:', opts.force, 'combined:', opts.forceHash || opts.force);
        try { appendLog(`ANIDB_LOOKUP_START path=${realPath} title=${seriesLookupTitle}`); } catch (logErr) {
          console.error('[Server] Failed to log ANIDB_LOOKUP_START:', logErr.message);
        }
        const timeoutMs = 60000;
        const anidbPromise = lookupMetadataWithAniDB(realPath, seriesLookupTitle, metaLookupOpts, opts.forceHash || opts.force);
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => {
            console.error(`[Server] AniDB lookup TIMEOUT after ${timeoutMs}ms`);
            try { appendLog(`ANIDB_TIMEOUT after ${timeoutMs}ms`); } catch (e) {}
            reject(new Error(`AniDB lookup timeout after ${timeoutMs}ms`));
          }, timeoutMs);
        });
        res = await Promise.race([anidbPromise, timeoutPromise]);
        try { appendLog(`ANIDB_LOOKUP_RESULT found=${!!res} hasName=${res && res.name ? 'yes' : 'no'}`); } catch (logErr) {
          console.error('[Server] Failed to log ANIDB_LOOKUP_RESULT:', logErr.message);
        }
        if (res) {
          console.log('[Server] AniDB lookup succeeded:', res.name || 'no-name');
          
          // After successful AniDB lookup, query AniList for relationship information
          // This provides parent series detection that AniDB hash lookups don't include
          try {
            if (!opts.skipAnimeProviders && sanitizedOrder.includes('anilist')) {
              try { appendLog(`ANILIST_RELATIONSHIP_LOOKUP_AFTER_ANIDB title=${res.name}`); } catch (e) {}
              const anilistResult = await searchAniList(res.name);
              if (anilistResult && anilistResult.parentSeriesTitle) {
                // Merge AniList relationship data into AniDB result
                res.parentSeriesTitle = anilistResult.parentSeriesTitle;
                res.parentSeriesId = anilistResult.parentSeriesId;
                res.detectedSeasonNumber = anilistResult.detectedSeasonNumber;
                try { 
                  appendLog(`ANILIST_RELATIONSHIP_FOUND_AFTER_ANIDB parent=${anilistResult.parentSeriesTitle} season=${anilistResult.detectedSeasonNumber || 'unknown'}`); 
                } catch (e) {}
              } else {
                try { appendLog(`ANILIST_RELATIONSHIP_NONE_AFTER_ANIDB title=${res.name}`); } catch (e) {}
              }
            }
          } catch (anilistErr) {
            // Don't fail the whole lookup if AniList relationship query fails
            try { appendLog(`ANILIST_RELATIONSHIP_ERROR_AFTER_ANIDB error=${anilistErr.message || String(anilistErr)}`); } catch (e) {}
          }
          
          break;
        }
      } catch (anidbErr) {
        console.error('[Server] AniDB lookup failed:', anidbErr);
        try { appendLog(`ANIDB_LOOKUP_ERROR error=${anidbErr.message || String(anidbErr)}`); } catch (logErr) {
          console.error('[Server] Failed to log ANIDB_LOOKUP_ERROR:', logErr.message);
        }
      }
    } else if (segment.type === 'meta') {
      const metaProviders = segment.providers.filter(p => p !== 'anidb');
      if (!metaProviders.length) continue;
      try { appendLog(`METALOOKUP_SEGMENT_START providers=${metaProviders.join('|')} title=${seriesLookupTitle}`); } catch (e) {}
      try {
        const segmentOpts = Object.assign({}, metaOpts, { providerOrder: metaProviders });
        res = await metaLookup(seriesLookupTitle, tmdbKey, segmentOpts);
        try { appendLog(`METALOOKUP_SEGMENT_RESULT providers=${metaProviders.join('|')} found=${!!res}`); } catch (e) {}
        if (res) break;
      } catch (metaErr) {
        console.error('[Server] metaLookup segment failed:', metaErr);
        try { appendLog(`METALOOKUP_SEGMENT_ERROR providers=${metaProviders.join('|')} error=${metaErr.message || String(metaErr)}`); } catch (e) {}
      }
    }
  }
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
  const parentMetaOpts = Object.assign({}, metaOpts || {}, { season: normSeason, episode: normEpisode, parentCandidate: parentCandidate, parentPath: parentPath, _parentDirect: true, providerOrder: combinedMetaProviders });
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
        if (res.provider === 'anidb') {
          try {
            const raw = res.raw || {};
            analyzeRawForMedia(raw);

            if (res.source) {
              guess.source = res.source;
            }

            seriesSignal = true;

            const primaryTitle = String(res.name || guess.title || seriesName || base || '').trim();
            if (primaryTitle) {
              guess.title = primaryTitle;
              guess.originalSeriesTitle = primaryTitle;
              guess.seriesTitleExact = primaryTitle;
              addSeriesCandidate('anidb.primary', primaryTitle, { prepend: true });
            }

            const altTitles = res.alternateTitles || {};
            const englishTitle = altTitles.english ? String(altTitles.english).trim() : null;
            const romajiTitle = altTitles.romaji ? String(altTitles.romaji).trim() : null;

            if (englishTitle) {
              guess.seriesTitleEnglish = englishTitle;
              if (!primaryTitle || englishTitle.toLowerCase() !== primaryTitle.toLowerCase()) {
                addSeriesCandidate('anidb.english', englishTitle);
              }
            }

            if (romajiTitle) {
              guess.seriesTitleRomaji = romajiTitle;
              if (!primaryTitle || romajiTitle.toLowerCase() !== primaryTitle.toLowerCase()) {
                addSeriesCandidate('anidb.romaji', romajiTitle);
              }
            }

            const pushAlternate = (label, values) => {
              if (!values) return;
              if (Array.isArray(values)) {
                for (const value of values) {
                  const trimmed = value && String(value).trim();
                  if (trimmed) addSeriesCandidate(`anidb.${label}`, trimmed);
                }
              } else {
                const trimmed = String(values).trim();
                if (trimmed) addSeriesCandidate(`anidb.${label}`, trimmed);
              }
            };

            pushAlternate('short', altTitles.short);
            pushAlternate('synonym', altTitles.synonyms);
            pushAlternate('other', altTitles.other);

            const chooseEpisodeTitle = () => {
              if (res.episodeTitle) return res.episodeTitle;
              if (res.episodeTitles) {
                if (res.episodeTitles.english) return res.episodeTitles.english;
                if (res.episodeTitles.romaji) return res.episodeTitles.romaji;
                if (res.episodeTitles.kanji) return res.episodeTitles.kanji;
              }
              return null;
            };

            const anidbEpisodeTitle = chooseEpisodeTitle();
            if (anidbEpisodeTitle) {
              const normalized = normalizeCapitalization(String(anidbEpisodeTitle).trim()).trim();
              if (normalized) {
                guess.episodeTitle = normalized;
                guess.extraGuess = guess.extraGuess || {};
                guess.extraGuess.episodeTitle = normalized;
              }
            }

            const providerId = res.id || raw.aid || raw.fid || raw.fileId || null;
            guess.provider = {
              matched: true,
              provider: 'anidb',
              id: providerId,
              title: primaryTitle || englishTitle || romajiTitle || null,
              raw: raw
            };
            guess.tmdb = { matched: false };
            assignProviderSourceMetadata(guess.provider, {
              seriesProvider: { id: 'anidb', detail: guess.title || primaryTitle },
              episodeProvider: (guess.episodeTitle || anidbEpisodeTitle) ? { id: 'anidb', detail: guess.episodeTitle || anidbEpisodeTitle } : null
            });

            const rawYear = raw.animeYear || raw.year || raw.animeProductionYear;
            const animeTypeRaw = res.animeType || raw.animeType || raw.animeSeriesType || null;
            const animeType = animeTypeRaw ? String(animeTypeRaw).trim() : null;
            const parsedYear = rawYear != null ? Number(String(rawYear).slice(0, 4)) : NaN;
            if (!Number.isNaN(parsedYear) && parsedYear > 0) {
              guess.year = String(parsedYear);
            }

            let episodeSeason = res.seasonNumber != null ? res.seasonNumber : normSeason;
            let episodeNumber = null;
            if (res.episodeNumber != null) {
              if (typeof res.episodeNumber === 'string') {
                const trimmed = res.episodeNumber.trim();
                if (trimmed.startsWith('0.')) {
                  const parts = trimmed.split('.');
                  const specialNum = parts.length > 1 ? Number(parts[1]) : NaN;
                  if (!Number.isNaN(specialNum)) {
                    episodeSeason = 0;
                    episodeNumber = specialNum;
                  }
                } else {
                  const parsed = Number(trimmed);
                  if (!Number.isNaN(parsed)) {
                    episodeNumber = parsed;
                  }
                }
              } else if (typeof res.episodeNumber === 'number') {
                episodeNumber = res.episodeNumber;
              }
            }

            if (episodeNumber == null && normEpisode != null) {
              episodeNumber = normEpisode;
            }

            if (episodeSeason == null && episodeNumber != null) {
              episodeSeason = 1;
            }

            if (episodeSeason != null) {
              guess.season = episodeSeason;
            }

            if (episodeNumber != null) {
              guess.episode = episodeNumber;
            }

            if (res.episodeNumberRaw) {
              guess.extraGuess = guess.extraGuess || {};
              guess.extraGuess.anidbEpisodeNumber = res.episodeNumberRaw;
            }

            if (res.raw && res.raw.animeEnglishName && !guess.seriesTitleEnglish) {
              const englishFromRaw = String(res.raw.animeEnglishName).trim();
              if (englishFromRaw) {
                guess.seriesTitleEnglish = englishFromRaw;
              }
            }

            if (res.raw && res.raw.animeRomajiName && !guess.seriesTitleRomaji) {
              const romajiFromRaw = String(res.raw.animeRomajiName).trim();
              if (romajiFromRaw) {
                guess.seriesTitleRomaji = romajiFromRaw;
              }
            }

            if (!guess.extraGuess) {
              guess.extraGuess = {};
            }
            guess.extraGuess.anidb = {
              episodeTitle: anidbEpisodeTitle || null,
              episodeNumber: res.episodeNumber || null,
              episodeNumberRaw: res.episodeNumberRaw || null,
              animeYear: rawYear || null,
              animeType: animeType || null,
              titleSource: res.anidbTitleSource || null
            };
            if (animeType) {
              guess.mediaType = animeType;
            }
            
            // Set providerResult so TVDB skip logic works
            providerResult = res;
          } catch (mapErr) {
            guess.tmdb = { matched: false };
          }
        } else {
          // Map TMDb response into our guess structure explicitly
          try {
            const raw = res.raw || {}
            analyzeRawForMedia(raw)
            
            // Preserve source field from AniDB or other providers
            if (res.source) {
              guess.source = res.source;
            }
            
            // Title (series/movie)
            // Use res.name which has already been cleaned by title-case logic in searchAniList/fetchAniListById
            let providerTitleRaw = String(res.name || raw.name || raw.title || '').trim()
            let anilistEnglish = null
            let anilistRomaji = null
            let anilistNative = null
            try {
              if (res && res.title) {
                if (res.title.english) anilistEnglish = String(res.title.english).trim()
                if (res.title.romaji) anilistRomaji = String(res.title.romaji).trim()
                if (res.title.native) anilistNative = String(res.title.native).trim()
              }
              if (!anilistEnglish && res && res.raw && res.raw.title && res.raw.title.english) anilistEnglish = String(res.raw.title.english).trim()
              if (!anilistRomaji && res && res.raw && res.raw.title && res.raw.title.romaji) anilistRomaji = String(res.raw.title.romaji).trim()
              if (!anilistNative && res && res.raw && res.raw.title && res.raw.title.native) anilistNative = String(res.raw.title.native).trim()
            } catch (e) { /* best-effort */ }
            // Use providerTitleRaw (from res.name) which is already cleaned, rather than raw anilistEnglish
            let providerPreferred = providerTitleRaw || ((anilistEnglish && anilistEnglish.length) ? anilistEnglish : ((anilistRomaji && anilistRomaji.length) ? anilistRomaji : ''))

            // If AniList says this is a movie with sequels (e.g., Kizumonogatari I/II/III),
            // map filename episode numbers (01/02/03) to the correct movie part title.
            try {
              const format = raw && raw.format ? String(raw.format).toUpperCase() : ''
              const isAniListMovie = format === 'MOVIE'
              if (isAniListMovie) {
                const isAllCaps = (s) => {
                  if (!s) return false
                  const letters = String(s).replace(/[^a-zA-Z]/g, '')
                  return letters.length > 0 && letters === letters.toUpperCase()
                }
                const sameEnRomaji = anilistEnglish && anilistRomaji && anilistEnglish === anilistRomaji
                if (sameEnRomaji && isAllCaps(anilistEnglish)) {
                  providerPreferred = String(anilistRomaji).trim()
                } else if (anilistEnglish) {
                  providerPreferred = String(anilistEnglish).trim()
                } else if (anilistRomaji) {
                  providerPreferred = String(anilistRomaji).trim()
                } else if (anilistNative) {
                  providerPreferred = String(anilistNative).trim()
                }
              }
              const episodeIndex = (normEpisode != null && Number.isFinite(Number(normEpisode))) ? Number(normEpisode) : null
              const edges = raw && raw.relations && Array.isArray(raw.relations.edges) ? raw.relations.edges : null
              if (isAniListMovie && episodeIndex && edges && edges.length) {
                function romanToInt(s) {
                  const map = { I:1, II:2, III:3, IV:4, V:5 }
                  const key = String(s || '').toUpperCase()
                  return map[key] || null
                }
                function extractPartIndex(title) {
                  if (!title) return null
                  const t = String(title)
                  let m = t.match(/\bPart\s+(\d{1,2})\b/i)
                  if (m && m[1]) return parseInt(m[1], 10)
                  m = t.match(/\b([IV]{1,3})\b/i)
                  if (m && m[1]) return romanToInt(m[1])
                  return null
                }

                const candidates = []
                if (providerPreferred) {
                  candidates.push({ title: providerPreferred, idx: extractPartIndex(providerPreferred), isBase: true })
                }
                for (const edge of edges) {
                  if (!edge || String(edge.relationType || '').toUpperCase() !== 'SEQUEL') continue
                  const nodeTitle = edge && edge.node && edge.node.title ? (edge.node.title.romaji || edge.node.title.english || edge.node.title.native) : null
                  if (nodeTitle) candidates.push({ title: String(nodeTitle).trim(), idx: extractPartIndex(nodeTitle), isBase: false })
                }

                if (candidates.length) {
                  const allHaveIndex = candidates.every(c => c.idx != null)
                  let ordered = candidates.slice()
                  if (allHaveIndex) {
                    ordered = ordered.sort((a,b) => a.idx - b.idx)
                  }
                  const pick = ordered[episodeIndex - 1]
                  if (pick && pick.title) {
                    providerPreferred = pick.title
                    try { appendLog(`META_ANILIST_MOVIE_PART_PICK episode=${episodeIndex} title=${String(providerPreferred).slice(0,120)}`) } catch (e) {}
                  }
                }
              }
            } catch (e) { /* best-effort only */ }
            
            // Check if AniList returned parent series information (for arcs/sequels that should be under parent folder)
            let useParentSeries = false
            let parentSeriesName = null
            if (res && res.parentSeriesTitle && res.detectedSeasonNumber) {
              // We have a parent series and detected season - use parent for folder organization
              parentSeriesName = res.parentSeriesTitle
              useParentSeries = true
              try { 
                appendLog(`META_USE_PARENT_SERIES child=${String(providerPreferred).slice(0,80)} parent=${String(parentSeriesName).slice(0,80)} season=${res.detectedSeasonNumber}`) 
              } catch (e) {}
            }
            
            // Also check for TVDB parent series information
            if (!useParentSeries && res && res.episode && res.episode.tvdb) {
              const tvdbData = res.episode.tvdb
              if (tvdbData.parentSeriesName) {
                parentSeriesName = tvdbData.parentSeriesName
                useParentSeries = true
                try { 
                  appendLog(`META_USE_TVDB_PARENT_SERIES child=${String(tvdbData.seriesName).slice(0,80)} parent=${String(parentSeriesName).slice(0,80)}`) 
                } catch (e) {}
              }
            }
            
            if (providerPreferred) {
              guess.originalSeriesTitle = providerPreferred
              guess.seriesTitleExact = providerPreferred
              
              // If we have parent series info, store it separately and use it for folder structure
              if (useParentSeries && parentSeriesName) {
                guess.parentSeriesTitle = parentSeriesName
                guess.childSeriesTitle = providerPreferred
                guess.seriesTitleForFolder = parentSeriesName
                // Override the season number if detected from the child title
                if (res.detectedSeasonNumber && !normSeason) {
                  guess.season = res.detectedSeasonNumber
                  try { 
                    appendLog(`META_OVERRIDE_SEASON from=${normSeason || 'none'} to=${res.detectedSeasonNumber} child=${String(providerPreferred).slice(0,80)}`) 
                  } catch (e) {}
                }
              }
              
              // store English/romaji separately for later preference logic
              // Strip "Season X" suffix from stored English title since we use SxxExx notation
              if (anilistEnglish) {
                let cleanedEnglish = anilistEnglish.replace(/\s+Season\s+\d{1,2}$/i, '').trim();
                cleanedEnglish = cleanedEnglish.replace(/\s+\(Season\s+\d{1,2}\)$/i, '').trim();
                guess.seriesTitleEnglish = cleanedEnglish;
              }
              if (anilistRomaji) guess.seriesTitleRomaji = anilistRomaji
              addSeriesCandidate('provider.original', useParentSeries && parentSeriesName ? parentSeriesName : providerPreferred, { prepend: true })
            }
            const mappedTitle = (useParentSeries && parentSeriesName) ? parentSeriesName : (providerPreferred || String(raw.displayName || guess.title || seriesName || base).trim())
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
            guess.provider = { matched: true, provider: providerName, id: raw.id || null, title: (guess.seriesTitleExact || providerTitleRaw || mappedTitle) || null, year: guess.year || null, raw: raw }

            // Back-compat: populate tmdb object only when provider is TMDb
            if (providerName === 'tmdb') {
              guess.tmdb = { matched: true, id: raw.id || null, raw: raw }
            } else {
              guess.tmdb = { matched: false }
            }

            const seriesProviderId = normalizeProviderId(res.provider || (raw && raw.source) || providerName)
            const episodeProviderId = normalizeProviderId((res && res.episode && res.episode.source) || null)
            const episodeDetailCandidate = (() => {
              if (guess.episodeTitle) return guess.episodeTitle
              if (res && res.episode) {
                try {
                  return res.episode.localized_name || res.episode.name || res.episode.title || null
                } catch (e) { return null }
              }
              return null
            })()
            assignProviderSourceMetadata(guess.provider, {
              seriesProvider: seriesProviderId ? { id: seriesProviderId, detail: guess.seriesTitleExact || guess.originalSeriesTitle || guess.title || providerPreferred } : null,
              episodeProvider: (episodeProviderId || seriesProviderId) ? { id: episodeProviderId || seriesProviderId, detail: episodeDetailCandidate } : null
            })

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
                // If AniList didn't provide a year but a later provider (TMDb/TVDB) supplied one during merging,
                // use that fallback year for this rescan only.
                try {
                  if (!guess.year && tvdbInfo && tvdbInfo.seriesYear) {
                    guess.year = tvdbInfo.seriesYear
                  }
                } catch (e) {}
                try {
                  if (!guess.year && raw && raw._fallbackProviderYear) {
                    const ryf = Number(String(raw._fallbackProviderYear))
                    if (!Number.isNaN(ryf) && ryf > 0) guess.year = String(ryf)
                  }
                } catch (e) {}
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

  // Only apply TVDb episode override when AniDB did not provide a match
  // and the upstream provider is not an AniList movie.
  const providerIsAniDB = providerResult && providerResult.provider === 'anidb';
  const providerIsAniList = providerResult && providerResult.provider === 'anilist';
  const providerIsAniListMovie = (() => {
    try {
      if (!providerIsAniList) return false;
      const raw = providerResult && providerResult.raw ? providerResult.raw : {};
      const format = raw && raw.format ? String(raw.format).toUpperCase() : '';
      if (format === 'MOVIE') return true;
      return false;
    } catch (e) { return false; }
  })();
  const skipTvdbOverride = providerIsAniDB || providerIsAniListMovie;
  
  try {
    appendLog(`TVDB_SKIP_CHECK providerResult=${!!providerResult} provider=${providerResult?.provider || '<none>'} isAniDB=${providerIsAniDB} isAniListMovie=${providerIsAniListMovie} willSkipTVDB=${skipTvdbOverride}`);
  } catch (e) {}

  if (tvdbCredentials && normSeason != null && normEpisode != null && !skipTvdbOverride) {
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
            year: guess.year || tvdbHit.seriesYear || null,
            season: normSeason,
            episode: normEpisode,
            episodeTitle: tvdbHit.episodeTitle,
            raw: tvdbHit.raw
          }
          const upstreamSeriesProviderId = normalizeProviderId((providerResult && (providerResult.provider || (providerResult.raw && providerResult.raw.source))) || null)
          const upstreamSeriesDetail = (providerResult && providerResult.name) ? providerResult.name : (guess.title || null)
          const episodeSummaryDetail = upstreamSeriesProviderId ? tvdbHit.episodeTitle : null
          assignProviderSourceMetadata(guess.provider, {
            seriesProvider: upstreamSeriesProviderId ? { id: upstreamSeriesProviderId, detail: upstreamSeriesDetail } : null,
            episodeProvider: { id: 'tvdb', detail: episodeSummaryDetail }
          })
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
    } else if (providerIsAniDB) {
      try {
        appendLog(`META_TVDB_OVERRIDE_SKIP path=${canonicalPath} reason=anidb-provider title=${providerResult && providerResult.episodeTitle ? providerResult.episodeTitle : '<none>'}`)
      } catch (e) {}
    } else if (providerIsAniListMovie) {
      try {
        appendLog(`META_TVDB_OVERRIDE_SKIP path=${canonicalPath} reason=anilist-movie title=${providerResult && providerResult.name ? providerResult.name : '<none>'}`)
      } catch (e) {}
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
      // Use first candidate (usually AniDB/provider result) or fall back to parsed series name
      guess.seriesTitle = (candidateValues.length > 0 ? candidateValues[0] : normalizeCapitalization(seriesName)).trim()
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
  }
  // Removed looksLikeEpisodeTitleCandidate check - was causing valid subtitles to be stripped
  if (!guess.seriesLookupTitle) guess.seriesLookupTitle = seriesLookupTitle || null

  // Diagnostic: log the final applied guess before returning
  try {
    const _dbg = `META_APPLY_RESULT title=${guess.title || '<none>'} episodeTitle=${guess.episodeTitle || '<none>'} season=${guess.season != null ? guess.season : '<none>'} episode=${guess.episode != null ? guess.episode : '<none>'} provider=${(guess.provider && guess.provider.provider) ? guess.provider.provider : '<none>'}`
    appendLog(_dbg);
  } catch (e) { /* ignore logging failure */ }

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
    source: guess.source || null,
    language: 'en',
    timestamp: Date.now(),
    extraGuess: buildExtraGuessSnapshot(guess)
  };
}

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

// Render custom metadata with simple title casing and sanitization
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

// Render provider-based filename using a template and provider data
function renderProviderName(data, key, session) {
  try {
    const userTemplate = (session && session.username && users[session.username] && users[session.username].settings && users[session.username].settings.rename_template) ? users[session.username].settings.rename_template : null;
    const baseNameTemplate = userTemplate || serverSettings.rename_template || '{title} ({year}) - {epLabel} - {episodeTitle}';
    // Prefer English title when available from AniList metadata
    let rawTitle = data.seriesTitleEnglish || data.title || '';
    try {
      const letters = String(rawTitle || '').replace(/[^a-zA-Z]/g, '');
      const isAllCaps = letters.length > 0 && letters === letters.toUpperCase();
      if (isAllCaps) rawTitle = titleCase(rawTitle);
    } catch (e) { /* ignore casing errors */ }
    if (!data.seriesTitleEnglish && isLikelyRomajiTitle(rawTitle, data)) {
      rawTitle = normalizeRomajiParticlesCase(rawTitle);
    }
    // Final stripping guard: ensure season-like suffixes ("2nd Season", "Season 2", etc.)
    // are removed from the title used for rendering so top-level folders don't inherit
    // ordinal-season text. Use existing helper `stripSeasonNumberSuffix` for consistency.
    // However, for movies (isMovie=true), don't strip "Part X" since it's part of the canonical title.
    const rawTitleStripped = (typeof stripSeasonNumberSuffix === 'function' && data.isMovie !== true) ? stripSeasonNumberSuffix(rawTitle) : rawTitle;
    
    // Fallback year logic: if AniList returns null/undefined for year, try to use
    // the fallback provider's year (TVDb/TMDb) or the parsed year from the filename.
    let templateYear = data && data.year ? String(data.year) : '';
    if (!templateYear || templateYear === 'null' || templateYear === 'undefined') {
      // Try fallback provider year (transiently stored in raw._fallbackProviderYear by meta-providers)
      if (data.raw && data.raw._fallbackProviderYear) {
        templateYear = String(data.raw._fallbackProviderYear);
      } else if (data.parsed && data.parsed.year) {
        // Fallback to parsed year from filename
        templateYear = String(data.parsed.year);
      } else if (data.extraGuess && data.extraGuess.year) {
        // Fallback to extraGuess year
        templateYear = String(data.extraGuess.year);
      }
    }
    
    const sanitizedYear = templateYear ? sanitize(templateYear) : '';
    function pad(n){ return String(n).padStart(2,'0') }
    let epLabel = '';
    if (data.episodeRange) epLabel = data.season != null ? `S${pad(data.season)}E${data.episodeRange}` : `E${data.episodeRange}`
    else if (data.episode != null) epLabel = data.season != null ? `S${pad(data.season)}E${pad(data.episode)}` : `E${pad(data.episode)}`
    const titleToken = cleanTitleForRender(rawTitleStripped, epLabel, data.episodeTitle || '');
    const nameWithoutExtRaw = String(baseNameTemplate)
      .replace('{title}', sanitize(titleToken))
      .replace('{basename}', sanitize(path.basename(key, path.extname(key))))
      .replace('{year}', sanitizedYear)
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
    providerRendered = ensureRenderedNameHasYear(providerRendered, templateYear);
    // Apply OS-specific filename-length truncation to the rendered name so displayed
    // and persisted rendered names don't exceed user-configured OS limits.
    try {
      const osKey = (session && session.username && users[session.username] && users[session.username].settings && users[session.username].settings.client_os) ? users[session.username].settings.client_os : (serverSettings && serverSettings.client_os ? serverSettings.client_os : 'linux');
      const maxLen = getMaxFilenameLengthForOS(osKey);
      if (maxLen && String(providerRendered).length > maxLen) {
        providerRendered = truncateFilenameComponent(providerRendered, maxLen);
      }
    } catch (e) {}
    return providerRendered;
  } catch (e) { return '' }
}

function getMaxFilenameLengthForOS(osKey) {
  const key = String(osKey || 'linux').toLowerCase();
  // Common max filename length per filesystem (component length in bytes)
  // Most filesystems have a 255-byte limit for the basename component.
  // Use conservative limits to account for UTF-8 multi-byte characters and filesystem overhead.
  // Windows/NTFS: 255 byte limit for basename. Use 200 to be safe with Unicode and path depth.
  if (key === 'windows') return 200;
  // macOS (APFS/HFS+): 255 UTF-8 bytes for basename
  if (key === 'mac' || key === 'macos' || key === 'darwin') return 240;
  // Linux (ext4/xfs/btrfs): 255 byte limit for basename
  return 240; // default for linux and unknown - conservative for UTF-8
}

function truncateFilenameComponent(name, maxLen) {
  if (!name) return name;
  const s = String(name);
  if (!maxLen || s.length <= maxLen) return s;
  
  // Try to intelligently truncate long episode titles while preserving key metadata
  // Pattern: "Series Title (Year) - S01E01 - Very Long Episode Title"
  // Goal: Keep "Series Title (Year) - S01E01" intact, truncate episode title
  const episodeLabelMatch = s.match(/^(.*?\s-\s(?:S\d{2})?E\d{1,3}(?:[SCTPO]\d+)?)\s-\s(.+)$/i);
  if (episodeLabelMatch) {
    const prefix = episodeLabelMatch[1]; // "Series Title (Year) - S01E01"
    const episodeTitle = episodeLabelMatch[2]; // "Very Long Episode Title"
    
    // If the prefix alone is under the limit, truncate only the episode title
    if (prefix.length < maxLen - 5) { // -5 for " - " + ellipsis
      const remainingLen = maxLen - prefix.length - 3; // -3 for " - "
      if (remainingLen > 10) { // Only if we have meaningful space for episode title
        const truncatedEpTitle = episodeTitle.slice(0, remainingLen - 1) + '…';
        return `${prefix} - ${truncatedEpTitle}`;
      }
    }
  }
  
  // Fallback: simple truncation with ellipsis
  const ell = '…';
  const keep = Math.max(1, maxLen - ell.length);
  return s.slice(0, keep) + ell;
}

// Centralized parsed item processing used by scans: parse filename, update parsedCache & enrichCache
function sanitizeMetadataProviderOrder(value) {
  try {
    if (value == null) return [...DEFAULT_METADATA_PROVIDER_ORDER];
    let arr = [];
    if (Array.isArray(value)) {
      arr = value;
    } else if (typeof value === 'string') {
      let parsed = null;
      try {
        parsed = JSON.parse(value);
      } catch (e) {
        parsed = null;
      }
      if (Array.isArray(parsed)) arr = parsed;
      else if (typeof parsed === 'string') arr = parsed.split(',');
      else arr = String(value).split(',');
    } else {
      arr = [];
    }
    const seen = new Set();
    const out = [];
    for (const raw of arr) {
      const id = String(raw || '').trim().toLowerCase();
      if (!id || !METADATA_PROVIDER_IDS.includes(id)) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out.length ? out : [...DEFAULT_METADATA_PROVIDER_ORDER];
  } catch (e) {
    return [...DEFAULT_METADATA_PROVIDER_ORDER];
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
        // Preserve existing provider block if it exists (don't overwrite provider data during rescans)
        const existingProvider = (enrichCache[key] && enrichCache[key].provider) ? enrichCache[key].provider : null;
        const updatePayload = { parsed: parsedBlock, sourceId: 'parsed-cache', cachedAt: now };
        if (existingProvider) updatePayload.provider = existingProvider;
        updateEnrichCache(key, Object.assign({}, enrichCache[key] || {}, updatePayload));
      } catch (e) {
        // Preserve existing provider block even in error path
        const existingProvider = (enrichCache[key] && enrichCache[key].provider) ? enrichCache[key].provider : null;
        const fallbackPayload = { sourceId: 'local-parser', title: parsed.title, parsedName: parsed.parsedName, season: parsed.season, episode: parsed.episode, episodeRange: parsed.episodeRange || null, episodeTitle: '', language: 'en', timestamp: now };
        if (existingProvider) fallbackPayload.provider = existingProvider;
        updateEnrichCache(key, Object.assign({}, enrichCache[key] || {}, fallbackPayload));
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
        // If the user's provider order prefers AniDB first, force computing ED2K hash
        const _providerOrder = resolveMetadataProviderOrder(username);
        const _forceHashForAniDB = (_providerOrder && _providerOrder.length && _providerOrder[0] === 'anidb');
        const _opts = Object.assign({}, { username });
        if (_forceHashForAniDB) _opts.forceHash = true;
        const data = await externalEnrich(key, tmdbKey, _opts);
        if (!data) { continue; }
        try {
          const providerRendered = renderProviderName(data, key, session);
          const providerRaw = cloneProviderRaw(extractProviderRaw(data));
          const providerBlock = { 
            title: data.title, 
            year: data.year, 
            season: data.season, 
            episode: data.episode, 
            episodeTitle: data.episodeTitle || '', 
            raw: providerRaw, 
            renderedName: providerRendered, 
            matched: !!data.title,
            source: data.source || (data.provider && data.provider.source) || null,
            seriesTitleEnglish: data.seriesTitleEnglish || null,
            seriesTitleRomaji: data.seriesTitleRomaji || null,
            seriesTitleExact: data.seriesTitleExact || null,
            originalSeriesTitle: data.originalSeriesTitle || null
          };
          try { logMissingEpisodeTitleIfNeeded(key, providerBlock) } catch (e) {}
          // Merge entire data object to preserve seriesTitleEnglish, seriesTitleRomaji, etc.
          updateEnrichCache(key, Object.assign({}, enrichCache[key] || {}, data, { provider: providerBlock, sourceId: 'provider', cachedAt: Date.now() }));
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
app.get('/api/libraries', requireAuth, (req, res) => {
  // Let user choose an existing folder under cwd or provide custom path via config later
  res.json([{ id: 'local', name: 'Local folder', canonicalPath: path.resolve('.') }]);
});

// New diagnostic endpoint: provider/meta status (TMDb/Kitsu)
app.get('/api/meta/status', requireAuth, (req, res) => {
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
app.post('/api/scan', requireAuth, async (req, res) => {
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
      // remove stale entries (but preserve enrichCache for applied/hidden items so they don't reappear)
      for (const r of (removed || [])) {
        try {
          const e = enrichCache[r] || null;
          // Keep enrichCache entry if item was applied or hidden (prevents reappearance)
          if (!e || (!e.applied && !e.hidden)) {
            delete enrichCache[r];
          }
          delete parsedCache[r];
        } catch (e) {}
      }
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
app.post('/api/scan/incremental', requireAuth, async (req, res) => {
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
      // remove stale entries (but preserve enrichCache for applied/hidden items)
      for (const r of (removed || [])) {
        try {
          const e = enrichCache[r] || null;
          // Keep enrichCache entry if item was applied or hidden (prevents reappearance)
          if (!e || (!e.applied && !e.hidden)) {
            delete enrichCache[r];
          }
          delete parsedCache[r];
        } catch (e) {}
      }
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
  // Filter out items that are marked hidden or applied in enrichCache before creating artifact
  const filteredItems = items.filter(it => {
    try {
      const k = canonicalize(it.canonicalPath);
      const e = enrichCache[k] || null;
      if (e && (e.hidden || e.applied)) return false;
      return true;
    } catch (e) { return true; }
  });
  const artifact = { id: scanId, libraryId: libraryId || 'local', totalCount: filteredItems.length, items: filteredItems, generatedAt: Date.now() };
  scans[scanId] = artifact;
  try { if (db) db.saveScansObject(scans); else writeJson(scanStoreFile, scans); } catch (e) {}
  appendLog(`INCREMENTAL_SCAN_COMPLETE id=${scanId} total=${filteredItems.length} hidden_filtered=${items.length - filteredItems.length}`);
  // include a small sample of first-page items to help clients refresh UI without
  // requiring an extra request. Clients may pass a 'limit' query param when
  // invoking incremental scan; default to 100.
  const sampleLimit = Number.isInteger(parseInt(req.query && req.query.limit)) ? parseInt(req.query.limit) : 100;
  const sample = filteredItems.slice(0, sampleLimit);
  res.json({ scanId, totalCount: filteredItems.length, items: sample, changedPaths: (changedItems || []).map(it => it && it.canonicalPath).filter(Boolean) });
  // Don't enrich new items during incremental scans - they should only be parsed and hashed
  // Enrichment will happen when user manually requests it or during full scans
});

app.get('/api/scan/:scanId', requireAuth, (req, res) => { const s = scans[req.params.scanId]; if (!s) return res.status(404).json({ error: 'scan not found' }); res.json({ libraryId: s.libraryId, totalCount: s.totalCount, generatedAt: s.generatedAt }); });
app.get('/api/scan/:scanId/items', requireAuth, (req, res) => { 
  const s = scans[req.params.scanId]; 
  if (!s) return res.status(404).json({ error: 'scan not found' }); 
  
  // Filter out applied/hidden items
  const filteredItems = (s.items || []).filter(it => {
    try {
      const k = canonicalize(it.canonicalPath);
      const e = enrichCache[k] || null;
      if (e && (e.hidden || e.applied)) return false;
      return true;
    } catch (err) { return true; }
  });
  
  const offset = parseInt(req.query.offset || '0', 10); 
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 500); 
  const slice = filteredItems.slice(offset, offset + limit); 
  res.json({ items: slice, offset, limit, total: filteredItems.length }); 
});

// Return the most recent scan artifact optionally filtered by libraryId. Useful when client lost lastScanId.
app.get('/api/scan/latest', requireAuth, (req, res) => {
  try {
    const lib = req.query.libraryId || null
    const all = Object.keys(scans || {}).map(k => scans[k]).filter(Boolean)
    let filtered = all
    if (lib) filtered = filtered.filter(s => s.libraryId === lib)
    if (!filtered.length) {
      const include = (req.query && (req.query.includeItems === '1' || req.query.includeItems === 'true'))
      if (include) return res.json({ scanId: null, libraryId: lib, totalCount: 0, generatedAt: null, items: [] })
      return res.json({ scanId: null, libraryId: lib, totalCount: 0, generatedAt: null })
    }
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
app.get('/api/scan/:scanId/search', requireAuth, (req, res) => {
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
    // Attach cached enrichment to search results so client can render preview names immediately
    const enrichedSlice = slice.map(it => {
      const copy = { ...it };
      try {
        const key = canonicalize(copy.canonicalPath || '');
        const raw = enrichCache[key] || null;
        if (raw) {
          const normalized = normalizeEnrichEntry(raw);
          if (normalized) copy.enrichment = normalized;
        }
      } catch (e) {}
      return copy;
    });
    return res.json({ items: enrichedSlice, offset, limit, total });
  } catch (e) { return res.status(500).json({ error: e.message }) }
})

app.get('/api/enrich', requireAuth, (req, res) => {
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
        return res.json({ cached: false, enrichment: cleanEnrichmentForClient(normalized) });
      }
      if (normalized.parsed || normalized.provider) return res.json({ cached: true, enrichment: cleanEnrichmentForClient(normalized) });
    }
    return res.json({ cached: false, enrichment: null });
  } catch (e) { return res.status(500).json({ error: e.message }) }
});

// Save per-item custom metadata overrides for items missing provider data
app.post('/api/enrich/custom', requireAuth, (req, res) => {
  try {
    const body = req.body || {}
    const key = canonicalize(body.path || '')
    console.log('[CUSTOM_META] Request:', { path: body.path, key, title: body.title })
    if (!key) return res.status(400).json({ error: 'path required' })

    const toNumber = (value) => {
      if (value === null || typeof value === 'undefined' || value === '') return null
      const n = Number(value)
      return Number.isFinite(n) ? n : null
    }

    const title = String(body.title || '').trim()
    const episodeTitleRaw = String(body.episodeTitle || '').trim()
    const yearRaw = String(body.year || '').trim()
    const isMovie = body.isMovie === true || String(body.isMovie || '').toLowerCase() === 'true'
    let season = toNumber(body.season)
    let episode = toNumber(body.episode)
    let episodeTitle = episodeTitleRaw

    if (!title) return res.status(400).json({ error: 'title required' })

    if (isMovie) {
      season = null
      episode = null
      episodeTitle = ''
    }

    const extraGuess = {
      title,
      episodeTitle: episodeTitle || '',
      season,
      episode,
      year: yearRaw || null,
      isMovie
    }
    if (isMovie) extraGuess.mediaFormat = 'MOVIE'

    const cleanExtra = sanitizeExtraGuess(extraGuess, null)
    if (!cleanExtra) return res.status(400).json({ error: 'invalid metadata' })

    const existing = enrichCache[key] || {}
    const data = Object.assign({}, existing, cleanExtra)
    data.title = cleanExtra.title || existing.title || null
    data.year = cleanExtra.year || existing.year || null
    data.season = (cleanExtra.season != null) ? cleanExtra.season : (existing.season ?? null)
    data.episode = (cleanExtra.episode != null) ? cleanExtra.episode : (existing.episode ?? null)
    data.episodeTitle = (cleanExtra.episodeTitle != null) ? cleanExtra.episodeTitle : (existing.episodeTitle || '')
    data.isMovie = (typeof cleanExtra.isMovie === 'boolean') ? cleanExtra.isMovie : existing.isMovie

    const providerRendered = renderCustomMetadataName(data, req.session)
    console.log('[CUSTOM_META] Rendered name:', providerRendered)
    const providerBlock = {
      title: data.title,
      year: data.year,
      season: data.season,
      episode: data.episode,
      episodeTitle: data.episodeTitle || '',
      raw: null,
      renderedName: providerRendered,
      matched: !!data.title,
      source: 'custom',
      seriesTitleEnglish: data.seriesTitleEnglish || null,
      seriesTitleRomaji: data.seriesTitleRomaji || null,
      seriesTitleExact: data.seriesTitleExact || null,
      originalSeriesTitle: data.originalSeriesTitle || null
    }

    const updated = updateEnrichCache(key, Object.assign({}, existing, data, {
      extraGuess: cleanExtra,
      provider: providerBlock,
      sourceId: 'custom',
      cachedAt: Date.now()
    }))

    console.log('[CUSTOM_META] Updated cache, has renderedName:', !!updated?.provider?.renderedName, 'source:', updated?.provider?.source)
    // For custom metadata, keep renderedName in response so UI can display it immediately
    // Add cache buster to force client to process the update
    const response = { ok: true, enrichment: updated, _cacheBuster: Date.now() }
    console.log('[CUSTOM_META] Sending response with renderedName:', response.enrichment?.provider?.renderedName)
    return res.json(response)
  } catch (e) {
    console.error('[CUSTOM_META] Error:', e)
    return res.status(500).json({ error: e.message })
  }
})

// Lookup enrichment by rendered metadata filename (without extension)
app.get('/api/enrich/by-rendered', requireAuth, (req, res) => {
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
app.post('/api/enrich/bulk', requireAuth, (req, res) => {
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

app.get('/api/csrf-token', (req, res) => {
  try {
    const token = res.locals && res.locals.csrfToken ? res.locals.csrfToken : (typeof req.csrfToken === 'function' ? req.csrfToken() : null);
    return res.json({ ok: true, token });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

app.get('/api/settings', requireAuth, (req, res) => {
  const userSettings = (req.session && req.session.username && users[req.session.username] && users[req.session.username].settings) ? users[req.session.username].settings : {};
  const serverOut = { ...(serverSettings || {}) };
  serverOut.delete_hardlinks_on_unapprove = resolveDeleteHardlinksSetting(req.session && req.session.username ? req.session.username : null);
  return res.json({ serverSettings: serverOut, userSettings });
});
// Diagnostic: expose current session and user presence to help debug auth issues (no secrets)
app.get('/api/debug/session', requireAuth, (req, res) => {
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
// Logs endpoint for UI debugging
app.get('/api/logs/recent', requireAuth, (req, res) => {
  try {
    const lines = req.query && req.query.lines ? parseInt(req.query.lines, 10) : 500;
    const filter = req.query && req.query.filter ? String(req.query.filter).toLowerCase() : '';
    if (!fs.existsSync(logsFile)) {
      return res.json({ logs: '', lines: 0 });
    }
    const content = fs.readFileSync(logsFile, 'utf8');
    const allLines = content.split('\n').filter(Boolean);
    let filtered = allLines;
    if (filter) {
      filtered = allLines.filter(line => line.toLowerCase().includes(filter));
    }
    const recent = filtered.slice(-lines).reverse().join('\n');
    return res.json({ logs: recent, lines: filtered.length, total: allLines.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
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
  const allowed = ['tmdb_api_key', 'anilist_api_key', 'anidb_username', 'anidb_password', 'anidb_client_name', 'anidb_client_version', 'scan_output_path', 'rename_template', 'default_meta_provider', 'metadata_provider_order', 'tvdb_v4_api_key', 'tvdb_v4_user_pin', 'output_folders', 'delete_hardlinks_on_unapprove', 'client_os', 'log_timezone'];
      for (const k of allowed) {
        if (body[k] === undefined) continue;
        if (k === 'metadata_provider_order') {
          const order = sanitizeMetadataProviderOrder(body[k]);
          serverSettings.metadata_provider_order = order;
          if (!body.default_meta_provider && order.length) {
            serverSettings.default_meta_provider = order[0];
          }
        } else if (k === 'default_meta_provider') {
          const first = String(body[k] || '').trim() || 'tmdb';
          serverSettings.default_meta_provider = first;
        } else if (k === 'output_folders') {
          serverSettings.output_folders = Array.isArray(body[k]) ? body[k] : [];
        } else if (k === 'delete_hardlinks_on_unapprove') {
          serverSettings.delete_hardlinks_on_unapprove = coerceBoolean(body[k]);
        } else {
          serverSettings[k] = body[k];
        }
      }
      if (!serverSettings.metadata_provider_order || !serverSettings.metadata_provider_order.length) {
        serverSettings.metadata_provider_order = sanitizeMetadataProviderOrder(serverSettings.metadata_provider_order);
      }
      if (!serverSettings.default_meta_provider && serverSettings.metadata_provider_order.length) {
        serverSettings.default_meta_provider = serverSettings.metadata_provider_order[0];
      }
      writeJson(settingsFile, serverSettings);
      appendLog(`SETTINGS_SAVED_GLOBAL by=${username} keys=${Object.keys(body).join(',')}`);
      return res.json({ ok: true, settings: serverSettings });
    }

    // otherwise save per-user
    if (!username) return res.status(401).json({ error: 'unauthenticated' });
    users[username] = users[username] || {};
    users[username].settings = users[username].settings || {};
  const allowed = ['tmdb_api_key', 'anilist_api_key', 'anidb_username', 'anidb_password', 'anidb_client_name', 'anidb_client_version', 'scan_input_path', 'scan_output_path', 'rename_template', 'default_meta_provider', 'metadata_provider_order', 'tvdb_v4_api_key', 'tvdb_v4_user_pin', 'output_folders', 'enable_folder_watch', 'delete_hardlinks_on_unapprove', 'client_os', 'log_timezone'];
    
    // Check if scan_input_path changed to update watcher
    const oldScanPath = users[username].settings.scan_input_path;
    const newScanPath = body.scan_input_path;
    const oldWatchEnabled = coerceBoolean(users[username].settings.enable_folder_watch);
    let newWatchEnabled = oldWatchEnabled;
    let watchProvided = false;
    
    for (const k of allowed) {
      if (body[k] === undefined) continue;
      if (k === 'metadata_provider_order') {
        const order = sanitizeMetadataProviderOrder(body[k]);
        users[username].settings.metadata_provider_order = order;
        if (!body.default_meta_provider && order.length) users[username].settings.default_meta_provider = order[0];
      } else if (k === 'default_meta_provider') {
        const first = String(body[k] || '').trim() || 'tmdb';
        users[username].settings.default_meta_provider = first;
      } else if (k === 'output_folders') {
        users[username].settings.output_folders = Array.isArray(body[k]) ? body[k] : [];
      } else if (k === 'enable_folder_watch') {
        watchProvided = true;
        const normalized = coerceBoolean(body[k]);
        users[username].settings.enable_folder_watch = normalized;
        newWatchEnabled = normalized;
      } else if (k === 'delete_hardlinks_on_unapprove') {
        users[username].settings.delete_hardlinks_on_unapprove = coerceBoolean(body[k]);
      } else {
        users[username].settings[k] = body[k];
      }
    }
    if (!users[username].settings.metadata_provider_order || !users[username].settings.metadata_provider_order.length) {
      users[username].settings.metadata_provider_order = sanitizeMetadataProviderOrder(users[username].settings.metadata_provider_order);
    }
    if (!users[username].settings.default_meta_provider && users[username].settings.metadata_provider_order.length) {
      users[username].settings.default_meta_provider = users[username].settings.metadata_provider_order[0];
    }
    writeJson(usersFile, users);
    appendLog(`SETTINGS_SAVED_USER user=${username} keys=${Object.keys(body).join(',')}`);
    
    const pathChanged = newScanPath !== undefined && newScanPath !== oldScanPath;
    const watchToggled = watchProvided && newWatchEnabled !== oldWatchEnabled;
    if (pathChanged || watchToggled) {
      stopFolderWatcher(username);
      const finalPath = users[username].settings.scan_input_path;
      if (newWatchEnabled && finalPath) {
        const libPath = path.resolve(finalPath);
        startFolderWatcher(username, libPath);
      }
    }
    
    return res.json({ ok: true, userSettings: users[username].settings });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// Get manual provider IDs
app.get('/api/manual-ids', requireAuth, (req, res) => {
  try {
    return res.json({ manualIds });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Save manual provider ID for a series title
app.post('/api/manual-ids', requireAuth, (req, res) => {
  try {
    const { title, anilist, tmdb, tvdb, anidbEpisode } = req.body;
    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'title is required' });
    }

    const normalizedTitle = normalizeManualIdKey(title);
    if (!normalizedTitle) {
      return res.status(400).json({ error: 'title cannot be empty' });
    }

    if (!manualIds[normalizedTitle]) manualIds[normalizedTitle] = {};

    if (anilist != null && String(anilist).trim()) manualIds[normalizedTitle].anilist = String(anilist).trim();
    else delete manualIds[normalizedTitle].anilist;

    if (tmdb != null && String(tmdb).trim()) manualIds[normalizedTitle].tmdb = String(tmdb).trim();
    else delete manualIds[normalizedTitle].tmdb;

    if (tvdb != null && String(tvdb).trim()) manualIds[normalizedTitle].tvdb = String(tvdb).trim();
    else delete manualIds[normalizedTitle].tvdb;

    if (anidbEpisode != null && String(anidbEpisode).trim()) {
      const normalized = normalizeAniDbEpisodeId(anidbEpisode);
      if (normalized) manualIds[normalizedTitle].anidbEpisode = normalized;
      else delete manualIds[normalizedTitle].anidbEpisode;
    } else {
      delete manualIds[normalizedTitle].anidbEpisode;
    }

    if (!manualIds[normalizedTitle].anilist && !manualIds[normalizedTitle].tmdb && !manualIds[normalizedTitle].tvdb && !manualIds[normalizedTitle].anidbEpisode) {
      delete manualIds[normalizedTitle];
    }

    fs.writeFileSync(manualIdsFile, JSON.stringify(manualIds, null, 2), 'utf8');
    loadManualIds();

    try {
      appendLog(`MANUAL_ID_SAVED title=${normalizedTitle} anilist=${anilist||'<none>'} tmdb=${tmdb||'<none>'} tvdb=${tvdb||'<none>'} anidbEpisode=${anidbEpisode||'<none>'} by=${req.session.username}`);
    } catch (e) {}

    return res.json({ ok: true, manualIds });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
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
app.get('/api/path/exists', requireAuth, (req, res) => { const p = req.query.path || ''; try { const rp = path.resolve(p); const exists = fs.existsSync(rp); const stat = exists ? fs.statSync(rp) : null; res.json({ exists, isDirectory: stat ? stat.isDirectory() : false, resolved: rp }); } catch (err) { res.json({ exists: false, isDirectory: false, error: err.message }); } });

app.post('/api/enrich', requireAuth, async (req, res) => {
  const { path: p, tmdb_api_key: tmdb_override, force, forceHash, tvdb_v4_api_key: tvdb_override_v4_api_key, tvdb_v4_user_pin: tvdb_override_v4_user_pin, skipAnimeProviders } = req.body;
  const key = canonicalize(p || '');
  appendLog(`ENRICH_REQUEST path=${key} force=${force ? 'yes' : 'no'} forceHash=${forceHash ? 'yes' : 'no'} skipAnimeProviders=${skipAnimeProviders ? 'yes' : 'no'}`);
  try {
    // On forced rescan, clear cached enrich/parsed/rendered entries while preserving applied/hidden flags
    if (force) {
      purgeCachesForPath(key, { preserveFlags: true, persist: true });
    }
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
    // Check if we already have complete provider data - if so, use it even if TMDb key is present
    // This prevents losing provider metadata (e.g., AniDB) when TMDb is also configured
    const existingEnrichEarly = enrichCache[key] || null;
    const hasCompleteProvider = existingEnrichEarly && existingEnrichEarly.provider && existingEnrichEarly.provider.renderedName;
    
  if (!force && parsedCache[key] && (!tmdbKeyEarly || hasCompleteProvider)) {
      const pc = parsedCache[key]
      const epTitle = (enrichCache[key] && enrichCache[key].provider && enrichCache[key].provider.episodeTitle) ? enrichCache[key].provider.episodeTitle : ''
      // build normalized entry - preserve existing provider block if it has a renderedName (preview)
      const parsedBlock = { title: pc.title, parsedName: pc.parsedName, season: pc.season, episode: pc.episode, timestamp: Date.now() }
      const existingProvider = (enrichCache[key] && enrichCache[key].provider) ? enrichCache[key].provider : null
      // If provider block exists and has renderedName, use the provider's parsedName instead of raw parsed
      const effectiveParsedBlock = (existingProvider && existingProvider.renderedName && existingProvider.parsedName) 
        ? { title: existingProvider.title || pc.title, parsedName: existingProvider.parsedName, season: existingProvider.season != null ? existingProvider.season : pc.season, episode: existingProvider.episode != null ? existingProvider.episode : pc.episode, timestamp: Date.now() }
        : parsedBlock
      const providerBlock = existingProvider
  const normalized = normalizeEnrichEntry(Object.assign({}, enrichCache[key] || {}, { parsed: effectiveParsedBlock, provider: providerBlock, sourceId: 'parsed-cache', cachedAt: Date.now() }));
  updateEnrichCache(key, normalized);
  try { if (db) db.setKV('enrichCache', enrichCache); else writeJson(enrichStoreFile, enrichCache); } catch (e) {}
      return res.json({ enrichment: enrichCache[key] })
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
    const data = await externalEnrich(key, tmdbKey, { username: req.session && req.session.username, tvdbOverride, forceHash, force, skipAnimeProviders });
    // Use centralized renderer and updater so rendering logic is consistent
    try {
      if (data && data.title) {
        const providerRendered = renderProviderName(data, key, req.session);
        const providerRaw = cloneProviderRaw(extractProviderRaw(data));
        const providerBlock = { 
          title: data.title, 
          year: data.year, 
          season: data.season, 
          episode: data.episode, 
          episodeTitle: data.episodeTitle || '', 
          raw: providerRaw, 
          renderedName: providerRendered, 
          matched: !!data.title,
          source: data.source || (data.provider && data.provider.source) || null,
          seriesTitleEnglish: data.seriesTitleEnglish || null,
          seriesTitleRomaji: data.seriesTitleRomaji || null,
          seriesTitleExact: data.seriesTitleExact || null,
          originalSeriesTitle: data.originalSeriesTitle || null
        };
        try { logMissingEpisodeTitleIfNeeded(key, providerBlock) } catch (e) {}
        // Merge entire data object to preserve seriesTitleEnglish, seriesTitleRomaji, etc.
        // updateEnrichCache will preserve applied/hidden flags from enrichCache[key]
        updateEnrichCache(key, Object.assign({}, data, { provider: providerBlock, sourceId: 'provider', cachedAt: Date.now() }));
      } else {
        updateEnrichCache(key, Object.assign({}, data, { cachedAt: Date.now() }));
      }
    } catch (e) {
      updateEnrichCache(key, Object.assign({}, data, { cachedAt: Date.now() }));
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
  // Update cache and persist immediately so changes survive browser close
  try {
    enrichCache[key] = enrichCache[key] || {};
    enrichCache[key].hidden = true;
    // Persist immediately instead of debouncing
    try { if (db) db.setKV('enrichCache', enrichCache); else writeJson(enrichStoreFile, enrichCache); } catch (e) { appendLog(`HIDE_PERSIST_FAIL path=${p} err=${e && e.message ? e.message : String(e)}`) }
  } catch (e) { appendLog(`HIDE_UPDATE_FAIL path=${p} err=${e && e.message ? e.message : String(e)}`) }

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
  const forceCache = coerceBoolean(req.body && req.body.force);
  appendLog(`REFRESH_SCAN_REQUEST scan=${req.params.scanId} by=${username} force=${forceCache ? 'yes' : 'no'}`);
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
    let renderedIndexMutated = false;
    // Pre-normalize existing enrich cache entries for this scan so title-case
    // changes are applied immediately even if a provider lookup fails later.
    try {
      for (const it of s.items || []) {
        try {
          const key = canonicalize(it.canonicalPath);
          if (enrichCache && enrichCache[key]) updateEnrichCacheInMemory(key, {});
        } catch (e) {}
      }
    } catch (e) {}
    try {
      for (const it of s.items) {
        try {
          const key = canonicalize(it.canonicalPath);
          if (forceCache) {
            const purgeResult = purgeCachesForPath(key, { preserveFlags: true, persist: false });
            if (purgeResult) {
              if (purgeResult.renderedIndex) renderedIndexMutated = true;
            }
          }
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
            // Respect user's provider order: if AniDB is configured first, force hash so
            // AniDB lookups wait for ED2K computation instead of falling back immediately.
            const _refreshProviderOrder = resolveMetadataProviderOrder(username);
            const _refreshForceHash = (_refreshProviderOrder && _refreshProviderOrder.length && _refreshProviderOrder[0] === 'anidb');
            const _refreshOpts = Object.assign({}, { username, force: true });
            if (_refreshForceHash) _refreshOpts.forceHash = true;
            lookup = await externalEnrich(key, tmdbKey, _refreshOpts);
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
              parsedName: (fallbackParsed && (fallbackParsed.parsedName || fallbackParsed.title)) || providerClone.renderedName || null,
              // Pull title variants from cached provider block OR top-level entry
              seriesTitleEnglish: providerClone.seriesTitleEnglish || (entryAfterParse && entryAfterParse.seriesTitleEnglish) || null,
              seriesTitleRomaji: providerClone.seriesTitleRomaji || (entryAfterParse && entryAfterParse.seriesTitleRomaji) || null,
              seriesTitleExact: providerClone.seriesTitleExact || (entryAfterParse && entryAfterParse.seriesTitleExact) || null
            };
          }
          if (!lookup && fallbackParsed) {
            lookup = {
              title: fallbackParsed.title || null,
              year: fallbackParsed.year || (entryAfterParse && entryAfterParse.year) || null,
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
                const providerRaw = cloneProviderRaw(extractProviderRaw(lookup));
                const providerBlock = {
                  title: lookup.title,
                  year: lookup.year,
                  season: lookup.season,
                  episode: lookup.episode,
                  episodeTitle: lookup.episodeTitle || '',
                  raw: providerRaw,
                  renderedName: providerRendered || (lookup.provider && lookup.provider.renderedName) || '',
                  matched: lookup.provider && typeof lookup.provider.matched !== 'undefined' ? lookup.provider.matched : !!lookup.title,
                  source: lookup.source || (lookup.provider && lookup.provider.source) || null,
                  // Preserve title variants from externalEnrich (seriesTitleEnglish, seriesTitleRomaji, etc.)
                  seriesTitleEnglish: lookup.seriesTitleEnglish || null,
                  seriesTitleRomaji: lookup.seriesTitleRomaji || null,
                  seriesTitleExact: lookup.seriesTitleExact || null,
                  originalSeriesTitle: lookup.originalSeriesTitle || null
                };
                try { logMissingEpisodeTitleIfNeeded(key, providerBlock) } catch (e) {}
                // Merge entire lookup object to preserve all fields like seriesTitleEnglish
                updateEnrichCache(key, Object.assign({}, enrichCache[key] || {}, lookup, { provider: providerBlock, sourceId: 'provider', cachedAt: Date.now() }));
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
      if (renderedIndexMutated) {
        try { if (db) db.setKV('renderedIndex', renderedIndex); else writeJson(renderedIndexFile, renderedIndex); } catch (e) {}
      }
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
app.get('/api/enrich/debug', requireAuth, requireAdmin, async (req, res) => { const p = req.query.path || ''; const key = canonicalize(p); const cached = enrichCache[key] || null; // pick tmdb key if available (use server setting only for debug)
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

    // defensive: ensure hideEvents is an array
    const he = Array.isArray(hideEvents) ? hideEvents : []
    const ev = he.filter(e => (e && e.ts && e.ts > since))
    const resp = { ok: true, events: ev || [] }

    try { hideEventsClientCache.set(clientKey, { ts: since, resp, lastHit: now }) } catch (e) {}
    return res.json(resp)
  } catch (e) {
    try { appendLog(`HIDE_EVENTS_ERR err=${e && e.message ? e.message : String(e)}`) } catch (ee) {}
    try { console.error('hide-events failed', e && e.message ? e.message : e) } catch (ee) {}
    return res.status(500).json({ error: e && e.message ? e.message : String(e) })
  }
})

// Helper function to render provider name for display
// Creates format: "Title (Year) - S01E08 - Episode Title"
function renderProviderName(data, fromPath, session) {
  try {
    if (!data) return null;

    const userTemplate = (session && session.username && users[session.username] && users[session.username].settings && users[session.username].settings.rename_template)
      ? users[session.username].settings.rename_template
      : null;
    const baseNameTemplate = userTemplate || serverSettings.rename_template || '{title} ({year}) - {epLabel} - {episodeTitle}';

    function pad(n) { return String(n).padStart(2, '0'); }

    const mediaFormat = data && data.mediaFormat ? String(data.mediaFormat).toUpperCase() : '';
    const rawSource = data && data.source ? String(data.source).toLowerCase() : '';
    const looksLikeTmdbMovie = !!(data && data.raw && data.raw.title && !data.raw.name);
    const tmdbMediaType = String(
      (data && data.raw && (data.raw.media_type || data.raw.mediaType)) ||
      (data && data.tmdb && data.tmdb.raw && (data.tmdb.raw.media_type || data.tmdb.raw.mediaType)) ||
      ''
    ).toLowerCase();
    const noEpisodeContext = (data && data.season == null && data.episode == null && !data.episodeRange);
    const isMovie = data.isMovie === true
      || mediaFormat.includes('MOVIE')
      || mediaFormat === 'FILM'
      || tmdbMediaType === 'movie'
      || looksLikeTmdbMovie
      || rawSource === 'tmdb-movie'
      || (noEpisodeContext && /\bmovie\b/i.test(String(data.episodeTitle || '')));

    let rawTitle = isMovie
      ? (data.title || data.seriesTitleEnglish || data.seriesTitle || '')
      : (data.seriesTitleEnglish || data.title || '');
    rawTitle = String(rawTitle || '').trim();
    if (!rawTitle) return null;

    // If upstream mapping split a movie subtitle into episodeTitle, stitch it back into title.
    if (isMovie && data.episodeTitle) {
      const movieSubtitle = String(data.episodeTitle || '').trim();
      if (movieSubtitle) {
        const titleNorm = rawTitle.toLowerCase();
        const subtitleNorm = movieSubtitle.toLowerCase();
        if (!titleNorm.includes(subtitleNorm)) {
          rawTitle = `${rawTitle} - ${movieSubtitle}`.replace(/\s{2,}/g, ' ').trim();
        }
      }
    }

    let templateYear = data && data.year ? String(data.year).trim() : '';
    if (!templateYear && data && data.parsed && data.parsed.year) templateYear = String(data.parsed.year).trim();

    let epLabel = '';
    let episodeTitle = '';
    if (!isMovie) {
      if (data.episodeRange) epLabel = data.season != null ? `S${pad(data.season)}E${data.episodeRange}` : `E${data.episodeRange}`;
      else if (data.episode != null) epLabel = data.season != null ? `S${pad(data.season)}E${pad(data.episode)}` : `E${pad(data.episode)}`;
      episodeTitle = data.episodeTitle ? String(data.episodeTitle).trim() : '';
    }

    const titleToken = isMovie ? rawTitle : cleanTitleForRender(rawTitle, epLabel, episodeTitle);

    let rendered = String(baseNameTemplate)
      .replace('{title}', sanitize(titleToken))
      .replace('{basename}', sanitize(path.basename(fromPath || '', path.extname(fromPath || ''))))
      .replace('{year}', sanitize(templateYear || ''))
      .replace('{epLabel}', sanitize(epLabel || ''))
      .replace('{episodeTitle}', sanitize(episodeTitle || ''))
      .replace('{season}', data.season != null ? String(data.season) : '')
      .replace('{episode}', data.episode != null ? String(data.episode) : '')
      .replace('{episodeRange}', data.episodeRange || '');

    rendered = String(rendered)
      .replace(/\s*\(\s*\)\s*/g, '')
      .replace(/\s*\-\s*(?:\-\s*)+/g, ' - ')
      .replace(/(^\s*\-\s*)|(\s*\-\s*$)/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (isMovie) {
      const y = String(templateYear || '').trim();
      if (y) rendered = `${stripTrailingYear(rendered)} (${y})`;
    } else {
      rendered = ensureRenderedNameHasYear(rendered, templateYear || '');
    }
    return rendered || null;
  } catch (e) {
    console.error('[renderProviderName] Error:', e);
    return null;
  }
}

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
app.post('/api/rename/preview', requireAuth, async (req, res) => {
  const { items, template, outputPath, useFilenameAsTitle, skipAnimeProviders } = req.body || {};
  if (!items || !Array.isArray(items)) return res.status(400).json({ error: 'items required' });
  const applyFilenameAsTitle = coerceBoolean(useFilenameAsTitle);
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
  
  // Enrich items on-demand if not already enriched (fixes issue where items beyond first 12 lack metadata)
  const username = req.session && req.session.username;
  let tmdbKey = null;
  try {
    if (username && users[username] && users[username].settings && users[username].settings.tmdb_api_key) {
      tmdbKey = users[username].settings.tmdb_api_key;
    } else if (serverSettings && serverSettings.tmdb_api_key) {
      tmdbKey = serverSettings.tmdb_api_key;
    }
  } catch (e) { tmdbKey = null; }
  
  // Check which items need enrichment and enrich them
  const enrichPromises = items.map(async (it) => {
    // Skip enrichment entirely when using filename as title
    if (applyFilenameAsTitle) {
      return;
    }
    const fromPath = canonicalize(it.canonicalPath);
    const existing = enrichCache[fromPath] || null;
    const prov = existing && existing.provider ? existing.provider : null;
    
    // If provider data exists but is missing renderedName, regenerate it from cached data
    // instead of re-enriching (prevents unnecessary API calls during approve)
    if (prov && prov.matched && !prov.renderedName && existing) {
      try {
        const providerRendered = renderProviderName(existing, fromPath, req.session);
        prov.renderedName = providerRendered;
        updateEnrichCache(fromPath, Object.assign({}, existing, { provider: prov }));
      } catch (e) { /* best effort */ }
    }
    
    // Only enrich if not already complete
    // During preview/apply, we should use cached metadata if it exists and is complete,
    // regardless of provider mode settings - those only matter during explicit rescan operations
    if (!isProviderComplete(prov)) {
      try {
        // When previewing/enriching items on-demand, if AniDB is the user's primary
        // metadata provider, prefer forcing hash so AniDB results are authoritative.
        const _previewProviderOrder = resolveMetadataProviderOrder(username);
        const _previewForceHash = (_previewProviderOrder && _previewProviderOrder.length && _previewProviderOrder[0] === 'anidb');
        const _previewOpts = Object.assign({}, { username });
        if (_previewForceHash) _previewOpts.forceHash = true;
        // Note: skipAnimeProviders is intentionally NOT passed here during preview
        // because we only want to apply provider filtering during explicit rescan operations,
        // not when generating rename plans from already-enriched items
        const data = await externalEnrich(fromPath, tmdbKey, _previewOpts);
        if (data) {
          const providerRendered = renderProviderName(data, fromPath, req.session);
          const providerRaw = cloneProviderRaw(extractProviderRaw(data));
          const providerBlock = {
            title: data.title,
            year: data.year,
            season: data.season,
            episode: data.episode,
            episodeTitle: data.episodeTitle || '',
            raw: providerRaw,
            renderedName: providerRendered,
            matched: !!data.title,
            source: data.source || (data.provider && data.provider.source) || null,
            seriesTitleEnglish: data.seriesTitleEnglish || null,
            seriesTitleRomaji: data.seriesTitleRomaji || null,
            seriesTitleExact: data.seriesTitleExact || null,
            originalSeriesTitle: data.originalSeriesTitle || null
          };
          updateEnrichCache(fromPath, Object.assign({}, enrichCache[fromPath] || {}, data, {
            provider: providerBlock,
            sourceId: 'provider',
            cachedAt: Date.now()
          }));
        }
      } catch (e) {
        try { appendLog(`PREVIEW_ENRICH_FAIL path=${fromPath} err=${e && e.message}`); } catch (ee) {}
      }
    }
  });
  
  // Wait for all enrichments to complete
  await Promise.all(enrichPromises);
  
  const plans = items.map(it => {
    const fromPath = canonicalize(it.canonicalPath);
    const key = fromPath;
    const meta = enrichCache[fromPath] || {};
  // prefer enrichment title (provider token) -> parsed/title/basename
  const rawTitle = (meta && (meta.title || (meta.extraGuess && meta.extraGuess.title))) ? (meta.title || (meta.extraGuess && meta.extraGuess.title)) : path.basename(fromPath, path.extname(fromPath));
  // Prefer explicit year fields on the enrichment entry; if missing, attempt to extract a year
  // from available metadata (episode/season/series dates) via extractYear so filenames
  // will include a year when provider metadata contains it.
  let year = '';
  try {
    if (meta && (meta.year || (meta.extraGuess && meta.extraGuess.year))) {
      year = meta.year || (meta.extraGuess && meta.extraGuess.year) || '';
    } else if (meta && meta.provider && meta.provider.year) {
      year = meta.provider.year;
    } else {
      year = extractYear(meta, fromPath) || '';
    }
  } catch (e) { year = '' }
    const ext = path.extname(fromPath);
    const filenameBase = sanitize(path.basename(fromPath, ext));
  // support {year} token in template; choose effective template in order: request -> user setting -> server setting -> default
  const userTemplate = (req && req.session && req.session.username && users[req.session.username] && users[req.session.username].settings && users[req.session.username].settings.rename_template) ? users[req.session.username].settings.rename_template : null;
  const baseNameTemplate = template || userTemplate || serverSettings.rename_template || '{title}';
    // compute epLabel from enrichment metadata
    function pad(n){ return String(n).padStart(2,'0') }
    
    // Check if we have an AniDB raw episode number that should be preserved (like "S2", "C1", "T1")
    const anidbRawEpisode = meta && meta.extraGuess && meta.extraGuess.anidb && meta.extraGuess.anidb.episodeNumberRaw;
    const shouldUseAnidbRaw = anidbRawEpisode && /^[SCTPO]\d+$/i.test(String(anidbRawEpisode));
    
    try {
      if (meta && meta.extraGuess && meta.extraGuess.anidb) {
        console.log('[DEBUG] AniDB raw episode check:', {
          hasAnidb: true,
          episodeNumberRaw: meta.extraGuess.anidb.episodeNumberRaw,
          anidbRawEpisode,
          shouldUseAnidbRaw,
          metaEpisode: meta.episode,
          metaSeason: meta.season
        });
      }
    } catch (e) {}
    
    let epLabel = ''
    if (meta && meta.episodeRange) {
      epLabel = meta.season != null ? `S${pad(meta.season)}E${meta.episodeRange}` : `E${meta.episodeRange}`
    } else if (shouldUseAnidbRaw) {
      // Use AniDB's raw episode format (S2, C1, etc.) with season 0 prefix
      epLabel = meta.season != null ? `S${pad(meta.season)}E${String(anidbRawEpisode).toUpperCase()}` : `E${String(anidbRawEpisode).toUpperCase()}`
    } else if (meta && meta.episode != null) {
      epLabel = meta.season != null ? `S${pad(meta.season)}E${pad(meta.episode)}` : `E${pad(meta.episode)}`
    }
  let episodeTitleToken = (meta && (meta.episodeTitle || (meta.extraGuess && meta.extraGuess.episodeTitle))) ? (meta.episodeTitle || (meta.extraGuess && meta.extraGuess.episodeTitle)) : '';

  // Support extra template tokens: {season}, {episode}, {episodeRange}, {tmdbId}
  let seasonToken = (meta && meta.season != null) ? String(meta.season) : '';
  let episodeToken = (meta && meta.episode != null) ? String(meta.episode) : '';
  let episodeRangeToken = (meta && meta.episodeRange) ? String(meta.episodeRange) : '';
  const tmdbIdToken = (meta && meta.tmdb && meta.tmdb.raw && (meta.tmdb.raw.id || meta.tmdb.raw.seriesId)) ? String(meta.tmdb.raw.id || meta.tmdb.raw.seriesId) : '';
  const isMovie = determineIsMovie(meta);
  if (isMovie === true) {
    epLabel = '';
    episodeTitleToken = '';
    seasonToken = '';
    episodeToken = '';
    episodeRangeToken = '';
  }

  const episodeTitleTokenFromMeta = (isMovie === true)
    ? ''
    : ((meta && (meta.episodeTitle || (meta.extraGuess && meta.extraGuess.episodeTitle))) ? (meta.episodeTitle || (meta.extraGuess && meta.extraGuess.episodeTitle)) : '');
  const resolvedSeriesTitle = resolveSeriesTitle(meta, rawTitle, fromPath, episodeTitleTokenFromMeta, { preferExact: true });
  const englishSeriesTitle = extractEnglishSeriesTitle(meta);
  const renderBaseTitle = (isMovie === true)
    ? (resolvedSeriesTitle || rawTitle)
    : (englishSeriesTitle || resolvedSeriesTitle || rawTitle);
  
  // Helper function to clean up title for rendering - strips episode artifacts but preserves full series title including subtitles
  function cleanTitleForRender(baseTitle, epLabel, epTitle) {
    try {
      let cleaned = String(baseTitle || '').trim();
      if (!cleaned) return '';
      
      // Remove episode markers like "- S01E01 - Episode Title" from end if present
      // But preserve the full series title including any colons or subtitles
      cleaned = cleaned.replace(/\s*[-–—:]+\s*S\d{1,2}E\d{1,3}(?:\s*[-–—:]+\s*.*)?$/i, '');
      cleaned = cleaned.replace(/\s*[-–—:]+\s*E\d{1,3}(?:\s*[-–—:]+\s*.*)?$/i, '');
      cleaned = cleaned.replace(/\s*[-–—:]+\s*Episode\s+\d+.*$/i, '');
      
      return cleaned.trim();
    } catch (e) {
      return String(baseTitle || '').trim();
    }
  }
  
  // Format episode number for title - use AniDB raw format if available
  let episodeForTitle = '';
  if (meta && meta.episode != null) {
    if (shouldUseAnidbRaw) {
      episodeForTitle = meta.season != null ? `S${String(meta.season).padStart(2,'0')}E${String(anidbRawEpisode).toUpperCase()}` : `E${String(anidbRawEpisode).toUpperCase()}`;
    } else {
      episodeForTitle = meta.season != null ? `S${String(meta.season).padStart(2,'0')}E${String(meta.episode).padStart(2,'0')}` : `E${String(meta.episode).padStart(2,'0')}`;
    }
  }
  
  const title = cleanTitleForRender(renderBaseTitle, episodeForTitle, episodeTitleTokenFromMeta);
  const templateYear = year ? String(year) : '';
  const folderYear = (isMovie === true && templateYear) ? templateYear : '';
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
        schedulePersistEnrichCache(100);
      }
    } catch (e) { /* best-effort cache update */ }
  }
  // Prefer explicit series titles from metadata when available.
  // Allow an explicit alias to override the computed name (and skip stripping) so known sequels
  // or numbered canonical titles (e.g. "Kaiju No. 8") are preserved as-is.
  // Prefer englishSeriesTitle (which already has Season suffix stripped) over meta.seriesTitleEnglish
  const seriesBase = englishSeriesTitle || (meta && (meta.seriesTitleEnglish || meta.seriesTitle)) || resolvedSeriesTitle || title || rawTitle || '';
  const aliasResolved = getSeriesAlias(seriesBase);
  let baseFolderName;
  if (aliasResolved) {
    baseFolderName = stripEpisodeArtifactsForFolder(String(aliasResolved).trim());
  } else {
    // For movies, don't strip Part N suffixes; only strip for TV series
    const shouldStripSeason = !(isMovie === true);
    baseFolderName = stripEpisodeArtifactsForFolder(shouldStripSeason ? String(stripSeasonNumberSuffix(seriesBase)).trim() : String(seriesBase).trim());
  }
  if (!baseFolderName) baseFolderName = stripEpisodeArtifactsForFolder(path.basename(fromPath, path.extname(fromPath)) || rawTitle || title);
  // Normalize folder name to consistent title-case to prevent duplicates from capitalization variance
  try { baseFolderName = titleCase(baseFolderName); } catch (e) {}
  let sanitizedBaseFolder = sanitize(baseFolderName);
  if (!sanitizedBaseFolder) {
    const fallbackFolderTitle = stripEpisodeArtifactsForFolder(title) || stripEpisodeArtifactsForFolder(rawTitle) || 'Untitled';
    sanitizedBaseFolder = sanitize(fallbackFolderTitle) || 'Untitled';
  }
  // Strip any trailing year from folder name - for movies it will be added back in standard format
  try { sanitizedBaseFolder = stripTrailingYear(sanitizedBaseFolder) } catch (e) {}
  
  // Enforce per-OS filename limits on folder and file base names
  try {
    const osKey = (req && req.session && req.session.username && users[req.session.username] && users[req.session.username].settings && users[req.session.username].settings.client_os) ? users[req.session.username].settings.client_os : (serverSettings && serverSettings.client_os ? serverSettings.client_os : 'linux');
    const maxLen = getMaxFilenameLengthForOS(osKey) || 255;
    if (sanitizedBaseFolder && sanitizedBaseFolder.length > maxLen) sanitizedBaseFolder = truncateFilenameComponent(sanitizedBaseFolder, maxLen);
  } catch (e) {}
  const titleFolder = folderYear ? `${sanitizedBaseFolder} (${folderYear})` : sanitizedBaseFolder;
  const seasonFolder = (!isMovie && meta && meta.season != null) ? `Season ${String(meta.season).padStart(2,'0')}` : '';
  // When using filename as title, skip series/season folder structure and place at output root
  const folder = applyFilenameAsTitle ? effectiveOutput : (seasonFolder ? path.join(effectiveOutput, titleFolder, seasonFolder) : path.join(effectiveOutput, titleFolder));

  // Render template with preferência to enrichment-provided tokens.
  // If the provider returned a renderedName (TMDb), prefer that exact rendered string for preview.
  // However, if this seems to be an episodic item and the provider-rendered name does not
  // contain episode information (SxxExx or episode title), prefer the user/template render
  // so previews include per-episode labels and the apply step won't collapse multiple
  // episodes into the same series-level filename.
  let nameWithoutExtRaw = null;
  if (applyFilenameAsTitle && filenameBase) {
    nameWithoutExtRaw = filenameBase;
  } else if (meta && meta.provider && meta.provider.renderedName) {
    // strip extension and insert year if provider-rendered name is missing it
    let providerName = String(meta.provider.renderedName).replace(/\.[^/.]+$/, '');
    try {
      // For TV series, strip season-like suffix; for movies, preserve Part N
      const shouldStripSeason = !(isMovie === true);
      if (shouldStripSeason) {
        const parts = providerName.split(/\s[-–—:]\s/);
        if (parts && parts.length > 0) {
          parts[0] = stripSeasonNumberSuffix(parts[0]);
          providerName = parts.join(' - ');
        } else {
          providerName = stripSeasonNumberSuffix(providerName);
        }
      }
      // Strip any existing year before adding to prevent duplication
      providerName = stripTrailingYear(providerName);
    } catch (e) {}
    if (isMovie === true) {
      const y = String(templateYear || '').trim();
      if (y) providerName = `${stripTrailingYear(providerName)} (${y})`;
    } else {
      providerName = ensureRenderedNameHasYear(providerName, templateYear);
    }
    // If this looks like a series-level rendered name (no episode tokens) but we
    // have episode metadata, prefer the template rendering so each episode gets
    // a unique filename.
    try {
      const hasEpisodeMeta = (isMovie !== true) && (meta && (meta.episode != null || meta.episodeRange));
      const providerLower = String(providerName || '').toLowerCase();
      const epLabelPresent = epLabel && providerLower.indexOf(String(epLabel).toLowerCase()) !== -1;
      const epTitlePresent = episodeTitleToken && providerLower.indexOf(String(episodeTitleToken).toLowerCase()) !== -1;
      const sxxMatch = /\bS\d{2}E\d{2}\b/i.test(providerName);
      const exxMatch = /\bE\d{1,3}\b/i.test(providerName);
      if (hasEpisodeMeta && !(epLabelPresent || epTitlePresent || sxxMatch || exxMatch)) {
        // fall through to template-based rendering below
        nameWithoutExtRaw = null;
      } else {
        // Sanitize to remove invalid filename characters (colons, etc)
        nameWithoutExtRaw = sanitize(providerName);
      }
    } catch (e) {
      // Sanitize to remove invalid filename characters (colons, etc)
      nameWithoutExtRaw = sanitize(providerName);
    }
  }
  
  if (!nameWithoutExtRaw) {
    // For movies, preserve Part N in the title; for TV shows, strip season suffixes
    const titleForFilename = (isMovie === true) ? title : stripSeasonNumberSuffix(title);
    nameWithoutExtRaw = baseNameTemplate
  .replace('{title}', sanitize(titleForFilename))
      .replace('{basename}', sanitize(path.basename(key, path.extname(key))))
  .replace('{year}', sanitize(templateYear))
      .replace('{epLabel}', sanitize(epLabel))
      .replace('{episodeTitle}', sanitize(episodeTitleToken))
      .replace('{season}', sanitize(seasonToken))
      .replace('{episode}', sanitize(episodeToken))
      .replace('{episodeRange}', sanitize(episodeRangeToken))
  .replace('{tmdbId}', sanitize(tmdbIdToken));
  }
  if (!nameWithoutExtRaw && filenameBase) {
    nameWithoutExtRaw = filenameBase;
  }
    // Clean up common artifact patterns from empty tokens: stray parentheses, repeated separators
    const nameWithoutExt = String(nameWithoutExtRaw)
      .replace(/\s*\(\s*\)\s*/g, '')
      .replace(/\s*\-\s*(?:\-\s*)+/g, ' - ')
      .replace(/(^\s*-\s*)|(\s*-\s*$)/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    // Apply filename length truncation to the complete basename (before extension)
    let truncatedNameWithoutExt = nameWithoutExt;
    try {
      const osKey = (req && req.session && req.session.username && users[req.session.username] && users[req.session.username].settings && users[req.session.username].settings.client_os) ? users[req.session.username].settings.client_os : (serverSettings && serverSettings.client_os ? serverSettings.client_os : 'linux');
      const maxLen = getMaxFilenameLengthForOS(osKey) || 255;
      // Account for extension length in the limit
      const extLen = ext ? ext.length : 0;
      const maxBasenameLen = Math.max(1, maxLen - extLen);
      if (truncatedNameWithoutExt && truncatedNameWithoutExt.length > maxBasenameLen) {
        truncatedNameWithoutExt = truncateFilenameComponent(truncatedNameWithoutExt, maxBasenameLen);
      }
    } catch (e) {}
    
    const fileName = (truncatedNameWithoutExt + ext).trim();
    // If an output path is configured, plan a hardlink under that path preserving a Jellyfin-friendly layout
    let toPath;
    if (effectiveOutput) {
      const finalFileName = fileName.replace(/\\/g, '/');
      toPath = path.join(folder, finalFileName).replace(/\\/g, '/');
    } else {
      toPath = path.join(path.dirname(fromPath), fileName).replace(/\\/g, '/');
    }
    const action = effectiveOutput ? 'hardlink' : (fromPath === toPath ? 'noop' : 'move');
  return { itemId: it.id, fromPath, toPath, actions: [{ op: action }], templateUsed: baseNameTemplate };
  });
  // DEBUG: persist a compact preview plan summary to logs for diagnostic purposes
  try {
    const uname = req && req.session && req.session.username ? req.session.username : '<anon>';
    const dump = (plans || []).slice(0, 50).map(p => ({ itemId: p.itemId, from: p.fromPath, to: p.toPath, templateUsed: p.templateUsed }));
    appendLog(`PREVIEW_PLANS user=${uname} count=${(plans||[]).length} payload=${JSON.stringify(dump)}`);
  } catch (e) { /* non-fatal debug logging */ }
  
  // Ensure any side-effect updates (English titles, movie flags) are persisted immediately
  try { persistEnrichCacheNow(); } catch (e) {}

  res.json({ plans });
});

function sanitize(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, '');
}

function ensureRenderedNameHasYear(name, year) {
  try {
    let result = String(name || '').trim();
    const yearToken = String(year || '').trim();
    if (!result || !yearToken) return result;
    // Remove any existing parenthetical occurrences of the same year to avoid duplicates
    try {
      const parenRe = new RegExp(`\\(\\s*${escapeRegExp(yearToken)}\\s*\\)`, 'g');
      result = result.replace(parenRe, '').replace(/\s{2,}/g, ' ').trim();
    } catch (e) {}
    
    // For TV shows: insert year BEFORE episode markers (S01E08, E01, etc.), not just before first separator
    // This ensures format: "Title (Year) - S01E08 - Episode" not "Title- S01E08 (Year) - Episode"
    const episodeMarkerPattern = /[\s\-–—]*(?:S\d{1,2}E\d{1,3}|E\d{1,3})\b/i;
    const epMatch = result.match(episodeMarkerPattern);
    if (epMatch && epMatch.index != null) {
      // Found episode marker - insert year before it
      const beforeEp = result.slice(0, epMatch.index).trim();
      const fromEp = result.slice(epMatch.index);
      return `${beforeEp} (${yearToken}) ${fromEp.trim()}`;
    }
    
    // If the original contained the year as a standalone token, normalize to a single parenthetical
    const yearPattern = new RegExp(`\\b${escapeRegExp(yearToken)}\\b`);
    if (yearPattern.test(result)) {
      // insert a single parenthetical year before the first separator
      const splitIdx = result.indexOf(' - ');
      if (splitIdx !== -1) {
        const basePart = result.slice(0, splitIdx).trim();
        const suffixPart = result.slice(splitIdx);
        return `${basePart} (${yearToken})${suffixPart}`;
      }
      return `${result} (${yearToken})`;
    }
    // Otherwise, just insert the parenthetical year before first separator or at end
    const splitIdx = result.indexOf(' - ');
    if (splitIdx !== -1) {
      const basePart = result.slice(0, splitIdx).trim();
      const suffixPart = result.slice(splitIdx);
      return `${basePart} (${yearToken})${suffixPart}`;
    }
    return `${result} (${yearToken})`;
  } catch (e) {
    return String(name || '').trim();
  }
}

// Remove trailing year in parentheses, e.g. "Show (2022)" -> "Show"
function stripTrailingYear(s) {
  try {
    return String(s || '').replace(/\s*\(\s*\d{4}\s*\)\s*$/, '').trim();
  } catch (e) { return String(s || '').trim(); }
}

function stripEpisodeArtifactsForFolder(name) {
  try {
    let out = String(name || '').trim();
    if (!out) return out;
    out = out.replace(/\s*[-–—:]+\s*S\d{1,2}E\d{1,3}(?:\s*[-–—:]+\s*.*)?$/i, '');
    out = out.replace(/\s*[-–—:]+\s*E\d{1,3}(?:\s*[-–—:]+\s*.*)?$/i, '');
    out = out.replace(/\s*[-–—:]+\s*Episode\s+\d+.*$/i, '');
    return out.trim();
  } catch (e) {
    return String(name || '').trim();
  }
}

// Remove trailing season-number-like suffixes ("Title 2", "Title II", "Title - Season 2", "Title Part 2")
function stripSeasonNumberSuffix(name) {
  try {
    if (!name) return name;
    const orig = String(name).trim();
    let s = orig;
    // Do not aggressively strip when the numeric suffix appears to be part of a canonical title
    // Examples to preserve: "Kaiju No. 8", "No. 6", "Volume 2", "Vol. 2", "Chapter 3"
    // If the suffix is explicitly prefixed with common non-season tokens, don't strip.
    if (/\b(No\.?|Vol(?:ume)?|Chapter|Ch\.?|Book)\b\s*\d+\s*$/i.test(s)) return orig;

    // If the title contains an explicit 'No.' token anywhere, assume numeric parts may be canonical
    if (/\bNo\.?\b/i.test(s) && /\d+\b/.test(s)) return orig;

    // Remove common season/part patterns at the end (with or without separators/hashes)
    // Match patterns like: "Season 2", "Season #2", "- Season 2", "(Season 2)", etc.
    s = s.replace(/\s*[\-–—:\/\(]?\s*(?:Season|Series|Part)\s*(?:#\s*)?(?:\b(?:[0-9]{1,2}|[IVXLC]+|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|[0-9]{1,2}(?:st|nd|rd|th))\b)\s*\)?$/i, '').trim();
    
    // Also strip patterns where the ordinal/number precedes the word 'Season', e.g. '2nd Season' or 'Second Season'
    try {
      // numeric ordinal before 'Season'
      s = s.replace(/\s+\d{1,2}(?:st|nd|rd|th)?\s+Season\s*$/i, '').trim();
      // textual ordinals (first, second, third, ...)
      s = s.replace(/\s+(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+Season\s*$/i, '').trim();
      // also handle forms like 'Season Second' (rare) just in case
      s = s.replace(/\s+Season\s+(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s*$/i, '').trim();
    } catch (e) { /* best-effort */ }
    return s;
  } catch (e) { return String(name || '').trim() }
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

function isExtrasFolderToken(value) {
  if (!value) return false;
  const norm = String(value).replace(/[\._\-]+/g, ' ').trim().toLowerCase();
  if (!norm) return false;
  // Common extras/bonus folder names that should be skipped when looking for series title
  const EXTRAS_KEYWORDS = [
    'featurettes', 'featurette', 'extras', 'extra', 'bonus', 'bonuses',
    'behind the scenes', 'bts', 'interviews', 'interview', 'deleted scenes',
    'making of', 'special', 'specials', 'special features', 'documentary', 'documentaries',
    'trailers', 'trailer', 'promos', 'promo', 'clips', 'outtakes', 'bloopers'
  ];
  for (const keyword of EXTRAS_KEYWORDS) {
    if (norm === keyword) return true;
    // Also match if it starts with the keyword followed by space/number (e.g., "Featurettes 2024")
    if (norm.startsWith(keyword + ' ')) return true;
  }
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
    const push = (value, stripSeason = true) => {
      if (!value) return;
      let trimmed = String(value).trim();
      if (!trimmed) return;
      // Strip "Season X" suffix from English titles since we specify season with SxxExx notation
      if (stripSeason) {
        trimmed = trimmed.replace(/\s+Season\s+\d{1,2}$/i, '').trim();
        trimmed = trimmed.replace(/\s+\(Season\s+\d{1,2}\)$/i, '').trim();
      }
      const key = trimmed.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(trimmed);
    };
    if (meta && typeof meta === 'object') {
      // Priority 1: Explicitly marked English titles
      push(meta.seriesTitleEnglish);
      if (meta.extraGuess) {
        push(meta.extraGuess.seriesTitleEnglish);
      }
      if (meta.provider) {
        push(meta.provider.seriesTitleEnglish);
        push(meta.provider.titleEnglish);
      }
      
      // Priority 2: English field in raw title objects (AniList/TVDB)
      // Check provider.raw.title.english first (most common case)
      if (meta.provider && meta.provider.raw && typeof meta.provider.raw === 'object') {
        const rawTitle = meta.provider.raw.title;
        if (rawTitle && typeof rawTitle === 'object' && rawTitle.english) {
          push(rawTitle.english);
        }
      }
      
      // Check meta.raw.title.english (AniList search results)
      if (meta.raw && typeof meta.raw === 'object' && meta.raw.title && typeof meta.raw.title === 'object' && meta.raw.title.english) {
        push(meta.raw.title.english);
      }
      
      // Check extraGuess provider raw
      if (meta.extraGuess && meta.extraGuess.provider && meta.extraGuess.provider.raw && typeof meta.extraGuess.provider.raw === 'object') {
        const extraRawTitle = meta.extraGuess.provider.raw.title;
        if (extraRawTitle && typeof extraRawTitle === 'object' && extraRawTitle.english) {
          push(extraRawTitle.english);
        }
      }
      
      // Priority 3: Fallback to romaji if English not available
      if (out.length === 0) {
        // Try romaji from provider.raw.title
        if (meta.provider && meta.provider.raw && typeof meta.provider.raw === 'object') {
          const rawTitle = meta.provider.raw.title;
          if (rawTitle && typeof rawTitle === 'object' && rawTitle.romaji) {
            push(rawTitle.romaji);
          }
        }
        // Try romaji from meta.raw.title
        if (meta.raw && typeof meta.raw === 'object' && meta.raw.title && typeof meta.raw.title === 'object' && meta.raw.title.romaji) {
          push(meta.raw.title.romaji);
        }
      }
      
      // Priority 4: Rendered name from provider (already cleaned)
      if (meta.provider && meta.provider.renderedName) {
        let rendered = String(meta.provider.renderedName || '').replace(/\.[^/.]+$/, '');
        const dashSplit = rendered.split(/\s+-\s+S\d{1,2}/i);
        if (dashSplit.length > 1) rendered = dashSplit[0];
        rendered = rendered.replace(/\s+\(Season\s+\d{1,2}\)$/i, '').trim();
        if (rendered) push(rendered);
      }
      
      // Priority 5: Generic title field
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
      // If we have an English-preferred title, prefer it early so provider-localized names
      // (e.g., Japanese) don't override a clear English series title.
      if (englishPreferred) push(englishPreferred);
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
  // englishPreferred already pushed if present; keep fallbackTitle afterwards
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
    const cacheSize = Object.keys(enrichCache || {}).length;
    if (db) {
      db.setKV('enrichCache', enrichCache);
      try { appendLog(`ENRICH_CACHE_PERSIST_OK db=true size=${cacheSize}`); } catch (e) {}
    } else {
      writeJson(enrichStoreFile, enrichCache);
      try { appendLog(`ENRICH_CACHE_PERSIST_OK file=true size=${cacheSize}`); } catch (e) {}
    }
  } catch (e) { 
    try { appendLog(`ENRICH_CACHE_PERSIST_FAIL err=${e.message} db=${!!db}`); } catch (ee) {}
  }
  try { if (_enrichPersistTimeout) { clearTimeout(_enrichPersistTimeout); _enrichPersistTimeout = null; } } catch (e) {}
}

function schedulePersistEnrichCache(delayMs = 100) {
  try {
    if (_enrichPersistTimeout) clearTimeout(_enrichPersistTimeout);
    _enrichPersistTimeout = setTimeout(() => { try { persistEnrichCacheNow(); } catch (e) {} }, delayMs);
  } catch (e) { try { persistEnrichCacheNow(); } catch (ee) {} }
}

// Centralized cache purge for a canonical path. Optionally preserves applied/hidden flags
// so forced refreshes do not lose approval state, and tracks which caches mutated.
function purgeCachesForPath(rawKey, { preserveFlags = true, persist = false } = {}) {
  const result = { enrichCache: false, parsedCache: false, renderedIndex: false };
  try {
    const key = canonicalize(rawKey || '');
    if (!key) return result;

    // Preserve approval/hide flags if requested
    let keep = null;
    if (preserveFlags && enrichCache && enrichCache[key]) {
      const prev = enrichCache[key];
      const applied = prev && prev.applied;
      const hidden = prev && prev.hidden;
      if (applied || hidden) {
        keep = {};
        if (applied) {
          keep.applied = applied;
          if (typeof prev.appliedAt !== 'undefined') keep.appliedAt = prev.appliedAt;
          if (typeof prev.appliedTo !== 'undefined') keep.appliedTo = prev.appliedTo;
        }
        if (hidden) keep.hidden = hidden;
      }
    }

    // Purge enrich cache entry
    if (enrichCache && Object.prototype.hasOwnProperty.call(enrichCache, key)) {
      if (keep && Object.keys(keep).length) {
        enrichCache[key] = keep;
      } else {
        delete enrichCache[key];
      }
      result.enrichCache = true;
    }

    // Purge parsed cache entry
    if (parsedCache && Object.prototype.hasOwnProperty.call(parsedCache, key)) {
      delete parsedCache[key];
      result.parsedCache = true;
    }

    // Drop any renderedIndex entries that reference this source/applied target
    try {
      const rKeys = Object.keys(renderedIndex || {});
      for (const rk of rKeys) {
        const entry = renderedIndex[rk];
        let match = false;
        if (typeof entry === 'string') {
          try { match = canonicalize(entry) === key; } catch (e) { match = false; }
        } else if (entry && typeof entry === 'object') {
          try {
            if (entry.source && canonicalize(entry.source) === key) match = true;
            else if (entry.appliedTo && canonicalize(entry.appliedTo) === key) match = true;
          } catch (e) { match = false; }
        }
        if (match) {
          delete renderedIndex[rk];
          result.renderedIndex = true;
        }
      }
    } catch (e) { /* best-effort */ }

    if (persist) {
      try { if (db) db.setKV('enrichCache', enrichCache); else writeJson(enrichStoreFile, enrichCache); } catch (e) {}
      try { if (db) db.setKV('parsedCache', parsedCache); else writeJson(parsedCacheFile, parsedCache); } catch (e) {}
      if (result.renderedIndex) {
        try { if (db) db.setKV('renderedIndex', renderedIndex); else writeJson(renderedIndexFile, renderedIndex); } catch (e) {}
      }
    }
  } catch (e) { /* best-effort */ }
  return result;
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
    // Persist sooner so rescans show updated values quickly (best-effort, debounced)
    try { schedulePersistEnrichCache(50); } catch (e) {}
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
    schedulePersistEnrichCache(100);
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
    schedulePersistEnrichCache(100);
    return merged;
  } catch (e) { /* best-effort */ }
}

function clearProviderFailure(key) {
  try {
    const prev = enrichCache[key] || {};
    if (!prev.providerFailure) return;
    const merged = updateEnrichCacheInMemory(key, Object.assign({}, prev, { providerFailure: null }));
    schedulePersistEnrichCache(100);
    return merged;
  } catch (e) { /* best-effort */ }
}

// Helper: clean series title to avoid duplicated episode label or episode title fragments
function escapeRegExp(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function cleanTitleForRender(t, epLabel, epTitle) {
  if (!t) return '';
  let s = String(t).trim();
  try {
    // Strip "Season X" suffix since we specify season with SxxExx notation
    s = s.replace(/\s+Season\s+\d{1,2}$/i, '').trim();
    s = s.replace(/\s+\(Season\s+\d{1,2}\)$/i, '').trim();
    
    // Remove episode label if present (e.g., "Title - S01E01", "Title- S01E01", "Title-S01E01")
    if (epLabel) {
      const lbl = String(epLabel).trim();
      if (lbl) {
        // Remove with various separators: " - S01E01", "- S01E01", " S01E01", "-S01E01"
        s = s.replace(new RegExp('[\\s\\-–—:]*' + escapeRegExp(lbl) + '(?=[\\s\\-–—:]|$)', 'gi'), '').trim();
      }
    }
    // Also strip any remaining SxxExx patterns anywhere in the string
    s = s.replace(/[\s\-–—:]*S\d{1,2}E\d{1,3}(?=[\\s\-–—:]|$)/gi, '').trim();
    s = s.replace(/^\s*S\d{1,2}[\s_\-:\.]*[EPp]?(\d{1,3})?(?:\.\d+)?[\s_\-:\.]*/i, '').trim();
    if (epTitle) {
      const et = String(epTitle).trim();
      if (et) s = s.replace(new RegExp('[\-–—:\\s]*' + escapeRegExp(et) + '$', 'i'), '').trim();
    }
    s = s.replace(/^[\-–—:\s]+|[\-–—:\s]+$/g, '').trim();
  } catch (e) { /* best-effort */ }
  return s || String(t).trim();
}

function isLikelyRomajiTitle(title, meta) {
  try {
    if (!title) return false;
    const t = String(title).trim();
    if (!t) return false;
    // If provider explicitly marked title source as romaji, trust it
    if (meta && (meta.titleSource === 'romaji' || meta.anidbTitleSource === 'romaji')) return true;
    // Heuristic: romaji often mixes lowercase particles like "wa", "no", "ni", etc. Capitalized particles are a sign of inconsistent casing
    const particles = ['wa','no','ni','to','de','e','kara','made','ga','wo','ya','mo'];
    const words = t.split(/\s+/);
    const hasCapParticle = words.some((w, idx) => {
      if (idx === 0) return false; // allow first word capitalization
      const core = w.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
      if (!core) return false;
      return particles.includes(core.toLowerCase()) && /^[A-Z][a-z]+$/.test(core);
    });
    // If we see capitalized particles, treat as romaji needing normalization
    if (hasCapParticle) return true;
    // Additional hint: presence of long vowels/romaji-specific punctuation
    if (/ou|uu|aa|ei/.test(t) && /\b[Ww]a\b/.test(t)) return true;
    return false;
  } catch (e) { return false; }
}

function normalizeRomajiParticlesCase(title) {
  if (!title) return title;
  const particles = new Set(['wa','no','ni','to','de','e','kara','made','ga','wo','ya','mo']);
  const tokens = String(title).split(/(\s+)/); // keep whitespace separators
  let seenWord = false;
  const normalized = tokens.map(tok => {
    if (!tok || /^(\s+)$/.test(tok)) return tok;
    const core = tok.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
    if (!core) return tok;
    const lower = core.toLowerCase();
    if (seenWord && particles.has(lower) && /^[A-Z][a-z]+$/.test(core)) {
      return tok.replace(core, lower);
    }
    seenWord = true;
    return tok;
  });
  return normalized.join('').replace(/\s{2,}/g, ' ').trim();
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
app.post('/api/rename/apply', requireAuth, async (req, res) => {
  const { plans, dryRun, outputFolder } = req.body || {};
  if (!plans || !Array.isArray(plans)) return res.status(400).json({ error: 'plans required' });

  // Diagnostic: dump the incoming plans payload
  try {
    const dumpUser = req.session && req.session.username ? req.session.username : '<anon>';
    const dumpPath = path.join(process.cwd(), 'data', `apply-plans-dump-${Date.now()}.json`);
    try { fs.writeFileSync(dumpPath, JSON.stringify({ user: dumpUser, plans: plans }, null, 2), { encoding: 'utf8' }); } catch (e) {}
  } catch (e) {}

  try { healCachedEnglishAndMovieFlags(); } catch (e) {}

  const results = [];
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Helper to ensure directory exists with retries
  const ensureDir = async (dir) => {
    if (fs.existsSync(dir)) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      // retry once after delay
      await sleep(50);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
  };

  for (const p of plans) {
    const resultItem = { itemId: p.itemId, status: 'pending' };
    try {
      const fromPath = path.resolve(p.fromPath);
      
      // STRICTLY use the plan's toPath (Preview WYSIWYG)
      if (!p.toPath) {
        throw new Error('Plan missing target path (preview required)');
      }
      
      let toPath = path.resolve(p.toPath);

      // If an explicit output folder override was provided (e.g. via "Apply to..." UI),
      // re-base the target path to be inside that folder, preserving the folder structure
      // (series folder, season folder) from the preview.
      if (outputFolder && typeof outputFolder === 'string') {
        // Extract the relative path from the original preview by finding the portion
        // after the configured output path. This preserves Series/Season folder structure.
        const username = req.session && req.session.username ? req.session.username : null;
        const userOutput = username && users[username] && users[username].settings && users[username].settings.scan_output_path 
          ? users[username].settings.scan_output_path 
          : null;
        const configuredOutput = userOutput || (serverSettings && serverSettings.scan_output_path) || '';
        
        let relativePath = path.basename(toPath); // fallback to just filename
        if (configuredOutput) {
          try {
            const resolvedConfigOutput = path.resolve(configuredOutput);
            const resolvedToPath = path.resolve(p.toPath);
            if (resolvedToPath.startsWith(resolvedConfigOutput)) {
              relativePath = path.relative(resolvedConfigOutput, resolvedToPath);
            }
          } catch (e) {
            // If relative path extraction fails, fall back to basename
          }
        }
        
        toPath = path.join(outputFolder, relativePath);
      }

      // Validation
      if (fromPath === toPath) {
        resultItem.status = 'noop';
        results.push(resultItem);
        continue;
      }

      if (!fs.existsSync(fromPath)) {
        resultItem.status = 'error';
        resultItem.error = 'Source file not found';
        results.push(resultItem);
        continue;
      }

      if (!dryRun) {
        const parentDir = path.dirname(toPath);
        await ensureDir(parentDir);

        if (fs.existsSync(toPath)) {
          resultItem.status = 'exists';
          resultItem.to = toPath;
        } else {
          // Hardlink with retry for "fails first time" issues
          let linked = false;
          let lastErr = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              fs.linkSync(fromPath, toPath);
              linked = true;
              break;
            } catch (err) {
              lastErr = err;
              if (err.code === 'EEXIST') {
                linked = true; // effectively success
                break;
              }
              // Wait and retry
              await sleep(100 * (attempt + 1));
            }
          }

          if (!linked) {
            throw lastErr || new Error('Hardlink failed after retries');
          }

          resultItem.status = 'hardlinked';
          resultItem.to = toPath;
          appendLog(`HARDLINK_SUCCESS from=${fromPath} to=${toPath}`);

          // Update Cache/DB
          try {
            const fromKey = canonicalize(fromPath);
            enrichCache[fromKey] = enrichCache[fromKey] || {};
            enrichCache[fromKey].applied = true;
            enrichCache[fromKey].hidden = true;
            enrichCache[fromKey].appliedAt = Date.now();
            enrichCache[fromKey].appliedTo = toPath;
            
            const finalBasename = path.basename(toPath);
            enrichCache[fromKey].renderedName = finalBasename;
            enrichCache[fromKey].metadataFilename = finalBasename.replace(path.extname(finalBasename), '');

            // Update renderedIndex
            const targetKey = canonicalize(toPath);
            renderedIndex[targetKey] = {
                source: fromPath,
                renderedName: finalBasename,
                appliedTo: toPath,
                metadataFilename: enrichCache[fromKey].metadataFilename,
                provider: enrichCache[fromKey].provider || null,
                parsed: enrichCache[fromKey].parsed || null
            };
            
            // Persist immediately to avoid data loss
            if (db) {
                db.setKV('enrichCache', enrichCache);
                db.setKV('renderedIndex', renderedIndex);
            }
          } catch (dbErr) {
            appendLog(`DB_UPDATE_FAIL ${dbErr.message}`);
          }
        }
      } else {
        resultItem.status = 'dry-run';
        resultItem.to = toPath;
      }
      results.push(resultItem);

    } catch (e) {
      resultItem.status = 'error';
      resultItem.error = e.message;
      appendLog(`APPLY_ERROR item=${p.itemId} err=${e.message}`);
      results.push(resultItem);
    }
  }

  // Final bulk save if no DB
  if (!db) {
      try { writeJson(enrichStoreFile, enrichCache); } catch (e) {}
      try { writeJson(renderedIndexFile, renderedIndex); } catch (e) {}
  } else {
      // Ensure everything is flushed even if per-item saves were used
      try { persistEnrichCacheNow(); } catch (e) {}
  }

  // Remove applied items from scans to prevent them from reappearing on next load
  // This is critical to keep scans in sync with enrichCache applied/hidden state
  try {
    let removedFromScans = 0;
    const appliedPaths = new Set(plans.filter(p => {
      const r = results.find(res => res.itemId === p.itemId);
      return r && r.status === 'hardlinked';
    }).map(p => canonicalize(p.fromPath)));

    if (appliedPaths.size > 0) {
      const scanIds = Object.keys(scans || {});
      for (const sid of scanIds) {
        try {
          const scan = scans[sid];
          if (!scan || !Array.isArray(scan.items)) continue;
          const before = scan.items.length;
          scan.items = scan.items.filter(it => {
            try {
              const k = canonicalize(it.canonicalPath);
              return !appliedPaths.has(k);
            } catch (e) { return true; }
          });
          const removed = before - scan.items.length;
          if (removed > 0) {
            scan.totalCount = scan.items.length;
            removedFromScans += removed;
          }
        } catch (e) { /* ignore per-scan errors */ }
      }
      
      if (removedFromScans > 0) {
        try { 
          if (db) db.saveScansObject(scans); 
          else writeJson(scanStoreFile, scans); 
          appendLog(`APPLY_SCAN_UPDATE removed=${removedFromScans} applied items from scans`);
        } catch (e) { 
          appendLog(`APPLY_SCAN_UPDATE_FAIL err=${e && e.message ? e.message : String(e)}`);
        }
      }
    }
  } catch (e) { 
    appendLog(`APPLY_SCAN_FILTER_FAIL err=${e && e.message ? e.message : String(e)}`);
  }

  res.json({ results });
});
function performUnapprove({ requestedPaths = null, count = 10, username = null } = {}) {
  const changed = [];
  const shouldDeleteHardlinks = resolveDeleteHardlinksSetting(username);
  const hardlinkTargets = new Map();
  const canonicalTargets = new Set();
  const restoredItems = [];

  const dropRenderedIndexTarget = (canonicalTarget) => {
    try {
      if (!canonicalTarget) return;
      if (renderedIndex && Object.prototype.hasOwnProperty.call(renderedIndex, canonicalTarget)) {
        delete renderedIndex[canonicalTarget];
      }
      const rKeys = Object.keys(renderedIndex || {});
      for (const rk of rKeys) {
        const entry = renderedIndex[rk];
        if (typeof entry === 'string') {
          try {
            if (canonicalize(entry) === canonicalTarget) delete renderedIndex[rk];
          } catch (e) { /* ignore */ }
        } else if (entry && typeof entry === 'object' && entry.appliedTo) {
          try {
            if (canonicalize(entry.appliedTo) === canonicalTarget) delete renderedIndex[rk];
          } catch (e) { /* ignore */ }
        }
      }
    } catch (e) { /* ignore */ }
  };

  function markUnapproved(key) {
    try {
      const entry = enrichCache[key];
      if (!entry) return;
      
      // Determine if we need to restore a moved file or delete a hardlink
      const sourceExists = fs.existsSync(key);
      const appliedTo = entry.appliedTo;
      
      if (appliedTo) {
        const list = Array.isArray(appliedTo) ? appliedTo : [appliedTo];
        for (const raw of list) {
          if (!raw) continue;
          try {
            const resolved = path.resolve(raw);
            const canonicalTarget = canonicalize(resolved);
            if (!canonicalTarget || canonicalTarget === key) continue;
            
            // If source is missing and target exists, this was likely a move (rename).
            // We must restore the file by moving it back.
            if (!sourceExists && fs.existsSync(resolved)) {
              try {
                const sourceDir = path.dirname(key);
                if (!fs.existsSync(sourceDir)) fs.mkdirSync(sourceDir, { recursive: true });
                fs.renameSync(resolved, key);
                appendLog(`UNAPPROVE_RESTORE_MOVE from=${resolved} to=${key}`);
                // Since we moved it back, we don't delete the target (it's gone)
                // and we don't treat it as a hardlink target.
                dropRenderedIndexTarget(canonicalTarget);
              } catch (err) {
                appendLog(`UNAPPROVE_RESTORE_FAIL from=${resolved} to=${key} err=${err.message}`);
              }
            } else {
              // Source exists (hardlink case) or target missing.
              // Schedule for deletion if configured.
              canonicalTargets.add(canonicalTarget);
              if (!hardlinkTargets.has(canonicalTarget)) {
                hardlinkTargets.set(canonicalTarget, { resolved, original: raw });
              }
            }
          } catch (e) { /* ignore invalid paths */ }
        }
      }

      let updated = false;
      if (entry.applied) {
        entry.applied = false;
        delete entry.appliedAt;
        delete entry.appliedTo;
        updated = true;
      } else if (entry.appliedTo) {
        delete entry.appliedTo;
        updated = true;
      }
      if (entry.hidden) {
        entry.hidden = false;
        updated = true;
      }
      if (updated) {
        if (!changed.includes(key)) changed.push(key);
        // Track item to restore to scans
        restoredItems.push(key);
      }
    } catch (e) {}
  }

  if (Array.isArray(requestedPaths) && requestedPaths.length > 0) {
    for (const p of requestedPaths) markUnapproved(p);
  } else {
    const applied = Object.keys(enrichCache)
      .map(k => ({ k, v: enrichCache[k] }))
      .filter(x => x.v && x.v.applied)
      .sort((a, b) => (b.v.appliedAt || 0) - (a.v.appliedAt || 0));
    const limit = (count && count > 0) ? count : applied.length;
    const toUn = applied.slice(0, limit);
    for (const item of toUn) markUnapproved(item.k);
  }

  try { if (db) db.setKV('enrichCache', enrichCache); else writeJson(enrichStoreFile, enrichCache); } catch (e) {}

  const deletedHardlinks = [];
  const hardlinkErrors = [];
  let renderedIndexMutated = false;

  if (canonicalTargets.size) {
    for (const canonicalTarget of canonicalTargets) {
      dropRenderedIndexTarget(canonicalTarget);
      renderedIndexMutated = true;
      if (!shouldDeleteHardlinks) continue;
      const info = hardlinkTargets.get(canonicalTarget);
      if (!info || !info.resolved) continue;
      try {
        // Check if file still exists (might have been moved back already if logic was mixed, but here we separated it)
        if (!fs.existsSync(info.resolved)) continue;
        
        const stat = fs.lstatSync(info.resolved);
        if (stat.isDirectory()) {
          hardlinkErrors.push({ path: info.resolved, error: 'target is a directory' });
          continue;
        }
        fs.unlinkSync(info.resolved);
        deletedHardlinks.push(info.resolved);
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          deletedHardlinks.push(info.resolved);
        } else {
          hardlinkErrors.push({ path: info.resolved, error: err && err.message ? err.message : String(err) });
        }
      }
    }
  }

  if (renderedIndexMutated) {
    try { if (db) db.setKV('renderedIndex', renderedIndex); else writeJson(renderedIndexFile, renderedIndex); } catch (e) {}
  }

  // Inject restored items back into active scans so they appear immediately in UI
  if (restoredItems.length > 0) {
    try {
      const scanIds = Object.keys(scans || {});
      let scansUpdated = false;
      for (const sid of scanIds) {
        const s = scans[sid];
        if (!s || !Array.isArray(s.items)) continue;
        let modified = false;
        for (const key of restoredItems) {
          // Check if already present
          const exists = s.items.some(it => canonicalize(it.canonicalPath) === key);
          if (!exists) {
            // Add it back
            s.items.push({ id: uuidv4(), canonicalPath: key, scannedAt: Date.now() });
            modified = true;
          }
        }
        if (modified) {
          s.totalCount = s.items.length;
          scansUpdated = true;
        }
      }
      if (scansUpdated) {
        try { if (db) db.saveScansObject(scans); else writeJson(scanStoreFile, scans); } catch (e) {}
      }
    } catch (e) { appendLog(`UNAPPROVE_SCAN_UPDATE_FAIL err=${e.message}`); }
  }

  return { changed, deletedHardlinks, hardlinkErrors, shouldDeleteHardlinks };
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

function normalizeApprovedSeriesLookupTitle(value) {
  try {
    const raw = String(value || '').trim();
    if (!raw) return '';
    return raw
      .replace(/\(\s*((?:19|20)\d{2})\s*\)\s*\(\s*\1\s*\)\s*$/i, '($1)')
      .replace(/\s*\(\s*(19|20)\d{2}\s*\)\s*$/i, '')
      .replace(/\s+(19|20)\d{2}\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  } catch (e) { return String(value || '').trim(); }
}

function normalizeApprovedSeriesDisplayTitle(value) {
  try {
    const raw = String(value || '').trim();
    if (!raw) return '';
    return raw
      .replace(/\(\s*((?:19|20)\d{2})\s*\)\s*\(\s*\1\s*\)\s*$/i, '($1)')
      .replace(/\s*\(\s*(19|20)\d{2}\s*\)\s*$/i, '')
      .replace(/\s+(19|20)\d{2}\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  } catch (e) { return String(value || '').trim(); }
}

function collectApprovedSeriesMetadataTitles(outputKey, seriesName) {
  const titles = [];
  const seen = new Set();
  const addTitle = (value) => {
    try {
      const raw = String(value || '').trim();
      if (!raw) return;
      const normalized = normalizeApprovedSeriesLookupTitle(raw);
      if (!normalized) return;
      const cacheKey = normalized.toLowerCase();
      if (seen.has(cacheKey)) return;
      seen.add(cacheKey);
      titles.push(normalized);
    } catch (e) { /* ignore */ }
  };

  try {
    const normalizedOutputKey = normalizeOutputKey(outputKey);
    const normalizedSeriesCandidates = Array.from(new Set([
      normalizeForCache(seriesName),
      normalizeForCache(normalizeApprovedSeriesDisplayTitle(seriesName)),
      normalizeForCache(normalizeApprovedSeriesLookupTitle(seriesName))
    ].filter(Boolean)));
    if (!normalizedOutputKey || !normalizedSeriesCandidates.length) {
      addTitle(seriesName);
      return titles;
    }

    addTitle(seriesName);

    for (const cacheKey of Object.keys(enrichCache || {})) {
      const entry = enrichCache[cacheKey];
      if (!entry || entry.applied !== true || !entry.appliedTo) continue;
      const targets = Array.isArray(entry.appliedTo) ? entry.appliedTo : [entry.appliedTo];
      for (const target of targets) {
        if (!target) continue;
        const info = deriveAppliedSeriesInfo(target);
        const bucketKey = normalizeOutputKey(info.outputRoot || path.dirname(path.dirname(target)));
        if (!bucketKey || bucketKey !== normalizedOutputKey) continue;

        const folderSeries = normalizeForCache(info.seriesName || '');
        if (!folderSeries || !normalizedSeriesCandidates.includes(folderSeries)) continue;

        addTitle(entry.seriesTitleEnglish);
        addTitle(entry.seriesTitleExact);
        addTitle(entry.seriesTitle);
        addTitle(entry.title);
        if (entry.provider && typeof entry.provider === 'object') {
          addTitle(entry.provider.title);
          addTitle(entry.provider.seriesTitleEnglish);
          addTitle(entry.provider.seriesTitleRomaji);
          addTitle(entry.provider.seriesTitleExact);
        }
      }
    }
  } catch (e) {
    addTitle(seriesName);
  }

  return titles;
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

function normalizeApprovedSeriesSourceKey(value) {
  try {
    return normalizeOutputKey(value);
  } catch (e) { return String(value || '').trim().toLowerCase(); }
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
      try { appendLog(`APPROVED_SERIES_SOURCE_RESOLVED key=${normalized.slice(0,80)} source=${resolvedSource}`); } catch (e) {}
      return { source: resolvedSource, configured: true };
    }
    try { appendLog(`APPROVED_SERIES_SOURCE_DEFAULT key=${normalized.slice(0,80)} reason=not_configured`); } catch (e) {}
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

function stripHtmlSummary(input) {
  try {
    const text = String(input || '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return '';
    return text.length > 220 ? `${text.slice(0, 217)}...` : text;
  } catch (e) { return ''; }
}

async function fetchAniListSeriesArtwork(title) {
  try {
    await new Promise(resolve => setTimeout(resolve, 1500));
    const lookupTitle = normalizeApprovedSeriesLookupTitle(title) || String(title || '').trim();
    const query = `query ($search: String) { Media(search: $search, type: ANIME) { id title { english romaji native } description(asHtml: false) coverImage { large medium color } bannerImage } }`;
    const payload = JSON.stringify({ query, variables: { search: lookupTitle } });
    const res = await httpRequest({ hostname: 'graphql.anilist.co', path: '/', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, payload, 10000);
    if (!res || res.statusCode !== 200) {
      try { appendLog(`APPROVED_SERIES_ANILIST_FETCH_FAIL title=${String(title).slice(0,80)} status=${res?.statusCode}`); } catch (e) {}
      return null;
    }
    const parsed = safeJsonParse(res.body);
    const media = parsed && parsed.data && parsed.data.Media ? parsed.data.Media : null;
    if (!media) return null;
    const displayName = (media.title && (media.title.english || media.title.romaji || media.title.native)) || lookupTitle;
    const imageUrl = (media.coverImage && (media.coverImage.large || media.coverImage.medium)) || media.bannerImage || null;
    const summary = stripHtmlSummary(media.description || '');
    if (!imageUrl) return null;
    try { appendLog(`APPROVED_SERIES_ANILIST_FETCH_OK title=${String(title).slice(0,80)} imageUrl=${imageUrl.slice(0,100)}`); } catch (e) {}
    return {
      id: media.id || null,
      name: displayName,
      imageUrl,
      summary,
      fetchedAt: Date.now(),
      provider: 'anilist'
    };
  } catch (e) {
    try { appendLog(`APPROVED_SERIES_ANILIST_FETCH_ERR title=${String(title).slice(0,80)} err=${e.message}`); } catch (ee) {}
    return null;
  }
}

async function fetchAniListSeriesArtworkWithCandidates(candidates) {
  try {
    const queue = Array.isArray(candidates) ? candidates : [];
    for (const candidate of queue) {
      const lookup = normalizeApprovedSeriesLookupTitle(candidate);
      if (!lookup) continue;
      const result = await fetchAniListSeriesArtwork(lookup);
      if (result && result.imageUrl) return result;
    }
  } catch (e) { /* ignore */ }
  return null;
}

async function fetchAniListSeriesArtworkByAniDbId(anidbId) {
  try {
    await new Promise(resolve => setTimeout(resolve, 1500));
    const aid = Number(anidbId);
    if (!Number.isFinite(aid) || aid <= 0) return null;

    // Query AniList for anime with this AniDB ID in externalLinks
    const query = `query ($anidbId: Int) { Media(idMal: null, type: ANIME) { id title { english romaji native } description(asHtml: false) coverImage { large medium color } bannerImage externalLinks { id site url } } }`;
    
    // We need to search by browsing all anime with AniDB links (not efficient, so we'll use a workaround)
    // Better approach: Query by searching the anime title we already have
    // But the best approach is to construct the AniDB URL and search for media with that external link
    
    // Since AniList doesn't support direct search by external ID, we'll use a different strategy:
    // Query AniList to find media where externalLinks contains our AniDB ID
    // This requires using a generic search and filtering
    
    const anidbUrl = `https://anidb.net/anime/${aid}`;
    
    // Use a broader query that gets media with external links
    const searchQuery = `{ Media(idMal: null, type: ANIME) { id } }`;
    
    // Actually, AniList GraphQL doesn't support filtering by external links directly
    // So we need to search by the series name (which we don't have here)
    // The solution: we need to pass the series name as well
    
    return null; // For now, we need the series name to search
  } catch (e) {
    try { appendLog(`APPROVED_SERIES_ANILIST_BY_ANIDB_FAIL anidbId=${anidbId} err=${e.message}`); } catch (ee) {}
    return null;
  }
}

async function fetchAniListSeriesArtworkByNameAndAniDbId(seriesName, anidbId) {
  try {
    await new Promise(resolve => setTimeout(resolve, 1500));
    const lookupTitle = normalizeApprovedSeriesLookupTitle(seriesName) || String(seriesName || '').trim();
    const aid = Number(anidbId);
    
    // First, try to find the anime on AniList by name
    const query = `query ($search: String) { Media(search: $search, type: ANIME) { id title { english romaji native } description(asHtml: false) coverImage { large medium color } bannerImage externalLinks { site url } } }`;
    const payload = JSON.stringify({ query, variables: { search: lookupTitle } });
    const res = await httpRequest({ hostname: 'graphql.anilist.co', path: '/', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, payload, 10000);
    
    if (!res || res.statusCode !== 200) {
      try { appendLog(`APPROVED_SERIES_ANILIST_FALLBACK_SEARCH_FAIL title=${String(seriesName).slice(0,80)} anidbId=${aid} status=${res?.statusCode}`); } catch (e) {}
      return null;
    }
    
    const parsed = safeJsonParse(res.body);
    const media = parsed && parsed.data && parsed.data.Media ? parsed.data.Media : null;
    
    if (!media) return null;
    
    // Verify this is the same anime by checking if AniDB ID matches in externalLinks
    const links = media && Array.isArray(media.externalLinks) ? media.externalLinks : [];
    let anidbMatch = false;
    for (const link of links) {
      const site = String((link && link.site) || '').toLowerCase();
      const url = String((link && link.url) || '');
      if (site.includes('anidb') || /anidb\.net/i.test(url)) {
        const m = url.match(/anidb\.net\/anime\/(\d{1,8})\b/i);
        if (m && m[1] && Number(m[1]) === aid) {
          anidbMatch = true;
          break;
        }
      }
    }
    
    if (!anidbMatch) {
      try { appendLog(`APPROVED_SERIES_ANILIST_FALLBACK_NO_MATCH title=${String(seriesName).slice(0,80)} anidbId=${aid} anilistId=${media.id}`); } catch (e) {}
      // Even if no exact match, still use the result if we found something
      // This is better than nothing
    }
    
    const displayName = (media.title && (media.title.english || media.title.romaji || media.title.native)) || lookupTitle;
    const imageUrl = (media.coverImage && (media.coverImage.large || media.coverImage.medium)) || media.bannerImage || null;
    const summary = stripHtmlSummary(media.description || '');
    
    if (!imageUrl) return null;
    
    try { appendLog(`APPROVED_SERIES_ANILIST_FALLBACK_OK title=${String(seriesName).slice(0,80)} anidbId=${aid} anilistId=${media.id} matched=${anidbMatch} imageUrl=${imageUrl.slice(0,100)}`); } catch (e) {}
    
    return {
      id: media.id || null,
      name: displayName,
      imageUrl,
      summary,
      fetchedAt: Date.now(),
      provider: 'anilist'
    };
  } catch (e) {
    try { appendLog(`APPROVED_SERIES_ANILIST_FALLBACK_ERR title=${String(seriesName).slice(0,80)} anidbId=${anidbId} err=${e.message}`); } catch (ee) {}
    return null;
  }
}

async function fetchTmdbSeriesArtwork(title, tmdbKey) {
  try {
    if (!tmdbKey) {
      try { appendLog(`APPROVED_SERIES_TMDB_NO_KEY title=${String(title).slice(0,80)}`); } catch (e) {}
      return null;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
    const lookupTitle = normalizeApprovedSeriesLookupTitle(title) || String(title || '').trim();
    const searchPath = `/3/search/tv?api_key=${encodeURIComponent(tmdbKey)}&query=${encodeURIComponent(lookupTitle)}`;
    const searchRes = await httpRequest({ hostname: 'api.themoviedb.org', path: searchPath, method: 'GET', headers: { 'Accept': 'application/json' } }, null, 10000);
    if (!searchRes || searchRes.statusCode !== 200) {
      try { appendLog(`APPROVED_SERIES_TMDB_SEARCH_FAIL title=${String(title).slice(0,80)} status=${searchRes?.statusCode}`); } catch (e) {}
      return null;
    }
    const searchData = safeJsonParse(searchRes.body);
    const results = searchData && Array.isArray(searchData.results) ? searchData.results : [];
    if (!results.length) return null;
    const first = results[0];
    const posterPath = first.poster_path || first.backdrop_path || null;
    if (!posterPath) return null;
    const imageUrl = `https://image.tmdb.org/t/p/w500${posterPath}`;
    const displayName = first.name || first.original_name || lookupTitle;
    const summary = stripHtmlSummary(first.overview || '');
    try { appendLog(`APPROVED_SERIES_TMDB_FETCH_OK title=${String(title).slice(0,80)} imageUrl=${imageUrl.slice(0,100)}`); } catch (e) {}
    return {
      id: first.id || null,
      name: displayName,
      imageUrl,
      summary,
      fetchedAt: Date.now(),
      provider: 'tmdb'
    };
  } catch (e) {
    try { appendLog(`APPROVED_SERIES_TMDB_FETCH_ERR title=${String(title).slice(0,80)} err=${e.message}`); } catch (ee) {}
    return null;
  }
}

function decodeHtmlEntities(input) {
  try {
    return String(input || '')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .trim();
  } catch (e) { return String(input || ''); }
}

function getSeriesNameForApprovedEntry(entry, targetPath) {
  try {
    const info = deriveAppliedSeriesInfo(targetPath);
    return normalizeApprovedSeriesDisplayTitle(info.seriesName || entry.seriesTitleEnglish || entry.seriesTitle || entry.title || 'Unknown Series');
  } catch (e) {
    return (entry && (entry.seriesTitleEnglish || entry.seriesTitle || entry.title))
      ? normalizeApprovedSeriesDisplayTitle(String(entry.seriesTitleEnglish || entry.seriesTitle || entry.title))
      : 'Unknown Series';
  }
}

function findAniDbAidForApprovedSeries(outputKey, seriesName) {
  try {
    const normalizedOutputKey = normalizeOutputKey(outputKey);
    const normalizedSeriesCandidates = Array.from(new Set([
      normalizeForCache(seriesName),
      normalizeForCache(normalizeApprovedSeriesLookupTitle(seriesName))
    ].filter(Boolean)));
    if (!normalizedOutputKey || !normalizedSeriesCandidates.length) return null;
    let best = null;

    for (const cacheKey of Object.keys(enrichCache || {})) {
      const entry = enrichCache[cacheKey];
      if (!entry || entry.applied !== true || !entry.appliedTo) continue;
      const targets = Array.isArray(entry.appliedTo) ? entry.appliedTo : [entry.appliedTo];
      for (const target of targets) {
        if (!target) continue;
        const info = deriveAppliedSeriesInfo(target);
        const bucketKey = normalizeOutputKey(info.outputRoot || path.dirname(path.dirname(target)));
        if (!bucketKey || bucketKey !== normalizedOutputKey) continue;

        const candidateName = getSeriesNameForApprovedEntry(entry, target);
        const normalizedCandidate = normalizeForCache(candidateName);
        if (!normalizedCandidate || !normalizedSeriesCandidates.includes(normalizedCandidate)) continue;

        const providerRaw = (entry.provider && entry.provider.raw && typeof entry.provider.raw === 'object')
          ? entry.provider.raw
          : (entry.raw && typeof entry.raw === 'object' ? entry.raw : null);
        const aidCandidates = [
          providerRaw && providerRaw.aid,
          providerRaw && providerRaw.animeId,
          providerRaw && providerRaw.anidbId,
          entry && entry.aid,
          entry && entry.anidbId
        ];
        let aid = null;
        for (const candidate of aidCandidates) {
          if (candidate == null) continue;
          const parsed = Number(String(candidate).trim());
          if (Number.isFinite(parsed) && parsed > 0) { aid = parsed; break; }
        }
        if (!aid) continue;

        const appliedAt = Number(entry.appliedAt || 0);
        if (!best || appliedAt > best.appliedAt) {
          best = { aid, appliedAt };
        }
      }
    }

    return best ? best.aid : null;
  } catch (e) { return null; }
}

async function findAniDbAidByTitle(seriesName, username) {
  try {
    const query = normalizeApprovedSeriesLookupTitle(seriesName);
    if (!query) return null;

    const creds = getAniDBCredentials(username, serverSettings, users);
    try {
      const apiClient = getAniDBClient(
        (creds && creds.anidb_username) ? creds.anidb_username : '',
        (creds && creds.anidb_password) ? creds.anidb_password : '',
        (creds && creds.anidb_client_name) ? creds.anidb_client_name : 'mmprename',
        (creds && creds.anidb_client_version) ? creds.anidb_client_version : 1
      );
      const anime = await apiClient.getAnimeInfoByTitle(query);
      const apiAid = Number(anime && anime.aid ? anime.aid : NaN);
      if (Number.isFinite(apiAid) && apiAid > 0) {
        try { appendLog(`APPROVED_SERIES_ANIDB_TITLE_API_HIT series=${String(seriesName || '').slice(0,120)} aid=${apiAid}`); } catch (e) {}
        return apiAid;
      }
    } catch (e) {
      try { appendLog(`APPROVED_SERIES_ANIDB_TITLE_API_MISS series=${String(seriesName || '').slice(0,120)} err=${e && e.message ? e.message : String(e)}`); } catch (ee) {}
    }

    try {
      const queryText = normalizeApprovedSeriesLookupTitle(seriesName) || String(seriesName || '').trim();
      const gql = `query ($search: String) { Media(search: $search, type: ANIME) { id externalLinks { site url } } }`;
      const payload = JSON.stringify({ query: gql, variables: { search: queryText } });
      const resp = await httpRequest({
        hostname: 'graphql.anilist.co',
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, payload, 8000);
      if (resp && resp.statusCode === 200 && resp.body) {
        const parsed = safeJsonParse(resp.body);
        const media = parsed && parsed.data && parsed.data.Media ? parsed.data.Media : null;
        const links = media && Array.isArray(media.externalLinks) ? media.externalLinks : [];
        for (const link of links) {
          const site = String((link && link.site) || '').toLowerCase();
          const url = String((link && link.url) || '');
          if (!site.includes('anidb') && !/anidb\.net/i.test(url)) continue;
          const m = url.match(/anidb\.net\/anime\/(\d{1,8})\b/i);
          if (!m || !m[1]) continue;
          const aid = Number(m[1]);
          if (Number.isFinite(aid) && aid > 0) {
            try { appendLog(`APPROVED_SERIES_ANIDB_TITLE_ANILIST_LINK_HIT series=${String(seriesName || '').slice(0,120)} aid=${aid}`); } catch (e) {}
            return aid;
          }
        }
      }
    } catch (e) {
      try { appendLog(`APPROVED_SERIES_ANIDB_TITLE_ANILIST_LINK_MISS series=${String(seriesName || '').slice(0,120)} err=${e && e.message ? e.message : String(e)}`); } catch (ee) {}
    }

    const encoded = encodeURIComponent(String(query).slice(0, 160));
    const page = await httpRequest({
      hostname: 'anidb.net',
      path: `/anime/?adb.search=${encoded}&do.search=1`,
      method: 'GET',
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
      }
    }, null, 10000);
    if (!page || page.statusCode !== 200 || !page.body) return null;
    const body = String(page.body || '');
    const match = body.match(/\/anime\/(\d{1,8})\b/i);
    if (!match || !match[1]) return null;
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch (e) { return null; }
}

function extractAniDbPageImageUrl(html) {
  try {
    const content = String(html || '');
    const absolute = content.match(/https?:\/\/cdn\.anidb\.net\/images\/main\/[^"'\s>]+/i);
    if (absolute && absolute[0]) return absolute[0];
    const relative = content.match(/(?:src|data-src)=["'](\/images\/main\/[^"'\s>]+)["']/i);
    if (relative && relative[1]) return `https://cdn.anidb.net${relative[1]}`;
    const protocolLess = content.match(/(?:src|data-src)=["'](\/\/cdn\.anidb\.net\/images\/main\/[^"'\s>]+)["']/i);
    if (protocolLess && protocolLess[1]) return `https:${protocolLess[1]}`;
  } catch (e) { /* ignore */ }
  return null;
}

function extractAniDbPageSummary(html) {
  try {
    const content = String(html || '');
    const meta1 = content.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i);
    const meta2 = content.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["'][^>]*>/i);
    const summaryRaw = (meta1 && meta1[1]) || (meta2 && meta2[1]) || '';
    const decoded = decodeHtmlEntities(summaryRaw);
    return stripHtmlSummary(decoded);
  } catch (e) { return ''; }
}

async function fetchAniDbSeriesArtwork(seriesName, outputKey, username) {
  try {
    await new Promise(resolve => setTimeout(resolve, 2500));
    let aid = findAniDbAidForApprovedSeries(outputKey, seriesName);
    if (!aid) {
      aid = await findAniDbAidByTitle(seriesName, username);
      try {
        if (aid) appendLog(`APPROVED_SERIES_ANIDB_TITLE_FALLBACK_HIT series=${String(seriesName || '').slice(0,120)} aid=${aid}`);
        else appendLog(`APPROVED_SERIES_ANIDB_TITLE_FALLBACK_NONE series=${String(seriesName || '').slice(0,120)}`);
      } catch (e) {}
    }
    if (!aid) {
      try { appendLog(`APPROVED_SERIES_ANIDB_NO_AID series=${String(seriesName || '').slice(0,80)}`); } catch (e) {}
      return null;
    }

    let imageUrl = null;
    let summary = '';

    const creds = getAniDBCredentials(username, serverSettings, users);
    try {
      const client = getAniDBClient(
        (creds && creds.anidb_username) ? creds.anidb_username : '',
        (creds && creds.anidb_password) ? creds.anidb_password : '',
        (creds && creds.anidb_client_name) ? creds.anidb_client_name : 'mmprename',
        (creds && creds.anidb_client_version) ? creds.anidb_client_version : 1
      );
      const anime = await client.getAnimeInfo(aid);
      
      if (anime) {
        // AniDB HTTP API returns a picture filename (like "12345.jpg")
        // We construct the full CDN URL from it
        if (anime.picture && anime.picture.trim()) {
          const cleanFilename = anime.picture.trim();
          imageUrl = `https://cdn.anidb.net/images/main/${cleanFilename}`;
          try { appendLog(`APPROVED_SERIES_ANIDB_PICTURE_OK series=${String(seriesName || '').slice(0,80)} aid=${aid} restricted=${!!anime.restricted} picture=${cleanFilename}`); } catch (e) {}
        } else {
          // No picture in API response - common for adult/restricted content
          const reason = anime.restricted ? 'restricted_content' : 'no_picture_in_api';
          try { appendLog(`APPROVED_SERIES_ANIDB_NO_PICTURE series=${String(seriesName || '').slice(0,80)} aid=${aid} restricted=${!!anime.restricted} reason=${reason}`); } catch (e) {}
        }
        
        if (anime.description) {
          summary = stripHtmlSummary(decodeHtmlEntities(anime.description));
        }
      }
    } catch (e) {
      try { appendLog(`APPROVED_SERIES_ANIDB_CLIENT_ERR series=${String(seriesName || '').slice(0,80)} aid=${aid} err=${e.message}`); } catch (ee) {}
    }

    if (!imageUrl) {
      try { appendLog(`APPROVED_SERIES_ANIDB_NO_IMAGE series=${String(seriesName || '').slice(0,80)} aid=${aid} trying_anilist_fallback=true`); } catch (e) {}
      
      // AniDB doesn't have image - try AniList as fallback (Jellyfin strategy)
      const anilistResult = await fetchAniListSeriesArtworkByNameAndAniDbId(seriesName, aid);
      if (anilistResult && anilistResult.imageUrl) {
        try { appendLog(`APPROVED_SERIES_ANIDB_FALLBACK_SUCCESS series=${String(seriesName || '').slice(0,80)} aid=${aid}`); } catch (e) {}
        return {
          ...anilistResult,
          provider: 'anilist-fallback-from-anidb'
        };
      }
      
      try { appendLog(`APPROVED_SERIES_ANIDB_FALLBACK_FAILED series=${String(seriesName || '').slice(0,80)} aid=${aid}`); } catch (e) {}
      return null;
    }
    try { appendLog(`APPROVED_SERIES_ANIDB_FETCH_OK series=${String(seriesName || '').slice(0,80)} aid=${aid} imageUrl=${imageUrl.slice(0,100)}`); } catch (e) {}
    return {
      id: aid,
      name: String(seriesName || '').trim(),
      imageUrl,
      summary: summary || '',
      fetchedAt: Date.now(),
      provider: 'anidb'
    };
  } catch (e) {
    try { appendLog(`APPROVED_SERIES_ANIDB_FETCH_ERR series=${String(seriesName || '').slice(0,80)} err=${e.message}`); } catch (ee) {}
    return null;
  }
}

async function fetchApprovedSeriesArtwork({ username, outputKey, source, seriesName }) {
  const selectedSource = normalizeApprovedSeriesSource(source);
  const titleCandidates = collectApprovedSeriesMetadataTitles(outputKey, seriesName);
  try { appendLog(`APPROVED_SERIES_FETCH_START source=${selectedSource} series=${String(seriesName).slice(0,80)}`); } catch (e) {}
  
  if (selectedSource === 'anilist') {
    return fetchAniListSeriesArtworkWithCandidates(titleCandidates);
  }
  
  if (selectedSource === 'tmdb') {
    let tmdbKey = null;
    try {
      if (username && users[username] && users[username].settings && users[username].settings.tmdb_api_key) {
        tmdbKey = users[username].settings.tmdb_api_key;
      } else if (serverSettings && serverSettings.tmdb_api_key) {
        tmdbKey = serverSettings.tmdb_api_key;
      }
    } catch (e) {}
    if (!tmdbKey) {
      try { appendLog(`APPROVED_SERIES_TMDB_NO_KEY series=${String(seriesName).slice(0,80)}`); } catch (e) {}
      return null;
    }
    for (const candidate of titleCandidates) {
      const result = await fetchTmdbSeriesArtwork(candidate, tmdbKey);
      if (result && result.imageUrl) return result;
    }
    return null;
  }
  
  if (selectedSource === 'anidb') {
    return fetchAniDbSeriesArtwork(seriesName, outputKey, username);
  }
  
  return null;
}

async function fetchAndCacheApprovedSeriesImage({ username, outputKey, source, seriesName, allowCooldown = true }) {
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
  const existing = approvedSeriesImages && approvedSeriesImages[cacheKey] ? approvedSeriesImages[cacheKey] : null;
  if (existing && existing.imageUrl && existing.provider === selectedSource) {
    try { appendLog(`APPROVED_SERIES_IMAGE_CACHE_HIT series=${cleanSeriesName.slice(0,80)} source=${selectedSource}`); } catch (e) {}
    return { ok: true, cached: true, fetched: false, source: selectedSource };
  }
  if (existing && existing.provider !== selectedSource) {
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

  try { appendLog(`APPROVED_SERIES_IMAGE_FETCH_START series=${cleanSeriesName.slice(0,80)} source=${selectedSource} output=${normalizedOutputKey.slice(0,80)}`); } catch (e) {}
  approvedSeriesImageFetchLocks.set(lockKey, { inFlight: true, lastFetchedAt: lockInfo && lockInfo.lastFetchedAt ? lockInfo.lastFetchedAt : 0 });
  try {
    const lookedUp = await fetchApprovedSeriesArtwork({ username, outputKey: normalizedOutputKey, source: selectedSource, seriesName: cleanSeriesName });
    approvedSeriesImageFetchLocks.set(lockKey, { inFlight: false, lastFetchedAt: Date.now() });

    if (!lookedUp || !lookedUp.imageUrl) {
      try { appendLog(`APPROVED_SERIES_IMAGE_FETCH_NO_IMAGE series=${cleanSeriesName.slice(0,80)} source=${selectedSource}`); } catch (e) {}
      return { ok: true, fetched: false, skipped: true, source: selectedSource, reason: 'no-image' };
    }

    approvedSeriesImages[cacheKey] = {
      provider: selectedSource,
      imageUrl: lookedUp.imageUrl,
      summary: lookedUp.summary || (existing && existing.summary) || '',
      mediaId: lookedUp.id || null,
      fetchedAt: lookedUp.fetchedAt || Date.now()
    };
    try { writeJson(approvedSeriesImagesFile, approvedSeriesImages); } catch (e) {}
    try { appendLog(`APPROVED_SERIES_IMAGE_FETCH_SUCCESS series=${cleanSeriesName.slice(0,80)} source=${selectedSource} imageUrl=${lookedUp.imageUrl.slice(0,100)}`); } catch (e) {}
    return { ok: true, fetched: true, source: selectedSource };
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

function getConfiguredOutputRoots(username) {
  const out = [];
  const seen = new Set();
  const push = (value) => {
    const key = normalizeOutputKey(value);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ key, path: String(value || '') });
  };
  try {
    const userSettings = username && users && users[username] && users[username].settings ? users[username].settings : {};
    if (userSettings && userSettings.scan_output_path) push(userSettings.scan_output_path);
    if (userSettings && Array.isArray(userSettings.output_folders)) {
      for (const folder of userSettings.output_folders) {
        if (folder && folder.path) push(folder.path);
      }
    }
    if (serverSettings && serverSettings.scan_output_path) push(serverSettings.scan_output_path);
  } catch (e) { /* ignore */ }
  return out;
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
          if (item && item.imageProvider && item.imageProvider !== bucket.source) {
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

async function runApprovedSeriesBackgroundFetchCycle() {
  if (approvedSeriesBackgroundInFlight) return;
  approvedSeriesBackgroundInFlight = true;
  try {
    let fetched = 0;
    const usernames = Object.keys(users || {});
    for (const username of usernames) {
      if (fetched >= APPROVED_SERIES_BACKGROUND_BATCH_SIZE) break;
      const payload = buildApprovedSeriesPayload(username);
      const outputs = Array.isArray(payload.outputs) ? payload.outputs : [];
      for (const output of outputs) {
        if (fetched >= APPROVED_SERIES_BACKGROUND_BATCH_SIZE) break;
        const source = normalizeApprovedSeriesSource(output.source || 'anilist');
        if (source === 'tmdb') continue;
        const seriesList = Array.isArray(output.series) ? output.series : [];
        for (const series of seriesList) {
          if (fetched >= APPROVED_SERIES_BACKGROUND_BATCH_SIZE) break;
          const seriesName = series && series.name ? String(series.name).trim() : '';
          if (!seriesName) continue;
          try {
            const result = await fetchAndCacheApprovedSeriesImage({
              username,
              outputKey: output.key,
              source,
              seriesName,
              allowCooldown: true
            });
            if (result && result.fetched) fetched += 1;
          } catch (e) {
            // best-effort background processing
          }
        }
      }
    }
    if (fetched > 0) {
      try { appendLog(`APPROVED_SERIES_BACKGROUND_FETCH fetched=${fetched}`); } catch (e) {}
    }
  } catch (e) {
    try { appendLog(`APPROVED_SERIES_BACKGROUND_FETCH_FAIL err=${e && e.message ? e.message : String(e)}`); } catch (ee) {}
  } finally {
    approvedSeriesBackgroundInFlight = false;
  }
}

function startApprovedSeriesBackgroundWorker() {
  try {
    if (approvedSeriesBackgroundTimer) return;
    approvedSeriesBackgroundTimer = setInterval(() => {
      runApprovedSeriesBackgroundFetchCycle();
    }, APPROVED_SERIES_BACKGROUND_INTERVAL_MS);
    setTimeout(() => { runApprovedSeriesBackgroundFetchCycle(); }, 5000);
    appendLog(`APPROVED_SERIES_BACKGROUND_WORKER_STARTED intervalMs=${APPROVED_SERIES_BACKGROUND_INTERVAL_MS}`);
  } catch (e) {
    try { appendLog(`APPROVED_SERIES_BACKGROUND_WORKER_START_FAIL err=${e && e.message ? e.message : String(e)}`); } catch (ee) {}
  }
}

app.get('/api/approved-series', requireAuth, (req, res) => {
  try {
    const username = req.session && req.session.username ? req.session.username : null;
    const payload = buildApprovedSeriesPayload(username);
    return res.json(payload);
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

app.post('/api/approved-series/source', requireAuth, (req, res) => {
  try {
    const username = req.session && req.session.username ? req.session.username : null;
    const outputKey = normalizeOutputKey(req && req.body ? req.body.outputKey : '');
    const source = normalizeApprovedSeriesSource(req && req.body ? req.body.source : 'anilist');
    if (!outputKey) return res.status(400).json({ error: 'outputKey is required' });
    if (!['anilist', 'tmdb', 'anidb'].includes(source)) return res.status(400).json({ error: 'invalid source' });
    const ok = setApprovedSeriesSourcePreference(username, outputKey, source);
    if (!ok) return res.status(500).json({ error: 'failed to save preference' });
    return res.json({ ok: true, source });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

app.post('/api/approved-series/clear-cache', requireAuth, requireAdmin, (req, res) => {
  try {
    const outputKey = normalizeOutputKey(req && req.body ? req.body.outputKey : '');
    if (!outputKey) return res.status(400).json({ error: 'outputKey is required' });

    let removed = 0;
    for (const key of Object.keys(approvedSeriesImages || {})) {
      if (!key || !key.startsWith(`${outputKey}::`)) continue;
      delete approvedSeriesImages[key];
      removed += 1;
    }

    for (const lockKey of Array.from(approvedSeriesImageFetchLocks.keys())) {
      if (!lockKey || lockKey.indexOf(`::${outputKey}::`) === -1) continue;
      approvedSeriesImageFetchLocks.delete(lockKey);
    }

    try { writeJson(approvedSeriesImagesFile, approvedSeriesImages); } catch (e) {}
    try { appendLog(`APPROVED_SERIES_CACHE_CLEARED outputKey=${outputKey} removed=${removed}`); } catch (e) {}
    return res.json({ ok: true, removed, outputKey });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

app.post('/api/approved-series/fetch-images', requireAuth, async (req, res) => {
  try {
    const username = req.session && req.session.username ? req.session.username : null;
    const outputKey = normalizeOutputKey(req && req.body ? req.body.outputKey : '');
    if (!outputKey) return res.status(400).json({ error: 'outputKey is required' });

    const payload = buildApprovedSeriesPayload(username);
    const output = (payload.outputs || []).find((o) => o.key === outputKey);
    if (!output) return res.status(404).json({ error: 'output not found' });

    const sourcePrefs = getApprovedSeriesSourcePreferences(username);
    const resolvedPref = resolveApprovedSeriesSourcePreference(sourcePrefs, outputKey);
    const selectedSource = normalizeApprovedSeriesSource((req && req.body && req.body.source) || resolvedPref.source || 'anilist');
    if (!['anilist', 'tmdb', 'anidb'].includes(selectedSource)) return res.status(400).json({ error: 'invalid source' });

    setApprovedSeriesSourcePreference(username, outputKey, selectedSource);

    let fetched = 0;
    let skipped = 0;
    const seriesList = Array.isArray(output.series) ? output.series : [];
    for (const series of seriesList) {
      const seriesName = series && series.name ? String(series.name) : '';
      if (!seriesName) { skipped++; continue; }
      const result = await fetchAndCacheApprovedSeriesImage({ username, outputKey, source: selectedSource, seriesName, allowCooldown: true });
      if (result && result.fetched) fetched++;
      else skipped++;
    }
    return res.json({ ok: true, fetched, skipped, source: selectedSource });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

app.post('/api/approved-series/fetch-image', requireAuth, async (req, res) => {
  try {
    const username = req.session && req.session.username ? req.session.username : null;
    const outputKey = normalizeOutputKey(req && req.body ? req.body.outputKey : '');
    const seriesName = req && req.body && req.body.seriesName ? String(req.body.seriesName).trim() : '';
    if (!outputKey) return res.status(400).json({ error: 'outputKey is required' });
    if (!seriesName) return res.status(400).json({ error: 'seriesName is required' });

    const sourcePrefs = getApprovedSeriesSourcePreferences(username);
    const resolvedPref = resolveApprovedSeriesSourcePreference(sourcePrefs, outputKey);
    const selectedSource = normalizeApprovedSeriesSource((req && req.body && req.body.source) || resolvedPref.source || 'anilist');
    if (!['anilist', 'tmdb', 'anidb'].includes(selectedSource)) return res.status(400).json({ error: 'invalid source' });

    const result = await fetchAndCacheApprovedSeriesImage({ username, outputKey, source: selectedSource, seriesName, allowCooldown: true });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

// Manual provider ID overrides
app.get('/api/manual-ids', requireAuth, requireAdmin, (req, res) => {
  try {
    return res.json({ manualIds: manualIds || {} });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

app.post('/api/manual-ids', requireAuth, requireAdmin, (req, res) => {
  try {
    const title = req && req.body ? req.body.title : null;
    if (!title) return res.status(400).json({ error: 'title is required' });
    const aliasTitles = (req && req.body && Array.isArray(req.body.aliasTitles)) ? req.body.aliasTitles : [];
    const filePath = req && req.body ? req.body.filePath : null;
    const normalizedFilePath = filePath ? normalizeManualPathKey(filePath) : null;
    let canonicalFilePath = null;
    try { canonicalFilePath = normalizedFilePath ? canonicalize(normalizedFilePath) : null; } catch (e) { canonicalFilePath = normalizedFilePath; }
    const filePathKeys = Array.from(new Set([filePath, normalizedFilePath, canonicalFilePath].filter(Boolean)));
    
    const keys = [title, ...aliasTitles]
      .map((value) => normalizeManualIdKey(value))
      .filter(Boolean)
      .filter((value, index, arr) => arr.indexOf(value) === index);
    if (!keys.length) return res.status(400).json({ error: 'invalid title' });

    const seriesEntry = {};
    const anilistId = normalizeManualIdValue(req.body.anilist);
    const tmdbId = normalizeManualIdValue(req.body.tmdb);
    const tvdbId = normalizeManualIdValue(req.body.tvdb);
    const anidbEpisodeId = normalizeAniDbEpisodeId(req.body.anidbEpisode);

    if (anidbEpisodeId !== null && !filePath) {
      return res.status(400).json({ error: 'filePath is required when setting anidbEpisode' });
    }

    // Series-level IDs go in the series entry
    if (anilistId !== null) seriesEntry.anilist = anilistId;
    if (tmdbId !== null) seriesEntry.tmdb = tmdbId;
    if (tvdbId !== null) seriesEntry.tvdb = tvdbId;

    const rawClear = req && req.body ? req.body.clear : null;
    const clearRequested = rawClear === true || rawClear === 'true' || rawClear === 1 || rawClear === '1';

    manualIds = manualIds || {};
    
    // Handle series-level IDs (AniList, TMDB, TVDB)
    if (Object.keys(seriesEntry).length === 0 && !anidbEpisodeId) {
      if (!clearRequested) {
        return res.status(400).json({ error: 'at least one manual ID is required (or pass clear=true to delete existing mapping)' });
      }
      for (const key of keys) {
        if (manualIds[key]) {
          // Only remove series-level IDs, preserve episode-level IDs
          delete manualIds[key].anilist;
          delete manualIds[key].tmdb;
          delete manualIds[key].tvdb;
          if (Object.keys(manualIds[key]).length === 0) delete manualIds[key];
        }
      }
      // Also clear episode-specific entry if clearing all
      for (const pathKey of filePathKeys) {
        if (manualIds[pathKey]) delete manualIds[pathKey];
      }
      try {
        appendLog(`MANUAL_ID_CLEARED title=${normalizeManualIdKey(title)} aliases=${Math.max(0, keys.length - 1)} by=${req && req.session && req.session.username ? req.session.username : 'unknown'}`);
      } catch (e) {}
    } else {
      // Save series-level IDs to all title keys
      if (Object.keys(seriesEntry).length > 0) {
        for (const key of keys) {
          if (!manualIds[key]) manualIds[key] = {};
          Object.assign(manualIds[key], seriesEntry);
        }
      }
      
      // Handle episode-level AniDB Episode ID (stored per file path)
      if (anidbEpisodeId !== null && filePathKeys.length) {
        for (const pathKey of filePathKeys) {
          if (!manualIds[pathKey]) manualIds[pathKey] = {};
          manualIds[pathKey].anidbEpisode = anidbEpisodeId;
        }
        
        // Clean up old episode IDs that were stored at title keys (migration cleanup)
        // Episode IDs should only be stored at file paths, not title keys
        for (const key of keys) {
          if (manualIds[key] && manualIds[key].anidbEpisode) {
            delete manualIds[key].anidbEpisode;
            if (Object.keys(manualIds[key]).length === 0) {
              delete manualIds[key];
            }
          }
        }
      } else if (anidbEpisodeId === null && filePathKeys.length) {
        // Clear episode ID if explicitly set to null
        for (const pathKey of filePathKeys) {
          if (!manualIds[pathKey]) continue;
          delete manualIds[pathKey].anidbEpisode;
          if (Object.keys(manualIds[pathKey]).length === 0) delete manualIds[pathKey];
        }
      }
      
      try {
        const episodeNote = normalizedFilePath ? ` filePath=${normalizedFilePath}` : '';
        const canonicalNote = canonicalFilePath ? ` canonicalFilePath=${canonicalFilePath}` : '';
        appendLog(`MANUAL_ID_SAVED title=${normalizeManualIdKey(title)} anilist=${anilistId != null ? anilistId : '<none>'} tmdb=${tmdbId != null ? tmdbId : '<none>'} tvdb=${tvdbId != null ? tvdbId : '<none>'} anidbEpisode=${anidbEpisodeId != null ? anidbEpisodeId : '<none>'}${episodeNote}${canonicalNote} filePathKeys=${filePathKeys.length} aliases=${Math.max(0, keys.length - 1)} by=${req && req.session && req.session.username ? req.session.username : 'unknown'}`);
      } catch (e) {}
    }

    try { writeJson(manualIdsFile, manualIds); } catch (e) {}
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

// Unapprove last N applied renames: mark applied->false, unhide, and optionally remove hardlinks
app.post('/api/rename/unapprove', requireAuth, requireAdmin, (req, res) => {
  try {
    const username = req.session && req.session.username ? req.session.username : null;
    const requestedPaths = (req.body && Array.isArray(req.body.paths)) ? req.body.paths : null;
    const rawCount = !requestedPaths ? ((req.body && req.body.count) ?? '10') : null;
    let count = 10;
    if (rawCount !== null && rawCount !== undefined) {
      const parsed = parseInt(String(rawCount), 10);
      if (Number.isFinite(parsed)) count = parsed;
    }

    const { changed, deletedHardlinks, hardlinkErrors, shouldDeleteHardlinks } = performUnapprove({ requestedPaths, count, username });

    appendLog(`UNAPPROVE count=${changed.length} deleteHardlinks=${shouldDeleteHardlinks ? 'yes' : 'no'} removed=${deletedHardlinks.length}`);
    res.json({ ok: true, unapproved: changed, deletedHardlinks, hardlinkErrors });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

app.get('/api/rename/hidden', requireAuth, requireAdmin, (req, res) => {
  try {
    const items = []
    const entries = enrichCache || {}
    for (const key of Object.keys(entries)) {
      const entry = entries[key]
      if (!entry) continue
      const hidden = entry.hidden === true
      const applied = entry.applied === true
      if (!hidden && !applied) continue
      const provider = entry.provider || {}
      const parsed = entry.parsed || {}
      items.push({
        path: key,
        hidden,
        applied,
        appliedAt: entry.appliedAt || null,
        appliedTo: entry.appliedTo || null,
        providerTitle: provider.renderedName || provider.title || null,
        providerYear: provider.year || null,
        providerEpisodeTitle: provider.episodeTitle || null,
        parsedTitle: parsed.parsedName || parsed.title || null,
        basename: path.basename(key)
      })
    }
    items.sort((a, b) => {
      const aKey = a.appliedAt || 0
      const bKey = b.appliedAt || 0
      if (aKey !== bKey) return bKey - aKey
      return a.path.localeCompare(b.path)
    })
    res.json({ items })
  } catch (e) {
    try { appendLog(`RENAME_HIDDEN_LIST_FAIL err=${e && e.message ? e.message : String(e)}`) } catch (ee) {}
    res.status(500).json({ error: e && e.message ? e.message : String(e) })
  }
})

// List duplicate items grouped by preview name (case-insensitive) OR ED2K hash OR series+season+episode
app.get('/api/rename/duplicates', requireAuth, requireAdmin, (req, res) => {
  try {
    const groupsByPreview = new Map();
    const groupsByHash = new Map();
    const groupsByMetadata = new Map();

    const derivePreviewName = (key, entry) => {
      try {
        const normalized = normalizeEnrichEntry(entry || {}) || {};
        if (normalized.provider && normalized.provider.renderedName) return normalized.provider.renderedName;
        if (entry && entry.renderedName) return entry.renderedName;
        // Do not fall back to parsed names here; duplicates should be based on provider-rendered previews only
        return path.basename(key);
      } catch (e) { return path.basename(key); }
    };

    const deriveMetadataKey = (entry) => {
      try {
        const normalized = normalizeEnrichEntry(entry || {}) || {};
        const seriesTitle = normalized.seriesTitleExact || normalized.seriesTitle || normalized.title || null;
        const season = normalized.season != null ? normalized.season : null;
        const episode = normalized.episode != null ? normalized.episode : null;
        if (!seriesTitle || season == null || episode == null) return null;
        const seriesNorm = normalizeForCache(seriesTitle);
        return `${seriesNorm}::S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}`;
      } catch (e) { return null; }
    };

    const resolveHash = (key, entry) => {
      let h = null;
      try {
        if (db) {
          try {
            const st = fs.existsSync(key) ? fs.statSync(key) : null;
            h = db.getEd2kHash(key, st ? st.size : null) || null;
          } catch (e) {}
        }
        if (!h && entry && entry.provider && entry.provider.raw && entry.provider.raw.ed2k) {
          h = entry.provider.raw.ed2k;
        }
      } catch (e) { h = null; }
      return h;
    };

    const addItem = (map, groupKey, meta, ctx = {}) => {
      if (!groupKey) return;
      if (!map.has(groupKey)) map.set(groupKey, { key: groupKey, items: [], ...ctx });
      const group = map.get(groupKey);
      if (ctx.previewName && !group.previewName) group.previewName = ctx.previewName;
      if (ctx.previewKey && !group.previewKey) group.previewKey = ctx.previewKey;
      group.items.push(meta);
    };

    for (const key of Object.keys(enrichCache || {})) {
      const entry = enrichCache[key];
      if (!entry) continue;
      const previewNameRaw = derivePreviewName(key, entry);
      const previewKey = previewNameRaw ? previewNameRaw.toLowerCase() : null;
      const metadataKey = deriveMetadataKey(entry);
      const hash = resolveHash(key, entry);
      const parsed = entry.parsed || {};
      const provider = entry.provider || {};
      const meta = {
        path: key,
        basename: path.basename(key),
        previewName: previewNameRaw || null,
        applied: entry.applied === true,
        hidden: entry.hidden === true,
        appliedTo: entry.appliedTo || null,
        appliedAt: entry.appliedAt || null,
        providerTitle: provider.renderedName || provider.title || null,
        parsedTitle: parsed.parsedName || parsed.title || null
      };

      if (previewKey) addItem(groupsByPreview, previewKey, meta, { previewName: previewNameRaw || null, previewKey });
      if (hash) addItem(groupsByHash, hash, meta, { previewName: previewNameRaw || null });
      if (metadataKey) addItem(groupsByMetadata, metadataKey, meta, { previewName: previewNameRaw || null });
    }

    const previewGroups = Array.from(groupsByPreview.values())
      .map((v) => ({
        groupType: 'preview',
        previewName: v.previewName || v.items[0]?.previewName || v.previewKey || v.key,
        previewKey: v.previewKey || v.key,
        items: v.items
      }))
      .filter(g => g.items.length > 1);
    const hashGroups = Array.from(groupsByHash.entries())
      .map(([k, v]) => ({ groupType: 'hash', hash: k, previewName: v.items[0]?.previewName || null, items: v.items }))
      .filter(g => g.items.length > 1);
    const metadataGroups = Array.from(groupsByMetadata.entries())
      .map(([k, v]) => ({ groupType: 'metadata', metadataKey: k, previewName: v.items[0]?.previewName || null, items: v.items }))
      .filter(g => g.items.length > 1);

    const deduped = [...previewGroups, ...hashGroups, ...metadataGroups];
    deduped.sort((a, b) => b.items.length - a.items.length || (a.previewName || '').localeCompare(b.previewName || ''));
    res.json({ groups: deduped, total: deduped.length, generatedAt: Date.now() });
  } catch (e) {
    try { appendLog(`DUPLICATES_LIST_FAIL err=${e && e.message ? e.message : String(e)}`); } catch (ee) {}
    res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
})

// Logs endpoints
app.get('/api/logs/recent', requireAuth, requireAdmin, (req, res) => {
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
        // Parse query parameters: filter mode and line count
        const filterMode = req.query.filter || 'dashboard' // 'dashboard' (default) | 'approved_series'
        const lineCount = parseInt(req.query.lines, 10) || 200
        const isApprovedSeriesLog = (line) => {
          const text = String(line || '').trim()
          if (!text) return false
          const content = text.replace(/^\S+\s+/, '')
          return content.includes('APPROVED_SERIES_')
        }
        
        // Split into lines and filter based on mode
        let lines = String(sb || '').split('\n')
        
        // Apply filtering based on filter mode
        if (filterMode === 'dashboard') {
          // Dashboard mode: exclude APPROVED_SERIES_* logs to reduce noise
          lines = lines.filter(line => !isApprovedSeriesLog(line))
        } else if (filterMode === 'approved_series') {
          // Approved Series mode: show only APPROVED_SERIES_* logs for debugging artwork fetching
          lines = lines.filter(line => isApprovedSeriesLog(line))
        }
        // For any other filter mode or no filter, show all logs
        
        // Take the last N lines and join them back
        const tail = lines.slice(-lineCount).join('\n')
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

app.post('/api/logs/clear', requireAuth, requireAdmin, (req, res) => {
  fs.writeFileSync(logsFile, '');
  res.json({ ok: true });
});

// Debug trace endpoint: return recent logs and runtime state for diagnostics
app.get('/api/debug/trace', requireAuth, requireAdmin, (req, res) => {
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

app.use((err, req, res, next) => {
  if (!err) return next();
  if (err && err.message === 'Origin not allowed by CORS policy') {
    return res.status(403).json({ error: 'origin not allowed' });
  }
  return next(err);
});

// Serve web app static if built (with no-cache for HTML to avoid stale JS references)
app.use('/', express.static(path.join(__dirname, 'web', 'dist'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

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
module.exports._test.performUnapprove = performUnapprove;
module.exports._test.renderedIndex = renderedIndex;
module.exports._test.serverSettings = serverSettings;
module.exports._test.users = users;
module.exports._test.canonicalize = canonicalize;
module.exports._test.setServerSetting = (key, value) => { serverSettings[key] = value; };
module.exports._test.setUserSetting = (username, key, value) => {
  if (!username) return;
  users[username] = users[username] || { username, role: 'admin', passwordHash: null, settings: {} };
  users[username].settings = users[username].settings || {};
  users[username].settings[key] = value;
};
module.exports._test.determineIsMovie = determineIsMovie;
module.exports._test.renderProviderName = renderProviderName;
module.exports._test.ensureRenderedNameHasYear = ensureRenderedNameHasYear;
module.exports._test.doProcessParsedItem = doProcessParsedItem;
// expose internal helpers for unit tests
module.exports._test.stripAniListSeasonSuffix = typeof stripAniListSeasonSuffix !== 'undefined' ? stripAniListSeasonSuffix : null;
module.exports._test.lookupWikipediaEpisode = typeof lookupWikipediaEpisode !== 'undefined' ? lookupWikipediaEpisode : null;
module.exports._test.assignProviderSourceMetadata = assignProviderSourceMetadata;
module.exports._test.PROVIDER_DISPLAY_NAMES = PROVIDER_DISPLAY_NAMES;
// expose wikiEpisodeCache for tests so unit tests can clear it
module.exports.wikiEpisodeCache = wikiEpisodeCache;

// Graceful shutdown handlers to flush cache before process exits
function gracefulShutdown(signal) {
  appendLog(`${signal}_RECEIVED flushing_cache`);
  try {
    persistEnrichCacheNow();
    appendLog(`${signal}_CACHE_FLUSHED exiting`);
    // Give a brief moment for any final I/O operations
    setTimeout(() => {
      process.exit(0);
    }, 100);
  } catch (err) {
    appendLog(`${signal}_CACHE_FLUSH_ERROR ${err.message}`);
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Only start the HTTP server when this file is run directly, not when required as a module
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server listening on ${PORT}`);
    // Initialize folder watchers for all users with scan_input_path
    initializeAllWatchers();
    // Run approved-series image caching in the background regardless of UI route activity.
    startApprovedSeriesBackgroundWorker();
  });
}




