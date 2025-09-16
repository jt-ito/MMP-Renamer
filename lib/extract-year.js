const path = require('path');

module.exports = function extractYear(meta, fromPath) {
  if (!meta) meta = {};
  // Prefer explicit episode air date -> season-level air date -> series-level dates -> meta.year fields
  try {
    // Episode-level (common shapes)
    const ep = meta.episode || (meta.raw && (meta.raw.episode || meta.raw.episodes && meta.raw.episodes[0])) || null
    if (ep) {
      const epDate = ep.air_date || ep.airDate || (ep.attributes && (ep.attributes.air_date || ep.attributes.airDate || ep.attributes.startDate)) || null
      if (epDate) {
        const y = new Date(String(epDate)).getUTCFullYear()
        if (!isNaN(y)) return String(y)
      }
    }
    // Season-level (TMDb attaches seasonAirDate earlier as seasonAirDate)
    const seasonDate = meta.seasonAirDate || (meta.raw && (meta.raw.seasonAirDate || (meta.raw.season && meta.raw.season.air_date))) || null
    if (seasonDate) {
      const y = new Date(String(seasonDate)).getUTCFullYear()
      if (!isNaN(y)) return String(y)
    }
    // Series-level typical fields
    const seriesDate = meta.first_air_date || meta.release_date || meta.firstAirDate || (meta.raw && (meta.raw.first_air_date || meta.raw.release_date || meta.raw.firstAirDate)) || null
    if (seriesDate) {
      const y = new Date(String(seriesDate)).getUTCFullYear()
      if (!isNaN(y)) return String(y)
    }

    // Provider-specific startDate shapes (AniList returns raw.startDate { year })
    try {
      if (meta.raw && meta.raw.startDate) {
        const sd = meta.raw.startDate
        if (sd && typeof sd === 'object' && sd.year) {
          const ry = Number(sd.year)
          if (!isNaN(ry)) return String(ry)
        } else if (sd && (typeof sd === 'string' || sd instanceof String)) {
          const y = new Date(String(sd)).getUTCFullYear()
          if (!isNaN(y)) return String(y)
        }
      }
      if (meta.raw && meta.raw.attributes && (meta.raw.attributes.startDate || meta.raw.attributes.releaseDate)) {
        const attrD = meta.raw.attributes.startDate || meta.raw.attributes.releaseDate
        const y = new Date(String(attrD)).getUTCFullYear()
        if (!isNaN(y)) return String(y)
      }
    } catch (e) {}
    // older/top-level year fields
    const candidates = [meta.year, meta.airedYear, meta.originalYear];
    for (const c of candidates) if (c && String(c).match(/^\d{4}$/)) return String(c);
    if (meta.timestamp) {
      try { const d = new Date(Number(meta.timestamp)); if (!isNaN(d)) return String(d.getUTCFullYear()) } catch (e) {}
    }
  } catch (e) { /* best-effort */ }
  // try to find a 4-digit year in title or parsedName
  const searchFields = [meta.title, meta.parsedName, path.basename(fromPath || '', path.extname(fromPath || ''))];
  for (const f of searchFields) {
    if (!f) continue;
    const m = String(f).match(/(19|20)\d{2}/);
    if (m) return m[0];
  }
  return null;
}
