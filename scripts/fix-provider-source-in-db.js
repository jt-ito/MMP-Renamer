#!/usr/bin/env node
/**
 * Fix provider.source field in SQLite database enrichCache
 * 
 * This script fixes cached enrichment data where provider.source was incorrectly
 * set to an object instead of a string, causing React error #31.
 */

const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'scans.db');

console.log('[FixProviderSource] Starting database cache repair...');
console.log('[FixProviderSource] Database:', dbPath);

// Open database
let db;
try {
  db = new Database(dbPath);
  console.log('[FixProviderSource] Database opened successfully');
} catch (err) {
  console.error('[FixProviderSource] Error opening database:', err.message);
  process.exit(1);
}

// Get enrichCache from kvstore
let enrichCache = {};
try {
  const row = db.prepare('SELECT value FROM kvstore WHERE key = ?').get('enrichCache');
  if (row && row.value) {
    enrichCache = JSON.parse(row.value);
    console.log(`[FixProviderSource] Loaded ${Object.keys(enrichCache).length} cached entries from database`);
  } else {
    console.log('[FixProviderSource] No enrichCache found in database');
    db.close();
    process.exit(0);
  }
} catch (err) {
  console.error('[FixProviderSource] Error reading enrichCache:', err.message);
  db.close();
  process.exit(1);
}

// Fix each entry
let fixedCount = 0;
let errorCount = 0;

for (const [key, entry] of Object.entries(enrichCache)) {
  try {
    if (!entry || !entry.provider) continue;
    
    const provider = entry.provider;
    
    // Check if source is an object (the bug)
    if (provider.source && typeof provider.source === 'object') {
      console.log(`[FixProviderSource] Fixing entry: ${key.substring(0, 60)}...`);
      console.log(`[FixProviderSource]   Old source:`, JSON.stringify(provider.source).substring(0, 100));
      
      // Try to extract the actual source string
      let newSource = null;
      
      // If source object has a 'source' property, use that
      if (provider.source.source && typeof provider.source.source === 'string') {
        newSource = provider.source.source;
      }
      // If source object has a 'provider' property that's a string, use that
      else if (provider.source.provider && typeof provider.source.provider === 'string') {
        newSource = provider.source.provider;
      }
      // Otherwise set to null
      else {
        newSource = null;
      }
      
      provider.source = newSource;
      console.log(`[FixProviderSource]   New source:`, newSource || 'null');
      fixedCount++;
    }
  } catch (err) {
    console.error(`[FixProviderSource] Error fixing entry ${key}:`, err.message);
    errorCount++;
  }
}

console.log(`[FixProviderSource] Fixed ${fixedCount} entries, ${errorCount} errors`);

// Save the fixed cache back to database
if (fixedCount > 0) {
  try {
    // Create backup table
    const timestamp = Date.now();
    db.exec(`CREATE TABLE IF NOT EXISTS kvstore_backup_${timestamp} AS SELECT * FROM kvstore WHERE key = 'enrichCache'`);
    console.log(`[FixProviderSource] Created backup table: kvstore_backup_${timestamp}`);
    
    // Update enrichCache
    const updateStmt = db.prepare('UPDATE kvstore SET value = ? WHERE key = ?');
    updateStmt.run(JSON.stringify(enrichCache), 'enrichCache');
    console.log(`[FixProviderSource] Updated enrichCache in database`);
    console.log(`[FixProviderSource] SUCCESS: Database cache repaired!`);
  } catch (err) {
    console.error('[FixProviderSource] Error saving fixed cache:', err.message);
    db.close();
    process.exit(1);
  }
} else {
  console.log('[FixProviderSource] No fixes needed, cache is clean');
}

db.close();
console.log('[FixProviderSource] Database closed');
