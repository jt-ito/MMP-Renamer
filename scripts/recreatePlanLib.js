const fs = require('fs');
const acorn = require('acorn');

const code = fs.readFileSync('pure_old_server.js', 'utf8');
const ast = acorn.parse(code, { ecmaVersion: 2022, locations: true, ranges: true });

let planCode = '';

function walk(node) {
  if (!node) return;
  if (node.type === 'FunctionDeclaration' && node.id && node.id.name === 'generatePlanForItem') {
    planCode = code.substring(node.range[0], node.range[1]);
    return;
  }
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

if (planCode) {
  // Wrap the body of generatePlanForItem in a try...catch block
  planCode = planCode.replace(
    /function generatePlanForItem\([^)]*\)\s*\{([\s\S]*)\}/,
    (match, body) => {
      return match.replace(body, `\n    try {\n${body}\n    } catch (e) {\n      if (typeof appendLog === 'function') appendLog(\`PLAN_GEN_ERROR item=\${it && it.canonicalPath} err=\${e && e.message}\`);\n      console.error('generatePlanForItem error:', e);\n      return null;\n    }\n  `);
    }
  );

  const finalCode = `module.exports = function buildPlanGenerator(ctx) {
  const {
    fs, path, sanitizeForFilename, extractSeasonNumberFromTitle, tvdbInfo, tvdbInfoParent,
    resolveSeriesTitle, extractEnglishSeriesTitle, getSeriesAlias, stripEpisodeArtifactsForFolder,
    stripTrailingYear, stripSeasonNumberSuffix, cleanTitleForRender,
    app, requireAuth, requireAdmin, enrichStoreFile, parsedCacheFile, renderedIndexFile, logsFile, hideEvents,
    db, enrichCache, activeScans, refreshProgress, sseClients, appendLog, performUnapprove,
    DEFAULT_METADATA_PROVIDER_ORDER, METADATA_PROVIDER_IDS,
    updateEnrichCacheInMemory, schedulePersistEnrichCache, cleanEnrichmentForClient,
    canonicalize, extractYear, sanitize, users, serverSettings, determineIsMovie, titleCase,
    getMaxFilenameLengthForOS, truncateFilenameComponent, ensureRenderedNameHasYear
  } = ctx;

  ${planCode}

  return generatePlanForItem;
};
`;
  fs.writeFileSync('lib/plan.js', finalCode);
  console.log('Recreated lib/plan.js successfully using Acorn!');
} else {
  console.error('Could not find generatePlanForItem');
}
