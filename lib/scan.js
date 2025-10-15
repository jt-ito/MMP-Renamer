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
        if (extRe.test(e.name)) {
          const canonical = canonicalize(full);
          let id = uuidv4();
          try { const st = fs.statSync(full); id = String(st.size || 0) + ':' + String(Math.floor(st.mtimeMs || Date.now())); } catch (e) {}
          foundItems.push({ id, canonicalPath: canonical, scannedAt: Date.now() });
        }
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
  try {
    // atomic write: write to temp file then rename
    const tmp = String(scanCacheFile) + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
    try { fs.renameSync(tmp, scanCacheFile) } catch (e) { /* fallback: try direct write */ fs.writeFileSync(scanCacheFile, JSON.stringify(obj, null, 2), 'utf8') }
  } catch (e) { /* ignore */ }
}

function incrementalScanLibrary(libPath, opts = {}) {
  const scanCacheFile = opts.scanCacheFile;
  // Load prior cache shape { files: {path:mtime}, dirs: {dir:mtime} }
  const prior = scanCacheFile ? loadScanCache(scanCacheFile) : {};
  const priorFiles = (prior && prior.files) ? prior.files : {};
  const priorDirs = (prior && prior.dirs) ? prior.dirs : {};

  const toProcess = [];
  const currentFiles = {};
  const currentDirs = {};

  // Fast-path: verify existing known files still exist and capture their mtimes and sizes and preserve ids
  for (const p of Object.keys(priorFiles || {})) {
    try {
      const priorEntry = priorFiles[p];
      const st = fs.statSync(p);
      if (st && st.mtimeMs != null) {
        currentFiles[p] = { mtime: st.mtimeMs, size: st.size, id: (priorEntry && priorEntry.id) ? priorEntry.id : String(st.size || 0) + ':' + String(Math.floor(st.mtimeMs || Date.now())) };
      }
    } catch (e) {
      // missing files will be reported as removed later
    }
  }

  // Walk the tree but skip directories whose mtime matches priorDirs (heuristic)
  const videoExts = opts.videoExts || ['mkv','mp4','avi','mov','m4v','mpg','mpeg','webm','wmv','flv','ts','ogg','ogv','3gp','3g2'];
  const ignoredDirs = opts.ignoredDirs || new Set(['node_modules', '.git', '.svn', '__pycache__']);
  const canonicalize = opts.canonicalize || (p => path.resolve(p).replace(/\\/g, '/'));
  const extRe = new RegExp('\\.(' + videoExts.join('|') + ')$', 'i');

  function walk(dir) {
    let ent;
    let dirCanonical = canonicalize(dir);
    try {
      const stDir = fs.statSync(dir);
      if (stDir && stDir.mtimeMs != null) currentDirs[dirCanonical] = stDir.mtimeMs;
      // NOTE: previous behavior skipped walking directories when their mtime matched
      // the prior cache (heuristic for unchanged contents). That could miss moved
      // or renamed files under directories whose mtime didn't change. To ensure
      // incremental scans discover every file, always walk directories. We still
      // preserve per-file change detection below so only modified/new files are
      // returned in `toProcess` for enrichment.
    } catch (e) {
      // ignore stat errors and continue
    }
    try { ent = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ent) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const name = e.name;
        if (ignoredDirs instanceof Set ? ignoredDirs.has(name) : (Array.isArray(ignoredDirs) && ignoredDirs.indexOf(name) !== -1)) continue;
        walk(full);
      } else {
        if (extRe.test(e.name)) {
          const c = canonicalize(full);
          try {
            const st = fs.statSync(full);
            // current file record contains mtime, size and preserved id when available
            const priorEntry = priorFiles[c];
            const newId = (priorEntry && priorEntry.id) ? priorEntry.id : String(st.size || 0) + ':' + String(Math.floor(st.mtimeMs || Date.now()));
            currentFiles[c] = { mtime: st.mtimeMs, size: st.size, id: newId };
            const priorM = priorEntry && priorEntry.mtime ? priorEntry.mtime : (priorFiles[c] && priorFiles[c].mtime ? priorFiles[c].mtime : null);
            const curM = currentFiles[c] && currentFiles[c].mtime ? currentFiles[c].mtime : null;
            if (!priorEntry || priorEntry.mtime !== curM || priorEntry.size !== st.size) {
              toProcess.push({ id: newId, canonicalPath: c, scannedAt: Date.now() });
            }
          } catch (e) {
            // stat failed - treat as new
            const id = opts.uuidv4 ? opts.uuidv4() : String(Math.random()).slice(2);
            currentFiles[c] = { mtime: Date.now(), size: 0, id };
            toProcess.push({ id, canonicalPath: c, scannedAt: Date.now() });
          }
        }
      }
    }
  }

  walk(libPath);

  // removed are prior files that were not seen in currentFiles
  const removed = [];
  for (const pk of Object.keys(priorFiles || {})) if (!currentFiles.hasOwnProperty(pk)) removed.push(pk);

  const currentCache = { files: currentFiles, dirs: currentDirs };
  return { toProcess, currentCache, removed };
}

function buildIncrementalItems(currentCache, toProcess, makeId) {
  const files = (currentCache && currentCache.files) ? currentCache.files : {};
  const idFactory = (typeof makeId === 'function') ? makeId : (() => String(Math.random()).slice(2));
  const ordered = [];
  const seen = new Set();

  function pushItem(pathKey, source) {
    if (!pathKey || typeof pathKey !== 'string') return;
    if (seen.has(pathKey)) return;
    const cacheEntry = files[pathKey] || {};
    const id = (source && source.id) || cacheEntry.id || idFactory();
    const scannedAt = (source && source.scannedAt) || cacheEntry.scannedAt || cacheEntry.mtime || Date.now();
    ordered.push({ id, canonicalPath: pathKey, scannedAt });
    seen.add(pathKey);
  }

  if (Array.isArray(toProcess)) {
    for (const entry of toProcess) {
      try {
        const key = entry && typeof entry.canonicalPath === 'string' ? entry.canonicalPath : null;
        if (key) pushItem(key, entry);
      } catch (e) { /* ignore malformed entries */ }
    }
  }

  for (const key of Object.keys(files)) {
    pushItem(key);
  }

  return ordered;
}

module.exports = {
  fullScanLibrary,
  incrementalScanLibrary,
  loadScanCache,
  saveScanCache,
  buildIncrementalItems,
};
