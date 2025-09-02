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
const parsedCacheFile = path.join(DATA_DIR, 'parsed-cache.json');

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
ensureFile(parsedCacheFile, {});

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
let parsedCache = readJson(parsedCacheFile, {});

// Helper: normalize enrich cache entries to a clear shape { parsed: {...}, provider: {...}, ... }
function makeParsedEntry(parsed) {
  if (!parsed) return null;
  return { title: parsed.title || '', parsedName: parsed.parsedName || '', season: parsed.season != null ? parsed.season : null, episode: parsed.episode != null ? parsed.episode : null, timestamp: parsed.timestamp || Date.now() };
}

function makeProviderEntry(data, renderedName) {
  if (!data) return null;
  return { title: data.title || '', year: data.year || null, season: data.season != null ? data.season : null, episode: data.episode != null ? data.episode : null, episodeTitle: data.episodeTitle || '', raw: data.raw || data, renderedName: renderedName || null, matched: !!data.title };
}

function normalizeEnrichEntry(raw) {
  raw = raw || {};
  const out = {};
  // retain applied/hidden flags at top-level
  if (raw.applied) out.applied = raw.applied;
  if (raw.hidden) out.hidden = raw.hidden;
  if (raw.appliedAt) out.appliedAt = raw.appliedAt;
  if (raw.appliedTo) out.appliedTo = raw.appliedTo;
  if (raw.renderedName) out.renderedName = raw.renderedName;
  if (raw.metadataFilename) out.metadataFilename = raw.metadataFilename;
  // parsed block
  if (raw.parsed) out.parsed = makeParsedEntry(raw.parsed);
  else if (raw.title || raw.parsedName || raw.season != null || raw.episode != null) out.parsed = makeParsedEntry({ title: raw.title || '', parsedName: raw.parsedName || '', season: raw.season, episode: raw.episode, timestamp: raw.timestamp });
  else out.parsed = null;
  // provider block
  if (raw.provider) out.provider = makeProviderEntry(raw.provider, raw.providerRenderedName || raw.provider && raw.provider.renderedName || raw.renderedName || null);
  else if (raw.providerRenderedName || raw.episodeTitle || raw.year) out.provider = makeProviderEntry({ title: raw.title || (raw.parsed && raw.parsed.title) || '', year: raw.year || null, season: raw.season, episode: raw.episode, episodeTitle: raw.episodeTitle || '' }, raw.providerRenderedName || raw.renderedName || null);
  else out.provider = null;
  out.cachedAt = raw.cachedAt || Date.now();
  out.sourceId = raw.sourceId || null;
  return out;
}

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
          if (i >= variants.length) return cb(null);
          const q = encodeURIComponent(variants[i]);
          const searchPath = useTv ? `/3/search/tv?api_key=${encodeURIComponent(apiKey)}&query=${q}` : `/3/search/multi?api_key=${encodeURIComponent(apiKey)}&query=${q}`;
          const req = https.request({ hostname: baseHost, path: searchPath, method: 'GET', headers: { 'Accept': 'application/json' }, timeout: 5000 }, (res) => {
            let sb = '';
            res.on('data', d => sb += d);
            res.on('end', () => {
              try {
                const j = JSON.parse(sb || '{}');
                const hits = j && j.results ? j.results : [];
                appendLog(`META_TMDB_ATTEMPT q=${variants[i]} results=${hits.length} type=${useTv ? 'tv' : 'multi'}`);
                if (hits && hits.length > 0) {
                  if (opts && opts.year) {
                    const y = String(opts.year);
                    const match = hits.find(h => {
                      const fy = h.first_air_date || h.release_date || h.firstAirDate;
                      if (!fy) return false;
                      try { return String(new Date(fy).getFullYear()) === y; } catch (e) { return false; }
                    });
                    if (match) return fetchTmdbDetails(match, cb);
                  }
                  return fetchTmdbDetails(hits[0], cb);
                }
              } catch (e) { /* ignore */ }
              setImmediate(() => tryOne(i + 1));
            });
          });
          req.on('error', () => setImmediate(() => tryOne(i + 1)));
          req.on('timeout', () => { req.destroy(); setImmediate(() => tryOne(i + 1)); });
          req.end();
      }
      function fetchTmdbDetails(hit, cb) {
        try {
          const id = hit.id
          const mediaType = hit.media_type || (hit.name ? 'tv' : 'movie')
          // If caller provided season & episode, prefer episode-level lookup with fallbacks for specials/decimals
          if (mediaType === 'tv' && opts && opts.season != null && opts.episode != null) {
            const epPath = `/3/tv/${id}/season/${encodeURIComponent(opts.season)}/episode/${encodeURIComponent(opts.episode)}?api_key=${encodeURIComponent(apiKey)}`
            const er = https.request({ hostname: baseHost, path: epPath, method: 'GET', headers: { 'Accept': 'application/json' }, timeout: 5000 }, (res) => {
              let eb = ''
              res.on('data', d => eb += d)
              res.on('end', async () => {
                let ej = null
                try { ej = JSON.parse(eb || '{}') } catch (e) { ej = null }
                // If episode lookup returned a useful name/number, decide whether to accept it.
                if (ej && ej.name) {
                  try {
                    // If caller provided a parsed episode title (from filename) and the requested
                    // episode was a fractional/decimal (e.g., "11.5"), compare similarity between
                    // the TMDb episode name and the parsed title. If they are not similar enough,
                    // do not accept this episode result here and fall through to specials/season0 logic.
                    const parsedEpTitle = opts && opts.parsedEpisodeTitle ? String(opts.parsedEpisodeTitle || '').trim() : '';
                    const epRequestedStr = String(opts.episode || '');
                    const isDecimal = epRequestedStr.indexOf('.') !== -1;
                    function normalizeForCompare(s) { try { return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(); } catch (e) { return String(s || '').toLowerCase(); } }
                    function levenshtein(a,b) {
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
                    function similarEnough(a,b) {
                      const na = normalizeForCompare(a)
                      const nb = normalizeForCompare(b)
                      if (!na || !nb) return false
                      if (na === nb) return true
                      if (na.indexOf(nb) !== -1 || nb.indexOf(na) !== -1) return true
                      const dist = levenshtein(na, nb)
                      const norm = dist / Math.max(na.length, nb.length, 1)
                      return norm <= 0.4
                    }
                    if (isDecimal && parsedEpTitle) {
                      const tmdbEpName = ej.name || ej.title || '';
                      if (!similarEnough(tmdbEpName, parsedEpTitle)) {
                        // treat as not matched and continue to season0 / specials fallback logic
                      } else {
                        return cb({ provider: 'tmdb', id, type: 'tv', name: hit.name || hit.original_name || hit.title, raw: hit, episode: ej })
                      }
                    } else {
                      return cb({ provider: 'tmdb', id, type: 'tv', name: hit.name || hit.original_name || hit.title, raw: hit, episode: ej })
                    }
                  } catch (e) {
                    return cb({ provider: 'tmdb', id, type: 'tv', name: hit.name || hit.original_name || hit.title, raw: hit, episode: ej })
                  }
                }

                // Only attempt season-0 (specials) lookup for true special candidates:
                // - explicitly season 0, or
                // - fractional/decimal episode numbers (e.g., 11.5)
                const epStr = String(opts.episode || '')
                const isSpecialCandidate = (Number(opts.season) === 0) || (epStr.indexOf('.') !== -1)
                if (!isSpecialCandidate) {
                  // Not a special candidate; return series-level hit without extra season0 work
                  return cb({ provider: 'tmdb', id, type: mediaType, name: hit.name || hit.original_name || hit.title, raw: hit })
                }

                // Fallback 1: try season 0 (specials) list and attempt to find a matching special
                const season0Path = `/3/tv/${id}/season/0?api_key=${encodeURIComponent(apiKey)}`
                const s0req = https.request({ hostname: baseHost, path: season0Path, method: 'GET', headers: { 'Accept': 'application/json' }, timeout: 5000 }, (sres) => {
                  let sb = ''
                  sres.on('data', d => sb += d)
                  sres.on('end', () => {
                    let s0 = null
                    try { s0 = JSON.parse(sb || '{}') } catch (e) { s0 = null }
                    const specials = s0 && s0.episodes ? s0.episodes : null
                    if (specials && Array.isArray(specials) && specials.length > 0) {
                      try {
                        const reqEpStr = String(opts.episode || '')
                        const reqNum = Number(reqEpStr)
                        const floorNum = isNaN(reqNum) ? null : Math.floor(reqNum)
                        // Try to match by exact episode_number (including integer fallback)
                        let match = null
                        if (!isNaN(reqNum)) {
                          match = specials.find(e => Number(e.episode_number) === reqNum) || specials.find(e => Number(e.episode_number) === floorNum)
                        }
                        // Try matching by air_date if episode endpoint returned an air_date
                        if (!match && ej && ej.air_date) match = specials.find(e => e.air_date === ej.air_date)
                        if (match) return cb({ provider: 'tmdb', id, type: 'tv', name: hit.name || hit.original_name || hit.title, raw: Object.assign({}, hit, { specials }), episode: match })
                      } catch (e) { /* ignore matching errors */ }
                    }

                    // Fallback 2: if the requested episode had a decimal (e.g., 11.5), try integer episode lookup (floor)
                    try {
                      const reqEpStr2 = String(opts.episode || '')
                      const reqNum2 = Number(reqEpStr2)
                      if (!isNaN(reqNum2) && String(reqEpStr2).indexOf('.') !== -1) {
                        const intEp = Math.floor(reqNum2)
                        const intPath = `/3/tv/${id}/season/${encodeURIComponent(opts.season)}/episode/${encodeURIComponent(intEp)}?api_key=${encodeURIComponent(apiKey)}`
                        const ir = https.request({ hostname: baseHost, path: intPath, method: 'GET', headers: { 'Accept': 'application/json' }, timeout: 5000 }, (ires) => {
                          let ib = ''
                          ires.on('data', d => ib += d)
                          ires.on('end', () => {
                            try {
                              const ij = JSON.parse(ib || '{}')
                              if (ij && ij.name) return cb({ provider: 'tmdb', id, type: 'tv', name: hit.name || hit.original_name || hit.title, raw: hit, episode: ij })
                            } catch (e) {}
                            // fall through to generic series-level response
                            return cb({ provider: 'tmdb', id, type: mediaType, name: hit.name || hit.original_name || hit.title, raw: Object.assign({}, hit, { specials }) })
                          })
                        })
                        ir.on('error', () => cb({ provider: 'tmdb', id, type: mediaType, name: hit.name || hit.original_name || hit.title, raw: Object.assign({}, hit, { specials }) }))
                        ir.on('timeout', () => { ir.destroy(); cb({ provider: 'tmdb', id, type: mediaType, name: hit.name || hit.original_name || hit.title, raw: Object.assign({}, hit, { specials }) }) })
                        ir.end()
                        return
                      }
                    } catch (e) { /* ignore */ }

                    // Nothing matched: return series-level hit but include specials list for downstream heuristics
                        // attach per-season air date when available before returning
                        try {
                          const seasonNum = opts && (opts.season != null) ? opts.season : null
                          if (seasonNum != null) {
                            const seasonPath = `/3/tv/${id}/season/${encodeURIComponent(seasonNum)}?api_key=${encodeURIComponent(apiKey)}`
                            const sreq = https.request({ hostname: baseHost, path: seasonPath, method: 'GET', headers: { 'Accept': 'application/json' }, timeout: 5000 }, (sres) => {
                              let sb2 = ''
                              sres.on('data', d => sb2 += d)
                              sres.on('end', () => {
                                try {
                                  const sj = JSON.parse(sb2 || '{}')
                                  // TMDb season object may include an air_date or episodes[].air_date — pick earliest
                                  let seasonAir = sj.air_date || null
                                  try {
                                    if (!seasonAir && sj.episodes && Array.isArray(sj.episodes) && sj.episodes.length) {
                                      const dates = sj.episodes.map(e => e && e.air_date).filter(Boolean)
                                      if (dates.length) seasonAir = dates.sort()[0]
                                    }
                                  } catch (e) {}
                                  const rawWithSeason = Object.assign({}, hit, { specials })
                                  if (seasonAir) rawWithSeason.seasonAirDate = seasonAir
                                  return cb({ provider: 'tmdb', id, type: mediaType, name: hit.name || hit.original_name || hit.title, raw: rawWithSeason })
                                } catch (e) { return cb({ provider: 'tmdb', id, type: mediaType, name: hit.name || hit.original_name || hit.title, raw: Object.assign({}, hit, { specials }) }) }
                              })
                            })
                            sreq.on('error', () => cb({ provider: 'tmdb', id, type: mediaType, name: hit.name || hit.original_name || hit.title, raw: Object.assign({}, hit, { specials }) }))
                            sreq.on('timeout', () => { sreq.destroy(); cb({ provider: 'tmdb', id, type: mediaType, name: hit.name || hit.original_name || hit.title, raw: Object.assign({}, hit, { specials }) }) })
                            sreq.end()
                            return
                          }
                        } catch (e) { /* fallthrough */ }
                        return cb({ provider: 'tmdb', id, type: mediaType, name: hit.name || hit.original_name || hit.title, raw: Object.assign({}, hit, { specials }) })
                  })
                })
                s0req.on('error', () => cb({ provider: 'tmdb', id, type: mediaType, name: hit.name || hit.original_name || hit.title, raw: hit }))
                s0req.on('timeout', () => { s0req.destroy(); cb({ provider: 'tmdb', id, type: mediaType, name: hit.name || hit.original_name || hit.title, raw: hit }) })
                s0req.end()
              })
            })
            er.on('error', () => cb({ provider: 'tmdb', id, type: mediaType, name: hit.name || hit.original_name || hit.title, raw: hit }))
            er.on('timeout', () => { er.destroy(); cb({ provider: 'tmdb', id, type: mediaType, name: hit.name || hit.original_name || hit.title, raw: hit }) })
            er.end()
            return
          }
          // If caller requested season (but not episode), try to attach season air date for accurate season year
          try {
            if (mediaType === 'tv' && opts && (opts.season != null) && apiKey) {
              const seasonNum2 = opts.season
              const seasonPath2 = `/3/tv/${id}/season/${encodeURIComponent(seasonNum2)}?api_key=${encodeURIComponent(apiKey)}`
              const sreq2 = https.request({ hostname: baseHost, path: seasonPath2, method: 'GET', headers: { 'Accept': 'application/json' }, timeout: 5000 }, (sres2) => {
                let sb3 = ''
                sres2.on('data', d => sb3 += d)
                sres2.on('end', () => {
                  try {
                    const sj2 = JSON.parse(sb3 || '{}')
                    let seasonAir2 = sj2.air_date || null
                    try {
                      if (!seasonAir2 && sj2.episodes && Array.isArray(sj2.episodes) && sj2.episodes.length) {
                        const dates2 = sj2.episodes.map(e => e && e.air_date).filter(Boolean)
                        if (dates2.length) seasonAir2 = dates2.sort()[0]
                      }
                    } catch (e) {}
                    const rawWithSeason2 = Object.assign({}, hit)
                    if (seasonAir2) rawWithSeason2.seasonAirDate = seasonAir2
                    return cb({ provider: 'tmdb', id, type: mediaType, name: hit.name || hit.original_name || hit.title, raw: rawWithSeason2 })
                  } catch (e) { return cb({ provider: 'tmdb', id, type: mediaType, name: hit.name || hit.original_name || hit.title, raw: hit }) }
                })
              })
              sreq2.on('error', () => cb({ provider: 'tmdb', id, type: mediaType, name: hit.name || hit.original_name || hit.title, raw: hit }))
              sreq2.on('timeout', () => { sreq2.destroy(); cb({ provider: 'tmdb', id, type: mediaType, name: hit.name || hit.original_name || hit.title, raw: hit }) })
              sreq2.end()
              return
            }
          } catch (e) { /* ignore */ }
          return cb({ provider: 'tmdb', id, type: mediaType, name: hit.name || hit.original_name || hit.title, raw: hit })
        } catch (e) { return cb(null) }
      }
      tryOne(0)
    }

    const variants = makeVariants(title)
    // TMDb: try variants against TMDb and return first match; if TMDb fails, try Kitsu as a fallback
    tryTmdbVariants(variants, (tRes) => {
      if (tRes) return resolve({ name: tRes.name, raw: Object.assign({}, tRes.raw, { id: tRes.id, type: tRes.type || tRes.mediaType || 'tv', source: 'tmdb' }), episode: tRes.episode || null })

      // Kitsu fallback
      function tryKitsuVariants(variantsK, cbK) {
        const baseHostK = 'kitsu.io'
        const tryOneK = (iK) => {
          if (iK >= variantsK.length) return cbK(null);
          const qk = encodeURIComponent(variantsK[iK]);
          const searchPathK = `/api/edge/anime?filter[text]=${qk}`;
          const reqK = https.request({ hostname: baseHostK, path: searchPathK, method: 'GET', headers: { 'Accept': 'application/vnd.api+json' }, timeout: 5000 }, (resK) => {
            let sbk = '';
            resK.on('data', d => sbk += d);
            resK.on('end', () => {
              try {
                const jk = JSON.parse(sbk || '{}');
                const hitsK = jk && jk.data ? jk.data : [];
                appendLog(`META_KITSU_ATTEMPT q=${variantsK[iK]} results=${hitsK.length}`);
                if (hitsK && hitsK.length > 0) {
                  const hit = hitsK[0];
                  const id = hit.id;
                  const attrs = hit.attributes || {};
                  const animeTitle = attrs.canonicalTitle || (attrs.titles && (attrs.titles.en || attrs.titles.en_jp)) || attrs.slug || variantsK[iK];
                  // if episode requested, attempt episode lookup via episodes endpoint
                  if (opts && opts.episode != null) {
                    const epNum = String(opts.episode);
                    const epPath = `/api/edge/episodes?filter[anime]=${encodeURIComponent(id)}&filter[number]=${encodeURIComponent(epNum)}`;
                    const epReq = https.request({ hostname: baseHostK, path: epPath, method: 'GET', headers: { 'Accept': 'application/vnd.api+json' }, timeout: 5000 }, (epRes) => {
                      let ebk = '';
                      epRes.on('data', d => ebk += d);
                      epRes.on('end', () => {
                        try {
                          const ejk = JSON.parse(ebk || '{}');
                          const epHits = ejk && ejk.data ? ejk.data : [];
                          if (epHits && epHits.length > 0) {
                            const ep = epHits[0];
                            const epAttrs = ep.attributes || {};
                            return cbK({ provider: 'kitsu', id, type: 'tv', name: animeTitle, raw: Object.assign({}, hit, { episodes: epHits }), episode: { number: epAttrs.number || epAttrs.absoluteNumber || opts.episode, title: epAttrs.canonicalTitle || (epAttrs.titles && (epAttrs.titles.en || epAttrs.titles.en_jp)) || '' } });
                          }
                        } catch (e) {}
                        // no episode match found, return series-level hit
                        return cbK({ provider: 'kitsu', id, type: 'tv', name: animeTitle, raw: hit, episode: null });
                      });
                    });
                    epReq.on('error', () => { return cbK({ provider: 'kitsu', id, type: 'tv', name: animeTitle, raw: hit, episode: null }); });
                    epReq.on('timeout', () => { epReq.destroy(); return cbK({ provider: 'kitsu', id, type: 'tv', name: animeTitle, raw: hit, episode: null }); });
                    epReq.end();
                    return;
                  }
                  return cbK({ provider: 'kitsu', id, type: 'tv', name: animeTitle, raw: hit, episode: null });
                }
              } catch (e) { /* ignore */ }
              setImmediate(() => tryOneK(iK + 1));
            });
          });
          reqK.on('error', () => setImmediate(() => tryOneK(iK + 1)));
          reqK.on('timeout', () => { reqK.destroy(); setImmediate(() => tryOneK(iK + 1)); });
          reqK.end();
        }
        tryOneK(0)
      }

      tryKitsuVariants(variants, (kRes) => {
        if (kRes) return resolve({ name: kRes.name, raw: Object.assign({}, kRes.raw, { id: kRes.id, type: kRes.type || 'tv', source: 'kitsu' }), episode: kRes.episode || null })
        return resolve(null)
      })
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
  const res = await metaLookup(seriesName, tmdbKey, { year: parsed.year, season: normSeason, episode: normEpisode, preferredProvider, parsedEpisodeTitle: episodeTitle })
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

          // Provider block - set provider name based on raw.source (tmdb or kitsu)
          const providerName = (raw && raw.source) ? String(raw.source).toLowerCase() : 'tmdb'
          guess.provider = { matched: true, provider: providerName, id: raw.id || null, raw: raw }

          // Back-compat: populate tvdb object only when provider is TMDb (avoid mislabeling other providers)
          if (providerName === 'tmdb') {
            guess.tvdb = { matched: true, id: raw.id || null, raw: raw }
          } else {
            guess.tvdb = { matched: false }
          }

          // Year extraction from common TMDb date fields (prefer per-season air date when present)
          const dateStr = raw.seasonAirDate || raw.first_air_date || raw.release_date || raw.firstAirDate || (raw.attributes && (raw.attributes.startDate || raw.attributes.releaseDate))
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
        const key = canonicalize(it.canonicalPath);
        // If we have a parsed cache for this path, reuse it
        let parsed = parsedCache[key] || null
        if (!parsed) {
          try {
            parsed = parseFilename(base)
            // store a lightweight parse result; parsedName will be rendered below using the effective template
            parsedCache[key] = { title: parsed.title, parsedName: parsed.parsedName, season: parsed.season, episode: parsed.episode, timestamp: Date.now() }
          } catch (e) { parsed = null }
        }
        // Render the parsed-name consistently using the effective rename template
        try {
          const userTemplate = (req && req.session && req.session.username && users[req.session.username] && users[req.session.username].settings && users[req.session.username].settings.rename_template) ? users[req.session.username].settings.rename_template : null;
          const baseNameTemplate = userTemplate || serverSettings.rename_template || '{title} ({year}) - {epLabel} - {episodeTitle}';
          if (parsed) {
            // build tokens for rendering parsed name; episodeTitle intentionally empty for parsed result
            const parsedTitleRaw = parsed.title || '';
            const parsedYear = parsed.year || '';
            function pad(n){ return String(n).padStart(2,'0') }
            let parsedEpLabel = '';
            if (parsed.episodeRange) parsedEpLabel = parsed.season != null ? `S${pad(parsed.season)}E${parsed.episodeRange}` : `E${parsed.episodeRange}`
            else if (parsed.episode != null) parsedEpLabel = parsed.season != null ? `S${pad(parsed.season)}E${pad(parsed.episode)}` : `E${pad(parsed.episode)}`
            const titleToken = cleanTitleForRender(parsedTitleRaw, parsedEpLabel, '');
            const nameWithoutExtRaw = String(baseNameTemplate)
              .replace('{title}', sanitize(titleToken))
              .replace('{basename}', sanitize(path.basename(key, path.extname(key))))
              .replace('{year}', parsedYear || '')
              .replace('{epLabel}', sanitize(parsedEpLabel))
              .replace('{episodeTitle}', '')
              .replace('{season}', parsed.season != null ? String(parsed.season) : '')
              .replace('{episode}', parsed.episode != null ? String(parsed.episode) : '')
              .replace('{episodeRange}', parsed.episodeRange || '')
              .replace('{tvdbId}', '')
            const parsedRendered = String(nameWithoutExtRaw)
              .replace(/\s*\(\s*\)\s*/g, '')
              .replace(/\s*\-\s*(?:\-\s*)+/g, ' - ')
              .replace(/(^\s*\-\s*)|(\s*\-\s*$)/g, '')
              .replace(/\s{2,}/g, ' ')
              .trim();
            // persist parsed-rendered name and lightweight parse tokens
            parsedCache[key] = Object.assign({}, parsedCache[key] || {}, { title: parsed.title, parsedName: parsedRendered, season: parsed.season, episode: parsed.episode, timestamp: Date.now() })
            // store a normalized enrichment entry derived from parsing only
            try {
              const parsedBlock = { title: parsed.title, parsedName: parsedRendered, season: parsed.season, episode: parsed.episode, timestamp: Date.now() }
              enrichCache[key] = normalizeEnrichEntry(Object.assign({}, enrichCache[key] || {}, { parsed: parsedBlock, sourceId: 'parsed-cache', cachedAt: Date.now() }));
            } catch (e) { enrichCache[key] = normalizeEnrichEntry({ parsed: { title: parsed.title, parsedName: parsed.parsedName, season: parsed.season, episode: parsed.episode, timestamp: Date.now() }, sourceId: 'parsed-cache', cachedAt: Date.now() }); }
          }
        } catch (renderErr) {
          // fallback to previous behavior on any error
          const episodeTitle = userHasAuthoritativeProviderKey ? '' : ((parsed && parsed.episodeTitle) || '');
          if (parsed) {
            enrichCache[key] = Object.assign({}, enrichCache[key] || {}, { sourceId: 'local-parser', title: parsed.title, parsedName: parsed.parsedName, season: parsed.season, episode: parsed.episode, episodeTitle: episodeTitle, language: 'en', timestamp: Date.now() });
          }
        }
      } catch (e) { appendLog(`PARSE_ITEM_FAIL path=${it.canonicalPath} err=${e.message}`); }
    }
    // persist parsed cache and enrich cache
    try { writeJson(parsedCacheFile, parsedCache) } catch (e) {}
    writeJson(enrichStoreFile, enrichCache);
  } catch (e) { appendLog(`PARSE_MODULE_FAIL err=${e.message}`); }

  const artifact = { id: scanId, libraryId: libraryId || 'local', totalCount: items.length, items, generatedAt: Date.now() };
  scans[scanId] = artifact;
  writeJson(scanStoreFile, scans);
  appendLog(`SCAN_COMPLETE id=${scanId} total=${items.length}`);
  // Auto-sweep stale enrich cache entries after a scan completes
  try { const removed = sweepEnrichCache(); if (removed && removed.length) appendLog(`AUTOSWEEP_AFTER_SCAN removed=${removed.length}`); } catch (e) {}
  res.json({ scanId, totalCount: items.length });

  // Kick off a background enrichment pass for the first N items (non-blocking).
  // This will call the external provider for up to the first 12 items and cache provider-rendered names
  (async function backgroundFirstNEnrich() {
    try {
      const N = 12;
      const first = artifact.items.slice(0, N);
      // pick tvdb/tmdb key similar to other endpoints (prefer session user's key, then server)
      let tvdbKey = null;
      try {
        const username = req.session && req.session.username;
        if (username && users[username] && users[username].settings && (users[username].settings.tmdb_api_key || users[username].settings.tvdb_api_key)) tvdbKey = users[username].settings.tmdb_api_key || users[username].settings.tvdb_api_key;
        else if (serverSettings && (serverSettings.tmdb_api_key || serverSettings.tvdb_api_key)) tvdbKey = serverSettings.tmdb_api_key || serverSettings.tvdb_api_key;
      } catch (e) { tvdbKey = null }

      for (const it of first) {
        try {
          const key = canonicalize(it.canonicalPath);
          // skip if we already have authoritative provider data cached
          const existing = enrichCache[key] || null;
          // Consider a cached provider "complete" only when it has a renderedName
          // and, when it represents an episode (season/episode present), also has an episodeTitle.
          const prov = existing && existing.provider ? existing.provider : null;
          const providerComplete = prov && prov.matched && prov.renderedName && (prov.episode == null || (prov.episodeTitle && String(prov.episodeTitle).trim()));
          if (providerComplete) continue;
          const data = await externalEnrich(key, tvdbKey, { username: req.session && req.session.username });
          if (!data) continue;
          // compute provider-rendered name using effective template
          try {
            const userTemplate = (req && req.session && req.session.username && users[req.session.username] && users[req.session.username].settings && users[req.session.username].settings.rename_template) ? users[req.session.username].settings.rename_template : null;
            const baseNameTemplate = userTemplate || serverSettings.rename_template || '{title} ({year}) - {epLabel} - {episodeTitle}';
            // build tokens from provider data
            const rawTitle = data.title || '';
            const yearToken = data.year || extractYear(data, key) || '';
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
              .replace('{tvdbId}', (data.tvdb && data.tvdb.raw && (data.tvdb.raw.id || data.tvdb.raw.seriesId)) ? String(data.tvdb.raw.id || data.tvdb.raw.seriesId) : '')
            let providerRendered = String(nameWithoutExtRaw)
              .replace(/\s*\(\s*\)\s*/g, '')
              .replace(/\s*\-\s*(?:\-\s*)+/g, ' - ')
              .replace(/(^\s*\-\s*)|(\s*\-\s*$)/g, '')
              .replace(/\s{2,}/g, ' ')
              .trim();
            // ...existing code...
            // write into enrich cache: add provider block and keep parsed block intact
            try {
              const providerBlock = { title: data.title, year: data.year, season: data.season, episode: data.episode, episodeTitle: data.episodeTitle || '', raw: data.raw || data, renderedName: providerRendered, matched: !!data.title }
              try { logMissingEpisodeTitleIfNeeded(key, providerBlock) } catch (e) {}
              enrichCache[key] = normalizeEnrichEntry(Object.assign({}, enrichCache[key] || {}, { provider: providerBlock, sourceId: 'provider', cachedAt: Date.now() }));
            } catch (e) {
              enrichCache[key] = normalizeEnrichEntry(Object.assign({}, enrichCache[key] || {}, data, { providerRenderedName: providerRendered, sourceId: 'provider', cachedAt: Date.now() }));
            }
            // persist caches
            try { writeJson(enrichStoreFile, enrichCache) } catch (e) {}
          } catch (e) {
            // if provider render fails, still persist raw provider data
            enrichCache[key] = Object.assign({}, enrichCache[key] || {}, data, { cachedAt: Date.now(), sourceId: 'provider' });
            try { writeJson(enrichStoreFile, enrichCache) } catch (ee) {}
          }
        } catch (e) { appendLog(`BACKGROUND_ENRICH_FAIL path=${it.canonicalPath} err=${e.message}`); }
      }
    } catch (e) { appendLog(`BACKGROUND_FIRSTN_ENRICH_FAIL scan=${scanId} err=${e.message}`); }
  })();
});

