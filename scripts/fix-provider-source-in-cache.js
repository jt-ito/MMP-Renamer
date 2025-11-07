#!/usr/bin/env node
/**
 * Fix provider.source field in enrichCache
 * 
 * This script fixes cached enrichment data where provider.source was incorrectly
 * set to an object instead of a string, causing React error #31.
 */

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const enrichStoreFile = path.join(dataDir, 'enrich-store.json');

console.log('[FixProviderSource] Starting cache repair...');
console.log('[FixProviderSource] Reading:', enrichStoreFile);

// Load enrichCache
let enrichCache = {};
try {
  if (fs.existsSync(enrichStoreFile)) {
    const rawData = fs.readFileSync(enrichStoreFile, 'utf8');
    enrichCache = JSON.parse(rawData);
    console.log(`[FixProviderSource] Loaded ${Object.keys(enrichCache).length} cached entries`);
  } else {
    console.log('[FixProviderSource] No enrich-store.json found, nothing to fix');
    process.exit(0);
  }
} catch (err) {
  console.error('[FixProviderSource] Error reading cache:', err.message);
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
      console.log(`[FixProviderSource] Fixing entry: ${key}`);
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

// Save the fixed cache
if (fixedCount > 0) {
  try {
    // Backup original
    const backupFile = enrichStoreFile + '.backup.' + Date.now();
    fs.copyFileSync(enrichStoreFile, backupFile);
    console.log(`[FixProviderSource] Created backup: ${backupFile}`);
    
    // Write fixed data
    fs.writeFileSync(enrichStoreFile, JSON.stringify(enrichCache, null, 2), 'utf8');
    console.log(`[FixProviderSource] Saved fixed cache to: ${enrichStoreFile}`);
    console.log(`[FixProviderSource] SUCCESS: Cache repaired!`);
  } catch (err) {
    console.error('[FixProviderSource] Error saving fixed cache:', err.message);
    process.exit(1);
  }
} else {
  console.log('[FixProviderSource] No fixes needed, cache is clean');
}
