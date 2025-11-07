const path = require('path');
const fs = require('fs');
let Database = null;
try { Database = require('better-sqlite3'); } catch (e) { Database = null }

let db = null;

function init(dbPath) {
  if (!Database) throw new Error('better-sqlite3 not installed');
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS scans (
      id TEXT PRIMARY KEY,
      libraryId TEXT,
      totalCount INTEGER,
      generatedAt INTEGER,
      meta TEXT
    );
    CREATE TABLE IF NOT EXISTS scan_items (
      scan_id TEXT,
      idx INTEGER,
      item TEXT,
      PRIMARY KEY(scan_id, idx)
    );
    CREATE INDEX IF NOT EXISTS idx_scan_items_scan ON scan_items(scan_id);
  `);
  // generic key/value store for caches and small JSON blobs
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      k TEXT PRIMARY KEY,
      v TEXT
    );
  `);
  // ED2K hash cache - stores computed hashes to avoid recomputing
  db.exec(`
    CREATE TABLE IF NOT EXISTS ed2k_hashes (
      file_path TEXT PRIMARY KEY,
      ed2k_hash TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      computed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ed2k_hash ON ed2k_hashes(ed2k_hash);
  `);
}

function loadScansObject() {
  if (!db) return {};
  const out = {};
  const rows = db.prepare('SELECT id, libraryId, totalCount, generatedAt, meta FROM scans').all();
  for (const r of rows) {
    const items = [];
    const itemsRows = db.prepare('SELECT idx, item FROM scan_items WHERE scan_id = ? ORDER BY idx ASC').all(r.id);
    for (const ir of itemsRows) {
      try { items.push(JSON.parse(ir.item)); } catch (e) { items.push(null); }
    }
    let meta = {};
    try { meta = r.meta ? JSON.parse(r.meta) : {}; } catch (e) { meta = {}; }
    out[r.id] = { id: r.id, libraryId: r.libraryId, totalCount: r.totalCount, generatedAt: r.generatedAt, items, meta };
  }
  return out;
}

function saveScansObject(scansObj) {
  if (!db) return;
  const existingIds = db.prepare('SELECT id FROM scans').all().map(r => r.id);
  const toKeep = new Set(Object.keys(scansObj || {}));
  const insertScan = db.prepare('INSERT OR REPLACE INTO scans (id, libraryId, totalCount, generatedAt, meta) VALUES (?, ?, ?, ?, ?)');
  const deleteItems = db.prepare('DELETE FROM scan_items WHERE scan_id = ?');
  const insertItem = db.prepare('INSERT OR REPLACE INTO scan_items (scan_id, idx, item) VALUES (?, ?, ?)');
  const deleteScan = db.prepare('DELETE FROM scans WHERE id = ?');
  const txn = db.transaction((scans) => {
    for (const id of Object.keys(scans || {})) {
      const s = scans[id];
      const metaStr = s.meta ? JSON.stringify(s.meta) : null;
      insertScan.run(s.id, s.libraryId || null, Number(s.totalCount || (Array.isArray(s.items) ? s.items.length : 0)), Number(s.generatedAt || Date.now()), metaStr);
      deleteItems.run(s.id);
      const items = Array.isArray(s.items) ? s.items : [];
      for (let i = 0; i < items.length; i++) {
        try { insertItem.run(s.id, i, JSON.stringify(items[i])); } catch (e) { insertItem.run(s.id, i, JSON.stringify(null)); }
      }
    }
    // delete scans not present
    for (const ex of existingIds) {
      if (!toKeep.has(ex)) deleteScan.run(ex);
    }
  });
  txn(scansObj);
}

function upsertScan(artifact) {
  if (!db || !artifact || !artifact.id) return;
  const insertScan = db.prepare('INSERT OR REPLACE INTO scans (id, libraryId, totalCount, generatedAt, meta) VALUES (?, ?, ?, ?, ?)');
  const deleteItems = db.prepare('DELETE FROM scan_items WHERE scan_id = ?');
  const insertItem = db.prepare('INSERT OR REPLACE INTO scan_items (scan_id, idx, item) VALUES (?, ?, ?)');
  const txn = db.transaction((s) => {
    insertScan.run(s.id, s.libraryId || null, Number(s.totalCount || (Array.isArray(s.items) ? s.items.length : 0)), Number(s.generatedAt || Date.now()), s.meta ? JSON.stringify(s.meta) : null);
    deleteItems.run(s.id);
    const items = Array.isArray(s.items) ? s.items : [];
    for (let i = 0; i < items.length; i++) {
      try { insertItem.run(s.id, i, JSON.stringify(items[i])); } catch (e) { insertItem.run(s.id, i, JSON.stringify(null)); }
    }
  });
  txn(artifact);
}

function deleteScansNotIn(idsToKeep) {
  if (!db) return;
  const keep = new Set(idsToKeep || []);
  const rows = db.prepare('SELECT id FROM scans').all();
  const deleteScan = db.prepare('DELETE FROM scans WHERE id = ?');
  for (const r of rows) {
    if (!keep.has(r.id)) deleteScan.run(r.id);
  }
}

// generic key/value helpers
function getKV(key) {
  if (!db) return null;
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(key);
  if (!row || !row.v) return null;
  try { return JSON.parse(row.v); } catch (e) { return null; }
}

function setKV(key, val) {
  if (!db) return;
  const s = JSON.stringify(val);
  db.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run(key, s);
}

function getHideEvents() {
  const arr = getKV('__hideEvents__');
  return Array.isArray(arr) ? arr : [];
}

function setHideEvents(evList) {
  setKV('__hideEvents__', Array.isArray(evList) ? evList : []);
}

// ED2K hash cache functions
function getEd2kHash(filePath, fileSize) {
  if (!db) return null;
  const row = db.prepare('SELECT ed2k_hash, file_size FROM ed2k_hashes WHERE file_path = ?').get(filePath);
  if (!row) return null;
  // Verify file size matches (invalidate cache if file changed)
  if (fileSize != null && row.file_size !== fileSize) {
    // File size changed, delete stale hash
    db.prepare('DELETE FROM ed2k_hashes WHERE file_path = ?').run(filePath);
    return null;
  }
  return row.ed2k_hash;
}

function setEd2kHash(filePath, ed2kHash, fileSize) {
  if (!db) return;
  const stmt = db.prepare('INSERT OR REPLACE INTO ed2k_hashes (file_path, ed2k_hash, file_size, computed_at) VALUES (?, ?, ?, ?)');
  stmt.run(filePath, ed2kHash, fileSize, Date.now());
}

function deleteEd2kHash(filePath) {
  if (!db) return;
  db.prepare('DELETE FROM ed2k_hashes WHERE file_path = ?').run(filePath);
}

module.exports = { 
  init, 
  loadScansObject, 
  saveScansObject, 
  upsertScan, 
  deleteScansNotIn, 
  getKV, 
  setKV, 
  getHideEvents, 
  setHideEvents,
  getEd2kHash,
  setEd2kHash,
  deleteEd2kHash
};

