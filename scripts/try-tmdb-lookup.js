const fs = require('fs');
const path = require('path');
const https = require('https');

function readKey() {
  try {
    const users = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'users.json'), 'utf8'))
    for (const u of Object.values(users)) {
      if (u && u.settings && (u.settings.tmdb_api_key || u.settings.tvdb_api_key)) return u.settings.tmdb_api_key || u.settings.tvdb_api_key
    }
  } catch (e) {}
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'settings.json'), 'utf8'))
    if (settings && (settings.tmdb_api_key || settings.tvdb_api_key)) return settings.tmdb_api_key || settings.tvdb_api_key
  } catch (e) {}
  return process.env.TMDB_API_KEY || null
}

function readConfiguredInput() {
  // try users.json first
  try {
    const users = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'users.json'), 'utf8'))
    for (const u of Object.values(users)) {
      if (u && u.settings && u.settings.scan_input_path) return path.resolve(u.settings.scan_input_path)
    }
  } catch (e) {}
  try {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'settings.json'), 'utf8'))
    if (s && s.scan_input_path) return path.resolve(s.scan_input_path)
  } catch (e) {}
  return process.env.SCAN_INPUT_PATH || null
}

const parseFilename = require('../lib/filename-parser');

function makeVariants(title, opts={}){
  const s = String(title || '').trim();
  const variants = [];
  if (!s) return variants;
  variants.push(s);
  const cleaned = s.replace(/[._\-:]+/g, ' ').replace(/\s+/g, ' ').trim();
  variants.push(cleaned);
  const stripped = cleaned.replace(/\s*[\[(].*?[\])]/g, '').replace(/\s+/g, ' ').trim();
  if (stripped && stripped !== cleaned) variants.push(stripped);
  const words = stripped.split(/\s+/).filter(Boolean);
  if (words.length>0) variants.push(words.slice(0, Math.min(6, words.length)).join(' '));
  variants.push(stripped.toLowerCase());
  if (opts.year) {
    variants.push(stripped + ' ' + String(opts.year));
    variants.push(stripped + ' (' + String(opts.year) + ')');
  }
  return [...new Set(variants.map(v=>v.trim()).filter(Boolean))];
}

function tmdbSearch(apiKey, query, useTv){
  return new Promise((resolve,reject)=>{
    if (!apiKey) return resolve({ error: 'no_api_key' })
    const host = 'api.themoviedb.org';
    const q = encodeURIComponent(query);
    const p = useTv ? `/3/search/tv?api_key=${encodeURIComponent(apiKey)}&query=${q}` : `/3/search/multi?api_key=${encodeURIComponent(apiKey)}&query=${q}`;
    const req = https.request({ hostname: host, path: p, method: 'GET', headers: { 'Accept':'application/json' }, timeout: 8000 }, (res)=>{
      let sb=''; res.on('data', d=> sb+=d); res.on('end', ()=>{
        try { const j = JSON.parse(sb||'{}'); resolve({ results: j.results || [], statusCode: res.statusCode }); } catch(e){ resolve({ error: e.message, statusCode: res.statusCode }) }
      })
    })
    req.on('error', e=> resolve({ error: e.message }))
    req.on('timeout', ()=> { req.destroy(); resolve({ error: 'timeout' }) })
    req.end();
  })
}

function kitsuSearch(query){
  return new Promise((resolve)=>{
    const host = 'kitsu.io';
    const p = `/api/edge/anime?filter[text]=${encodeURIComponent(query)}`;
    const req = https.request({ hostname: host, path: p, method: 'GET', headers: { 'Accept': 'application/vnd.api+json' }, timeout: 8000 }, (res)=>{
      let sb=''; res.on('data', d=> sb+=d); res.on('end', ()=>{
        try { const j = JSON.parse(sb||'{}'); resolve({ results: j.data || [], statusCode: res.statusCode }); } catch(e){ resolve({ error: e.message, statusCode: res.statusCode }) }
      })
    })
    req.on('error', e=> resolve({ error: e.message }))
    req.on('timeout', ()=> { req.destroy(); resolve({ error: 'timeout' }) })
    req.end();
  })
}

async function run(targetPath){
  console.log('Target:', targetPath);
  const base = path.basename(targetPath);
  const parent = path.basename(path.dirname(targetPath));
  const parsedFile = parseFilename(base);
  const parsedParent = parseFilename(parent);
  console.log('\nParsed from filename:', parsedFile);
  console.log('\nParsed from parent folder:', parsedParent);

  const apiKey = readKey();
  console.log('\nTMDb key present:', !!apiKey);

  // Build a prioritized query list: filename title, optionally parent folder title (if parent isn't configured input root), then raw basename
  const candidates = [];
  if (parsedFile && parsedFile.title) candidates.push(parsedFile.title)

  const configuredInput = readConfiguredInput();
  const parentPath = path.resolve(path.dirname(targetPath));
  const fileDir = path.resolve(path.dirname(targetPath));
  // Only try the parent folder title when the parent isn't the configured input root, and the file is not a loose file directly in the input root
  if (parsedParent && parsedParent.title) {
    if (configuredInput) {
      const resolvedConfigured = path.resolve(configuredInput);
      if (parentPath !== resolvedConfigured) {
        candidates.push(parsedParent.title);
      }
    } else {
      // no configured input known locally; still try parent
      candidates.push(parsedParent.title);
    }
  }
  // fallback to raw basename without ext
  candidates.push(base.replace(/\.[^.]+$/, ''))

  const opts = { year: parsedFile && parsedFile.year ? parsedFile.year : undefined, season: parsedFile && parsedFile.season != null ? parsedFile.season : undefined, episode: parsedFile && parsedFile.episode != null ? parsedFile.episode : undefined }

  const tried = [];
  for (const c of candidates) {
    const vars = makeVariants(c, opts);
    for (const v of vars) {
      if (tried.includes(v)) continue; tried.push(v);
    }
  }

  console.log('\nQuery variants to try (in order):\n', tried.join('\n'));

  // Prefer TV search when we have season/episode
  const useTv = !!(opts.season != null || opts.episode != null);
  for (const q of tried) {
    console.log('\n-- TMDb search for:', q);
    const r = await tmdbSearch(apiKey, q, useTv);
    if (r.error) { console.log('  Error:', r.error); continue }
    console.log('  Results count:', (r.results && r.results.length) || 0);
    if (r.results && r.results.length) {
      console.log('  First hit:', JSON.stringify(r.results[0], null, 2));
      // stop on first hit
      return;
    }
  }

  console.log('\nNo TMDb results; trying Kitsu fallback (anime)');
  for (const q of tried) {
    console.log('\n-- Kitsu search for:', q);
    const k = await kitsuSearch(q);
    if (k.error) { console.log('  Error:', k.error); continue }
    console.log('  Results count:', (k.results && k.results.length) || 0);
    if (k.results && k.results.length) {
      console.log('  First hit:', JSON.stringify(k.results[0], null, 2));
      return;
    }
  }

  console.log('\nNo provider matches found for any variant.');
}

if (require.main === module) {
  const target = process.argv[2] || '/mnt/Tor/[Judas] Jidouhanbaiki ni Umarekawatta Ore wa Meikyuu o Samayou (Reborn as a Vending Machine, I Now Wander the Dungeon) (Season 1) [1080p][HEVC x265 10bit][Dual-Audio][Multi-Subs]/[Judas] Orejihanki - S01E01v2.mkv';
  run(target).catch(e=>{ console.error('Fatal', e); process.exit(1) })
}
