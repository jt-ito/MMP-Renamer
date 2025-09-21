#!/usr/bin/env node
/*
  scripts/migrate-scans-to-sqlite.js

  Streams data/scans.json into a SQLite database at data/scans.db
  - Uses stream-json to avoid loading the entire JSON into memory
  - Uses better-sqlite3 for simple, synchronous, reliable DB writes
  - Creates tables: scans (metadata) and scan_items (items per scan)
  - For safety: requires an environment variable MIGRATE_ALLOW or the --yes flag to actually write to data/scans.db
*/

const fs = require('fs');
const path = require('path');
const {chain} = require('stream-chain');
const {parser} = require('stream-json');
const {pick} = require('stream-json/filters/Pick');
const {streamArray} = require('stream-json/streamers/StreamArray');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SCANS_JSON = path.join(DATA_DIR, 'scans.json');
const DB_PATH = path.join(DATA_DIR, 'scans.db');

function usage() {
  console.log('Usage: node migrate-scans-to-sqlite.js [--yes]');
  console.log('This will create/overwrite', DB_PATH);
  process.exit(1);
}

const allow = process.argv.includes('--yes') || process.env.MIGRATE_ALLOW === '1';
if (!allow) {
  console.log('Migration is protected. Pass --yes or set MIGRATE_ALLOW=1 to perform the migration.');
  usage();
}

if (!fs.existsSync(SCANS_JSON)) {
  console.error('Missing', SCANS_JSON);
  process.exit(2);
}

console.log('Starting migration from', SCANS_JSON, 'to', DB_PATH);

// Backup existing DB if present
if (fs.existsSync(DB_PATH)) {
  const bak = DB_PATH + '.bak.' + Date.now();
  fs.copyFileSync(DB_PATH, bak);
  console.log('Backed up existing DB to', bak);
}

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// Create schema
db.exec(`
CREATE TABLE IF NOT EXISTS scans (
  id TEXT PRIMARY KEY,
  generatedAt INTEGER,
  totalCount INTEGER,
  meta TEXT
);
CREATE TABLE IF NOT EXISTS scan_items (
  scan_id TEXT,
  idx INTEGER,
  item TEXT,
  PRIMARY KEY(scan_id, idx),
  FOREIGN KEY(scan_id) REFERENCES scans(id)
);
CREATE INDEX IF NOT EXISTS idx_scan_items_scan ON scan_items(scan_id);
`);

const insertScan = db.prepare('INSERT OR REPLACE INTO scans (id, generatedAt, totalCount, meta) VALUES (?, ?, ?, ?)');
const insertItem = db.prepare('INSERT OR REPLACE INTO scan_items (scan_id, idx, item) VALUES (?, ?, ?, ?)');

// We'll parse the top-level object keys (scanId -> artifact)
const fileStream = fs.createReadStream(SCANS_JSON);
const pipeline = chain([
  fileStream,
  parser(),
  // pick top-level keys
  pick({filter: null}),
  streamArray(),
]);

let processed = 0;

pipeline.on('data', ({key, value}) => {
  // key is the property name (scan id), value is the artifact object
  try {
    const scanId = key;
    const gen = value.generatedAt || Date.now();
    const totalCount = (value.meta && value.meta.totalCount) || (Array.isArray(value.items) ? value.items.length : 0);
    const meta = JSON.stringify(value.meta || {});

    const insertScanTxn = db.transaction(() => {
      insertScan.run(scanId, gen, totalCount, meta);
      const items = value.items || [];
      for (let i = 0; i < items.length; i++) {
        insertItem.run(scanId, i, JSON.stringify(items[i]));
      }
    });
    insertScanTxn();
    processed++;
    if (processed % 10 === 0) console.log('Processed', processed, 'scans');
  } catch (err) {
    console.error('Error processing scan key', key, err);
  }
});

pipeline.on('end', () => {
  console.log('Migration complete. Total scans processed:', processed);
  db.close();
});

pipeline.on('error', (err) => {
  console.error('Stream error:', err);
  db.close();
  process.exit(3);
});