app.get('/api/scan/:scanId', (req, res) => { const s = scans[req.params.scanId]; if (!s) return res.status(404).json({ error: 'scan not found' }); res.json({ libraryId: s.libraryId, totalCount: s.totalCount, generatedAt: s.generatedAt }); });
app.get('/api/scan/:scanId/items', (req, res) => { const s = scans[req.params.scanId]; if (!s) return res.status(404).json({ error: 'scan not found' }); const offset = parseInt(req.query.offset || '0', 10); const limit = Math.min(parseInt(req.query.limit || '50', 10), 500); const slice = s.items.slice(offset, offset + limit); res.json({ items: slice, offset, limit, total: s.totalCount }); });

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
  const { path: p, tvdb_api_key: tvdb_override, tmdb_api_key: tmdb_override, force } = req.body;
  const key = canonicalize(p || '');
  appendLog(`ENRICH_REQUEST path=${key} force=${force ? 'yes' : 'no'}`);
  try {
    // prefer existing enrichment when present and not forcing
    // Only short-circuit to cached provider if it appears to be a complete provider hit
    // (i.e. provider.matched and provider.renderedName present). If cached provider
    // data exists but lacks a renderedName (or is otherwise incomplete), allow an
    // external lookup so rescans/background refreshes can populate missing fields.
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
    // Resolve an effective provider key early so we can decide whether to short-circuit to parsed-only
    let tvdbKeyEarly = null
    try {
      if (tmdb_override) tvdbKeyEarly = tmdb_override;
      else if (tvdb_override) tvdbKeyEarly = tvdb_override;
      else if (req.session && req.session.username && users[req.session.username] && users[req.session.username].settings && (users[req.session.username].settings.tmdb_api_key || users[req.session.username].settings.tvdb_api_key)) tvdbKeyEarly = users[req.session.username].settings.tmdb_api_key || users[req.session.username].settings.tvdb_api_key;
      else if (serverSettings && (serverSettings.tmdb_api_key || serverSettings.tvdb_api_key)) tvdbKeyEarly = serverSettings.tmdb_api_key || serverSettings.tvdb_api_key;
    } catch (e) { tvdbKeyEarly = null }

    // If we have a parsedCache entry and not forcing a provider refresh, return a lightweight enrichment
    // unless an authoritative provider key is present — in that case perform an external lookup so provider results can override parsed.
    if (!force && parsedCache[key] && !tvdbKeyEarly) {
      const pc = parsedCache[key]
      const epTitle = (enrichCache[key] && enrichCache[key].provider && enrichCache[key].provider.episodeTitle) ? enrichCache[key].provider.episodeTitle : ''
      // build normalized entry
      const parsedBlock = { title: pc.title, parsedName: pc.parsedName, season: pc.season, episode: pc.episode, timestamp: Date.now() }
      const providerBlock = (enrichCache[key] && enrichCache[key].provider) ? enrichCache[key].provider : null
      const normalized = normalizeEnrichEntry(Object.assign({}, enrichCache[key] || {}, { parsed: parsedBlock, provider: providerBlock, sourceId: 'parsed-cache', cachedAt: Date.now() }));
      enrichCache[key] = normalized
      try { writeJson(enrichStoreFile, enrichCache) } catch (e) {}
      return res.json({ parsed: normalized.parsed || null, provider: normalized.provider || null })
    }

    // otherwise perform authoritative external enrich (used by rescan/force)
    let tvdbKey = null
    try {
      if (tmdb_override) tvdbKey = tmdb_override;
      else if (tvdb_override) tvdbKey = tvdb_override;
      else if (req.session && req.session.username && users[req.session.username] && users[req.session.username].settings && (users[req.session.username].settings.tmdb_api_key || users[req.session.username].settings.tvdb_api_key)) tvdbKey = users[req.session.username].settings.tmdb_api_key || users[req.session.username].settings.tvdb_api_key;
      else if (serverSettings && (serverSettings.tmdb_api_key || serverSettings.tvdb_api_key)) tvdbKey = serverSettings.tmdb_api_key || serverSettings.tvdb_api_key;
    } catch (e) { tvdbKey = null }
    const data = await externalEnrich(key, tvdbKey, { username: req.session && req.session.username });
    // compute provider-rendered name using effective template so provider results can override parsed display
    try {
      const userTemplate = (req && req.session && req.session.username && users[req.session.username] && users[req.session.username].settings && users[req.session.username].settings.rename_template) ? users[req.session.username].settings.rename_template : null;
      const baseNameTemplate = userTemplate || serverSettings.rename_template || '{title} ({year}) - {epLabel} - {episodeTitle}';
      const rawTitle = data.title || '';
      const yearToken = data.year || extractYear(data, key) || '';
      function pad(n){ return String(n).padStart(2,'0') }
      let epLabel = '';
      if (data.episodeRange) epLabel = data.season != null ? `S${pad(data.season)}E${data.episodeRange}` : `E${data.episodeRange}`
      else if (data.episode != null) epLabel = data.season != null ? `S${pad(data.season)}E${pad(data.episode)}` : `E${pad(data.episode)}`
  // determine fallback episodeTitle: prefer parsedCache, otherwise guess from filename
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
        .replace('{tvdbId}', (data.tvdb && data.tvdb.raw && (data.tvdb.raw.id || data.tvdb.raw.seriesId)) ? String(data.tvdb.raw.id || data.tvdb.raw.seriesId) : '')
      let providerRendered = String(nameWithoutExtRaw)
        .replace(/\s*\(\s*\)\s*/g, '')
        .replace(/\s*\-\s*(?:\-\s*)+/g, ' - ')
        .replace(/(^\s*\-\s*)|(\s*\-\s*$)/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
  // ...existing code...
      // attach normalized provider block
  const providerBlock = { title: data.title, year: data.year, season: data.season, episode: data.episode, episodeTitle: data.episodeTitle || '', raw: data.raw || data, renderedName: providerRendered, matched: !!data.title };
  try { logMissingEpisodeTitleIfNeeded(key, providerBlock) } catch (e) {}
  enrichCache[key] = normalizeEnrichEntry(Object.assign({}, enrichCache[key] || {}, { provider: providerBlock, sourceId: 'provider', cachedAt: Date.now() }));
    } catch (e) {
      enrichCache[key] = { ...data, cachedAt: Date.now() };
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
        writeJson(parsedCacheFile, parsedCache)
      }
    } catch (e) {}
    writeJson(enrichStoreFile, enrichCache);
    appendLog(`ENRICH_SUCCESS path=${key}`);
    res.json({ enrichment: enrichCache[key] });
  } catch (err) { appendLog(`ENRICH_FAIL path=${key} err=${err.message}`); res.status(500).json({ error: err.message }); }
});

