const fs = require('fs');
const acorn = require('acorn');

const missingFunctions = [
  'isMeaningfulTitle', 'isPlaceholderTitle', 'extractSeasonNumberFromTitle', 
  'fullScanLibrary', 'searchTmdbAndEpisode', 'incrementalScanLibrary',
  'loadScanCache', 'saveScanCache', 'lookupWikipediaEpisode',
  'cleanEnrichmentForClient', 'sanitizeExtraGuess', 'renderCustomMetadataName',
  'updateEnrichCacheInMemory', 'sweepEnrichCache', 'normalizeForCache',
  'normalizeOutputKey', 'buildApprovedSeriesPayload', 'getApprovedSeriesSourcePreferences',
  'resolveApprovedSeriesSourcePreference', 'normalizeApprovedSeriesSource',
  'setApprovedSeriesSourcePreference', 'fetchAndCacheApprovedSeriesImage',
  'createBgJob', 'resolveMetadataProviderOrder', 'pace', 'deriveAppliedSeriesInfo'
];

const missingVars = ['IGNORED_DIRS', 'VIDEO_EXTS', 'hostPace'];

const code = fs.readFileSync('pure_old_server.js', 'utf8');

// Parse the code using acorn
const ast = acorn.parse(code, { ecmaVersion: 2022, locations: true, ranges: true });

let output = `\n// --- RESTORED LEGACY FUNCTIONS ---\n\n`;
let foundCount = 0;

function walk(node) {
  if (!node) return;
  
  if (node.type === 'FunctionDeclaration') {
    if (node.id && missingFunctions.includes(node.id.name)) {
      output += code.substring(node.range[0], node.range[1]) + '\n\n';
      foundCount++;
    }
  } else if (node.type === 'VariableDeclaration') {
    for (const dec of node.declarations) {
      if (dec.id && missingFunctions.includes(dec.id.name) && dec.init && (dec.init.type === 'ArrowFunctionExpression' || dec.init.type === 'FunctionExpression')) {
        output += code.substring(node.range[0], node.range[1]) + '\n\n';
        foundCount++;
      }
      if (dec.id && missingVars.includes(dec.id.name)) {
        output += code.substring(node.range[0], node.range[1]) + '\n\n';
        foundCount++;
      }
    }
  }
  
  // Recurse into children
  for (const key in node) {
    if (node.hasOwnProperty(key)) {
      const child = node[key];
      if (Array.isArray(child)) {
        child.forEach(c => walk(c));
      } else if (child && typeof child === 'object' && child.type) {
        walk(child);
      }
    }
  }
}

walk(ast);

fs.writeFileSync('raw-legacy.js', output);
console.log(`Wrote raw-legacy.js using acorn successfully! Found ${foundCount} items.`);
