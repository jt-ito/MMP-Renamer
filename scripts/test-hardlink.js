#!/usr/bin/env node
// scripts/test-hardlink.js
// Usage (PowerShell):
//  node .\scripts\test-hardlink.js --from "C:\path\to\source.mkv" --prov "86 EIGHTY-SIX (2021) - S01E01 - Undertaker" --isSeries true --season 1 --year 2021 --out "C:\mnt\sda1\Choows"
// Minimal: node scripts/test-hardlink.js --from "./S01E01-Undertaker.mkv" --prov "86 EIGHTY-SIX (2021) - S01E01 - Undertaker" --isSeries true --season 1 --out "./out"

const fs = require('fs');
const path = require('path');

function usageAndExit() {
  console.error('Usage: node scripts/test-hardlink.js --from <source> --prov <providerRenderedName> [--isSeries true|false] [--season N] [--year YYYY] [--out <configuredOutput>]');
  process.exit(1);
}

let argv = null;
try {
  argv = require('minimist')(process.argv.slice(2));
} catch (e) {
  // simple fallback parser for --key value pairs
  argv = {};
  const parts = process.argv.slice(2);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.startsWith('--')) {
      const key = p.slice(2);
      const next = parts[i+1];
      if (next && !next.startsWith('--')) { argv[key] = next; i++; } else { argv[key] = true; }
    }
  }
}
if (!argv.from || !argv.prov) usageAndExit();

const from = path.resolve(argv.from);
const provRendered = String(argv.prov || '').trim();
const isSeries = argv.isSeries === true || argv.isSeries === 'true' || argv.isSeries === '1';
const season = argv.season != null ? String(argv.season) : null;
const year = argv.year != null ? String(argv.year) : null;
const configuredOut = argv.out ? path.resolve(argv.out) : null;

function sanitize(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '');
}

function extractYearFromString(s) {
  const m = String(s || '').match(/(19|20)\d{2}/);
  return m ? m[0] : null;
}

(async function main(){
  try {
    if (!fs.existsSync(from)) {
      console.error(JSON.stringify({ ok: false, error: 'source not found', from }));
      process.exit(2);
    }
    const ext = path.extname(from) || '.mkv';
    const baseOut = configuredOut || path.dirname(from);

    let finalDir, finalFileName;

    if (isSeries) {
      // derive series folder by stripping episode suffix like ' - S01E01' from providerRendered
      let seriesRenderedRaw = provRendered.replace(/\.[^/.]+$/, '');
      const sMatch = seriesRenderedRaw.search(/\s-\sS\d{1,2}E\d{1,3}/);
      let seriesFolderBase = sMatch !== -1 ? seriesRenderedRaw.slice(0, sMatch).trim() : seriesRenderedRaw;
      if (!seriesFolderBase) {
        seriesFolderBase = provRendered;
      }
      // omit year for series folders; keep exact title only
      const seasonFolder = `Season ${String(season || '1').padStart(2,'0')}`;
      finalDir = path.join(baseOut, sanitize(seriesFolderBase), seasonFolder);
      finalFileName = sanitize(provRendered) + ext; // use exact provider-rendered name as filename (sanitized)
    } else {
      // movie layout: Title (Year)/Title (Year).ext
      const movieBase = provRendered;
      finalDir = path.join(baseOut, sanitize(movieBase));
      finalFileName = sanitize(movieBase) + ext;
    }

    if (!fs.existsSync(finalDir)) {
      fs.mkdirSync(finalDir, { recursive: true });
    }

    const target = path.join(finalDir, finalFileName);
    let method = null;
    try {
      fs.linkSync(from, target);
      method = 'link';
      console.error(JSON.stringify({ ok: true, method, from, to: target }));
    } catch (linkErr) {
      try {
        fs.copyFileSync(from, target);
        method = 'copy';
        console.error(JSON.stringify({ ok: true, method, from, to: target, fallback: 'copy after link failed', linkErr: String(linkErr && linkErr.message) }));
      } catch (copyErr) {
        console.error(JSON.stringify({ ok: false, error: 'link and copy failed', linkErr: String(linkErr && linkErr.message), copyErr: String(copyErr && copyErr.message) }));
        process.exit(3);
      }
    }

    // output a small metadata JSON file beside the created file so you can inspect what would be written to enrich cache
    const meta = { source: from, target, method, providerRendered: provRendered, isSeries, season, year, timestamp: Date.now() };
    try { fs.writeFileSync(path.join(finalDir, path.basename(finalFileName) + '.metadata.json'), JSON.stringify(meta, null, 2), 'utf8'); } catch (e) {}

    process.exit(0);
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e && e.message }));
    process.exit(4);
  }
})();
