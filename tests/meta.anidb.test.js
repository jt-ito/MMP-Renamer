const assert = require('assert')
const server = require('../server')

describe('AniDB episode lookup', function() {
  it('should fetch episode titles from AniDB when available', async function() {
    const orig = server._test && server._test._httpRequest ? server._test._httpRequest : null
    server._test = server._test || {}
    server._test.anidbCredentials = { client: 'testclient', clientver: '1' }
    server._test._httpRequest = async function(options, body) {
      const host = options && options.hostname ? options.hostname : ''
      const reqPath = (options && options.path) ? options.path : ''
      if (host === 'graphql.anilist.co') {
        const j = body ? JSON.parse(body) : {}
        const search = j && j.variables && j.variables.search ? String(j.variables.search) : ''
        if (/AniDB Show/i.test(search)) {
          const resp = {
            data: {
              Page: {
                media: [
                  {
                    id: 200,
                    title: { romaji: 'AniDB Show', english: 'AniDB Show', native: 'アニDBショー' },
                    relations: { nodes: [] },
                    externalLinks: [ { site: 'AniDB', url: 'https://anidb.net/anime/9999' } ]
                  }
                ]
              }
            }
          }
          return { statusCode: 200, headers: {}, body: JSON.stringify(resp) }
        }
        return { statusCode: 200, headers: {}, body: JSON.stringify({ data: { Page: { media: [] } } }) }
      }
      if (host === 'api.anidb.net') {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<anime id="9999">
  <titles>
    <title xml:lang="en" type="main">AniDB Show</title>
    <title xml:lang="ja" type="official">アニDBショー</title>
  </titles>
  <episodes>
    <episode id="1">
      <epno type="1">1</epno>
      <title xml:lang="en">Pilot Episode</title>
    </episode>
    <episode id="2">
      <epno type="1">2</epno>
      <title xml:lang="en">AniDB Episode Title</title>
    </episode>
  </episodes>
</anime>`
        return { statusCode: 200, headers: {}, body: xml }
      }
      if (host === 'en.wikipedia.org') {
        throw new Error('Wikipedia should not be queried when AniDB data is available')
      }
      return { statusCode: 200, headers: {}, body: '{}' }
    }

    try {
      try {
        if (server.wikiEpisodeCache) for (const key of Object.keys(server.wikiEpisodeCache)) delete server.wikiEpisodeCache[key]
        const wcFile = require('path').join(__dirname, '..', 'data', 'wiki-episode-cache.json')
        require('fs').writeFileSync(wcFile, JSON.stringify({}), 'utf8')
      } catch (e) {}
      try {
        if (server.anidbEpisodeCache) for (const key of Object.keys(server.anidbEpisodeCache)) delete server.anidbEpisodeCache[key]
      } catch (e) {}

      const res = await server.metaLookup('AniDB Show', null, { season: 1, episode: 2 })
      assert.ok(res && res.episode && res.episode.name, 'Expected AniDB episode name')
      assert.strictEqual(res.episode.name, 'AniDB Episode Title')
      assert.strictEqual(res.episode.provider, 'anidb')
    } finally {
      if (orig) server._test._httpRequest = orig
      else delete server._test._httpRequest
      delete server._test.anidbCredentials
    }
  })
})
