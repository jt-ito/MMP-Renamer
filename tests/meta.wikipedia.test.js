const assert = require('assert')
const server = require('../server')

describe('Wikipedia episode lookup (parent-derived AniList flow)', function() {
  it('should use Wikipedia to find an episode title for a parent-derived AniList match', async function() {
    // Backup original httpRequest hook
    const orig = server._test && server._test._httpRequest ? server._test._httpRequest : null

    // Fake httpRequest to simulate AniList and Wikipedia responses
    server._test = server._test || {}
    server._test.anidbCredentials = null
    server._test._httpRequest = async function(options, body, timeoutMs) {
      const hostname = options && options.hostname
      const path = options && options.path

      // AniList GraphQL searches
      if (hostname === 'graphql.anilist.co') {
        try {
          const j = body ? JSON.parse(body) : {}
          const search = j && j.variables && j.variables.search ? String(j.variables.search) : ''
          // If searching for the base title 'NoMatchTitle' return empty
          if (/NoMatchTitle/i.test(search)) {
            return { statusCode: 200, headers: {}, body: JSON.stringify({ data: { Page: { media: [] } } }) }
          }
          // If searching for the parent candidate 'Test Show' return one media
          if (/Test Show/i.test(search)) {
            const resp = { data: { Page: { media: [ { id: 100, title: { romaji: 'Test Show', english: null, native: 'Test Show' }, relations: { nodes: [] }, externalLinks: [] } ] } } }
            return { statusCode: 200, headers: {}, body: JSON.stringify(resp) }
          }
        } catch (e) {
          return { statusCode: 200, headers: {}, body: JSON.stringify({ data: { Page: { media: [] } } }) }
        }
      }

      // Wikipedia search API
      if (hostname === 'en.wikipedia.org' && path && path.indexOf('list=search') !== -1) {
        const resp = { query: { search: [ { pageid: 123, title: 'List of Test Show episodes' } ] } }
        return { statusCode: 200, headers: {}, body: JSON.stringify(resp) }
      }

      // Wikipedia parse API for the pageid 123: include a simple table with episode rows
      if (hostname === 'en.wikipedia.org' && path && path.indexOf('action=parse') !== -1) {
        const html = `
          <div>
            <table>
              <tr><td>1</td><td class="summary">Pilot</td></tr>
              <tr><td>2</td><td class="summary">Second</td></tr>
              <tr><td>3</td><td class="summary">The Special Episode</td></tr>
            </table>
          </div>
        `
        const resp = { parse: { text: { '*': html } }, title: 'List of Test Show episodes' }
        return { statusCode: 200, headers: {}, body: JSON.stringify(resp) }
      }

      // Default fallback
      return { statusCode: 200, headers: {}, body: '{}' }
    }

    try {
      try {
        if (server.wikiEpisodeCache) for (const k of Object.keys(server.wikiEpisodeCache)) delete server.wikiEpisodeCache[k]
        const wcFile = require('path').join(__dirname, '..', 'data', 'wiki-episode-cache.json')
        require('fs').writeFileSync(wcFile, JSON.stringify({}), 'utf8')
      } catch (e) {}
      try {
        if (server.anidbEpisodeCache) for (const k of Object.keys(server.anidbEpisodeCache)) delete server.anidbEpisodeCache[k]
      } catch (e) {}
      // Call metaLookup with a title that will not be found, but provide parentCandidate so
      // the parent-derived AniList branch runs and should consult Wikipedia.
      const res = await server.metaLookup('NoMatchTitle', null, { parentCandidate: 'Test Show', season: 1, episode: 3 })
      assert.ok(res && res.episode && res.episode.name, 'Expected episode entry with name')
      assert.strictEqual(res.episode.name, 'The Special Episode')
    } finally {
      // restore original hook
      if (orig) server._test._httpRequest = orig
      else delete server._test._httpRequest
      delete server._test.anidbCredentials
    }
  })
})
