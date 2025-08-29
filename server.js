const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
// Enable CORS but allow credentials so cookies can be sent from the browser (echo origin)
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
const bcrypt = require('bcryptjs');
const cookieSession = require('cookie-session');

// simple cookie session for auth
// cookie-session will be initialized after we ensure a persistent SESSION_KEY is available

const DATA_DIR = path.resolve(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const scanStoreFile = path.join(DATA_DIR, 'scans.json');
const enrichStoreFile = path.join(DATA_DIR, 'enrich.json');
const logsFile = path.join(DATA_DIR, 'logs.txt');
const settingsFile = path.join(DATA_DIR, 'settings.json');
const usersFile = path.join(DATA_DIR, 'users.json');
const renderedIndexFile = path.join(DATA_DIR, 'rendered-index.json');

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

ensureFile(scanStoreFile, {});
ensureFile(enrichStoreFile, {});
ensureFile(logsFile, '');
ensureFile(settingsFile, {});
ensureFile(usersFile, {});
ensureFile(renderedIndexFile, {});

// Persist a generated SESSION_KEY to disk if none provided. This ensures cookie signing works
// across restarts when using a host-mounted data directory, without requiring env vars.
const sessionKeyFile = path.join(DATA_DIR, 'session.key');
function loadOrCreateSessionKey() {
  try {
    // Accept either SESSION_KEY or MR_SESSION_KEY (compose env) for compatibility
    const envKey = (process.env.SESSION_KEY && String(process.env.SESSION_KEY).trim()) ? String(process.env.SESSION_KEY).trim() : ((process.env.MR_SESSION_KEY && String(process.env.MR_SESSION_KEY).trim()) ? String(process.env.MR_SESSION_KEY).trim() : null);
    if (envKey) return envKey;
    if (fs.existsSync(sessionKeyFile)) {
      const k = String(fs.readFileSync(sessionKeyFile, 'utf8') || '').trim();
      if (k) return k;
    }
    const newKey = uuidv4();
    try { fs.writeFileSync(sessionKeyFile, newKey, { encoding: 'utf8' }); } catch (e) { console.error('failed write session.key', e && e.message); }
    return newKey;
  } catch (e) { console.error('loadOrCreateSessionKey', e && e.message); return uuidv4(); }
}
const EFFECTIVE_SESSION_KEY = loadOrCreateSessionKey();

// simple cookie session for auth (initialized with EFFECTIVE_SESSION_KEY)
app.use(cookieSession({
  name: 'session',
  keys: [EFFECTIVE_SESSION_KEY],
  maxAge: 24 * 60 * 60 * 1000,
  httpOnly: true,
  // Allow explicit override for secure cookies. In Docker images NODE_ENV=production
  // is often set, but the container may be served over plain HTTP (no TLS). In that
  // case browsers will ignore cookies with the Secure flag. Set SESSION_COOKIE_SECURE
  // to 'false' when running over plain HTTP in containers to allow cookies.
  secure: (typeof process.env.SESSION_COOKIE_SECURE !== 'undefined')
    ? String(process.env.SESSION_COOKIE_SECURE).toLowerCase() === 'true'
    : (process.env.NODE_ENV === 'production'),
  sameSite: 'lax'
}));

function readJson(file, def) { try { return JSON.parse(fs.readFileSync(file, 'utf8') || ''); } catch (e) { return def; } }
function writeJson(file, obj) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: 'utf8' });
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error('writeJson error', file, e && e.message);
    // best-effort fallback
    try { fs.writeFileSync(file, JSON.stringify(obj, null, 2), { encoding: 'utf8' }); } catch (e2) { console.error('writeJson fallback failed', e2 && e2.message); }
  }
}

let scans = readJson(scanStoreFile, {});
let enrichCache = readJson(enrichStoreFile, {});
let serverSettings = readJson(settingsFile, {});
let users = readJson(usersFile, {});
let renderedIndex = readJson(renderedIndexFile, {});

async function ensureAdmin() {
  try {
    // If users already exist, nothing to do
    if (users && Object.keys(users).length > 0) return;
    // If an ADMIN_PASSWORD env var was provided, create an admin user automatically.
    // Otherwise leave registration open so the first web registration will create the admin.
  // Accept ADMIN_PASSWORD or MR_ADMIN_PASSWORD
  const adminPwd = (process.env.ADMIN_PASSWORD && String(process.env.ADMIN_PASSWORD).trim()) ? String(process.env.ADMIN_PASSWORD).trim() : (process.env.MR_ADMIN_PASSWORD && String(process.env.MR_ADMIN_PASSWORD).trim() ? String(process.env.MR_ADMIN_PASSWORD).trim() : null);
    if (!adminPwd) {
      appendLog('NO_ADMIN_AUTOCREATE: registration open (no ADMIN_PASSWORD)');
      return;
    }
    const hash = await bcrypt.hash(String(adminPwd), 10);
    const uname = 'admin';
    users = users || {};
    users[uname] = { username: uname, passwordHash: hash, role: 'admin' };
    writeJson(usersFile, users);
    appendLog('USER_CREATED admin (from ADMIN_PASSWORD env)');
  } catch (e) {
    appendLog('ENSURE_ADMIN_FAIL ' + (e && e.message ? e.message : String(e)));
  }
}
ensureAdmin().catch(()=>{});

function requireAuth(req, res, next) { if (req.session && req.session.username && users[req.session.username]) return next(); return res.status(401).json({ error: 'unauthenticated' }); }
function requireAdmin(req, res, next) { if (!req.session || !req.session.username) return res.status(401).json({ error: 'unauthenticated' }); const u = users[req.session.username]; if (!u || u.role !== 'admin') return res.status(403).json({ error: 'forbidden' }); return next(); }

app.post('/api/login', async (req, res) => { const { username, password } = req.body || {}; const user = users[username]; if (!user) return res.status(401).json({ error: 'invalid' }); const ok = await bcrypt.compare(password, user.passwordHash); if (!ok) return res.status(401).json({ error: 'invalid' }); req.session.username = username; res.json({ ok: true, username, role: user.role }); });
app.post('/api/logout', (req, res) => { req.session = null; res.json({ ok: true }); });
app.get('/api/session', (req, res) => { if (req.session && req.session.username && users[req.session.username]) { const u = users[req.session.username]; return res.json({ authenticated: true, username: u.username, role: u.role }); } res.json({ authenticated: false }); });

