// Simplified parser: return series/movie title plus season and episode numbers
// Slightly smarter parser: extract title + season/episode and conservatively detect episodeTitle on the right-hand side
function cleanToken(str) {
  if (!str) return '';
  let t = String(str).replace(/\[[^\]]+\]/g, ' ').replace(/\([^\)]+\)/g, ' ');
  t = t.replace(/[\._\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/[-_ ]+[A-Z0-9]{2,}(?:\-[A-Z0-9]{2,})?$/i, ' ');
  t = t.replace(/[\[\]{}()'"!~,;:@#%^&*=+<>/?\\]/g, ' ').replace(/\s+/g, ' ').trim();
  return t;
}

// lighter cleaning for series/title extraction: preserve trailing title words (don't strip uppercase group tokens)
function cleanSeries(str) {
  if (!str) return '';
  let t = String(str).replace(/\[[^\]]+\]/g, ' ').replace(/\([^\)]+\)/g, ' ');
  t = t.replace(/[\._\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/[\[\]{}()'"!~,;:@#%^&*=+<>/?\\]/g, ' ').replace(/\s+/g, ' ').trim();
  return t;
}

const path = require('path');
const fs = require('fs');

// Attempt to read configured scan input path from data/settings.json so the
// filename parser will ignore the library root when given a full path.
let configuredScanInput = null;
try {
  const settingsFile = path.resolve(__dirname, '..', 'data', 'settings.json');
  if (fs.existsSync(settingsFile)) {
    const sraw = fs.readFileSync(settingsFile, 'utf8') || '{}';
    const sjson = JSON.parse(sraw || '{}');
    if (sjson && sjson.scan_input_path) configuredScanInput = String(sjson.scan_input_path).trim();
  }
} catch (e) { /* best-effort */ }
// Also allow override via environment variable
if (!configuredScanInput && process.env.SCAN_INPUT_PATH) configuredScanInput = process.env.SCAN_INPUT_PATH;

function stripConfiguredScanPrefix(original) {
  try {
    if (!original) return original;
    if (!configuredScanInput) return original;
    const normOrig = String(original).replace(/\\/g, '/');
    let normScan = String(configuredScanInput).replace(/\\/g, '/');
    // remove trailing slash
    normScan = normScan.replace(/\/+$|\/+$/g, '');
    // case-insensitive compare on Windows-like drives, otherwise compare as-is
    if (normOrig.toLowerCase().startsWith(normScan.toLowerCase())) {
      let out = normOrig.slice(normScan.length);
      // if remaining starts with separator, remove it
      if (out.startsWith('/')) out = out.slice(1);
      return out || original;
    }
    return original;
  } catch (e) { return original }
}
// Helper: parse episode numeric token allowing fractional only for .5 or .5.xxx patterns
function parseEpisodeNumber(raw) {
  const s = String(raw || '')
  if (s.indexOf('.') >= 0) {
    const parts = s.split('.')
    const intPart = parts[0] || ''
    const fracPart = parts.slice(1).join('.')
    if (fracPart === '5' || fracPart.startsWith('5.')) return parseFloat(s)
    const n = parseInt(intPart, 10)
    return Number.isNaN(n) ? null : n
  }
  const n = parseInt(s, 10)
  return Number.isNaN(n) ? null : n
}
module.exports = function parseFilename(name) {
  const original = String(name || '').trim();
  // If a configured scan input path exists, strip it from any full path so
  // parent/mount tokens from the library root aren't considered when parsing.
  const analyzed = stripConfiguredScanPrefix(original);
  // If caller passed a full path, prefer the basename for parsing to avoid
  // parent/mount point tokens leaking into the detected title. We still
  // preserve `original` in the return value for callers that need it.
  const basename = path.basename(analyzed, path.extname(analyzed));
  // (no year extraction here; year should come from provider APIs)
  // If the caller passed a full path and the basename looks like an "episode-only"
  // filename (e.g., 'S01E01 - Title' or '01 - Title'), prefer using the parent
  // directory name as the series title context so we don't accidentally make the
  // episode title the series title. We'll detect episode-only basenames by
  // checking for leading Sxx or a leading numeric token followed by non-noise text.
  let preferParentDir = false;
  try {
    const baseCheck = basename.trim();
    if (/^S0*\d{1,2}[EPp]/i.test(baseCheck)) preferParentDir = true;
    else if (/^\d{1,3}[\s_\-]+/.test(baseCheck)) preferParentDir = true;
  } catch (e) { /* ignore */ }
  let parentDirName = null;
  let parentSeriesCandidate = null;
  try {
    // treat both Windows and POSIX separators as path indicators so parser works
    // with paths from Docker/Linux mounts as well as native Windows paths
    const isPath = /[\\/]/.test(analyzed);
    if (isPath) {
      const normalized = analyzed.replace(/\//g, path.sep);
      const dirPath = path.dirname(normalized);
      let segments = dirPath.split(path.sep).filter(Boolean);
      const ROOT_PREFIX_TOKENS = new Set(['', 'mnt','media','volume','volumes','storage','nas','share','shares','srv','data','library','input','output','home','users','public']);
      const GENERIC_LIBRARY_NAMES = new Set(['anime','animes','manga','mangas','shows','series','tv','television','movies','movie','films','film','cartoons','animation']);
      const isWindowsDrive = (seg) => /^[A-Za-z]:$/.test(String(seg || ''));
      let removedPrefix = false;
      while (segments.length) {
        const seg = segments[0];
        if (!seg) { segments.shift(); continue; }
        const lower = String(seg).toLowerCase();
        if (isWindowsDrive(seg) || ROOT_PREFIX_TOKENS.has(lower)) {
          removedPrefix = true;
          segments.shift();
          continue;
        }
        break;
      }
      if (segments.length > 1 && GENERIC_LIBRARY_NAMES.has(String(segments[0]).toLowerCase())) {
        removedPrefix = true;
        segments.shift();
      }
      if (segments.length && segments[0] && segments[0].length <= 4 && /^[a-z0-9]+$/i.test(segments[0]) && removedPrefix) {
        segments.shift();
      }
      if (segments.length > 0) parentDirName = segments[segments.length - 1] ? String(segments[segments.length - 1]) : null;
      for (let i = segments.length - 1; i >= 0; i--) {
        const seg = segments[i];
        if (!seg) continue;
        const cleanedSeg = cleanSeries(seg);
        if (!cleanedSeg) continue;
        const lowered = cleanedSeg.toLowerCase();
        if (/^(?:season|seasons?|special|specials|extras|extra|bonus|ova|ovas|movie|movies|film|films|collection|collections)$/i.test(lowered)) continue;
        if (/^s0*\d+$/.test(lowered)) continue;
        if (/^sp\d*$/i.test(lowered)) continue;
        if (/^\d{1,3}$/.test(lowered)) continue;
        parentSeriesCandidate = seg;
        break;
      }
      if (!parentSeriesCandidate && parentDirName) parentSeriesCandidate = parentDirName;
    }
  } catch (e) { parentDirName = null; parentSeriesCandidate = null }
  if (parentSeriesCandidate) parentDirName = parentSeriesCandidate ? String(parentSeriesCandidate) : parentDirName;
  // Sanitize parentDirName when we'll prefer it: strip trailing Sxx markers and release noise
  let parentSeriesClean = null;
  try {
    if (parentDirName) {
      let p = String(parentDirName || '').replace(/[\._\-]+/g, ' ').trim();
      // Cut off at any Sxx marker (e.g., 'Show Name S01 ...')
      p = p.split(/\bS0*\d{1,2}\b/i)[0].trim();
      const noiseList = ['x264','x265','h264','h265','hevc','avc','10bit','8bit','12bit','bluray','bdrip','bdr','brrip','webrip','web-dl','webdl','hdtv','hdrip','dvdrip','dvdr','cam','ts','tvrip','dvd','remux','proper','repack','limited','uncut','internal','extended','fansub','1080p','720p','2160p','4k','2160','1080','480p','360p','8k','dual','audio','dual-audio','dual_audio','dub','sub'];
      const toks = p.split(/\s+/).filter(Boolean);
      for (let i = 0; i < toks.length; i++) {
        if (i === 0) continue;
        const tl = toks[i].toLowerCase();
        if (noiseList.some(n => tl.startsWith(n)) || /^\d{3,4}p$/.test(tl)) { toks.splice(i); break; }
      }
      const reduced = toks.join(' ').trim();
      const cleaned = cleanSeries(reduced || parentDirName);
      parentSeriesClean = cleaned || null;
      if (parentSeriesClean) {
        parentSeriesClean = parentSeriesClean.replace(/\bS0*\d{1,2}(?:[EPp]0*\d{1,3}(?:\.\d+)?)?\b/ig, ' ').replace(/\bSP\b/ig, ' ').replace(/\bP0*\d{1,3}\b/ig, ' ').replace(/\s+/g, ' ').trim();
      }
    }
  } catch (e) { parentSeriesClean = parentDirName ? cleanSeries(parentDirName) : parentSeriesClean }
  if (preferParentDir && parentDirName) {
    // use parentDirName in place of basename to avoid episode-title-as-series
    // regressions when parsing files inside a season folder like 'Aparida S01/...'
    // we'll set `basenameForParsing` and continue using it
    // NOTE: keep `original` unchanged
    // eslint-disable-next-line no-unused-vars
    const _basenameFallback = parentDirName;
  }
  // If we prefer the parent directory as the title context, use it for
  // parsing the series title. However keep the original filename `basename`
  // available for episode detection (e.g. S01E01 tokens). Use
  // `basenameForParsing` for title heuristics and `basename` for episode
  // detection to avoid mis-classifying episode text as the series name.
  // preserve decimal episode markers (e.g. S01E11.5) across dot/underscore cleaning
  // Use the actual file basename for episode detection to avoid losing SxxEyy markers
  const preservedDecimals = String(basename).replace(/(S0*\d{1,2}[EPp]0*\d{1,3})\.(\d+(?:\.\d+)?)/ig, (m, g1, g2) => `${g1}::DEC::${g2}`);
  const cleaned = preservedDecimals.replace(/[\._\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  let season = null, episode = null, episodeTitle = '';
  let episodeRange = null;
  let episodeLocked = false; // when true, do not let loose numeric heuristics overwrite detected episode

  // remove bracketed groups/parentheses for cleaner matching
  let withoutBrackets = cleaned.replace(/\[[^\]]+\]/g, ' ').replace(/\([^\)]+\)/g, ' ').replace(/\s+/g, ' ').trim();
  // restore preserved decimal markers back to dots so regexes can detect decimal episodes
  withoutBrackets = withoutBrackets.replace(/::DEC::/g, '.');

  // Strip version suffixes like 'v2' or 'V03' when they are attached directly to
  // episode tokens or numeric tokens. This helps parse filenames such as
  // '... S01E01v2' or '... 01v2' by removing the trailing version marker for
  // the purpose of detection while preserving decimal episodes (e.g. 11.5).
  try {
    withoutBrackets = withoutBrackets.replace(/\b(S0*\d{1,2}[EPp]0*\d{1,3}(?:\.\d+)?)[vV]\d+\b/g, '$1');
    withoutBrackets = withoutBrackets.replace(/\b(\d{1,3}(?:\.\d+)?)[vV]\d+\b/g, '$1');
  } catch (e) { /* non-fatal */ }

  // remove explicit dual-audio markers in their common forms (e.g., "Dual Audio", "Dual-Audio", "dual_audio")
  withoutBrackets = withoutBrackets.replace(/\b(?:audio[._\- ]*dual|dual[._\- ]*audio)\b/ig, ' ').replace(/\s+/g, ' ').trim();

  // normalize plus signs which are commonly used in release names (e.g. S01+SP)
  withoutBrackets = withoutBrackets.replace(/\+/g, ' ').replace(/\s+/g, ' ').trim();

  let title = withoutBrackets;
  // do not extract years from filenames; provider APIs supply authoritative year data
  let anchorIdx = -1;

  // Early heuristic: if a season marker (S01, S01E01, S01P01) appears early in the name,
  // assume the text to the left is the series title. This helps with names like
  // "86 S01+SP ..." where the numeric series title appears before the season token.
  try {
  const seasonMarker = withoutBrackets.match(/\bS0*(\d{1,2})(?:[EPp]0*(\d{1,3}(?:\.\d+)?))?(?=\b|[^a-z0-9]|$)/i);
    if (seasonMarker) {
      const marker = seasonMarker[0];
      const idx = withoutBrackets.toLowerCase().indexOf(marker.toLowerCase());
      if (idx > 0) {
        const left = withoutBrackets.slice(0, idx).trim();
        if (left) {
          // Use lighter series cleaning so we don't strip short numeric titles
          const candidate = cleanSeries(left);
          if (candidate) {
            title = candidate;
            anchorIdx = idx; // remember where the season marker was found so we can anchor subsequent episode searches
            // set detected season/episode conservatively
            if (!season) season = parseInt(seasonMarker[1], 10);
            if (seasonMarker[2] && !episode) { episode = parseInt(seasonMarker[2], 10); episodeLocked = true; }
          }
        }
      }
    }
    // If we anchored to a season marker but didn't find an episode number there,
    // prefer any explicit SxxPyy/SxxEyy pattern found elsewhere in the full string (common in nested paths)
    try {
    if (anchorIdx >= 0 && (episode == null)) {
    const explicit = withoutBrackets.match(/\bS0*(\d{1,2})[EPp]0*(\d{1,3}(?:\.\d+)?)\b/i);
    if (explicit) {
      season = parseInt(explicit[1], 10);
  const rawE = String(explicit[2] || '');
  episode = parseEpisodeNumber(rawE);
      episodeLocked = true;
            // promote the explicit match into the main match so downstream logic uses it
            // build a match-like array similar to RegExp.exec
            try { match = [explicit[0], explicit[1], explicit[2]]; if (anchorIdx < 0) anchorIdx = withoutBrackets.toLowerCase().indexOf(explicit[0].toLowerCase()); } catch(e) {}
          }
      }
    } catch (e) { /* ignore */ }
  } catch (e) { /* non-fatal */ }

  // Dash-based patterns (try most specific to least specific):
  // 1) Title - S01E02 - Episode Title
  // 2) Title - 1x02 - Episode Title
  // 3) Title - 01-02 - Episode Title  (multi-episode range)
  // 4) Title - 01 - Episode Title
  const hyphenDashPatterns = [
    { re: /^(.+?)\s*[-–—]\s*S(\d{1,2})E(\d{1,3}(?:\.\d+)?)(?:\s*[-–—]\s*(.+))?$/i, type: 'sxxexx' },
    { re: /^(.+?)\s*[-–—]\s*(\d{1,2})x(\d{1,3})(?:\s*[-–—]\s*(.+))?$/i, type: 'x' },
    { re: /^(.+?)\s*[-–—]\s*0*(\d{1,3})\s*[-–—]\s*0*(\d{1,3})(?:\s*[-–—]\s*(.+))?$/, type: 'range' },
    { re: /^(.+?)\s*[-–—]\s*0*(\d{1,3})(?:\s*[-–—]\s*(.+))?$/, type: 'single' }
  ];

  const dashPatternsLoose = [
    { re: /^(.+?)[\s_\-–—]+S(\d{1,2})E(\d{1,3}(?:\.\d+)?)[\s_\-–—]+(.+)$/i, type: 'sxxexx' },
    { re: /^(.+?)[\s_\-–—]+(\d{1,2})x(\d{1,3})[\s_\-–—]+(.+)$/i, type: 'x' },
    { re: /^(.+?)[\s_\-–—]+0*(\d{1,3})[\s_\-–—]+0*(\d{1,3})[\s_\-–—]+(.+)$/, type: 'range' },
    { re: /^(.+?)[\s_\-–—]+0*(\d{1,3})[\s_\-–—]+(.+)$/, type: 'single' }
  ];

  let dashApplied = false;
  const applyDashMatch = (m, dp) => {
    if (!m || dashApplied) return;
    dashApplied = true;
    // left side is series title candidate; use lighter cleaning to avoid removing legitimate title words
    title = cleanSeries(m[1]);
    const pickDefaultSeason = () => {
      try {
        const leftRaw = m[1] || '';
        const leftTrim = String(leftRaw).trim();
        if (!leftTrim) return 1;
        const words = leftTrim.split(/\s+/).filter(Boolean);
        const seasonWord = leftTrim.match(/season[^0-9a-z]{0,3}(\d{1,2})/i) || leftTrim.match(/season\s*(\d{1,2})/i);
        if (seasonWord && seasonWord[1]) {
          const num = parseInt(seasonWord[1], 10);
          if (!Number.isNaN(num)) return num;
        }
  const trailingMatch = leftTrim.match(/(\d{1,2})$/);
        const trailingNum = trailingMatch ? parseInt(trailingMatch[1], 10) : null;
        const looksLikeRelease = /\[[^\]]+\]|\b(BDRIP|WEB|WEBRIP|WEBDL|BDRIP|BD|HEVC|x264|x265)\b/i.test(leftTrim) || /\[[^\]]+\]/.test(original);
        if (trailingNum != null) {
          const precedingWord = words.length >= 2 ? words[words.length - 2].toLowerCase() : '';
          const blockedSet = new Set(['part','movie','film','volume','vol','chapter','episode','ep','ova','special','sp','disc']);
          const validSequel = trailingNum >= 2 && trailingNum <= 12 && words.length >= 3 && !blockedSet.has(precedingWord);
          if (validSequel) return trailingNum;
        }
        if (!trailingNum || looksLikeRelease || words.length <= 2) return 1;
        return 1;
      } catch (e) {
        return 1;
      }
    };
    if (dp.type === 'sxxexx') {
      season = parseInt(m[2], 10);
      const rawE = String(m[3] || '');
      episode = parseEpisodeNumber(rawE);
    } else if (dp.type === 'x') {
      season = parseInt(m[2], 10);
      episode = parseInt(m[3], 10);
    } else if (dp.type === 'range') {
      const a = parseInt(m[2], 10);
      const b = parseInt(m[3], 10);
      if (!Number.isNaN(a)) episode = a;
      if (!Number.isNaN(b)) episodeRange = `${String(a).padStart(2,'0')}-${String(b).padStart(2,'0')}`;
      if (season == null) {
        const inferredSeason = pickDefaultSeason();
        if (typeof inferredSeason === 'number') season = inferredSeason;
      }
    } else if (dp.type === 'single') {
      const a = parseInt(m[2], 10);
      if (!Number.isNaN(a)) {
        episode = a;
        if (season == null) {
          const inferredSeason = pickDefaultSeason();
          if (typeof inferredSeason === 'number') season = inferredSeason;
        }
      }
    }

    // right side is the episode title candidate (may include noise)
    const rightRaw = m[m.length - 1] || '';
    let rightSide = cleanToken(rightRaw);
    const noiseTokens = ['x264','x265','h264','h265','hevc','avc','10bit','8bit','12bit','bluray','bdrip','bdr','brrip','webrip','web-dl','webdl','hdtv','hdrip','dvdrip','dvdr','cam','ts','tvrip','dvd','remux','proper','repack','limited','uncut','internal','extended','fansub','1080p','720p','2160p','4k','2160','1080','480p','360p','8k'];
    // accept 'bit'/'bits' in noise tokens too
    if (!noiseTokens.includes('bit')) noiseTokens.push('bit','bits');
    const rToks0 = rightSide.split(/\s+/).filter(Boolean);
    let cutIdx = -1;
    for (let i = 0; i < rToks0.length; i++) {
      const t = rToks0[i].toLowerCase();
      if (i === 0) continue;
      if (noiseTokens.includes(t) || /^\d{3,4}p$/.test(t) || noiseTokens.some(n => t.startsWith(n))) { cutIdx = i; break; }
    }
    if (cutIdx >= 0) rToks0.splice(cutIdx);
    const candidateTitle = rToks0.join(' ').trim();
    if (candidateTitle) episodeTitle = candidateTitle;
  };

  // First, attempt to match patterns that require an explicit hyphen/dash separator so sequel numerals stay in the series title.
  let hyphenSource = null;
  try {
    hyphenSource = String(basename || '').replace(/\[[^\]]+\]/g, ' ').replace(/\([^\)]+\)/g, ' ');
    hyphenSource = hyphenSource.replace(/[\._]+/g, ' ');
    hyphenSource = hyphenSource.replace(/\s*([-–—])\s*/g, ' $1 ');
    hyphenSource = hyphenSource.replace(/\s+/g, ' ').trim();
    if (!hyphenSource) hyphenSource = null;
  } catch (e) { hyphenSource = null; }

  if (hyphenSource) {
    for (const dp of hyphenDashPatterns) {
      const m = hyphenSource.match(dp.re);
      if (!m) continue;
      applyDashMatch(m, dp);
      break; // only apply first matching dash pattern
    }
  }

  // Fallback to the looser whitespace-based patterns if no hyphen-delimited match succeeded.
  if (!dashApplied) {
    for (const dp of dashPatternsLoose) {
      const m = withoutBrackets.match(dp.re);
      if (!m) continue;
      applyDashMatch(m, dp);
      if (dashApplied) break;
    }
  }

  // If a dash pattern matched we already filled season/episode/episodeRange/title/episodeTitle — skip other pattern heuristics
  const matchedDash = dashApplied;

  // Extra heuristic: handle cases like "Title - 06 [WEB ...]" where the RHS after the
  // dash is only noise (WEB/1080p/codec) or empty. Treat the numeric token after the
  // dash as the episode number rather than part of the series title. This helps
  // filenames such as "Chuhai Lips - 06 [WEB 1080p ...].mkv" parse correctly.
  if (!matchedDash) {
    try {
      const mSimple = withoutBrackets.match(/^(.+?)[\s_\-–—]+0*(\d{1,3})(?:[\s_\-–—]+(.*))?$/);
      if (mSimple) {
        const left = (mSimple[1] || '').trim();
        const num = parseInt(mSimple[2], 10);
        const right = (mSimple[3] || '').trim();
        // If right side is empty or contains only noise tokens, accept this as Title - <ep>
        const noiseList = ['x264','x265','h264','h265','hevc','avc','10bit','8bit','12bit','bluray','bdrip','bdr','brrip','webrip','web-dl','webdl','hdtv','hdrip','dvdrip','dvdr','cam','ts','tvrip','dvd','remux','proper','repack','limited','uncut','internal','extended','fansub','1080p','720p','2160p','4k','2160','1080','480p','360p','8k','web','nw','uncensored','censored','dual','audio','dual-audio','dual_audio','dub','sub','eng','engsub','engsubs'];
        const rightTokens = (right ? right.replace(/[\[\]()]/g, ' ').split(/\s+/).filter(Boolean) : []);
        let onlyNoise = true;
        for (let t of rightTokens) {
          const tl = t.toLowerCase();
          if (/^\d{3,4}p$/.test(tl)) continue;
          if (noiseList.some(n => tl.startsWith(n))) continue;
          // if token contains any letter/digit that isn't noise, treat as non-noise
          onlyNoise = false; break;
        }
        if (rightTokens.length === 0 || onlyNoise) {
          // accept as episode marker
          title = cleanSeries(left) || title;
          episode = num;
          if (season == null) season = 1;
          episodeTitle = '';
        }
      }
    } catch (e) { /* ignore */ }
  }

  // Prefer explicit SxxPyy/SxxEyy markers (P for specials) before falling back to numeric heuristics
  const patterns = [ /\bS(\d{1,2})[EPp](\d{1,3}(?:\.\d+)?)\b/i, /\bS(\d{1,2})E(\d{1,3}(?:\.\d+)?)\b/i, /\b(\d{1,2})x(\d{1,3})\b/i, /\b(?:Ep(?:isode)?|E)\.?[ _-]{0,3}(\d{1,3})\b/i ];
  let match = null;
  // If we previously detected a season marker to the left, anchor our episode-search to that point
  const searchForEpisode = (anchorIdx >= 0) ? withoutBrackets.slice(anchorIdx) : withoutBrackets;
  if (!matchedDash) {
    for (const p of patterns) {
      const m = searchForEpisode.match(p);
      if (m) { match = m; break; }
    }
  }
  // If no episode found yet, look for an isolated numeric token that likely represents episode
  if (episode == null && !episodeLocked) {
  // limit numeric-token heuristics to the anchored substring when available to avoid picking up release-noise earlier in the name
  const tokens = searchForEpisode.split(/\s+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (!/^\d{1,3}$/.test(tok)) continue;
      const num = parseInt(tok, 10);
      // skip 4-digit years
      if (tok.length === 4) continue;
      const next = tokens[i+1] ? tokens[i+1].toLowerCase() : '';
      const prev = tokens[i-1] ? tokens[i-1].toLowerCase() : '';
      // heuristic: treat as episode if it's the last token, or followed by a noise token (720p, x264...), or preceded by 'ep'/'episode'
      const noiseAfter = /^\d{3,4}p$/.test(next) || (next && (next.startsWith('x264') || next.startsWith('x265') || next.startsWith('web') || next.startsWith('hd') || next.startsWith('bluray') || next.startsWith('bdr') || next.startsWith('webrip') || next.startsWith('bdrip') || next.startsWith('fansub')));
      if (i === tokens.length - 1 || noiseAfter || prev === 'ep' || prev === 'episode' || prev === '-') {
        episode = num;
        if (season == null) season = 1; // assume season 1 when missing
        // Conservative attempt: take tokens after the numeric token as an episode title candidate
        try {
          const rightTokens = tokens.slice(i + 1).filter(Boolean);
          // join and clean, truncate at known noise tokens
          if (rightTokens.length > 0) {
            let cand = rightTokens.join(' ');
            cand = cand.replace(/\[[^\]]+\]/g, ' ').replace(/[\._\-]+/g, ' ').replace(/[\[\]{}()"'!~,;:@#%^&*=+<>/?\\]/g, ' ').replace(/\s+/g, ' ').trim();
            cand = cand.split(/(?:x264|x265|h264|h265|hevc|10bit|8bit|bluray|bdrip|webrip|web-dl|1080p|720p|2160p|4k)/i)[0].trim();
            if (cand && /[A-Za-z]/.test(cand) && cand.length > 1) episodeTitle = cand;
          }
        } catch (e) { /* ignore */ }
        // remove that numeric token from title tokens
  // remove that numeric token from the token list we were examining
  tokens.splice(i, 1);
        break;
      }
    }
  }

  if (episode == null && !episodeLocked) {
    try {
      const baseForBrackets = String(basename || '');
  const bonusLike = /(NCOP|NCED|OP|ED|Featurette|Extras?|OVA|ONA|PV|Menu|Special|Creditless|NC)/i.test(baseForBrackets) || /(NCOP|NCED|OP|ED|Featurette|Extras?|OVA|ONA|PV|Menu|Special|Creditless|NC)/i.test(original);
      if (!bonusLike) {
      const combined = [];
      combined.push(...Array.from(baseForBrackets.matchAll(/\[(\d{1,3})\]/g)));
      combined.push(...Array.from(baseForBrackets.matchAll(/\((\d{1,3})\)/g)));
      combined.push(...Array.from(baseForBrackets.matchAll(/\((?:Ep(?:isode)?)[^0-9]{0,3}(\d{1,3})\)/ig)));
      combined.push(...Array.from(baseForBrackets.matchAll(/(?:Ep(?:isode)?)[^0-9]{0,3}(\d{1,3})/ig)));
      for (const bm of combined) {
        if (!bm || !bm[1]) continue;
        const num = parseInt(bm[1], 10);
        if (Number.isNaN(num)) continue;
        if (num >= 0 && num <= 200) {
          episode = num;
          episodeLocked = true;
          if (season == null) season = 1;
          break;
        }
      }
      }
    } catch (e) { /* ignore */ }
  }

  if (match) {
    if (/^S\d+/i.test(match[0])) {
      const sVal = parseInt(match[1], 10);
  const rawE = String(match[2] || '');
  const eVal = parseEpisodeNumber(rawE);
      if (!episodeLocked) { season = sVal; episode = eVal; }
      else { if (season == null) season = sVal; }
    } else if (/x/i.test(match[0])) {
      const sVal = parseInt(match[1], 10);
      const eVal = parseInt(match[2], 10);
      if (!episodeLocked) { season = sVal; episode = eVal; }
      else { if (season == null) season = sVal; }
    } else {
      if (!episodeLocked) { season = null; episode = parseInt(match[1], 10); }
    }

    // split on first occurrence of the matched token
    const idx = withoutBrackets.toLowerCase().indexOf(match[0].toLowerCase());
    if (idx >= 0) {
      title = withoutBrackets.slice(0, idx).trim();
      let right = withoutBrackets.slice(idx + match[0].length).replace(/^[-\s:._]+/, '').trim();

      // remove dual-audio from right as well
      right = right.replace(/\b(?:audio[._\- ]*dual|dual[._\- ]*audio)\b/ig, ' ').replace(/\s+/g, ' ').trim();

      // truncate right-hand side at the first noise token (codec/res/resolution/release-group), but only if that token is not the first word
  const noiseTokens = ['x264','x265','h264','h265','hevc','avc','10bit','8bit','12bit','bluray','bdrip','bd25','bd50','bdremux','bdr','brrip','webrip','web-dl','webdl','hdtv','hdrip','dvdrip','dvdr','cam','ts','tvrip','dvd','remux','proper','repack','limited','uncut','internal','extended','fansub','yify','ettv','rarbg','anidb','1080p','720p','2160p','4k','2160','1080','480p','360p','8k'];
  // include 'bit' tokens which often follow numeric values ("10 bits")
  if (!noiseTokens.includes('bit')) noiseTokens.push('bit','bits');
      const rToks = right.split(/\s+/).filter(Boolean);
      let cutIndex = -1;
      for (let i = 0; i < rToks.length; i++) {
        const t = rToks[i].toLowerCase();
        if (i === 0) continue; // do not truncate if noise is the first token
        // exact match or startsWith (e.g., '1080p', '1080p.bdrip') or numeric-res pattern
        if (noiseTokens.includes(t) || /^\d{3,4}p$/.test(t) || noiseTokens.some(n => t.startsWith(n))) { cutIndex = i; break; }
      }
      if (cutIndex >= 0) rToks.splice(cutIndex);
      const candidate = cleanToken(rToks.join(' '));
      if (candidate && /[A-Za-z]/.test(candidate) && candidate.length > 2) {
        episodeTitle = candidate;
      }
    }
  }

  // Remove trailing noise tokens from title
  const noise = new Set(['x264','x265','h264','h265','hevc','avc','10bit','8bit','12bit','bluray','bdrip','bd25','bd50','bdremux','bdr','brrip','webrip','web-dl','webdl','hdtv','hdrip','dvdrip','dvdr','cam','ts','tvrip','dvd','remux','remastered','proper','repack','limited','uncut','internal','extended','dual','audio','dual-audio','dual_audio','multi','dub','dubbed','subbed','fansub','eng','engsub','engsubs','jpn','japanese','english','subs','sub','ass','srt','ssa','aac','ac3','dts','flac','mp3','opus','1080p','720p','2160p','4k','2160','1080','480p','360p','8k','yify','ettv','rarbg','anidb']);
  // add 'bit' tokens to global noise set
  ['bit','bits'].forEach(b => noise.add(b));
  const toks = title.split(/\s+/).filter(Boolean);
  // truncate title at first noise token if it's not the first token
  for (let i = 0; i < toks.length; i++) {
    const tl = toks[i].toLowerCase();
    if (i === 0) continue;
    if (noise.has(tl) || /^\d{3,4}p$/.test(tl) || Array.from(noise).some(n => tl.startsWith(n))) { toks.splice(i); break; }
  }
  while (toks.length > 0 && noise.has(toks[toks.length-1].toLowerCase())) toks.pop();
  title = toks.join(' ').trim();
  // strip trailing season/special tokens that may have been included in the left-side candidate (e.g., "S01 SP", "S01P01")
    try {
    // strip Sxx, SxxExx and SxxExx.decimal forms, SP and Pxx tokens from title
    title = title.replace(/\bS0*\d{1,2}(?:[EPp]0*\d{1,3}(?:\.\d+)?)?\b/ig, ' ').replace(/\bSP\b/ig, ' ').replace(/\bP0*\d{1,3}\b/ig, ' ').replace(/\s+/g, ' ').trim();
  } catch (e) { /* ignore */ }
  // remove 4-digit years from title (we'll get year from API)
  try {
    // remove any remaining year tokens but do not clobber the extracted `year` variable
    title = title.replace(/\b(19|20)\d{2}\b/g, '').replace(/\s+/g, ' ').trim();
  } catch (e) { /* ignore */ }
  if (!title) title = withoutBrackets;

  // parsedName will be computed after final overrides

  // Final conservative fallback: if we found an episode number but no episodeTitle,
  // try to extract a right-hand title from the raw original name using common separators
  if (!episodeTitle && episode != null) {
    try {
      let raw = String(original).replace(/\.[^.]+$/, '')
      raw = raw.replace(/\[[^\]]+\]/g, ' ').replace(/\([^\)]+\)/g, ' ').replace(/[\._]+/g, ' ').replace(/\s+/g, ' ').trim();
      // look for patterns like '... 01 - Title' or '... - 01 - Title' or '..._01_ Title'
      const m = raw.match(new RegExp('(?:^|[\\s_\-])0*' + String(episode) + '[\\s_\-]+(.+)$'))
      if (m && m[1]) {
        const cand = cleanToken(m[1])
        if (cand && /[A-Za-z]/.test(cand)) episodeTitle = cand
      }
    } catch (e) { /* ignore */ }
  }

  // As a last-resort, prefer the rightmost explicit SxxEyy marker (episode) if present,
  // otherwise fall back to any SxxPyy (special) marker. This avoids earlier P markers
  // in paths taking precedence over the actual SxxEyy file name.
  try {
    let explicitFinal = null;
    const allE = Array.from(withoutBrackets.matchAll(/\bS0*(\d{1,2})E0*(\d{1,3}(?:\.\d+)?)\b/ig));
    if (allE.length > 0) explicitFinal = allE[allE.length - 1];
    if (!explicitFinal) {
      const allP = Array.from(withoutBrackets.matchAll(/\bS0*(\d{1,2})[Pp]0*(\d{1,3}(?:\.\d+)?)\b/ig));
      if (allP.length > 0) explicitFinal = allP[allP.length - 1];
    }
    if (explicitFinal) {
      season = parseInt(explicitFinal[1], 10);
  const rawE = String(explicitFinal[2] || '');
  episode = parseEpisodeNumber(rawE);
      // attempt to extract episodeTitle from the text after the explicit marker
      try {
        const markerText = explicitFinal[0];
        const idx = withoutBrackets.toLowerCase().lastIndexOf(String(markerText).toLowerCase());
        if (idx >= 0) {
          const left = withoutBrackets.slice(0, idx).trim();
          let right = withoutBrackets.slice(idx + String(markerText).length).replace(/^[-\s:._]+/, '').trim();
          // IMPORTANT: If the explicit marker is at the beginning (left is empty), do NOT
          // treat the right-hand text as the series title. Right-hand text after a leading
          // S01E01 is usually the episode title or additional noise (e.g., "S01E01 - Clover Is Born").
          // Preserve the previously-detected title (likely from the path or left-side heuristics)
          // and only consider using the right-hand text as the series title when left is non-empty.
          if (left) {
            title = left;
          } else {
            // left is empty: keep existing 'title' value; do not overwrite it with RHS
            // but allow episodeTitle extraction from the right-hand text (since left was empty)
          }

          // remove dual-audio and normalize for episodeTitle extraction (only when there is RHS)
          if (right) {
            const rightForEpisode = right.replace(/\b(?:audio[._\- ]*dual|dual[._\- ]*audio)\b/ig, ' ').replace(/\+/g, ' ').replace(/\s+/g, ' ').trim();
            const noiseTokensLocal = ['x264','x265','h264','h265','hevc','avc','10bit','8bit','12bit','bluray','bdrip','bd25','bd50','bdremux','bdr','brrip','webrip','web-dl','webdl','hdtv','hdrip','dvdrip','dvdr','cam','ts','tvrip','dvd','remux','proper','repack','limited','uncut','internal','extended','fansub','1080p','720p','2160p','4k','2160','1080','480p','360p','8k','bit','bits'];
            const rToks = rightForEpisode.split(/\s+/).filter(Boolean);
            let cut = -1;
            for (let i = 0; i < rToks.length; i++) {
              const t = rToks[i].toLowerCase();
              if (i === 0) continue;
              if (noiseTokensLocal.includes(t) || /^\d{3,4}p$/.test(t) || noiseTokensLocal.some(n => t.startsWith(n))) { cut = i; break; }
            }
            if (cut >= 0) rToks.splice(cut);
            const cand = cleanToken(rToks.join(' '));
            // prefer alphabetic candidate over existing episodeTitle which may be release-noise
            if (cand && /[A-Za-z]/.test(cand) && cand.length > 1) episodeTitle = cand;
          }
        }
      } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }

  // Recompute parsedName to reflect any final overrides
  // If we preferred using the parent directory as the series title context
  // and the computed `title` looks like it contains episode markers or
  // the episode (i.e., 'S01E01 ...'), then use the parent directory name
  // as the title instead so tests and consumers get the series name.
  try {
    if (preferParentDir && parentSeriesClean) {
      const lower = parentSeriesClean.toLowerCase();
      const generic = lower.length === 0 || /^(?:season|seasons|special|specials|extras|extra|bonus|ova|ovas|movie|movies|film|films|collection|collections)$/i.test(parentSeriesClean);
      if (!generic) {
        title = parentSeriesClean;
      }
    } else if (preferParentDir && parentDirName) {
      const looksLikeEpisode = /^S0*\d{1,2}/i.test(title) || /^0*\d{1,3}[\s_\-]/.test(title) || /\bS0*\d{1,2}E0*\d{1,3}\b/i.test(original);
      if (looksLikeEpisode) {
        let fallback = cleanSeries(parentDirName || title);
        fallback = fallback.replace(/\bS0*\d{1,2}(?:[EPp]0*\d{1,3}(?:\.\d+)?)?\b/ig, ' ').replace(/\bSP\b/ig, ' ').replace(/\bP0*\d{1,3}\b/ig, ' ').replace(/\s+/g, ' ').trim();
        if (fallback) title = fallback;
      }
    }
  } catch (e) { /* ignore */ }
  let parsedName = title;
  if (episodeRange) {
    const epLabel = (season != null) ? `S${String(season).padStart(2,'0')}E${episodeRange}` : `E${episodeRange}`;
    parsedName = `${title} - ${epLabel}`;
  } else if (episode != null) {
    const pad = n => String(n).padStart(2,'0');
    const epLabel = (season != null) ? `S${pad(season)}E${pad(episode)}` : `E${pad(episode)}`;
    parsedName = `${title} - ${epLabel}`;
  }

  // We intentionally do not provide an episodeTitle from filename parsing
  // — titles will be retrieved from the API/enrichment step to avoid false positives.
  episodeTitle = '';
  return { original, title, parsedName, season, episode, episodeTitle, episodeRange };
}
