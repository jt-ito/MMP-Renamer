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

module.exports = function parseFilename(name) {
  const original = String(name || '').trim();
  // operate on the basename (last path segment) so parent folders like '/input' are not parsed here
  const basename = (original.split(/[\\/]/).pop() || original).trim();
  const cleaned = basename.replace(/[\._\-]+/g, ' ').replace(/\s+/g, ' ').trim();

  let season = null;
  let episode = null;
  let episodeRange = null;
  let episodeTitle = '';
  let episodeLocked = false;

  // withoutBrackets: usable for title cleaning
  let withoutBrackets = cleaned.replace(/\[[^\]]+\]/g, ' ').replace(/\([^\)]+\)/g, ' ').replace(/\s+/g, ' ').trim();
  // rawNoBrackets: use basename and preserve dots so markers like S01E11.5 are intact; don't include parent folders
  const rawNoBrackets = String(basename).replace(/\[[^\]]+\]|\([^\)]+\)/g, ' ').replace(/\+/g, ' ').replace(/\s+/g, ' ').trim();

  // remove explicit dual-audio markers and normalize
  withoutBrackets = withoutBrackets.replace(/\b(?:audio[._\- ]*dual|dual[._\- ]*audio)\b/ig, ' ').replace(/\s+/g, ' ').trim();

  let title = withoutBrackets || '';
  let anchorIdx = -1;

  // If there's a season marker and text to the left, prefer that left-side as title
  const seasonMarker = rawNoBrackets.match(/\bS0*(\d{1,2})(?:[EPp]0*(\d{1,3}(?:\.\d+)?))?(?=\b|[^a-z0-9\.]|$)/i);
  if (seasonMarker) {
    const marker = seasonMarker[0];
    const idx = rawNoBrackets.toLowerCase().indexOf(marker.toLowerCase());
    if (idx > 0) {
      const left = rawNoBrackets.slice(0, idx).trim();
      const candidate = cleanSeries(left || '');
      if (candidate) {
        title = candidate;
        anchorIdx = idx;
        if (!season) season = parseInt(seasonMarker[1], 10);
        if (seasonMarker[2] && !episode) { episode = parseFloat(seasonMarker[2]); episodeLocked = true; }
      }
    }
  }

  // derive a parent-folder candidate from the provided original path (do not parse folder noise)
  let parentFolderCandidate = '';
  let titleLocked = false;
  try {
    const segs = String(original).split(/[\\/]/).filter(Boolean);
    // check folder segments from nearest parent backwards
    if (segs.length > 1) {
      for (let i = segs.length - 2; i >= 0; i--) {
        const segRaw = String(segs[i] || '').trim();
        const segLow = segRaw.toLowerCase();
        const SKIP = ['input','sample','samples','tmp','temp','incoming','to_process','processed','output'];
        if (!segRaw || SKIP.includes(segLow)) continue;
        // 1) Prefer a leading numeric token before other checks (so '86 S01...' yields '86')
        let lead = segRaw.match(/^\s*(\d{1,4})\b/);
        if (lead && lead[1]) { parentFolderCandidate = lead[1]; break; }
        // ignore purely release-like folder names
        if (/\b(x264|x265|bluray|bdrip|web[- ]?dl|webrip|bd|remux|dvd|hdtv|dual|audio)\b/i.test(segRaw)) continue;
        // quick heuristics: 2) token before Sxx marker, 3) first short word
        let m = segRaw.match(/(\d{1,4}|[A-Za-z0-9 \-\.]{1,40})\s+(?=S0*\d)/i);
        if (m && m[1]) { parentFolderCandidate = cleanSeries(m[1]); break; }
        m = segRaw.match(/^[^\d]*?([A-Za-z0-9]{2,40})/);
        if (m && m[1]) { parentFolderCandidate = cleanSeries(m[1]); break; }
        // fallback: cleaned folder
        const segClean = cleanSeries(segRaw).replace(/\bS0*\d{1,2}(?:[EPp]0*\d{1,3}(?:\.\d+)?)?\b/ig, '').replace(/\bSP\b/ig, '').replace(/\s+/g, ' ').trim();
        if (segClean) { parentFolderCandidate = segClean; break; }
      }
    }
  } catch (e) { /* ignore */ }

  // If the basename begins with a season/episode marker, prefer the parent-folder candidate
  // (or leave title empty) because a series name would not appear to the right of the marker.
  try {
    const basenameStartsWithMarker = /^\s*S0*\d+/i.test(basename);
    if (basenameStartsWithMarker) {
      if (parentFolderCandidate) { title = parentFolderCandidate; titleLocked = true; }
      else { title = ''; }
      // anchor subsequent searches at start
      anchorIdx = 0;
    }
  } catch (e) { /* ignore */ }

  // Dash-pattern heuristics (Title - S01E02 - ... or Title - 1x02 - ... or Title - 01 - ...)
  const dashPatterns = [
    { re: /^(.+?)[\s_\-–—]+S(\d{1,2})E(\d{1,3}(?:\.\d+)?)(?:[\s_\-–—]+.*)?$/i, type: 'sxxexx' },
    { re: /^(.+?)[\s_\-–—]+(\d{1,2})x(\d{1,3})(?:[\s_\-–—]+.*)?$/i, type: 'x' },
    { re: /^(.+?)[\s_\-–—]+0*(\d{1,3})[\s_\-–—]+0*(\d{1,3})(?:[\s_\-–—]+.*)?$/i, type: 'range' },
    { re: /^(.+?)[\s_\-–—]+0*(\d{1,3})(?:[\s_\-–—]+.*)?$/i, type: 'single' }
  ];

  let matchedDash = false;
  for (const dp of dashPatterns) {
    const m = rawNoBrackets.match(dp.re);
    if (!m) continue;
    matchedDash = true;
  if (!titleLocked) title = cleanSeries(m[1] || '');
    if (dp.type === 'sxxexx') {
      season = parseInt(m[2], 10);
      episode = m[3] ? parseFloat(m[3]) : null;
    } else if (dp.type === 'x') {
      season = parseInt(m[2], 10);
      episode = m[3] ? parseInt(m[3], 10) : null;
    } else if (dp.type === 'range') {
      const a = parseInt(m[2], 10);
      const b = parseInt(m[3], 10);
      if (!Number.isNaN(a)) episode = a;
      if (!Number.isNaN(b)) episodeRange = `${String(a).padStart(2,'0')}-${String(b).padStart(2,'0')}`;
      if (season == null) season = 1;
    } else if (dp.type === 'single') {
      const a = parseInt(m[2], 10);
      if (!Number.isNaN(a)) { episode = a; if (season == null) season = 1; }
    }
    break;
  }

  // If no dash pattern matched, find the rightmost explicit SxxEyy or SxxPyy marker
  if (!matchedDash) {
    const allE = Array.from(rawNoBrackets.matchAll(/\bS0*(\d{1,2})E0*(\d{1,3}(?:\.\d+)?)\b/ig));
    const allP = Array.from(rawNoBrackets.matchAll(/\bS0*(\d{1,2})[Pp]0*(\d{1,3}(?:\.\d+)?)\b/ig));
    const explicitFinal = allE.length ? allE[allE.length - 1] : (allP.length ? allP[allP.length - 1] : null);
    if (explicitFinal) {
      const s = parseInt(explicitFinal[1], 10);
      const rawEp = explicitFinal[2];
      const e = rawEp && String(rawEp).indexOf('.') !== -1 ? parseFloat(rawEp) : parseInt(rawEp, 10);
      if (!episodeLocked) { season = s; episode = e; } else { if (season == null) season = s; }
      const idx = rawNoBrackets.toLowerCase().lastIndexOf(String(explicitFinal[0]).toLowerCase());
      if (idx >= 0) {
        const left = rawNoBrackets.slice(0, idx).trim();
        const leftClean = cleanSeries(left);
        if (leftClean) {
          if (!titleLocked) title = leftClean;
        } else {
          // marker at start or no left-side title; prefer parent-folder candidate when available
          if (parentFolderCandidate) {
            if (!titleLocked) { title = parentFolderCandidate; titleLocked = true; }
          } else {
            // do not use right-hand side episode text as series title; leave title empty to let server/provider enrich
            if (!titleLocked) title = '';
          }
        }
      }
    }
  }

  // Numeric heuristics: look for isolated numeric tokens (allow decimals) in the anchored substring
  if (episode == null && !episodeLocked) {
    const searchForEpisode = (anchorIdx >= 0) ? rawNoBrackets.slice(anchorIdx) : rawNoBrackets;
    const tokens = searchForEpisode.split(/\s+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (!/^\d{1,3}(?:\.\d+)?$/.test(tok)) continue;
      if (tok.length === 4) continue; // likely a year
      const num = tok.indexOf('.') !== -1 ? parseFloat(tok) : parseInt(tok, 10);
      const next = tokens[i+1] ? tokens[i+1].toLowerCase() : '';
      const prev = tokens[i-1] ? tokens[i-1].toLowerCase() : '';
      const noiseAfter = /^\d{3,4}p$/.test(next) || (next && (next.startsWith('x264') || next.startsWith('x265') || next.startsWith('web') || next.startsWith('hd') || next.startsWith('bluray')));
      if (i === tokens.length - 1 || noiseAfter || prev === 'ep' || prev === 'episode' || prev === '-') {
        episode = num;
        if (season == null) season = 1;
        break;
      }
    }
  }

  // Clean trailing noise tokens from title and remove years
  const noiseSet = new Set(['x264','x265','h264','h265','hevc','avc','10bit','8bit','12bit','bluray','bdrip','bdr','brrip','webrip','web-dl','webdl','hdtv','hdrip','dvdrip','dvdr','cam','ts','tvrip','dvd','remux','proper','repack','limited','uncut','internal','extended','dual','audio','multi','dub','sub','fansub','yify','ettv','rarbg','anidb','1080p','720p','2160p','4k','2160','1080','480p','360p','8k','bit','bits']);
  const toks = String(title || '').split(/\s+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    if (i === 0) continue;
    const tl = toks[i].toLowerCase();
    if (noiseSet.has(tl) || /^\d{3,4}p$/.test(tl)) { toks.splice(i); break; }
  }
  while (toks.length > 0 && noiseSet.has(toks[toks.length-1].toLowerCase())) toks.pop();
  if (!titleLocked) title = toks.join(' ').trim();
  try { title = title.replace(/\bS0*\d{1,2}(?:[EPp]0*\d{1,3})?\b/ig, ' ').replace(/\bSP\b/ig, ' ').replace(/\bP0*\d{1,3}\b/ig, ' ').replace(/\s+/g, ' ').trim(); } catch (e) {}
  try { title = title.replace(/\b(19|20)\d{2}\b/g, '').replace(/\s+/g, ' ').trim(); } catch (e) {}
  if (!title) {
    // remove SxxEyy / SxxPyy / Pxx / SP markers from the fallback so fragments like '5' from '11.5' don't remain
    const cleanedFromWithout = withoutBrackets.replace(/\bS0*\d{1,2}(?:[EPp]0*\d{1,3}(?:\.\d+)?)?\b/ig, ' ').replace(/\bP0*\d{1,3}\b/ig, ' ').replace(/\bSP\b/ig, ' ').replace(/\s+/g, ' ').trim();
    if (!titleLocked) title = cleanedFromWithout || withoutBrackets.replace(/\.[^.]+$/, '').split(/[\\/]/).pop() || '';
  }

  // If episode is fractional (e.g., 11.5) we may have left the fractional token ('5') in the title
  try {
    if (episode != null && String(episode).indexOf('.') !== -1) {
      const frac = String(episode).split('.')[1];
      if (frac) {
        const tks = title.split(/\s+/).filter(Boolean);
        // remove any token that is exactly the fractional digits
        const filtered = tks.filter(tok => tok !== frac);
        title = filtered.join(' ').trim();
      }
    }
  } catch (e) { /* ignore */ }

  // Build parsedName
  const pad = n => String(n).padStart(2,'0');
  let parsedName = title;
  if (episodeRange) {
    const epPart = Number.isInteger(Number(episode)) ? pad(episode) : String(episode);
    const epLabel = (season != null) ? `S${pad(season)}E${epPart}` : `E${epPart}`;
    parsedName = `${title} - ${epLabel}`;
  } else if (episode != null) {
    const epLabel = (season != null) ? `S${pad(season)}E${(String(episode).indexOf('.') === -1 ? pad(episode) : String(episode))}` : `E${String(episode)}`;
    parsedName = `${title} - ${epLabel}`;
  }

  // Never return episodeTitle from filename parsing; API should provide it
  episodeTitle = '';
  return { original, title, parsedName, season, episode, episodeTitle, episodeRange };
}
