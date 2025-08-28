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
  const cleaned = original.replace(/[\._\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  let season = null, episode = null, episodeTitle = '';
  let episodeRange = null;

  // remove bracketed groups/parentheses for cleaner matching
  let withoutBrackets = cleaned.replace(/\[[^\]]+\]/g, ' ').replace(/\([^\)]+\)/g, ' ').replace(/\s+/g, ' ').trim();

  // remove explicit dual-audio markers in their common forms (e.g., "Dual Audio", "Dual-Audio", "dual_audio")
  withoutBrackets = withoutBrackets.replace(/\b(?:audio[._\- ]*dual|dual[._\- ]*audio)\b/ig, ' ').replace(/\s+/g, ' ').trim();

  let title = withoutBrackets;

  // Dash-based patterns (try most specific to least specific):
  // 1) Title - S01E02 - Episode Title
  // 2) Title - 1x02 - Episode Title
  // 3) Title - 01-02 - Episode Title  (multi-episode range)
  // 4) Title - 01 - Episode Title
  const dashPatterns = [
    { re: /^(.+?)[\s_\-–—]+S(\d{1,2})E(\d{1,3})[\s_\-–—]+(.+)$/i, type: 'sxxexx' },
    { re: /^(.+?)[\s_\-–—]+(\d{1,2})x(\d{1,3})[\s_\-–—]+(.+)$/i, type: 'x' },
    { re: /^(.+?)[\s_\-–—]+0*(\d{1,3})[\s_\-–—]+0*(\d{1,3})[\s_\-–—]+(.+)$/, type: 'range' },
    { re: /^(.+?)[\s_\-–—]+0*(\d{1,3})[\s_\-–—]+(.+)$/, type: 'single' }
  ];

  for (const dp of dashPatterns) {
    const m = withoutBrackets.match(dp.re);
    if (!m) continue;
  // left side is series title candidate; use lighter cleaning to avoid removing legitimate title words
  title = cleanSeries(m[1]);
    if (dp.type === 'sxxexx') {
      season = parseInt(m[2], 10);
      episode = parseInt(m[3], 10);
    } else if (dp.type === 'x') {
      season = parseInt(m[2], 10);
      episode = parseInt(m[3], 10);
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

  // right side is the episode title candidate (may include noise)
  const rightRaw = m[m.length - 1] || '';
    let rightSide = cleanToken(rightRaw);
  const noiseTokens = ['x264','x265','h264','h265','hevc','avc','10bit','8bit','12bit','bluray','bdrip','bdr','brrip','webrip','web-dl','webdl','hdtv','hdrip','dvdrip','dvdr','cam','ts','tvrip','dvd','remux','proper','repack','limited','uncut','internal','extended','fansub','1080p','720p','2160p','4k','2160','1080','480p','360p','8k'];
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
    break; // only apply first matching dash pattern
  }

  // If a dash pattern matched we already filled season/episode/episodeRange/title/episodeTitle — skip other pattern heuristics
  const matchedDash = !!(episode != null || episodeRange != null);

  const patterns = [ /\bS(\d{1,2})E(\d{1,3})\b/i, /\b(\d{1,2})x(\d{1,3})\b/i, /\b(?:Ep(?:isode)?|E)\.?[ _-]?(\d{1,3})\b/i ];
  let match = null;
  if (!matchedDash) {
    for (const p of patterns) {
      const m = withoutBrackets.match(p);
      if (m) { match = m; break; }
    }
  }
  // If no episode found yet, look for an isolated numeric token that likely represents episode
  if (episode == null) {
    const tokens = withoutBrackets.split(/\s+/).filter(Boolean);
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
        tokens.splice(i, 1);
        break;
      }
    }
  }

  if (match) {
    if (/^S\d+/i.test(match[0])) {
      season = parseInt(match[1], 10);
      episode = parseInt(match[2], 10);
    } else if (/x/i.test(match[0])) {
      season = parseInt(match[1], 10);
      episode = parseInt(match[2], 10);
    } else {
      season = null;
      episode = parseInt(match[1], 10);
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
  const toks = title.split(/\s+/).filter(Boolean);
  // truncate title at first noise token if it's not the first token
  for (let i = 0; i < toks.length; i++) {
    const tl = toks[i].toLowerCase();
    if (i === 0) continue;
    if (noise.has(tl) || /^\d{3,4}p$/.test(tl) || Array.from(noise).some(n => tl.startsWith(n))) { toks.splice(i); break; }
  }
  while (toks.length > 0 && noise.has(toks[toks.length-1].toLowerCase())) toks.pop();
  title = toks.join(' ').trim();
  if (!title) title = withoutBrackets;

  // Build parsedName (include SxxEyy)
  let parsedName = title;
  if (episodeRange) {
    // episodeRange already padded as '01-03'
    const epLabel = (season != null) ? `S${String(season).padStart(2,'0')}E${episodeRange}` : `E${episodeRange}`;
    parsedName = `${title} - ${epLabel}`;
    if (episodeTitle) parsedName += ` - ${episodeTitle}`;
  } else if (episode != null) {
    const pad = n => String(n).padStart(2,'0');
    const epLabel = (season != null) ? `S${pad(season)}E${pad(episode)}` : `E${pad(episode)}`;
    parsedName = `${title} - ${epLabel}`;
    if (episodeTitle) parsedName += ` - ${episodeTitle}`; // include if conservative candidate found
  }

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

  return { original, title, parsedName, season, episode, episodeTitle, episodeRange };
}
