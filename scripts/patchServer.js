const fs = require('fs');

let server = fs.readFileSync('server.js', 'utf8');
const legacy = fs.readFileSync('raw-legacy.js', 'utf8');

const globalsStr = `
const scanLib = require('./lib/scan');
const tvdbLib = require('./lib/tvdb');
const { tvdbInfo, tvdbInfoParent } = tvdbLib;
const { sanitizeForFilename } = require('./lib/filename-parser');
const lastRequestAt = {};

function isProviderComplete(prov) {
  if (!prov) return false;
  const complete = !!(prov.matched && prov.renderedName && (prov.episode == null || (prov.episodeTitle && String(prov.episodeTitle).trim())));
  return complete;
}
`;

// Inject legacy code
if (server.includes('const ctx = {')) {
  server = server.replace('const ctx = {', globalsStr + legacy + '\nconst ctx = {\n    ' + 
    'isMeaningfulTitle, isPlaceholderTitle, extractSeasonNumberFromTitle, fullScanLibrary, ' +
    'searchTmdbAndEpisode, incrementalScanLibrary, loadScanCache, saveScanCache, ' +
    'lookupWikipediaEpisode, cleanEnrichmentForClient, sanitizeExtraGuess, ' +
    'renderCustomMetadataName, updateEnrichCacheInMemory, sweepEnrichCache, ' +
    'normalizeForCache, normalizeOutputKey, buildApprovedSeriesPayload, ' +
    'getApprovedSeriesSourcePreferences, resolveApprovedSeriesSourcePreference, ' +
    'normalizeApprovedSeriesSource, setApprovedSeriesSourcePreference, ' +
    'fetchAndCacheApprovedSeriesImage, createBgJob, resolveMetadataProviderOrder, ' +
    'bgJobs, approvedSeriesImages, approvedSeriesImageFetchLocks, tvdbInfo, tvdbInfoParent, ' +
    'resolveCopySidecarSubtitlesSetting, copyExternalSubtitles, resolveExtractSubtitlesSetting, ' +
    'resolveExtractSubtitleFormat, extractSubtitlesToSrt, resolveHardsubSetting, ' +
    'resolveHardsubLanguage, burnHardsubToFile, sanitizeForFilename, determineIsMovie, ' +
    'ensureRenderedNameHasYear, SUBTITLE_EXTS, VALID_SUBTITLE_FORMATS, sanitize, ' +
    'hideEventsClientCache, HIDE_EVENTS_CACHE_WINDOW_MS, pace, deriveAppliedSeriesInfo,\n    ');
  
  // Remove the old IGNORED_DIRS and VIDEO_EXTS to avoid double declaration
  server = server.replace("  const IGNORED_DIRS = new Set(['node_modules', '.git', '.svn', '__pycache__']);", '');
  server = server.replace("  const VIDEO_EXTS = ['mkv', 'mp4', 'avi', 'mov', 'm4v', 'mpg', 'mpeg', 'webm', 'wmv', 'flv', 'ts', 'ogg', 'ogv', '3gp', '3g2'];", '');

  fs.writeFileSync('server.js', server);
  console.log('Successfully patched server.js with globals and ALL missing variables!');
} else {
  console.log('Could not find "const ctx = {" in server.js');
}
