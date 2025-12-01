const fs = require('fs');
const path = require('path');
let Database = null;
try { Database = require('better-sqlite3'); } catch (e) {}

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'scans.db');
const ENRICH_FILE = path.join(DATA_DIR, 'enrich-store.json');

const searchTerm = process.argv[2];
if (!searchTerm) {
  console.error('Usage: node scripts/fix-missing-item.js "Partial Filename"');
  process.exit(1);
}

console.log(`Searching for items matching: "${searchTerm}"...`);

let db = null;
let enrichCache = {};
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
  } catch (e) {
    console.error('Failed to load from DB, falling back to JSON:', e.message);
  }
}

if (mode === 'json' && Object.keys(enrichCache).length === 0) {
  if (fs.existsSync(ENRICH_FILE)) {
    try {
      enrichCache = JSON.parse(fs.readFileSync(ENRICH_FILE, 'utf8'));
      console.log('Loaded enrichCache from JSON file.');
    } catch (e) {
      console.error('Failed to load JSON file:', e.message);
    }
  }
}

const keys = Object.keys(enrichCache);
let found = 0;
let modified = 0;

for (const key of keys) {
  if (key.toLowerCase().includes(searchTerm.toLowerCase())) {
    found++;
    const entry = enrichCache[key];
    console.log(`Found: ${key}`);
    console.log(`  State: hidden=${entry.hidden}, applied=${entry.applied}`);
    
    if (entry.hidden || entry.applied) {
      console.log('  -> FIXING: Clearing hidden/applied flags.');
      entry.hidden = false;
      entry.applied = false;
      delete entry.appliedAt;
      delete entry.appliedTo;
      modified++;
    } else {
      console.log('  -> Item is not hidden/applied. It should be visible in scans.');
    }
  }
}

if (found === 0) {
  console.log('No matching items found in cache.');
} else if (modified > 0) {
  console.log(`\nModified ${modified} items.`);
  if (mode === 'db' && db) {
    db.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run('enrichCache', JSON.stringify(enrichCache));
    console.log('Saved changes to DB.');
  } else {
    fs.writeFileSync(ENRICH_FILE, JSON.stringify(enrichCache, null, 2), 'utf8');
    console.log('Saved changes to JSON file.');
  }
  console.log('\nIMPORTANT: Please RESTART your container/server now to load these changes.');
} else {
  console.log('\nNo changes needed.');
}
