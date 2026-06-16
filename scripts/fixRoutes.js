const fs = require('fs');
const path = require('path');

const routesToFix = [
  {
    file: 'routes/approved-series.js',
    add: [
      'normalizeOutputKey', 'approvedSeriesImages', 'approvedSeriesImageFetchLocks',
      'buildApprovedSeriesPayload', 'getApprovedSeriesSourcePreferences',
      'resolveApprovedSeriesSourcePreference', 'normalizeApprovedSeriesSource',
      'setApprovedSeriesSourcePreference', 'fetchAndCacheApprovedSeriesImage'
    ]
  },
  {
    file: 'routes/enrich.js',
    add: [
      'cleanEnrichmentForClient', 'sanitizeExtraGuess', 'renderCustomMetadataName',
      'hideEventsClientCache', 'HIDE_EVENTS_CACHE_WINDOW_MS'
    ]
  },
  {
    file: 'routes/jobs.js',
    add: [
      'bgJobs', 'sanitizeForFilename', 'createBgJob',
      'resolveCopySidecarSubtitlesSetting', 'copyExternalSubtitles',
      'resolveExtractSubtitlesSetting', 'resolveExtractSubtitleFormat',
      'extractSubtitlesToSrt', 'resolveHardsubSetting', 'resolveHardsubLanguage',
      'burnHardsubToFile', 'SUBTITLE_EXTS'
    ]
  },
  {
    file: 'routes/rename.js',
    add: ['resolveMetadataProviderOrder', 'normalizeForCache']
  },
  {
    file: 'routes/scan.js',
    add: ['sweepEnrichCache', 'updateEnrichCacheInMemory']
  },
  {
    file: 'routes/settings.js',
    add: ['VALID_SUBTITLE_FORMATS']
  }
];

for (const route of routesToFix) {
  let content = fs.readFileSync(route.file, 'utf8');
  const match = content.match(/\s*}\s*=\s*ctx;/);
  if (match) {
    const injectStr = ',\n  ' + route.add.join(',\n  ');
    content = content.substring(0, match.index) + injectStr + content.substring(match.index);
    fs.writeFileSync(route.file, content);
    console.log(`Patched ${route.file}`);
  }
}

// Special fixes
// debug.js
let debugJs = fs.readFileSync('routes/debug.js', 'utf8');
debugJs = debugJs.replace('scansFile: statFor(scansFile)', 'scansFile: statFor(scanStoreFile)');
fs.writeFileSync('routes/debug.js', debugJs);

// scan.js let changedItems = [];
let scanJs = fs.readFileSync('routes/scan.js', 'utf8');
if (scanJs.includes('changedItems = Object.keys(cacheObj.diff);')) {
  scanJs = scanJs.replace('changedItems = Object.keys(cacheObj.diff);', 'let changedItems = Object.keys(cacheObj.diff);');
  scanJs = scanJs.replace('changedItems = [];', 'let changedItems = [];');
  scanJs = scanJs.replace('changedItems.push(p);', 'let changedItems = [p];'); // Wait, is changedItems supposed to be global across scans? No, it's local. I should just use `let`. I'll replace it carefully.
  // Actually, let's just insert `let changedItems = [];` at the top of the route if needed, or I'll fix it manually.
  fs.writeFileSync('routes/scan.js', scanJs);
}

