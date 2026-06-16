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
  'resolveCopySidecarSubtitlesSetting', 'copyExternalSubtitles',
  'resolveExtractSubtitlesSetting', 'resolveExtractSubtitleFormat',
  'extractSubtitlesToSrt', 'resolveHardsubSetting', 'resolveHardsubLanguage',
  'burnHardsubToFile', 'createBgJob', 'sanitizeForFilename', 'resolveMetadataProviderOrder'
];

const missingVars = [
  'bgJobs', 'SUBTITLE_EXTS', 'VALID_SUBTITLE_FORMATS',
  'hideEventsClientCache', 'HIDE_EVENTS_CACHE_WINDOW_MS',
  'approvedSeriesImages', 'approvedSeriesImageFetchLocks', 'tvdbInfo', 'tvdbInfoParent'
];

const code = fs.readFileSync('pure_old_server.js', 'utf8');

function extractBlock(startIndex) {
  let openBraces = 0;
  let inString = false;
  let stringChar = '';
  let i = startIndex;
  
  // find first brace
  while (i < code.length && code[i] !== '{') i++;
  if (i >= code.length) return '';
  
  const blockStart = i;
  openBraces = 1;
  i++;

  while (i < code.length && openBraces > 0) {
    const c = code[i];
    if (inString) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === stringChar) {
        inString = false;
      }
    } else {
      if (c === '"' || c === "'" || c === '`') {
        inString = true;
        stringChar = c;
      } else if (c === '{') {
        openBraces++;
      } else if (c === '}') {
        openBraces--;
      }
    }
    i++;
  }
  return code.substring(startIndex, i);
}

let output = `// Auto-extracted legacy helpers\nconst fs = require('fs');\nconst path = require('path');\nconst crypto = require('crypto');\n\n`;

for (const v of missingVars) {
  const r = new RegExp(`(?:const|let|var)\\s+${v}\\s*=\\s*([^;]+);`);
  const match = r.exec(code);
  if (match) {
    output += `let ${v} = ${match[1]};\n`;
  } else {
    // maybe it's a Map or Set initialized later?
    if (v === 'bgJobs') output += `const bgJobs = new Map();\n`;
    if (v === 'SUBTITLE_EXTS') output += `const SUBTITLE_EXTS = new Set(['.srt', '.ass', '.ssa', '.vtt', '.sub', '.idx']);\n`;
    if (v === 'VALID_SUBTITLE_FORMATS') output += `const VALID_SUBTITLE_FORMATS = ['srt', 'ass', 'vtt'];\n`;
    if (v === 'hideEventsClientCache') output += `const hideEventsClientCache = new Map();\n`;
    if (v === 'HIDE_EVENTS_CACHE_WINDOW_MS') output += `const HIDE_EVENTS_CACHE_WINDOW_MS = 60 * 60 * 1000;\n`;
    if (v === 'approvedSeriesImages') output += `const approvedSeriesImages = {};\n`;
    if (v === 'approvedSeriesImageFetchLocks') output += `const approvedSeriesImageFetchLocks = {};\n`;
    if (v === 'tvdbInfo') output += `let tvdbInfo = null;\n`;
    if (v === 'tvdbInfoParent') output += `let tvdbInfoParent = null;\n`;
  }
}

output += '\n// Functions\n';

for (const fn of missingFunctions) {
  const r = new RegExp(`function\\s+${fn}\\s*\\([^)]*\\)\\s*\\{`);
  const match = r.exec(code);
  if (match) {
    const fnDef = code.substring(match.index, match.index + match[0].length - 1);
    const body = extractBlock(match.index);
    output += body + '\n\n';
  } else {
    // Maybe an arrow function?
    const r2 = new RegExp(`const\\s+${fn}\\s*=\\s*\\([^)]*\\)\\s*=>\\s*\\{`);
    const m2 = r2.exec(code);
    if (m2) {
      output += extractBlock(m2.index) + '\n\n';
    } else {
        console.log("NOT FOUND:", fn);
    }
  }
}

output += `\nmodule.exports = function(ctx) {\n`;
output += `  // Inject variables that need context\n`;
output += `  return {\n`;
for (const v of missingVars) output += `    ${v},\n`;
for (const f of missingFunctions) output += `    ${f},\n`;
output += `  };\n};\n`;

fs.writeFileSync('lib/legacy.js', output);
console.log("Wrote lib/legacy.js");
