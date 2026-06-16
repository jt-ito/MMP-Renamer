function generatePlanForItem(it, { username, effectiveOutput, applyFilenameAsTitle, template }) {
    const fromPath = canonicalize(it.canonicalPath);
    const key = fromPath;
    const meta = enrichCache[fromPath] || {};
  const rawTitle = (meta && (meta.title || (meta.extraGuess && meta.extraGuess.title))) ? (meta.title || (meta.extraGuess && meta.extraGuess.title)) : path.basename(fromPath, path.extname(fromPath));
  let year = '';
  try {
    if (meta && (meta.year || (meta.extraGuess && meta.extraGuess.year))) {
      year = meta.year || (meta.extraGuess && meta.extraGuess.year) || '';
    } else if (meta && meta.provider && meta.provider.year) {
      year = meta.provider.year;
    } else {
      year = extractYear(meta, fromPath) || '';
    }
  } catch (e) { year = '' }
    const ext = path.extname(fromPath);
    const filenameBase = sanitize(path.basename(fromPath, ext));
  const userTemplate = (username && users[username] && users[username].settings && users[username].settings.rename_template) ? users[username].settings.rename_template : null;
  const baseNameTemplate = template || userTemplate || serverSettings.rename_template || '{title}';
    function pad(n){ return String(n).padStart(2,'0') }
    const anidbRawEpisode = meta && meta.extraGuess && meta.extraGuess.anidb && meta.extraGuess.anidb.episodeNumberRaw;
    const shouldUseAnidbRaw = anidbRawEpisode && /^[SCTPO]\d+$/i.test(String(anidbRawEpisode));
    let epLabel = ''
    if (meta && meta.episodeRange) {
      epLabel = meta.season != null ? `S${pad(meta.season)}E${meta.episodeRange}` : `E${meta.episodeRange}`
    } else if (shouldUseAnidbRaw) {
      epLabel = meta.season != null ? `S${pad(meta.season)}E${String(anidbRawEpisode).toUpperCase()}` : `E${String(anidbRawEpisode).toUpperCase()}`
    } else if (meta && meta.episode != null) {
      epLabel = meta.season != null ? `S${pad(meta.season)}E${pad(meta.episode)}` : `E${pad(meta.episode)}`
    }
  let episodeTitleToken = (meta && (meta.episodeTitle || (meta.extraGuess && meta.extraGuess.episodeTitle))) ? (meta.episodeTitle || (meta.extraGuess && meta.extraGuess.episodeTitle)) : '';
  let seasonToken = (meta && meta.season != null) ? String(meta.season) : '';
  let episodeToken = (meta && meta.episode != null) ? String(meta.episode) : '';
  let episodeRangeToken = (meta && meta.episodeRange) ? String(meta.episodeRange) : '';
  const tmdbIdToken = (meta && meta.tmdb && meta.tmdb.raw && (meta.tmdb.raw.id || meta.tmdb.raw.seriesId)) ? String(meta.tmdb.raw.id || meta.tmdb.raw.seriesId) : '';
  const isMovie = determineIsMovie(meta);
  if (isMovie === true) {
    epLabel = '';
    episodeTitleToken = '';
    seasonToken = '';
    episodeToken = '';
    episodeRangeToken = '';
  }
  const episodeTitleTokenFromMeta = (isMovie === true)
    ? ''
    : ((meta && (meta.episodeTitle || (meta.extraGuess && meta.extraGuess.episodeTitle))) ? (meta.episodeTitle || (meta.extraGuess && meta.extraGuess.episodeTitle)) : '');
  const resolvedSeriesTitle = resolveSeriesTitle(meta, rawTitle, fromPath, episodeTitleTokenFromMeta, { preferExact: true });
  const englishSeriesTitle = extractEnglishSeriesTitle(meta);
  const renderBaseTitle = (isMovie === true)
    ? (resolvedSeriesTitle || rawTitle)
    : (englishSeriesTitle || resolvedSeriesTitle || rawTitle);
  function cleanTitleForRender(baseTitle, epLabel, epTitle) {
    try {
      let cleaned = String(baseTitle || '').trim();
      if (!cleaned) return '';
      cleaned = cleaned.replace(/\s*[-–—:]+\s*S\d{1,2}E\d{1,3}(?:\s*[-–—:]+\s*.*)?$/i, '');
      cleaned = cleaned.replace(/\s*[-–—:]+\s*E\d{1,3}(?:\s*[-–—:]+\s*.*)?$/i, '');
      cleaned = cleaned.replace(/\s*[-–—:]+\s*Episode\s+\d+.*$/i, '');
      return cleaned.trim();
    } catch (e) {
      return String(baseTitle || '').trim();
    }
  }
  let episodeForTitle = '';
  if (meta && meta.episode != null) {
    if (shouldUseAnidbRaw) {
      episodeForTitle = meta.season != null ? `S${String(meta.season).padStart(2,'0')}E${String(anidbRawEpisode).toUpperCase()}` : `E${String(anidbRawEpisode).toUpperCase()}`;
    } else {
      episodeForTitle = meta.season != null ? `S${String(meta.season).padStart(2,'0')}E${String(meta.episode).padStart(2,'0')}` : `E${String(meta.episode).padStart(2,'0')}`;
    }
  }
  const title = cleanTitleForRender(renderBaseTitle, episodeForTitle, episodeTitleTokenFromMeta);
  const templateYear = year ? String(year) : '';
  const folderYear = (isMovie === true && templateYear) ? templateYear : '';
  const folderBaseTitle = renderBaseTitle || title;
  if (englishSeriesTitle || typeof isMovie === 'boolean') {
    try {
      const currentEnglish = meta && meta.seriesTitleEnglish ? String(meta.seriesTitleEnglish).trim() : null;
      const needsEnglishUpdate = !currentEnglish || currentEnglish !== englishSeriesTitle;
  const currentMovieFlag = (meta && typeof meta.isMovie === 'boolean') ? meta.isMovie : ((meta && meta.extraGuess && typeof meta.extraGuess.isMovie === 'boolean') ? meta.extraGuess.isMovie : null);
      const needsMovieUpdate = typeof isMovie === 'boolean' && currentMovieFlag !== isMovie;
      if (needsEnglishUpdate || needsMovieUpdate) {
        const updatedExtra = meta && meta.extraGuess && typeof meta.extraGuess === 'object' ? Object.assign({}, meta.extraGuess) : {};
  if (typeof isMovie === 'boolean') updatedExtra.isMovie = isMovie;
        const cacheUpdate = Object.assign({}, meta, {
          seriesTitleEnglish: englishSeriesTitle || currentEnglish || null,
          seriesTitle: englishSeriesTitle || meta.seriesTitle || null,
          seriesTitleExact: englishSeriesTitle || meta.seriesTitleExact || null,
          isMovie: (typeof isMovie === 'boolean') ? isMovie : (typeof currentMovieFlag === 'boolean' ? currentMovieFlag : meta && meta.isMovie),
          extraGuess: updatedExtra,
        });
        updateEnrichCacheInMemory(fromPath, cacheUpdate);
        schedulePersistEnrichCache(100);
      }
    } catch (e) { /* best-effort cache update */ }
  }
  const seriesBase = englishSeriesTitle || (meta && (meta.seriesTitleEnglish || meta.seriesTitle)) || resolvedSeriesTitle || title || rawTitle || '';
  const aliasResolved = getSeriesAlias(seriesBase);
  let baseFolderName;
  if (aliasResolved) {
    baseFolderName = stripEpisodeArtifactsForFolder(String(aliasResolved).trim());
  } else {
    const shouldStripSeason = !(isMovie === true);
    baseFolderName = stripEpisodeArtifactsForFolder(shouldStripSeason ? String(stripSeasonNumberSuffix(seriesBase)).trim() : String(seriesBase).trim());
  }
  if (!baseFolderName) baseFolderName = stripEpisodeArtifactsForFolder(path.basename(fromPath, path.extname(fromPath)) || rawTitle || title);
  try { baseFolderName = titleCase(baseFolderName); } catch (e) {}
  let sanitizedBaseFolder = sanitize(baseFolderName);
  if (!sanitizedBaseFolder) {
    const fallbackFolderTitle = stripEpisodeArtifactsForFolder(title) || stripEpisodeArtifactsForFolder(rawTitle) || 'Untitled';
    sanitizedBaseFolder = sanitize(fallbackFolderTitle) || 'Untitled';
  }
  try { sanitizedBaseFolder = stripTrailingYear(sanitizedBaseFolder) } catch (e) {}
  try {
    const osKey = (username && users[username] && users[username].settings && users[username].settings.client_os) ? users[username].settings.client_os : (serverSettings && serverSettings.client_os ? serverSettings.client_os : 'linux');
    const maxLen = getMaxFilenameLengthForOS(osKey) || 255;
    if (sanitizedBaseFolder && sanitizedBaseFolder.length > maxLen) sanitizedBaseFolder = truncateFilenameComponent(sanitizedBaseFolder, maxLen);
  } catch (e) {}
  const titleFolder = folderYear ? `${sanitizedBaseFolder} (${folderYear})` : sanitizedBaseFolder;
  const seasonFolder = (!isMovie && meta && meta.season != null) ? `Season ${String(meta.season).padStart(2,'0')}` : '';
  const folder = applyFilenameAsTitle ? effectiveOutput : (seasonFolder ? path.join(effectiveOutput, titleFolder, seasonFolder) : path.join(effectiveOutput, titleFolder));
  let nameWithoutExtRaw = null;
  if (applyFilenameAsTitle && filenameBase) {
    nameWithoutExtRaw = filenameBase;
  } else if (meta && meta.provider && meta.provider.renderedName) {
    let providerName = String(meta.provider.renderedName).replace(/\.[^/.]+$/, '');
    try {
      const shouldStripSeason = !(isMovie === true);
      if (shouldStripSeason) {
        const parts = providerName.split(/\s[-–—:]\s/);
        if (parts && parts.length > 0) {
          parts[0] = stripSeasonNumberSuffix(parts[0]);
          providerName = parts.join(' - ');
        } else {
          providerName = stripSeasonNumberSuffix(providerName);
        }
      }
      providerName = stripTrailingYear(providerName);
    } catch (e) {}
    if (isMovie === true) {
      const y = String(templateYear || '').trim();
      if (y) providerName = `${stripTrailingYear(providerName)} (${y})`;
    } else {
      providerName = ensureRenderedNameHasYear(providerName, templateYear);
    }
    try {
      const hasEpisodeMeta = (isMovie !== true) && (meta && (meta.episode != null || meta.episodeRange));
      const providerLower = String(providerName || '').toLowerCase();
      const epLabelPresent = epLabel && providerLower.indexOf(String(epLabel).toLowerCase()) !== -1;
      const epTitlePresent = episodeTitleToken && providerLower.indexOf(String(episodeTitleToken).toLowerCase()) !== -1;
      const sxxMatch = /\bS\d{2}E\d{2}\b/i.test(providerName);
      const exxMatch = /\bE\d{1,3}\b/i.test(providerName);
      if (hasEpisodeMeta && !(epLabelPresent || epTitlePresent || sxxMatch || exxMatch)) {
        nameWithoutExtRaw = null;
      } else {
        nameWithoutExtRaw = sanitize(providerName);
      }
    } catch (e) {
      nameWithoutExtRaw = sanitize(providerName);
    }
  }
  if (!nameWithoutExtRaw) {
    const titleForFilename = (isMovie === true) ? title : stripSeasonNumberSuffix(title);
    nameWithoutExtRaw = baseNameTemplate
  .replace('{title}', sanitize(titleForFilename))
      .replace('{basename}', sanitize(path.basename(key, path.extname(key))))
  .replace('{year}', sanitize(templateYear))
      .replace('{epLabel}', sanitize(epLabel))
      .replace('{episodeTitle}', sanitize(episodeTitleToken))
      .replace('{season}', sanitize(seasonToken))
      .replace('{episode}', sanitize(episodeToken))
      .replace('{episodeRange}', sanitize(episodeRangeToken))
  .replace('{tmdbId}', sanitize(tmdbIdToken));
  }
  if (!nameWithoutExtRaw && filenameBase) {
    nameWithoutExtRaw = filenameBase;
  }
    const nameWithoutExt = String(nameWithoutExtRaw)
      .replace(/\s*\(\s*\)\s*/g, '')
      .replace(/\s*\-\s*(?:\-\s*)+/g, ' - ')
      .replace(/(^\s*-\s*)|(\s*-\s*$)/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    let truncatedNameWithoutExt = nameWithoutExt;
    try {
      const osKey = (username && users[username] && users[username].settings && users[username].settings.client_os) ? users[username].settings.client_os : (serverSettings && serverSettings.client_os ? serverSettings.client_os : 'linux');
      const maxLen = getMaxFilenameLengthForOS(osKey) || 255;
      const extLen = ext ? ext.length : 0;
      const maxBasenameLen = Math.max(1, maxLen - extLen);
      if (truncatedNameWithoutExt && truncatedNameWithoutExt.length > maxBasenameLen) {
        truncatedNameWithoutExt = truncateFilenameComponent(truncatedNameWithoutExt, maxBasenameLen);
      }
    } catch (e) {}
    const fileName = (truncatedNameWithoutExt + ext).trim();
    let toPath;
    if (effectiveOutput) {
      const finalFileName = fileName.replace(/\\/g, '/');
      toPath = path.join(folder, finalFileName).replace(/\\/g, '/');
    } else {
      toPath = path.join(path.dirname(fromPath), fileName).replace(/\\/g, '/');
    }
    const action = effectiveOutput ? 'hardlink' : (fromPath === toPath ? 'noop' : 'move');
  return { itemId: it.id, fromPath, toPath, actions: [{ op: action }], templateUsed: baseNameTemplate };
}

// Rename preview (generate plan)