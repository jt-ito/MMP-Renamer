const fs = require('fs');
const path = require('path');

const VIDEO_EXTS = ['mkv','mp4','avi','mov','m4v','mpg','mpeg','webm','wmv','flv','ts','ogg','ogv','3gp','3g2'];
const extRe = new RegExp('\\.(' + VIDEO_EXTS.join('|') + ')$', 'i');
const DATA_DIR = path.join(__dirname, '..', 'data');
const scanCacheFile = path.join(DATA_DIR, 'scan-cache.json');

function canonical(p) { return path.resolve(p).replace(/\\/g, '/'); }

function fullScan(dir) {
  const found = [];
  function walk(d) {
    let ent;
    try { ent = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ent) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (extRe.test(e.name)) found.push({ canonicalPath: canonical(full) });
    }
  }
  walk(dir);
  return found;
}

function buildCacheMap(found) {
  const m = {};
  for (const it of found) {
    try { m[it.canonicalPath] = fs.statSync(it.canonicalPath).mtimeMs } catch (e) { m[it.canonicalPath] = Date.now() }
  }
  return m;
}

async function run() {
  const tmpDir = path.join(__dirname, '..', 'tmp_test_scan');
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(tmpDir, { recursive: true });
  const f1 = path.join(tmpDir, 'Show - 01.mkv'); fs.writeFileSync(f1, 'x');
  console.log('Created', f1);

  const found1 = fullScan(tmpDir);
  console.log('full scan found', found1.length);
  const cache1 = buildCacheMap(found1);
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  fs.writeFileSync(scanCacheFile, JSON.stringify(cache1, null, 2), 'utf8');

  // add a new file
  const f2 = path.join(tmpDir, 'Show - 02.mkv'); fs.writeFileSync(f2, 'y');
  const found2 = fullScan(tmpDir);
  const cache2 = buildCacheMap(found2);
  const toProcess = [];
  for (const it of found2) {
    const priorM = cache1[it.canonicalPath];
    const curM = cache2[it.canonicalPath];
    if (!priorM || priorM !== curM) toProcess.push(it);
  }
  const removed = [];
  for (const pk of Object.keys(cache1)) if (!found2.find(f=>f.canonicalPath===pk)) removed.push(pk);
  console.log('after adding, toProcess', toProcess.length, 'removed', removed.length);

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
}

run().catch(err => { console.error(err); process.exit(1); });