// Expose whether registration is open (no users exist)
app.get('/api/auth/status', (req, res) => {
  try {
    const hasUsers = users && Object.keys(users).length > 0;
    return res.json({ hasUsers });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// One-time open registration: only allowed when there are no users recorded yet.
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    // If users already exist, close registration
    if (users && Object.keys(users).length > 0) return res.status(403).json({ error: 'registration closed' });
    if (String(password).length < 6) return res.status(400).json({ error: 'password too short (min 6 chars)' });
    const uname = String(username).trim();
    const hash = await bcrypt.hash(String(password), 10);
    // First created user becomes admin
    users[uname] = { username: uname, passwordHash: hash, role: 'admin' };
    writeJson(usersFile, users);
    // create session for the new user
    req.session.username = uname;
    appendLog(`USER_REGISTERED initial admin=${uname}`);
    return res.json({ ok: true, username: uname, role: 'admin' });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.get('/api/users', requireAuth, requireAdmin, (req, res) => { const list = Object.values(users).map(u => ({ username: u.username, role: u.role })); res.json({ users: list }); });
app.post('/api/users', requireAuth, requireAdmin, async (req, res) => { const { username, password, role } = req.body || {}; if (!username || !password) return res.status(400).json({ error: 'username and password required' }); if (users[username]) return res.status(400).json({ error: 'user exists' }); try { const hash = await bcrypt.hash(password, 10); users[username] = { username, passwordHash: hash, role: role || 'user' }; writeJson(usersFile, users); appendLog(`USER_CREATE ${username} by=${req.session.username}`); res.json({ ok: true, username, role: users[username].role }); } catch (err) { res.status(500).json({ error: err.message }); } });
app.delete('/api/users/:username', requireAuth, requireAdmin, (req, res) => { const target = req.params.username; if (!users[target]) return res.status(404).json({ error: 'not found' }); if (target === 'admin') return res.status(400).json({ error: 'cannot delete admin' }); delete users[target]; writeJson(usersFile, users); appendLog(`USER_DELETE ${target} by=${req.session.username}`); res.json({ ok: true }); });

app.post('/api/users/:username/password', requireAuth, async (req, res) => {
  const target = req.params.username; const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: 'newPassword required (min 6 chars)' });
  if (!users[target]) return res.status(404).json({ error: 'user not found' });
  const requester = req.session.username; const requesterUser = users[requester];
  if (requesterUser && requesterUser.role === 'admin') { try { const hash = await bcrypt.hash(newPassword, 10); users[target].passwordHash = hash; writeJson(usersFile, users); appendLog(`USER_PWD_CHANGE target=${target} by=${requester}`); return res.json({ ok: true }); } catch (err) { return res.status(500).json({ error: err.message }) }
  }
  if (requester !== target) return res.status(403).json({ error: 'forbidden' }); if (!currentPassword) return res.status(400).json({ error: 'currentPassword required' });
  try { const ok = await bcrypt.compare(currentPassword, users[target].passwordHash); if (!ok) return res.status(401).json({ error: 'invalid current password' }); const hash = await bcrypt.hash(newPassword, 10); users[target].passwordHash = hash; writeJson(usersFile, users); appendLog(`USER_PWD_CHANGE_SELF user=${target}`); return res.json({ ok: true }); } catch (err) { return res.status(500).json({ error: err.message }) }
});

function appendLog(line) { const ts = new Date().toISOString(); const entry = `${ts} ${line}\n`; fs.appendFileSync(logsFile, entry); }

// Mock external metadata provider (TMDb)
function metaLookup(title, apiKey, opts = {}) {
  try {
    const mask = apiKey ? (String(apiKey).slice(0,6) + '...' + String(apiKey).slice(-4)) : null
    appendLog(`META_LOOKUP_REQUEST title=${title} keyPresent=${apiKey ? 'yes' : 'no'} keyMask=${mask}`)
  } catch (e) {}
  return new Promise((resolve) => {
    const https = require('https')

    function makeVariants(t) {
      const s = String(t || '').trim()
      const variants = []
      if (!s) return variants
      // original
      variants.push(s)
      // clean separators -> spaces
      const cleaned = s.replace(/[._\-:]+/g, ' ').replace(/\s+/g, ' ').trim()
      variants.push(cleaned)
      // strip bracketed/parenthetical suffixes: "Title (something)" or "Title [something]"
      const stripped = cleaned.replace(/\s*[\[(].*?[\])]/g, '').replace(/\s+/g, ' ').trim()
      if (stripped && stripped !== cleaned) variants.push(stripped)
      // try shorter word prefixes
      const words = stripped.split(/\s+/).filter(Boolean)
      if (words.length > 0) variants.push(words.slice(0, Math.min(5, words.length)).join(' '))
      if (words.length > 1) variants.push(words.slice(0, Math.min(3, words.length)).join(' '))
  // (no provider-specific suffixes — TMDb-only lookup)
      // try appending year if provided in opts
      try {
        if (opts && opts.year) {
          const y = String(opts.year)
          variants.push(stripped + ' ' + y)
          variants.push(stripped + ' (' + y + ')')
        }
      } catch (e) {}
      // lowercase variants
      variants.push(stripped.toLowerCase())
      // unique and filtered
      return [...new Set(variants.map(v => (v || '').trim()))].filter(Boolean)
    }

  // TMDb-only lookup implemented below

    function tryTmdbVariants(variants, cb) {
      if (!apiKey) return cb(null)
      const useTv = (opts && (opts.season != null || opts.episode != null))
      const baseHost = 'api.themoviedb.org'
      const tryOne = (i) => {
        if (i >= variants.length) return cb(null)
        const q = encodeURIComponent(variants[i])
        const searchPath = useTv ? `/3/search/tv?api_key=${encodeURIComponent(apiKey)}&query=${q}` : `/3/search/multi?api_key=${encodeURIComponent(apiKey)}&query=${q}`
        const req = https.request({ hostname: baseHost, path: searchPath, method: 'GET', headers: { 'Accept': 'application/json' }, timeout: 5000 }, (res) => {
          let sb = ''
          res.on('data', d => sb += d)
          res.on('end', () => {
            try {
              const j = JSON.parse(sb || '{}')
              const hits = j && j.results ? j.results : []
              appendLog(`META_TMDB_ATTEMPT q=${variants[i]} results=${hits.length} type=${useTv ? 'tv' : 'multi'}`)
              if (hits && hits.length > 0) {
                if (opts && opts.year) {
                  const y = String(opts.year)
                  const match = hits.find(h => {
                    const fy = h.first_air_date || h.release_date || h.firstAirDate
                    if (!fy) return false
                    try { return String(new Date(fy).getFullYear()) === y } catch (e) { return false }
                  })
                  if (match) return fetchTmdbDetails(match, cb)
                }
                return fetchTmdbDetails(hits[0], cb)
              }
            } catch (e) { /* ignore */ }
            setImmediate(() => tryOne(i + 1))
          })
        })
        req.on('error', () => setImmediate(() => tryOne(i + 1)))
        req.on('timeout', () => { req.destroy(); setImmediate(() => tryOne(i + 1)) })
        req.end()
      }
      function fetchTmdbDetails(hit, cb) {
        try {
          const id = hit.id
          const mediaType = hit.media_type || (hit.name ? 'tv' : 'movie')
          if (mediaType === 'tv' && opts && opts.season != null && opts.episode != null) {
            const epPath = `/3/tv/${id}/season/${encodeURIComponent(opts.season)}/episode/${encodeURIComponent(opts.episode)}?api_key=${encodeURIComponent(apiKey)}`
            const er = https.request({ hostname: baseHost, path: epPath, method: 'GET', headers: { 'Accept': 'application/json' }, timeout: 5000 }, (res) => {
              let eb = ''
              res.on('data', d => eb += d)
              res.on('end', () => {
                try {
                  const ej = JSON.parse(eb || '{}')
                  if (ej && (ej.name || ej.episode_number != null)) return cb({ provider: 'tmdb', id, type: 'tv', name: hit.name || hit.original_name || hit.title, raw: hit, episode: ej })
                } catch (e) { /* ignore */ }
                return cb({ provider: 'tmdb', id, type: mediaType, name: hit.name || hit.original_name || hit.title, raw: hit })
              })
            })
            er.on('error', () => cb({ provider: 'tmdb', id, type: mediaType, name: hit.name || hit.original_name || hit.title, raw: hit }))
            er.on('timeout', () => { er.destroy(); cb({ provider: 'tmdb', id, type: mediaType, name: hit.name || hit.original_name || hit.title, raw: hit }) })
            er.end()
            return
          }
          return cb({ provider: 'tmdb', id, type: mediaType, name: hit.name || hit.original_name || hit.title, raw: hit })
        } catch (e) { return cb(null) }
      }
      tryOne(0)
    }

    const variants = makeVariants(title)
    // TMDb-only: try variants against TMDb and return first match
    tryTmdbVariants(variants, (tRes) => {
      if (tRes) return resolve({ name: tRes.name, raw: Object.assign({}, tRes.raw, { id: tRes.id, type: tRes.type || tRes.mediaType || 'tv', source: 'tmdb' }), episode: tRes.episode || null })
      return resolve(null)
    })
  })
}

async function externalEnrich(canonicalPath, providedKey, opts = {}) {
  // lightweight filename parser to strip common release tags and extract season/episode
  const base = path.basename(canonicalPath, path.extname(canonicalPath));
  const parseFilename = require('./lib/filename-parser');
  const parsed = parseFilename(base);
  const normSeason = (parsed.season == null && parsed.episode != null) ? 1 : parsed.season
  const normEpisode = parsed.episode

  // split series and episode title heuristically
  let seriesName = parsed.title || parsed.parsedName || base
  let episodeTitle = parsed.episodeTitle || ''

  // helper: detect if a candidate looks like an episode token rather than a series title
  function isEpisodeLike(s) {
    if (!s) return false
    const ss = String(s)
    // common patterns: S01, S01E01, 1x02, E01, solitary numeric tokens when near season markers
    if (/\bS\d{1,2}([EPp]\d{1,3})?\b/i.test(ss)) return true
    if (/\b\d{1,2}x\d{1,3}\b/i.test(ss)) return true
    if (/\bE\.?\d{1,3}\b/i.test(ss)) return true
    // if the string contains words like 'episode' or is mostly numeric
    if (/episode/i.test(ss)) return true
    if (/^\d{1,3}$/.test(ss)) return true
    return false
  }

  // helper: detect resolution/year/noise tokens in a candidate title
  function isNoiseLike(s) {
    if (!s) return false
    const t = String(s).toLowerCase()
    const noise = ['1080p','720p','2160p','4k','x264','x265','bluray','bdrip','webrip','web-dl','hdtv','dvdr','bdr','10bit','8bit','bit','bits']
    if (/(19|20)\d{2}/.test(t)) return true
    for (const n of noise) if (t.indexOf(n) !== -1) return true
    return false
  }

  // If parsed title looks like an episode (e.g., filename only contains SxxEyy - Title), prefer a parent-folder as series title
  if (isEpisodeLike(seriesName) || isNoiseLike(seriesName)) {
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
            if (!(/^[0-9]+$/.test(String(cand).trim()) && hasSeasonMarker)) {
              if (isEpisodeLike(cand) || isNoiseLike(cand)) continue
            }
          // prefer parent folder candidate
          seriesName = cand
          break
        } catch (e) { /* ignore and continue up the path */ }
      }
    } catch (e) { /* ignore */ }
  }
  if (normEpisode != null) {
    const eps = String(normEpisode)
    const epsRe = new RegExp('\\b0*' + eps + '\\b')
    if (epsRe.test(seriesName)) {
      const parts = seriesName.split(epsRe)
      if (parts.length > 1) {
        const left = parts[0].replace(/[-_\s]+$/,'').trim()
        const right = parts.slice(1).join('').replace(/^[\-_\s]+/,'').trim()
        if (left) seriesName = left
        if (right) episodeTitle = right
      }
    }
  }

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

  const guess = { title: seriesName, parsedName: formattedParsedName, season: normSeason, episode: normEpisode, episodeTitle };

  const tmdbKey = providedKey || (users && users.admin && users.admin.settings && (users.admin.settings.tmdb_api_key || users.admin.settings.tvdb_api_key)) || (serverSettings && (serverSettings.tmdb_api_key || serverSettings.tvdb_api_key))
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
    try {
      const res = await metaLookup(seriesName, tmdbKey, { year: parsed.year, season: normSeason, episode: normEpisode, preferredProvider })
      if (res && res.name) {
        // Map TMDb response into our guess structure explicitly
        try {
          const raw = res.raw || {}
          // Title (series/movie)
          guess.title = String(res.name || raw.name || raw.title || guess.title).trim()

          // Episode-level data (when available)
          if (res.episode) {
            const ep = res.episode
            const epTitle = ep.name || ep.title || (ep.attributes && ep.attributes.canonicalTitle)
            if (epTitle) guess.episodeTitle = String(epTitle).trim()
          }

          // Provider block - TMDb only
          guess.provider = { matched: true, provider: 'tmdb', id: raw.id || null, raw: raw }

          // Back-compat: populate tvdb object with TMDb identifiers/raw
          guess.tvdb = { matched: true, id: raw.id || null, raw: raw }

          // Year extraction from common TMDb date fields
          const dateStr = raw.first_air_date || raw.release_date || raw.firstAirDate || (raw.attributes && (raw.attributes.startDate || raw.attributes.releaseDate))
          if (dateStr) {
            const y = new Date(String(dateStr)).getFullYear()
            if (!isNaN(y)) guess.year = String(y)
          }
        } catch (mapErr) {
          // Map error -> keep guess as-is but note tvdb not matched
          guess.tvdb = { matched: false }
        }
      } else {
        guess.tvdb = { matched: false }
      }
    } catch (e) {
      guess.tvdb = { error: e.message }
    }
  }

  return {
    sourceId: 'mock:1',
    title: guess.title || base,
  year: guess.year || null,
    parsedName: guess.parsedName,
    episodeRange: parsed.episodeRange,
    season: guess.season,
    episode: guess.episode,
    episodeTitle: guess.episodeTitle,
    tvdb: guess.tvdb || null,
    provider: guess.provider || null,
    language: 'en',
    timestamp: Date.now(),
    extraGuess: guess
  };
}

