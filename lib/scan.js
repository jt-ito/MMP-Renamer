const fs = require('fs');
const path = require('path');

function defaultCanonicalize(p) { return path.resolve(p).replace(/\\/g, '/'); }

function fullScanLibrary(libPath, opts = {}) {
  const videoExts = opts.videoExts || ['mkv','mp4','avi','mov','m4v','mpg','mpeg','webm','wmv','flv','ts','ogg','ogv','3gp','3g2'];
  const ignoredDirs = opts.ignoredDirs || new Set(['node_modules', '.git', '.svn', '__pycache__']);
  const canonicalize = opts.canonicalize || defaultCanonicalize;
  const uuidv4 = opts.uuidv4 || (() => { return String(Math.random()).slice(2) });

  const extRe = new RegExp('\\.(' + videoExts.join('|') + ')$', 'i');
  const foundItems = [];
  function walk(dir) {
    let ent;
    try { ent = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ent) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const name = e.name;
        if (ignoredDirs instanceof Set ? ignoredDirs.has(name) : (Array.isArray(ignoredDirs) && ignoredDirs.indexOf(name) !== -1)) continue;
        walk(full);
      } else {
        if (extRe.test(e.name)) foundItems.push({ id: uuidv4(), canonicalPath: canonicalize(full), scannedAt: Date.now() });
      }
    }
  }
  walk(libPath);
  return foundItems;
}

function loadScanCache(scanCacheFile) {
  try { return JSON.parse(fs.readFileSync(scanCacheFile, 'utf8') || '{}') } catch (e) { return {} }
}

function saveScanCache(scanCacheFile, obj) {
  try { fs.writeFileSync(scanCacheFile, JSON.stringify(obj, null, 2), 'utf8') } catch (e) { /* ignore */ }
}

function incrementalScanLibrary(libPath, opts = {}) {
  const scanCacheFile = opts.scanCacheFile;
  const discovered = fullScanLibrary(libPath, opts);
  const currentCache = {};
  for (const it of discovered) {
    try { const st = fs.statSync(it.canonicalPath); currentCache[it.canonicalPath] = st.mtimeMs; } catch (e) { currentCache[it.canonicalPath] = Date.now(); }
  }
  const priorCache = scanCacheFile ? loadScanCache(scanCacheFile) : {};
  const toProcess = [];
  const seen = new Set();
  for (const it of discovered) {
    seen.add(it.canonicalPath);
    const priorM = priorCache[it.canonicalPath];
    const curM = currentCache[it.canonicalPath];
    if (!priorM || priorM !== curM) toProcess.push(it);
  }
  const removed = [];
  for (const pk of Object.keys(priorCache || {})) if (!seen.has(pk)) removed.push(pk);
  return { toProcess, currentCache, removed };
}

module.exports = {
  fullScanLibrary,
  incrementalScanLibrary,
  loadScanCache,
  saveScanCache,
};
