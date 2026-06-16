const fs = require('fs');

const missingFunctions = [
  'isMeaningfulTitle', 'isPlaceholderTitle', 'extractSeasonNumberFromTitle', 
  'fullScanLibrary', 'searchTmdbAndEpisode', 'incrementalScanLibrary',
  'loadScanCache', 'saveScanCache', 'lookupWikipediaEpisode',
  'cleanEnrichmentForClient', 'sanitizeExtraGuess', 'renderCustomMetadataName',
  'updateEnrichCacheInMemory', 'sweepEnrichCache', 'normalizeForCache',
  'normalizeOutputKey', 'buildApprovedSeriesPayload', 'getApprovedSeriesSourcePreferences',
  'resolveApprovedSeriesSourcePreference', 'normalizeApprovedSeriesSource',
  'setApprovedSeriesSourcePreference', 'fetchAndCacheApprovedSeriesImage',
  'createBgJob', 'resolveMetadataProviderOrder'
];

const code = fs.readFileSync('pure_old_server.js', 'utf8');

function extractBlock(startIndex) {
  let openBraces = 0;
  let inString = false;
  let stringChar = '';
  let i = startIndex;
  
  while (i < code.length && code[i] !== '{') i++;
  if (i >= code.length) return '';
  
  const blockStart = i;
  openBraces = 1;
  i++;

  while (i < code.length && openBraces > 0) {
    const c = code[i];
    if (inString) {
      if (c === '\\') { i += 2; continue; }
      if (c === stringChar) { inString = false; }
    } else {
      if (c === '"' || c === "'" || c === '`') {
        inString = true;
        stringChar = c;
      } else if (c === '{') openBraces++;
      else if (c === '}') openBraces--;
    }
    i++;
  }
  return code.substring(startIndex, i);
}

let output = `\n// --- RESTORED LEGACY FUNCTIONS ---\n\n`;

for (const fn of missingFunctions) {
  const r = new RegExp(`(?:async\\s+)?function\\s+${fn}\\s*\\([^)]*\\)\\s*\\{`);
  const match = r.exec(code);
  if (match) {
    output += extractBlock(match.index) + '\n\n';
  } else {
    const r2 = new RegExp(`const\\s+${fn}\\s*=\\s*(?:async\\s+)?\\([^)]*\\)\\s*=>\\s*\\{`);
    const m2 = r2.exec(code);
    if (m2) output += extractBlock(m2.index) + '\n\n';
  }
}

fs.writeFileSync('raw-legacy.js', output);
console.log("Wrote raw-legacy.js with ONLY functions.");