// Normalize path canonicalization (simple lower-case, resolve)
function canonicalize(p) {
  return path.resolve(p).replace(/\\/g, '/');
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
    const serverKey = serverSettings && (serverSettings.tmdb_api_key || serverSettings.tvdb_api_key) ? String(serverSettings.tmdb_api_key || serverSettings.tvdb_api_key) : null
    const serverMask = serverKey ? (serverKey.slice(0,6) + '...' + serverKey.slice(-4)) : null
    let userKey = null
    try { const u = req.session && req.session.username && users[req.session.username]; if (u && u.settings && (u.settings.tmdb_api_key || u.settings.tvdb_api_key)) userKey = String(u.settings.tmdb_api_key || u.settings.tvdb_api_key) } catch (e) {}
    const userMask = userKey ? (userKey.slice(0,6) + '...' + userKey.slice(-4)) : null
  // recent META_LOOKUP logs (TMDb attempts and lookup requests)
  let recent = ''
  try { recent = fs.readFileSync(logsFile, 'utf8').split('\n').filter(l => l.indexOf('META_LOOKUP_REQUEST') !== -1 || l.indexOf('META_TMDB_SEARCH') !== -1 || l.indexOf('META_TMDB_ATTEMPT') !== -1).slice(-200).join('\n') } catch (e) { recent = '' }
    res.json({ serverKeyPresent: !!serverKey, userKeyPresent: !!userKey, serverKeyMask: serverMask, userKeyMask: userMask, logs: recent })
  } catch (e) { res.json({ error: e.message }) }
})

