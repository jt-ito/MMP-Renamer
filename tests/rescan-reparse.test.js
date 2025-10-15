const assert = require('assert');
const fs = require('fs');
const path = require('path');
const server = require('../server');
const parseFilename = require('../lib/filename-parser');

function canonicalize(p) {
  return path.resolve(p).replace(/\\/g, '/');
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

describe('rescan re-parses filenames', function() {
  const tmpRoot = path.join(__dirname, '..', 'tmp_rescan_reparse');

  beforeEach(function() {
    cleanup(tmpRoot);
    fs.mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(function() {
    cleanup(tmpRoot);
  });

  it('refreshes parsed cache entries when rescanning existing files', function() {
    const filePath = path.join(tmpRoot, 'Getsuyoubi no Tawawa 2 - 01.mkv');
    fs.writeFileSync(filePath, 'dummy');
    const key = canonicalize(filePath);
    const processParsed = server._test.doProcessParsedItem || server._test.processParsedItem;
    assert.ok(typeof processParsed === 'function', 'expected processParsedItem helper to be exposed');

    const stale = { title: 'Old Title', parsedName: 'Old.Title', season: 9, episode: 9, episodeRange: null, timestamp: 1 };
    server.parsedCache[key] = Object.assign({}, stale);
    server.enrichCache[key] = { parsed: Object.assign({}, stale) };

    processParsed({ canonicalPath: key, scannedAt: Date.now() }, {});

    const parsed = server.parsedCache[key];
    const expected = parseFilename(path.basename(filePath, path.extname(filePath)));
    assert.ok(parsed, 'expected parsed cache entry to exist after rescan');
    assert.strictEqual(parsed.title, expected.title, 'title should refresh from parser');
    assert.strictEqual(parsed.season, expected.season, 'season should refresh from parser');
    assert.strictEqual(parsed.episode, expected.episode, 'episode should refresh from parser');
    assert.ok(server.enrichCache[key] && server.enrichCache[key].parsed, 'expected enrich cache parsed block');
    assert.strictEqual(server.enrichCache[key].parsed.title, expected.title, 'enrich cache should reflect refreshed parse');

    delete server.parsedCache[key];
    delete server.enrichCache[key];
  });
});
