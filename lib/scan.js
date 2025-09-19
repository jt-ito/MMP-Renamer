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
  // Load prior cache shape { files: {path:mtime}, dirs: {dir:mtime} }
  const prior = scanCacheFile ? loadScanCache(scanCacheFile) : {};
  const priorFiles = (prior && prior.files) ? prior.files : {};
  const priorDirs = (prior && prior.dirs) ? prior.dirs : {};

  const toProcess = [];
  const currentFiles = {};
  const currentDirs = {};

  // Fast-path: verify existing known files still exist and capture their mtimes
  for (const p of Object.keys(priorFiles || {})) {
    try {
      const st = fs.statSync(p);
      if (st && st.mtimeMs != null) currentFiles[p] = st.mtimeMs;
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
      // If we have a prior dir mtime and it matches, skip walking this directory
      const priorM = priorDirs[dirCanonical];
      if (priorM && priorM === stDir.mtimeMs) {
        return; // assume contents unchanged
      }
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
          try { const st = fs.statSync(full); currentFiles[c] = st.mtimeMs; } catch (e) { currentFiles[c] = Date.now(); }
          const priorM = priorFiles[c];
          const curM = currentFiles[c];
          if (!priorM || priorM !== curM) {
            toProcess.push({ id: opts.uuidv4 ? opts.uuidv4() : String(Math.random()).slice(2), canonicalPath: c, scannedAt: Date.now() });
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

module.exports = {
  fullScanLibrary,
  incrementalScanLibrary,
  loadScanCache,
  saveScanCache,
};
