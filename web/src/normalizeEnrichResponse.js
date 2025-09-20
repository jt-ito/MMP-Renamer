// Export a helper to normalize server enrichment shapes into a canonical object
export default function normalizeEnrichResponse(data) {
  if (!data) return null
  // Direct GET /api/enrich returns { cached, parsed, provider }
  if (data.parsed || data.provider) {
  return { parsed: data.parsed || null, provider: data.provider || null, hidden: data.hidden || false, applied: data.applied || false, rescanned: data.rescanned || false }
  }
  // POST /api/enrich historically returned { enrichment: {...} } or direct enrichment object
  const e = data.enrichment || data
  if (!e) return null
  // If already normalized
  if (e.parsed || e.provider) return { parsed: e.parsed || null, provider: e.provider || null, hidden: e.hidden || false, applied: e.applied || false, rescanned: e.rescanned || false }
  // Otherwise build parsed/provider blocks from legacy enrichment shape
  const parsed = (e.parsed) ? e.parsed : (e.parsedName || e.title ? { title: e.title || '', parsedName: e.parsedName || '', season: e.season, episode: e.episode, timestamp: e.timestamp } : null)
  const provider = (e.provider) ? e.provider : ((e.episodeTitle || e.year || e.providerRenderedName || e.tmdb) ? { title: e.title || parsed && parsed.title || '', year: e.year || null, season: e.season, episode: e.episode, episodeTitle: e.episodeTitle || '', raw: e.provider || e.tmdb || null, renderedName: e.providerRenderedName || e.renderedName || null, matched: !!(e.title || e.episodeTitle) } : null)
  return { parsed: parsed || null, provider: provider || null, hidden: e.hidden || false, applied: e.applied || false, rescanned: e.rescanned || false }
}