// Hide a source item (mark hidden=true on the source canonical key)
app.post('/api/enrich/hide', requireAuth, async (req, res) => {
  try {
    const p = req.body && req.body.path ? req.body.path : null
    if (!p) return res.status(400).json({ error: 'path required' })
    const key = canonicalize(p)
    enrichCache[key] = enrichCache[key] || {}
    enrichCache[key].hidden = true
    writeJson(enrichStoreFile, enrichCache)
    appendLog(`HIDE path=${p}`)
    return res.json({ ok: true, path: key })
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
      } catch (e) { /* ignore per-key errors */ }
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

    // persist changes
    try { writeJson(enrichStoreFile, enrichCache) } catch (e) {}
    try { writeJson(renderedIndexFile, renderedIndex) } catch (e) {}
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
      // Treat cached provider as authoritative only when it's fully rendered (renderedName present)
      // and, for episode items, an episodeTitle is present. Otherwise perform an external lookup.
      const provEx = existing && existing.provider ? existing.provider : null;
      const providerCompleteEx = provEx && provEx.matched && provEx.renderedName && (provEx.episode == null || (provEx.episodeTitle && String(provEx.episodeTitle).trim()));
      if (providerCompleteEx && (!provEx.provider || String(provEx.provider).toLowerCase() === 'tmdb')) {
        data = existing
      } else {
        data = await externalEnrich(key, tvdbKey, { username });
      }
      // compute provider-rendered name and store normalized provider block when we have provider data
      try {
        if (data && data.title) {
          const userTemplate = (username && users[username] && users[username].settings && users[username].settings.rename_template) ? users[username].settings.rename_template : null;
          const baseNameTemplate = userTemplate || serverSettings.rename_template || '{title} ({year}) - {epLabel} - {episodeTitle}';
          const rawTitle = data.title || '';
          const yearToken = data.year || extractYear(data, key) || '';
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
            .replace('{tvdbId}', (data.tvdb && data.tvdb.raw && (data.tvdb.raw.id || data.tvdb.raw.seriesId)) ? String(data.tvdb.raw.id || data.tvdb.raw.seriesId) : '')
          let providerRendered = String(nameWithoutExtRaw)
            .replace(/\s*\(\s*\)\s*/g, '')
            .replace(/\s*\-\s*(?:\-\s*)+/g, ' - ')
            .replace(/(^\s*\-\s*)|(\s*\-\s*$)/g, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
          // ...existing code...
          const providerBlock = { title: data.title, year: data.year, season: data.season, episode: data.episode, episodeTitle: data.episodeTitle || '', raw: data.raw || data, renderedName: providerRendered, matched: !!data.title };
          try { logMissingEpisodeTitleIfNeeded(key, providerBlock) } catch (e) {}
          enrichCache[key] = normalizeEnrichEntry(Object.assign({}, enrichCache[key] || {}, { provider: providerBlock, sourceId: 'provider', cachedAt: Date.now() }));
        } else {
          enrichCache[key] = { ...data, cachedAt: Date.now() };
        }
      } catch (e) {
        enrichCache[key] = { ...data, cachedAt: Date.now() };
      }
      results.push({ path: key, ok: true, parsedName: data.parsedName, title: data.title });
      appendLog(`REFRESH_ITEM_OK path=${key} parsedName=${data.parsedName}`);
    } catch (err) {
      appendLog(`REFRESH_ITEM_FAIL path=${it.canonicalPath} err=${err.message}`);
      results.push({ path: it.canonicalPath, ok: false, error: err.message });
    }
  }
  writeJson(enrichStoreFile, enrichCache);
  appendLog(`REFRESH_SCAN_COMPLETE scan=${req.params.scanId} items=${results.length}`);
  // Auto-sweep stale enrich cache entries after a refresh completes
  try { const removed2 = sweepEnrichCache(); if (removed2 && removed2.length) appendLog(`AUTOSWEEP_AFTER_REFRESH removed=${removed2.length}`); } catch (e) {}
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
    const meta = enrichCache[fromPath] || {};
  // prefer enrichment title (provider token) -> parsed/title/basename
  const rawTitle = (meta && (meta.title || (meta.extraGuess && meta.extraGuess.title))) ? (meta.title || (meta.extraGuess && meta.extraGuess.title)) : path.basename(fromPath, path.extname(fromPath));
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
      epLabel = meta.season != null ? `S${pad(meta.season)}E${pad(meta.episode)}` : `E${pad(meta.episode)}`
    }
  const episodeTitleToken = (meta && (meta.episodeTitle || (meta.extraGuess && meta.extraGuess.episodeTitle))) ? (meta.episodeTitle || (meta.extraGuess && meta.extraGuess.episodeTitle)) : ''

    // Support extra template tokens: {season}, {episode}, {episodeRange}, {tvdbId}
    const seasonToken = (meta && meta.season != null) ? String(meta.season) : ''
    const episodeToken = (meta && meta.episode != null) ? String(meta.episode) : ''
    const episodeRangeToken = (meta && meta.episodeRange) ? String(meta.episodeRange) : ''
    const tvdbIdToken = (meta && meta.tvdb && meta.tvdb.raw && (meta.tvdb.raw.id || meta.tvdb.raw.seriesId)) ? String(meta.tvdb.raw.id || meta.tvdb.raw.seriesId) : ''

  // Build title token from provider/parsed tokens and clean it for render.
  const episodeTitleTokenFromMeta = (meta && (meta.episodeTitle || (meta.extraGuess && meta.extraGuess.episodeTitle))) ? (meta.episodeTitle || (meta.extraGuess && meta.extraGuess.episodeTitle)) : ''
  const title = cleanTitleForRender(rawTitle, (meta && meta.episode != null) ? (meta.season != null ? `S${String(meta.season).padStart(2,'0')}E${String(meta.episode).padStart(2,'0')}` : `E${String(meta.episode).padStart(2,'0')}`) : '', episodeTitleTokenFromMeta);

  // Render template with preferência to enrichment-provided tokens.
  // If the provider returned a renderedName (TMDb), prefer that exact rendered string for preview.
  let nameWithoutExtRaw;
  if (meta && meta.provider && meta.provider.renderedName) {
    // strip any extension the provider might include and use the provider-rendered name verbatim
    nameWithoutExtRaw = String(meta.provider.renderedName).replace(/\.[^/.]+$/, '');
  } else {
    nameWithoutExtRaw = baseNameTemplate
      .replace('{title}', sanitize(title))
      .replace('{basename}', sanitize(path.basename(fromPath, ext)))
      .replace('{year}', year || '')
      .replace('{epLabel}', sanitize(epLabel))
      .replace('{episodeTitle}', sanitize(episodeTitleToken))
      .replace('{season}', sanitize(seasonToken))
      .replace('{episode}', sanitize(episodeToken))
      .replace('{episodeRange}', sanitize(episodeRangeToken))
      .replace('{tvdbId}', sanitize(tvdbIdToken));
  }
    // Clean up common artifact patterns from empty tokens: stray parentheses, repeated separators
    const nameWithoutExt = String(nameWithoutExtRaw)
      .replace(/\s*\(\s*\)\s*/g, '') // remove empty ()
      .replace(/\s*\-\s*(?:\-\s*)+/g, ' - ') // collapse repeated dashes
      .replace(/(^\s*-\s*)|(\s*-\s*$)/g, '') // trim leading/trailing dashes
      .replace(/\s{2,}/g, ' ') // collapse multiple spaces
      .trim();
    const fileName = (nameWithoutExt + ext).trim();
  // If an output path is configured, plan a symlink under that path preserving a Jellyfin-friendly layout
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
  const action = effectiveOutput ? 'symlink' : (fromPath === toPath ? 'noop' : 'move');
  return { itemId: it.id, fromPath, toPath, actions: [{ op: action }], templateUsed: baseNameTemplate };
  });
  res.json({ plans });
});

