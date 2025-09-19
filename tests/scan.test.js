const assert = require('assert');
const fs = require('fs');
const path = require('path');
const scanLib = require('../lib/scan');

const DATA_DIR = path.join(__dirname, '..', 'data');
const tmpRoot = path.join(__dirname, '..', 'tmp_test_scan_unit');

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

describe('lib/scan.js', function() {
  beforeEach(function() {
    cleanup(tmpRoot);
    cleanup(DATA_DIR);
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });
  });
  afterEach(function() {
    cleanup(tmpRoot);
    cleanup(DATA_DIR);
  });

  it('fullScanLibrary finds files and incremental detects added/removed files', function() {
    const a = path.join(tmpRoot, 'Show - 01.mkv');
    fs.writeFileSync(a, 'x');

    const found1 = scanLib.fullScanLibrary(tmpRoot, { canonicalize: p => path.resolve(p).replace(/\\/g, '/') });
    assert.strictEqual(found1.length, 1, 'expected one file on first scan');

    // build cache via stats
    const curCache = {};
    for (const it of found1) {
      const st = fs.statSync(it.canonicalPath);
      curCache[it.canonicalPath] = { mtime: st.mtimeMs, size: st.size, id: String(st.size || 0) + ':' + String(Math.floor(st.mtimeMs || Date.now())) };
    }
  const scanCacheFile = path.join(DATA_DIR, 'scan-cache.json');
  scanLib.saveScanCache(scanCacheFile, { files: curCache, dirs: {}, initialScanAt: Date.now() });

    // add a new file
    const b = path.join(tmpRoot, 'Show - 02.mkv');
    fs.writeFileSync(b, 'y');

  const inc = scanLib.incrementalScanLibrary(tmpRoot, { scanCacheFile, canonicalize: p => path.resolve(p).replace(/\\/g, '/') });
    // should detect one new file and zero removed
    assert.strictEqual(inc.toProcess.length, 1, 'expected one new/changed file');
    assert.strictEqual(inc.removed.length, 0, 'expected no removed files');

  // Save current cache returned by incremental and ensure ids are present and reused
  scanLib.saveScanCache(scanCacheFile, Object.assign({}, inc.currentCache || {}, { initialScanAt: Date.now() }));
  const incAgain = scanLib.incrementalScanLibrary(tmpRoot, { scanCacheFile, canonicalize: p => path.resolve(p).replace(/\\/g, '/') });
  // since nothing changed, toProcess should be zero
  assert.strictEqual(incAgain.toProcess.length, 0, 'expected zero new files after re-check');

    // remove the first file
    fs.rmSync(a);
    const inc2 = scanLib.incrementalScanLibrary(tmpRoot, { scanCacheFile, canonicalize: p => path.resolve(p).replace(/\\/g, '/') });
    // now removed should include the first file path
    assert.ok(inc2.removed.length >= 1, 'expected at least one removed file');
  });

  it('saveScanCache is atomic and recovers from corrupted file', function() {
    const scanCacheFile = path.join(DATA_DIR, 'scan-cache.json');
    // write a corrupted file first
    fs.writeFileSync(scanCacheFile, '{ this is : not json', 'utf8');
    // now call saveScanCache to write a valid object
    const good = { files: {}, dirs: {}, initialScanAt: Date.now() };
    scanLib.saveScanCache(scanCacheFile, good);
    const read = JSON.parse(fs.readFileSync(scanCacheFile, 'utf8'));
    assert.ok(read && read.files && typeof read.initialScanAt === 'number', 'expected valid JSON after atomic save');
  });
});