// Backwards compatible endpoint for older clients
app.get('/api/tvdb/status', (req, res) => {
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
  const items = [];

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
        // video file filter (match many common container formats)
        if (extRe.test(e.name)) {
          items.push({ id: uuidv4(), canonicalPath: canonicalize(full), scannedAt: Date.now() });
        }
      }
    }
  }

  try {
    walkDir(libPath);
  } catch (err) {
    appendLog(`SCAN_ERROR ${err.message}`);
    return res.status(500).json({ error: err.message });
  }

  const scanId = uuidv4();
  // Run quick local parsing for each discovered item so the UI shows cleaned parsed names immediately
  try {
    const parseFilename = require('./lib/filename-parser');
    let userHasAuthoritativeProviderKey = false;
    try {
      const username = req.session && req.session.username;
      // determine effective preferred provider for this user (user setting -> server setting -> tmdb)
      let preferred = 'tmdb'
      try { if (username && users[username] && users[username].settings && users[username].settings.default_meta_provider) preferred = users[username].settings.default_meta_provider; else if (serverSettings && serverSettings.default_meta_provider) preferred = serverSettings.default_meta_provider } catch (e) { preferred = 'tmdb' }
      // only consider TMDb authoritative if preferred is tmdb and a TMDb/tvdb key exists
      if (String(preferred).toLowerCase() === 'tmdb') {
        if (username && users[username] && users[username].settings && users[username].settings.tvdb_api_key) userHasAuthoritativeProviderKey = Boolean(users[username].settings.tvdb_api_key)
        else if (serverSettings && serverSettings.tvdb_api_key) userHasAuthoritativeProviderKey = Boolean(serverSettings.tvdb_api_key)
      }
    } catch (e) { userHasAuthoritativeProviderKey = false }
    for (const it of items) {
      try {
        const base = path.basename(it.canonicalPath, path.extname(it.canonicalPath));
        const parsed = parseFilename(base);
        const key = canonicalize(it.canonicalPath);
        // only suppress local parsed episodeTitle when the user's effective preferred provider is TMDb and a TMDb key is present
        const episodeTitle = userHasAuthoritativeProviderKey ? '' : (parsed.episodeTitle || '');
        enrichCache[key] = Object.assign({}, enrichCache[key] || {}, { sourceId: 'local-parser', title: parsed.title, parsedName: parsed.parsedName, season: parsed.season, episode: parsed.episode, episodeTitle: episodeTitle, language: 'en', timestamp: Date.now() });
      } catch (e) { appendLog(`PARSE_ITEM_FAIL path=${it.canonicalPath} err=${e.message}`); }
    }
    writeJson(enrichStoreFile, enrichCache);
  } catch (e) { appendLog(`PARSE_MODULE_FAIL err=${e.message}`); }

  const artifact = { id: scanId, libraryId: libraryId || 'local', totalCount: items.length, items, generatedAt: Date.now() };
  scans[scanId] = artifact;
  writeJson(scanStoreFile, scans);
  appendLog(`SCAN_COMPLETE id=${scanId} total=${items.length}`);
  res.json({ scanId, totalCount: items.length });
});