function sanitize(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, '');
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
    s = s.replace(/^\s*S\d{1,2}[\s_\-:\.]*[EPp]?\d{1,3}(?:\.\d+)?[\s_\-:\.]*/i, '').trim();
    if (epTitle) {
      const et = String(epTitle).trim();
      if (et) s = s.replace(new RegExp('[\-–—:\\s]*' + escapeRegExp(et) + '$', 'i'), '').trim();
    }
    s = s.replace(/^[\-–—:\s]+|[\-–—:\s]+$/g, '').trim();
  } catch (e) { /* best-effort */ }
  return s || String(t).trim();
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
    try { writeJson(enrichStoreFile, enrichCache) } catch (e) {}
    try { writeJson(renderedIndexFile, renderedIndex) } catch (e) {}
    if (removed.length) appendLog(`ENRICH_SWEEP_AUTO removed=${removed.length}`);
  } catch (e) { appendLog('ENRICH_SWEEP_ERR ' + (e && e.message ? e.message : String(e))) }
  return removed;
}

// ...existing code...

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
        // Determine if this plan explicitly requested a symlink (preview sets actions: [{op:'symlink'}])
        const requestedSymlink = (p.actions && Array.isArray(p.actions) && p.actions[0] && p.actions[0].op === 'symlink') || false
        const targetUnderConfiguredOut = configuredOut && toResolved.startsWith(path.resolve(configuredOut))
  // If the plan explicitly requested a symlink, require a configured output path; never create symlink into the input folder
  if (requestedSymlink && !configuredOut) {
    appendLog(`SYMLINK_FAIL_NO_OUTPUT from=${from} requestedSymlink=true`);
    throw new Error('Symlink requested but no configured output path found. Set scan_output_path in settings.');
  }
  if (requestedSymlink || targetUnderConfiguredOut) {
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
                epLabel2 = enrichment.season != null ? `S${pad(enrichment.season)}E${pad(enrichment.episode)}` : `E${pad(enrichment.episode)}`
              }
              const episodeTitleToken2 = enrichment && (enrichment.episodeTitle || (enrichment.extraGuess && enrichment.extraGuess.episodeTitle)) ? (enrichment.episodeTitle || (enrichment.extraGuess && enrichment.extraGuess.episodeTitle)) : ''
              const seasonToken2 = (enrichment && enrichment.season != null) ? String(enrichment.season) : ''
              const episodeToken2 = (enrichment && enrichment.episode != null) ? String(enrichment.episode) : ''
              const episodeRangeToken2 = (enrichment && enrichment.episodeRange) ? String(enrichment.episodeRange) : ''
              const tvdbIdToken2 = (enrichment && enrichment.tvdb && enrichment.tvdb.raw && (enrichment.tvdb.raw.id || enrichment.tvdb.raw.seriesId)) ? String(enrichment.tvdb.raw.id || enrichment.tvdb.raw.seriesId) : ''
              const rawTitle2 = (enrichment && (enrichment.title || (enrichment.extraGuess && enrichment.extraGuess.title))) ? (enrichment.title || (enrichment.extraGuess && enrichment.extraGuess.title)) : path.basename(from, ext2)
              // reuse cleaning logic from preview to avoid duplicated episode labels/titles in rendered filenames
              const titleToken2 = cleanTitleForRender(rawTitle2, (enrichment && enrichment.episode != null) ? (enrichment.season != null ? `S${String(enrichment.season).padStart(2,'0')}E${String(enrichment.episode).padStart(2,'0')}` : `E${String(enrichment.episode).padStart(2,'0')}`) : '', (enrichment && (enrichment.episodeTitle || (enrichment.extraGuess && enrichment.extraGuess.episodeTitle))) ? (enrichment.episodeTitle || (enrichment.extraGuess && enrichment.extraGuess.episodeTitle)) : '');
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
              let finalFileName2 = (nameWithoutExt2 + ext2).trim();
              // If provider rendered name exists, prefer it exactly for both folder and filename
              let newToResolved;
              if (enrichment && enrichment.provider && enrichment.provider.renderedName) {
                // use provider tokens to construct the desired layout without hard-coding
                const prov = enrichment.provider || {};
                const provYear = prov.year || extractYear(prov, from) || '';
                const titleFolder = sanitize(String(prov.title || prov.renderedName || path.basename(from, ext2)).trim() + (provYear ? ` (${provYear})` : ''));
                if (!configuredOut) {
                  appendLog(`SYMLINK_WARN no configured output path for from=${from} provider=${prov.renderedName}`);
                }
                // resolve final base output in order: explicit per-plan outputPath -> per-user configured -> server setting
                const planOut = (p && p.outputPath) ? p.outputPath : null;
                const resolvedConfigured = planOut || configuredOut || serverSettings && serverSettings.scan_output_path ? (planOut || configuredOut || serverSettings.scan_output_path) : null;
                const baseOut = resolvedConfigured ? path.resolve(resolvedConfigured) : null;
                // Diagnostic: log resolved output path and targets to aid debugging when links end up under input
                try { appendLog(`SYMLINK_CONFIG from=${from} configuredOut=${configuredOut || ''} planOut=${planOut || ''} baseOut=${baseOut || ''} toResolved=${toResolved || ''}`); } catch (e) {}
                if (!baseOut) {
                  appendLog(`SYMLINK_FAIL_NO_OUTPUT from=${from} provider=${prov.renderedName || prov.title || ''}`);
                  throw new Error('No configured output path (user, plan, or server) — cannot symlink without an output path. Set scan_output_path in settings.');
                }
                // Movie vs Series detection: presence of season/episode indicates series
                const isSeries = (prov.season != null) || (prov.episode != null);
                if (isSeries) {
                  const seasonNum = prov.season != null ? String(prov.season) : '1';
                  const seasonFolder = `Season ${String(seasonNum).padStart(2,'0')}`;
                  const seriesRenderedRaw = String(prov.renderedName || prov.title || prov.name || '').trim();
                  let seriesFolderBase = seriesRenderedRaw.replace(/\.[^/.]+$/, '');
                  const sMatch = seriesFolderBase.search(/\s-\sS\d{1,2}E\d{1,3}/);
                  if (sMatch !== -1) seriesFolderBase = seriesFolderBase.slice(0, sMatch).trim();
                  if (!seriesFolderBase) seriesFolderBase = String(prov.title || '').trim() + (prov.year ? ` (${prov.year})` : '');
                  if (prov.year && seriesFolderBase.indexOf(`(${prov.year})`) === -1) seriesFolderBase = seriesFolderBase + ` (${prov.year})`;
                  const dir = path.join(baseOut, sanitize(seriesFolderBase), seasonFolder);
                  const filenameBase = sanitize(seriesRenderedRaw);
                  finalFileName2 = (filenameBase + ext2).trim();
                  newToResolved = path.join(dir, finalFileName2);
                } else {
                  const movieBase = sanitize(String(prov.title || prov.renderedName || path.basename(from, ext2)).trim() + (provYear ? ` (${provYear})` : ''));
                  finalFileName2 = (movieBase + ext2).trim();
                  const dir = path.join(baseOut, movieBase);
                  newToResolved = path.join(dir, finalFileName2);
                }
              }
              // ensure directory exists
              const ensureDir = path.dirname(newToResolved);
              if (!fs.existsSync(ensureDir)) fs.mkdirSync(ensureDir, { recursive: true });
              // assign for subsequent operations
              // prefer the rendered name if target path differs
              var effectiveToResolved = newToResolved;
              // helper to create symlink preferring a relative target when possible
              function createSymlinkPreferRelative(srcPath, linkPath) {
                try {
                  const rel = path.relative(path.dirname(linkPath), srcPath);
                  // If relative path is shorter and doesn't ascend outside root too strangely, try it first
                  try {
                    fs.symlinkSync(rel, linkPath, 'file');
                    appendLog(`SYMLINK_TARGET_USED link=${linkPath} target=${rel}`);
                    return;
                  } catch (e) {
                    // fallback to absolute
                  }
                  try { fs.symlinkSync(srcPath, linkPath, 'file'); appendLog(`SYMLINK_TARGET_USED link=${linkPath} target=${srcPath}`); return; } catch (e2) { throw e2 }
                } catch (e) { throw e }
              }
            } catch (renderErr) {
              // fallback to original toResolved
              var effectiveToResolved = toResolved;
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

              // Defensive: never create provider-driven symlinks inside the configured input path
            try {
              if (configuredInput) {
                const inpResolved = path.resolve(configuredInput);
                if (String(effectiveToResolved || '').startsWith(inpResolved)) {
                  appendLog(`SYMLINK_REFUSE_INPUT from=${from} to=${effectiveToResolved} configuredInput=${inpResolved}`);
                  throw new Error('Refusing to create symlink inside configured input path');
                }
              }
            } catch (e) { throw e }
              if (!fs.existsSync(effectiveToResolved)) {
              try {
                createSymlinkPreferRelative(from, effectiveToResolved)
                resultsItem.status = 'symlinked';
                resultsItem.to = effectiveToResolved;
                appendLog(`SYMLINK_OK from=${from} to=${effectiveToResolved}`);
              } catch (linkErr) {
                appendLog(`SYMLINK_FAIL from=${from} to=${effectiveToResolved} linkErr=${linkErr && linkErr.message ? linkErr.message : String(linkErr)}`);
                throw linkErr;
              }
            } else {
              // target already exists
              resultsItem.status = 'exists';
              resultsItem.to = effectiveToResolved;
              appendLog(`SYMLINK_SKIP_EXISTS to=${effectiveToResolved}`);
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
              writeJson(enrichStoreFile, enrichCache);
              try { writeJson(renderedIndexFile, renderedIndex) } catch (e) {}
            } catch (e) { appendLog(`SYMLINK_MARK_FAIL from=${from} err=${e.message}`) }
          } catch (err) {
            // bubble up to outer error handler
            throw err
          }
        } else {
          // default behavior: preserve original file; attempt to symlink into target
          try {
            const toDir2 = path.dirname(to);
            if (!fs.existsSync(toDir2)) fs.mkdirSync(toDir2, { recursive: true });
            if (!fs.existsSync(to)) {
              // fail early if cross-device (hardlinks won't work across mounts) — diagnostic only
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
                    appendLog(`SYMLINK_CROSS_DEVICE from=${from} to=${to}`);
                    // Symlinks can cross devices but the filesystem/stat info indicated different devs; still allow symlink attempt
                  }
                }
              } catch (e) {
                // if we couldn't stat, proceed and let linkSync surface the error
              }
              // Defensive: refuse symlink into configured input root
              try {
                if (configuredInput) {
                  const inpResolved2 = path.resolve(configuredInput);
                  const toResolved2 = path.resolve(to);
                  if (String(toResolved2).startsWith(inpResolved2)) {
                    appendLog(`SYMLINK_REFUSE_INPUT from=${from} to=${toResolved2} configuredInput=${inpResolved2}`);
                    throw new Error('Refusing to create symlink inside configured input path');
                  }
                }
              } catch (e) { throw e }
              try {
                // create using helper that prefers relative targets
                function createSymlinkPreferRelative(srcPath, linkPath) {
                  try {
                    const rel = path.relative(path.dirname(linkPath), srcPath);
                    try { fs.symlinkSync(rel, linkPath, 'file'); appendLog(`SYMLINK_TARGET_USED link=${linkPath} target=${rel}`); return; } catch (e) {}
                    try { fs.symlinkSync(srcPath, linkPath, 'file'); appendLog(`SYMLINK_TARGET_USED link=${linkPath} target=${srcPath}`); return; } catch (e2) { throw e2 }
                  } catch (e) { throw e }
                }
                createSymlinkPreferRelative(from, to)
                resultsItem.status = 'symlinked';
                resultsItem.to = to;
                appendLog(`SYMLINK_OK from=${from} to=${to}`);
              } catch (linkErr2) {
                appendLog(`SYMLINK_FAIL from=${from} to=${to} linkErr=${linkErr2 && linkErr2.message ? linkErr2.message : String(linkErr2)}`);
                throw linkErr2;
              }
            } else {
              resultsItem.status = 'exists';
              resultsItem.to = to;
              appendLog(`SYMLINK_SKIP_EXISTS to=${to}`);
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
              writeJson(enrichStoreFile, enrichCache);
              try { writeJson(renderedIndexFile, renderedIndex) } catch (e) {}
            } catch (e) { appendLog(`SYMLINK_MARK_FAIL from=${from} err=${e.message}`) }
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
