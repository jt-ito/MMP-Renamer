const fs = require('fs');
const path = require('path');
let Database = null;
try { Database = require('better-sqlite3'); } catch (e) {}

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'scans.db');
const ENRICH_FILE = path.join(DATA_DIR, 'enrich-store.json');
const SCAN_STORE_FILE = path.join(DATA_DIR, 'scans.json');

const searchTerm = process.argv[2];
if (!searchTerm) {
  console.error('Usage: node scripts/fix-missing-item-deep.js "Partial Filename"');
  process.exit(1);
}

console.log(`Searching for items matching: "${searchTerm}"...`);

let db = null;
let enrichCache = {};
let scans = {};
let mode = 'json';

if (fs.existsSync(DB_PATH) && Database) {
  try {
    db = new Database(DB_PATH);
    const row = db.prepare('SELECT v FROM kv WHERE k = ?').get('enrichCache');
    if (row && row.v) {
      enrichCache = JSON.parse(row.v);
      mode = 'db';
      console.log('Loaded enrichCache from SQLite DB.');
    }
    // Load scans from DB
    const scanRows = db.prepare('SELECT id, meta FROM scans').all();
    for (const r of scanRows) {
      const items = [];
      const itemsRows = db.prepare('SELECT item FROM scan_items WHERE scan_id = ?').all(r.id);
      for (const ir of itemsRows) {
        try { items.push(JSON.parse(ir.item)); } catch (e) {}
      }
      scans[r.id] = { id: r.id, items };
    }
    console.log(`Loaded ${Object.keys(scans).length} scans from DB.`);
  } catch (e) {
    console.error('Failed to load from DB, falling back to JSON:', e.message);
  }
}

if (mode === 'json') {
  if (fs.existsSync(ENRICH_FILE)) {
    try { enrichCache = JSON.parse(fs.readFileSync(ENRICH_FILE, 'utf8')); } catch (e) {}
  }
  if (fs.existsSync(SCAN_STORE_FILE)) {
    try { scans = JSON.parse(fs.readFileSync(SCAN_STORE_FILE, 'utf8')); } catch (e) {}
  }
}

const keys = Object.keys(enrichCache);
let found = 0;
let modified = 0;

// 1. Fix Enrich Cache
for (const key of keys) {
  if (key.toLowerCase().includes(searchTerm.toLowerCase())) {
    found++;
    const entry = enrichCache[key];
    console.log(`Found in EnrichCache: ${key}`);
    
    if (entry.hidden || entry.applied) {
      console.log('  -> FIXING: Clearing hidden/applied flags.');
      entry.hidden = false;
      entry.applied = false;
      delete entry.appliedAt;
      delete entry.appliedTo;
      modified++;
    }
  }
}

// 2. Fix Scans (Inject item if missing)
// If we found the item in enrichCache (or even if we didn't but the user insists),
// we need to make sure it exists in the latest scan artifact.
if (found > 0) {
  const scanIds = Object.keys(scans);
  // Sort by recent (heuristic: assume keys or timestamps)
  // Just iterate all scans and ensure the item is present if it matches the path structure
  for (const sid of scanIds) {
    const s = scans[sid];
    if (!s || !Array.isArray(s.items)) continue;
    
    // Check if item exists in this scan
    let existsInScan = false;
    for (const it of s.items) {
      if (it.canonicalPath && it.canonicalPath.toLowerCase().includes(searchTerm.toLowerCase())) {
        existsInScan = true;
        break;
      }
    }
    
    if (!existsInScan) {
      // We need to find the full path from enrichCache to inject it
      const fullPath = keys.find(k => k.toLowerCase().includes(searchTerm.toLowerCase()));
      if (fullPath) {
        console.log(`  -> INJECTING into scan ${sid}: ${fullPath}`);
        s.items.push({
          id: Math.random().toString(36).slice(2),
          canonicalPath: fullPath,
          scannedAt: Date.now()
        });
        s.totalCount = s.items.length;
        modified++;
      }
    }
  }
}

if (modified > 0) {
  console.log(`\nModified ${modified} entries.`);
  if (mode === 'db' && db) {
    db.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run('enrichCache', JSON.stringify(enrichCache));
    
    // Save scans back to DB
    const insertScan = db.prepare('INSERT OR REPLACE INTO scans (id, libraryId, totalCount, generatedAt, meta) VALUES (?, ?, ?, ?, ?)');
    const deleteItems = db.prepare('DELETE FROM scan_items WHERE scan_id = ?');
    const insertItem = db.prepare('INSERT OR REPLACE INTO scan_items (scan_id, idx, item) VALUES (?, ?, ?)');
    
    const txn = db.transaction((scansObj) => {
      for (const id of Object.keys(scansObj)) {
        const s = scansObj[id];
        // We don't have all fields (libraryId, generatedAt) perfectly preserved in this script's load logic if using simple JSON fallback structure,
        // but for DB mode we loaded them. If we missed them, we might corrupt the scan metadata.
        // Ideally we should only update the items.
        // For safety in this rescue script, let's just update the items for existing scans.
        
        deleteItems.run(s.id);
        const items = Array.isArray(s.items) ? s.items : [];
        for (let i = 0; i < items.length; i++) {
          try { insertItem.run(s.id, i, JSON.stringify(items[i])); } catch (e) {}
        }
        // Update count
        db.prepare('UPDATE scans SET totalCount = ? WHERE id = ?').run(items.length, s.id);
      }
    });
    txn(scans);
    console.log('Saved changes to DB.');
  } else {
    fs.writeFileSync(ENRICH_FILE, JSON.stringify(enrichCache, null, 2), 'utf8');
    fs.writeFileSync(SCAN_STORE_FILE, JSON.stringify(scans, null, 2), 'utf8');
    console.log('Saved changes to JSON files.');
  }
  console.log('\nIMPORTANT: Please RESTART your container/server now to load these changes.');
} else {
  console.log('\nNo changes needed.');
}