app.get('/api/scan/:scanId', (req, res) => { const s = scans[req.params.scanId]; if (!s) return res.status(404).json({ error: 'scan not found' }); res.json({ libraryId: s.libraryId, totalCount: s.totalCount, generatedAt: s.generatedAt }); });
app.get('/api/scan/:scanId/items', (req, res) => { const s = scans[req.params.scanId]; if (!s) return res.status(404).json({ error: 'scan not found' }); const offset = parseInt(req.query.offset || '0', 10); const limit = Math.min(parseInt(req.query.limit || '50', 10), 500); const slice = s.items.slice(offset, offset + limit); res.json({ items: slice, offset, limit, total: s.totalCount }); });

app.get('/api/enrich', (req, res) => { const { path: p } = req.query; const key = canonicalize(p || ''); if (enrichCache[key]) return res.json({ cached: true, enrichment: enrichCache[key] }); return res.json({ cached: false }); });

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
app.post('/api/settings', requireAuth, (req, res) => {
  const body = req.body || {};
  const username = req.session && req.session.username;
  try {
    // if admin requested global update
    if (username && users[username] && users[username].role === 'admin' && body.global) {
      // Admins may set global server settings, but not a global scan_input_path (per-user only)
  const allowed = ['tmdb_api_key', 'tvdb_api_key', 'scan_output_path', 'rename_template', 'default_meta_provider'];
      for (const k of allowed) if (body[k] !== undefined) serverSettings[k] = body[k];
      writeJson(settingsFile, serverSettings);
      appendLog(`SETTINGS_SAVED_GLOBAL by=${username} keys=${Object.keys(body).join(',')}`);
      return res.json({ ok: true, settings: serverSettings });
    }

    // otherwise save per-user
    if (!username) return res.status(401).json({ error: 'unauthenticated' });
    users[username] = users[username] || {};
    users[username].settings = users[username].settings || {};
  const allowed = ['tmdb_api_key', 'tvdb_api_key', 'scan_input_path', 'scan_output_path', 'rename_template', 'default_meta_provider'];
    for (const k of allowed) { if (body[k] !== undefined) users[username].settings[k] = body[k]; }
    writeJson(usersFile, users);
    appendLog(`SETTINGS_SAVED_USER user=${username} keys=${Object.keys(body).join(',')}`);
    return res.json({ ok: true, userSettings: users[username].settings });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// Path existence check (used by the client to validate configured paths)
app.get('/api/path/exists', (req, res) => { const p = req.query.path || ''; try { const rp = path.resolve(p); const exists = fs.existsSync(rp); const stat = exists ? fs.statSync(rp) : null; res.json({ exists, isDirectory: stat ? stat.isDirectory() : false, resolved: rp }); } catch (err) { res.json({ exists: false, isDirectory: false, error: err.message }); } });

app.post('/api/enrich', async (req, res) => {
  const { path: p, tvdb_api_key: tvdb_override, tmdb_api_key: tmdb_override } = req.body;
  const key = canonicalize(p || '');
  appendLog(`ENRICH_REQUEST path=${key}`);
  try {
    let tvdbKey = null
    try {
      if (tmdb_override) tvdbKey = tmdb_override;
      else if (tvdb_override) tvdbKey = tvdb_override;
      else if (req.session && req.session.username && users[req.session.username] && users[req.session.username].settings && (users[req.session.username].settings.tmdb_api_key || users[req.session.username].settings.tvdb_api_key)) tvdbKey = users[req.session.username].settings.tmdb_api_key || users[req.session.username].settings.tvdb_api_key;
      else if (serverSettings && (serverSettings.tmdb_api_key || serverSettings.tvdb_api_key)) tvdbKey = serverSettings.tmdb_api_key || serverSettings.tvdb_api_key;
    } catch (e) { tvdbKey = null }
  const data = await externalEnrich(key, tvdbKey, { username: req.session && req.session.username });
    enrichCache[key] = { ...data, cachedAt: Date.now() };
    writeJson(enrichStoreFile, enrichCache);
    appendLog(`ENRICH_SUCCESS path=${key}`);
    res.json({ enrichment: enrichCache[key] });
  } catch (err) { appendLog(`ENRICH_FAIL path=${key} err=${err.message}`); res.status(500).json({ error: err.message }); }
});

// Force-refresh metadata for all items in a completed scan (server-side enrichment)
app.post('/api/scan/:scanId/refresh', requireAuth, async (req, res) => {
  const s = scans[req.params.scanId];
  if (!s) return res.status(404).json({ error: 'scan not found' });
  const username = req.session && req.session.username;
  appendLog(`REFRESH_SCAN_REQUEST scan=${req.params.scanId} by=${username}`);
  // pick tmdb/tvdb key if available (tmdb preferred)
  const { tvdb_api_key: tvdb_override, tmdb_api_key: tmdb_override } = req.body || {};
  let tvdbKey = null
  try {
    if (tmdb_override) tvdbKey = tmdb_override;
    else if (tvdb_override) tvdbKey = tvdb_override;
    else if (username && users[username] && users[username].settings && (users[username].settings.tmdb_api_key || users[username].settings.tvdb_api_key)) tvdbKey = users[username].settings.tmdb_api_key || users[username].settings.tvdb_api_key;
    else if (serverSettings && (serverSettings.tmdb_api_key || serverSettings.tvdb_api_key)) tvdbKey = serverSettings.tmdb_api_key || serverSettings.tvdb_api_key;
  } catch (e) { tvdbKey = null }
  const results = [];
  for (const it of s.items) {
    try {
      const key = canonicalize(it.canonicalPath);
      // If we already have a provider match from TMDb, skip external API hit and keep cached values
      const existing = enrichCache[key] || null
      let data = null
      if (existing && existing.provider && existing.provider.matched && existing.provider.provider === 'tmdb') {
        data = existing
      } else {
        data = await externalEnrich(key, tvdbKey, { username });
      }
      enrichCache[key] = { ...data, cachedAt: Date.now() };
      results.push({ path: key, ok: true, parsedName: data.parsedName, title: data.title });
      appendLog(`REFRESH_ITEM_OK path=${key} parsedName=${data.parsedName}`);
    } catch (err) {
      appendLog(`REFRESH_ITEM_FAIL path=${it.canonicalPath} err=${err.message}`);
      results.push({ path: it.canonicalPath, ok: false, error: err.message });
    }
  }
  writeJson(enrichStoreFile, enrichCache);
  appendLog(`REFRESH_SCAN_COMPLETE scan=${req.params.scanId} items=${results.length}`);
  res.json({ ok: true, results });
});

// Debug enrich: return cached enrichment and what externalEnrich would produce now
app.get('/api/enrich/debug', async (req, res) => { const p = req.query.path || ''; const key = canonicalize(p); const cached = enrichCache[key] || null; // pick tvdb key if available (use server setting only for debug)
  const tvdbKey = serverSettings && (serverSettings.tmdb_api_key || serverSettings.tvdb_api_key) ? (serverSettings.tmdb_api_key || serverSettings.tvdb_api_key) : null;
  let forced = null;
  try {
    forced = await externalEnrich(key, tvdbKey, { username: null });
  } catch (e) { forced = { error: e.message } }
  res.json({ key, cached, forced });
});

// Rename preview (generate plan)
app.post('/api/rename/preview', (req, res) => {
  const { items, template, outputPath } = req.body || {};
  if (!items || !Array.isArray(items)) return res.status(400).json({ error: 'items required' });
  // resolve effective output path: request overrides server setting
  const effectiveOutput = outputPath || serverSettings.scan_output_path || '';
  const plans = items.map(it => {
    const fromPath = canonicalize(it.canonicalPath);
    const meta = enrichCache[fromPath] || {};
  // prefer provider/enrichment values when present, fall back to parsed/title/basename
  const title = (meta && (meta.title || (meta.extraGuess && meta.extraGuess.title))) ? (meta.title || (meta.extraGuess && meta.extraGuess.title)) : path.basename(fromPath, path.extname(fromPath));
  const year = (meta && (meta.year || (meta.extraGuess && meta.extraGuess.year))) ? (meta.year || (meta.extraGuess && meta.extraGuess.year)) : extractYear(meta, fromPath);
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
      // preserve fractional episodes (11.5) while padding integer part
      const epVal = String(meta.episode)
      const epLabelPart = /^\d+(?:\.\d+)?$/.test(epVal) ? (epVal.indexOf('.') === -1 ? pad(epVal) : (() => { const p = epVal.split('.'); return pad(p[0]) + '.' + p[1] })()) : epVal
      epLabel = meta.season != null ? `S${pad(meta.season)}E${epLabelPart}` : `E${epLabelPart}`
    }
  const episodeTitleToken = (meta && (meta.episodeTitle || (meta.extraGuess && meta.extraGuess.episodeTitle))) ? (meta.episodeTitle || (meta.extraGuess && meta.extraGuess.episodeTitle)) : ''

    // Support extra template tokens: {season}, {episode}, {episodeRange}, {tvdbId}
    const seasonToken = (meta && meta.season != null) ? String(meta.season) : ''
    const episodeToken = (meta && meta.episode != null) ? String(meta.episode) : ''
    const episodeRangeToken = (meta && meta.episodeRange) ? String(meta.episodeRange) : ''
    const tvdbIdToken = (meta && meta.tvdb && meta.tvdb.raw && (meta.tvdb.raw.id || meta.tvdb.raw.seriesId)) ? String(meta.tvdb.raw.id || meta.tvdb.raw.seriesId) : ''

    // Render template with preferência to enrichment-provided tokens
    const nameWithoutExtRaw = baseNameTemplate
      .replace('{title}', sanitize(title))
      .replace('{basename}', sanitize(path.basename(fromPath, ext)))
      .replace('{year}', year || '')
      .replace('{epLabel}', sanitize(epLabel))
      .replace('{episodeTitle}', sanitize(episodeTitleToken))
      .replace('{season}', sanitize(seasonToken))
      .replace('{episode}', sanitize(episodeToken))
      .replace('{episodeRange}', sanitize(episodeRangeToken))
      .replace('{tvdbId}', sanitize(tvdbIdToken));
    // Clean up common artifact patterns from empty tokens: stray parentheses, repeated separators
    const nameWithoutExt = String(nameWithoutExtRaw)
      .replace(/\s*\(\s*\)\s*/g, '') // remove empty ()
      .replace(/\s*\-\s*(?:\-\s*)+/g, ' - ') // collapse repeated dashes
      .replace(/(^\s*-\s*)|(\s*-\s*$)/g, '') // trim leading/trailing dashes
      .replace(/\s{2,}/g, ' ') // collapse multiple spaces
      .trim();
    const fileName = (nameWithoutExt + ext).trim();
    // If an output path is configured, plan a hardlink under that path preserving a Jellyfin-friendly layout
    let toPath;
    if (effectiveOutput) {
      // folder: <output>/<Show Title (Year)>/Season NN
      const titleFolder = year ? `${sanitize(title)} (${year})` : sanitize(title);
      const seasonFolder = (meta && meta.season != null) ? `Season ${String(meta.season).padStart(2,'0')}` : '';
      const folder = seasonFolder ? path.join(effectiveOutput, titleFolder, seasonFolder) : path.join(effectiveOutput, titleFolder);
      // filename should directly be the rendered template (nameWithoutExt) + ext
      let finalFileName = nameWithoutExt;
  // finalFileName is derived strictly from the rendered template (no automatic year injection)
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

function extractYear(meta, fromPath) {
  if (!meta) meta = {};
  // common fields
  const candidates = [meta.year, meta.airedYear, meta.originalYear];
  for (const c of candidates) if (c && String(c).match(/^\d{4}$/)) return String(c);
  if (meta.timestamp) {
    try { const d = new Date(Number(meta.timestamp)); if (!isNaN(d)) return String(d.getFullYear()) } catch (e) {}
  }
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
  const results = [];
  for (const p of plans) {
    try {
      const from = p.fromPath;
      const to = p.toPath;
      if (from === to) {
        results.push({ itemId: p.itemId, status: 'noop' });
        continue;
      }
      // If to is under an output directory configured on the server, prefer hardlink creation
      const configuredOut = serverSettings.scan_output_path ? canonicalize(serverSettings.scan_output_path) : null;
      const toResolved = path.resolve(to);
      const resultsItem = { itemId: p.itemId };

      if (!dryRun) {
        // Determine if this plan explicitly requested a hardlink (preview sets actions: [{op:'hardlink'}])
        const requestedHardlink = (p.actions && Array.isArray(p.actions) && p.actions[0] && p.actions[0].op === 'hardlink') || false
        const targetUnderConfiguredOut = configuredOut && toResolved.startsWith(path.resolve(configuredOut))
        if (requestedHardlink || targetUnderConfiguredOut) {
          // create directories and attempt to create a hard link; do NOT move the original file
          try {
            // Re-render filename from enrichment and template if available to ensure TMDb-based names are used
            try {
              const enrichment = enrichCache[from] || {};
              const tmpl = (p.templateUsed) ? p.templateUsed : (enrichment && enrichment.extraGuess && enrichment.extraGuess.rename_template) || serverSettings.rename_template || '{title}';
              // build tokens similar to previewRename
              const ext2 = path.extname(from);
              function pad(n){ return String(n).padStart(2,'0') }
              let epLabel2 = ''
              if (enrichment && enrichment.episodeRange) {
                epLabel2 = enrichment.season != null ? `S${pad(enrichment.season)}E${enrichment.episodeRange}` : `E${enrichment.episodeRange}`
              } else if (enrichment && enrichment.episode != null) {
                const epVal2 = String(enrichment.episode)
                const epLabelPart2 = /^\d+(?:\.\d+)?$/.test(epVal2) ? (epVal2.indexOf('.') === -1 ? pad(epVal2) : (() => { const p = epVal2.split('.'); return pad(p[0]) + '.' + p[1] })()) : epVal2
                epLabel2 = enrichment.season != null ? `S${pad(enrichment.season)}E${epLabelPart2}` : `E${epLabelPart2}`
              }
              const episodeTitleToken2 = enrichment && (enrichment.episodeTitle || (enrichment.extraGuess && enrichment.extraGuess.episodeTitle)) ? (enrichment.episodeTitle || (enrichment.extraGuess && enrichment.extraGuess.episodeTitle)) : ''
              const seasonToken2 = (enrichment && enrichment.season != null) ? String(enrichment.season) : ''
              const episodeToken2 = (enrichment && enrichment.episode != null) ? String(enrichment.episode) : ''
              const episodeRangeToken2 = (enrichment && enrichment.episodeRange) ? String(enrichment.episodeRange) : ''
              const tvdbIdToken2 = (enrichment && enrichment.tvdb && enrichment.tvdb.raw && (enrichment.tvdb.raw.id || enrichment.tvdb.raw.seriesId)) ? String(enrichment.tvdb.raw.id || enrichment.tvdb.raw.seriesId) : ''
              const titleToken2 = (enrichment && (enrichment.title || (enrichment.extraGuess && enrichment.extraGuess.title))) ? (enrichment.title || (enrichment.extraGuess && enrichment.extraGuess.title)) : path.basename(from, ext2)
              const yearToken2 = (enrichment && (enrichment.year || (enrichment.extraGuess && enrichment.extraGuess.year))) ? (enrichment.year || (enrichment.extraGuess && enrichment.extraGuess.year)) : (extractYear(enrichment, from) || '')
              const nameWithoutExtRaw2 = String(tmpl || '{title}').replace('{title}', sanitize(titleToken2))
                .replace('{basename}', sanitize(path.basename(from, ext2)))
                .replace('{year}', yearToken2)
                .replace('{epLabel}', sanitize(epLabel2))
                .replace('{episodeTitle}', sanitize(episodeTitleToken2))
                .replace('{season}', sanitize(seasonToken2))
                .replace('{episode}', sanitize(episodeToken2))
                .replace('{episodeRange}', sanitize(episodeRangeToken2))
                .replace('{tvdbId}', sanitize(tvdbIdToken2))
              const nameWithoutExt2 = String(nameWithoutExtRaw2)
                .replace(/\s*\(\s*\)\s*/g, '')
                .replace(/\s*\-\s*(?:\-\s*)+/g, ' - ')
                .replace(/(^\s*-\s*)|(\s*-\s*$)/g, '')
                .replace(/\s{2,}/g, ' ')
                .trim();
              const finalFileName2 = (nameWithoutExt2 + ext2).trim();
              // use toResolved's directory but replace basename with rendered name
              const dir = path.dirname(toResolved);
              const newToResolved = path.join(dir, finalFileName2);
              // ensure directory exists
              if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
              // assign for subsequent operations
              // prefer the rendered name if target path differs
              var effectiveToResolved = newToResolved;
            } catch (renderErr) {
              // fallback to original toResolved
              var effectiveToResolved = toResolved;
            }
            if (!fs.existsSync(effectiveToResolved)) {
              try {
                fs.linkSync(from, effectiveToResolved);
                resultsItem.status = 'hardlinked';
                resultsItem.to = effectiveToResolved;
                appendLog(`HARDLINK_OK from=${from} to=${effectiveToResolved}`);
              } catch (linkErr) {
                // If hardlinking fails (different device or unsupported), fallback to copying the file so original is preserved
                try {
                  fs.copyFileSync(from, effectiveToResolved);
                  resultsItem.status = 'copied_after_hardlink_fail';
                  resultsItem.to = effectiveToResolved;
                  appendLog(`HARDLINK_FAIL_FALLBACK_COPY from=${from} to=${effectiveToResolved} err=${linkErr.message}`);
                } catch (copyErr) {
                  // both hardlink and copy failed
                  appendLog(`HARDLINK_AND_COPY_FAIL from=${from} to=${effectiveToResolved} linkErr=${linkErr.message} copyErr=${copyErr.message}`);
                  throw copyErr
                }
              }
            } else {
              // target already exists
              resultsItem.status = 'exists';
              resultsItem.to = effectiveToResolved;
              appendLog(`HARDLINK_SKIP_EXISTS to=${effectiveToResolved}`);
            }

            // mark applied in enrich cache and persist
            try {
              enrichCache[from] = enrichCache[from] || {};
              enrichCache[from].applied = true;
              enrichCache[from].hidden = true;
              enrichCache[from].appliedAt = Date.now();
              enrichCache[from].appliedTo = effectiveToResolved || toResolved;
              const finalBasename = path.basename(effectiveToResolved || toResolved);
              enrichCache[from].renderedName = finalBasename;
              // metadataFilename: rendered filename without the extension
              enrichCache[from].metadataFilename = finalBasename.replace(new RegExp(path.extname(finalBasename) + '$'), '')
              // also index the enrichment by the target path so lookups on the created file return metadata
              try {
                const targetKey = canonicalize(effectiveToResolved || toResolved)
                enrichCache[targetKey] = Object.assign({}, enrichCache[from])
                // record mapping metadataFilename -> targetKey for quick lookup
                try {
                  const metaName = enrichCache[from].metadataFilename
                  if (metaName) renderedIndex[metaName] = targetKey
                } catch (e) {}
              } catch (e) {}
              writeJson(enrichStoreFile, enrichCache);
              try { writeJson(renderedIndexFile, renderedIndex) } catch (e) {}
            } catch (e) { appendLog(`HARDLINK_MARK_FAIL from=${from} err=${e.message}`) }
          } catch (err) {
            // bubble up to outer error handler
            throw err
          }
        } else {
          // default behavior: move/rename the original file
          const toDir2 = path.dirname(to);
          if (!fs.existsSync(toDir2)) fs.mkdirSync(toDir2, { recursive: true });
          fs.renameSync(from, to);
          resultsItem.status = 'moved';
          resultsItem.to = to;
          appendLog(`RENAME_OK from=${from} to=${to}`);
          try {
            enrichCache[from] = enrichCache[from] || {};
            enrichCache[from].applied = true;
            enrichCache[from].hidden = true;
            enrichCache[from].appliedAt = Date.now();
            enrichCache[from].appliedTo = to;
            const movedBasename = path.basename(to);
            enrichCache[from].renderedName = movedBasename;
            enrichCache[from].metadataFilename = movedBasename.replace(new RegExp(path.extname(movedBasename) + '$'), '')
            // index by destination as well so metadata lookups by the new filename work
            try {
              const targetKey2 = canonicalize(to)
              enrichCache[targetKey2] = Object.assign({}, enrichCache[from])
              try {
                const metaName2 = enrichCache[from].metadataFilename
                if (metaName2) renderedIndex[metaName2] = targetKey2
              } catch (e) {}
            } catch (e) {}
            writeJson(enrichStoreFile, enrichCache);
            try { writeJson(renderedIndexFile, renderedIndex) } catch (e) {}
          } catch (e) { appendLog(`RENAME_MARK_FAIL from=${from} err=${e.message}`) }
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
    const count = parseInt((req.body && req.body.count) || '10', 10) || 10
    // collect applied entries sorted by appliedAt desc
    const applied = Object.keys(enrichCache).map(k => ({ k, v: enrichCache[k] })).filter(x => x.v && x.v.applied).sort((a,b) => (b.v.appliedAt || 0) - (a.v.appliedAt || 0))
    const toUn = applied.slice(0, count)
    const changed = []
    for (const item of toUn) {
      try {
        enrichCache[item.k].applied = false
        enrichCache[item.k].hidden = false
        delete enrichCache[item.k].appliedAt
        delete enrichCache[item.k].appliedTo
        changed.push(item.k)
      } catch (e) {}
    }
    writeJson(enrichStoreFile, enrichCache)
    appendLog(`UNAPPROVE count=${changed.length}`)
    res.json({ ok: true, unapproved: changed })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Logs endpoints
app.get('/api/logs/recent', (req, res) => {
  const tail = fs.existsSync(logsFile) ? fs.readFileSync(logsFile, 'utf8').split('\n').slice(-200).join('\n') : '';
  res.json({ logs: tail });
});

app.post('/api/logs/clear', (req, res) => {
  fs.writeFileSync(logsFile, '');
  res.json({ ok: true });
});

// Backwards-compatible TVDB status endpoint -> proxy to /api/meta/status
app.get('/api/tvdb/status', (req, res) => {
  return app._router.handle(req, res, () => {}, 'GET', '/api/meta/status')
})

// Serve web app static if built
app.use('/', express.static(path.join(__dirname, 'web', 'dist')));

const PORT = process.env.PORT || 5173;
// export helpers for test harnesses
module.exports = module.exports || {};
module.exports.externalEnrich = externalEnrich;

// Only start the HTTP server when this file is run directly, not when required as a module
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server listening on ${PORT}`);
  });
}
