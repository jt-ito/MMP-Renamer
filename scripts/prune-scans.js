#!/usr/bin/env node
// scripts/prune-scans.js
// Safely prune `data/scans.json` to keep only the most recent N scans.
// Usage (PowerShell):
//   node .\scripts\prune-scans.js [KEEP]
// Defaults KEEP to 2.

const fs = require('fs');
const path = require('path');

const KEEP = Number(process.argv[2] || process.env.KEEP_SCAN_ARTIFACTS || 2);
const repoRoot = path.resolve(__dirname, '..');
const dataDir = path.join(repoRoot, 'data');
const scansFile = path.join(dataDir, 'scans.json');

function nowTs() { return new Date().toISOString().replace(/[:.]/g, '-'); }

(async function main(){
  try {
    if (!fs.existsSync(scansFile)) {
      console.error('No scans file found at', scansFile);
      process.exit(1);
    }
    const stat = fs.statSync(scansFile);
    console.log('scans.json size:', stat.size, 'bytes');
    // Backup first
    const bakName = scansFile + `.bak.${nowTs()}`;
    console.log('Creating backup:', bakName);
    fs.copyFileSync(scansFile, bakName);

    // Read and parse
    const raw = fs.readFileSync(scansFile, 'utf8');
    let scans = null;
    try { scans = JSON.parse(raw || '{}'); } catch (e) {
      console.error('Failed to parse scans.json:', e && e.message);
      console.error('Backup is available at', bakName);
      process.exit(2);
    }
    if (!scans || typeof scans !== 'object') {
      console.error('scans.json does not contain an object');
      process.exit(3);
    }

    const ids = Object.keys(scans);
    console.log('Found', ids.length, 'scan artifacts. KEEP =', KEEP);
    if (ids.length <= KEEP) {
      console.log('Nothing to do. Exiting.');
      process.exit(0);
    }

    // Build array with timestamps for sorting
    const arr = ids.map(id => {
      const s = scans[id] || {};
      const ts = (s.generatedAt != null) ? Number(s.generatedAt) : (s.generated_at || 0);
      return { id, ts };
    });
    arr.sort((a,b) => b.ts - a.ts);
    const toKeep = new Set(arr.slice(0, KEEP).map(x => x.id));
    const toRemove = arr.slice(KEEP).map(x => x.id);

    // Remove
    for (const rid of toRemove) {
      try { delete scans[rid]; } catch (e) { /* ignore per-key error */ }
    }

    // Write atomically to temp file then rename
    const tmp = scansFile + `.tmp.${nowTs()}`;
    fs.writeFileSync(tmp, JSON.stringify(scans, null, 2), { encoding: 'utf8' });
    fs.renameSync(tmp, scansFile);

    console.log('Pruned', toRemove.length, 'scan(s):', toRemove.join(', '));
    console.log('Wrote pruned scans.json and left backup at', bakName);
    process.exit(0);
  } catch (e) {
    console.error('Unexpected error', e && e.stack ? e.stack : e);
    process.exit(99);
  }
})();
