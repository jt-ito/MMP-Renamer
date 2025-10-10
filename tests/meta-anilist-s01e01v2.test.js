const assert = require('assert')
const server = require('../server.js')

describe('metaLookup S01E01v2 mis-selection regression', function() {
  it('should prefer a Season 1 parent over an unrelated 3rd Season AniList media when season=1', async function() {
    // backup
    const orig = server._test && server._test._httpRequest ? server._test._httpRequest : null

    // We'll respond to AniList GraphQL queries. The fake will return:
    // - If the search includes "Season 3" or a title that matches the 3rd season, return a media list with the 3rd season media as first hit
    // - If the search is the plain parent title, return a media list with parent (no season suffix)
    // The expected behaviour: when opts.season === 1, metaLookup should select the parent (season 1) item, not the 3rd season item.

    function fakeHttpRequest(options, body, timeoutMs) {
      try {
        const j = JSON.parse(body)
        const q = j && j.variables && j.variables.search ? String(j.variables.search).toLowerCase() : ''
        // Simulate search that returns 3rd season when season text present
        if (q.indexOf('season 3') !== -1 || q.indexOf('(season 3)') !== -1 || q.indexOf('3rd season') !== -1) {
          const resp = { data: { Page: { media: [{ id: 3003, title: { romaji: 'Example Show 3rd Season', english: null, native: 'Example S3' } , seasonYear: 2022, externalLinks: [] }] } } }
          return Promise.resolve({ statusCode: 200, headers: {}, body: JSON.stringify(resp) })
        }
        // Simulate plain parent search returning a parent series entry (no season tokens)
        if (q.indexOf('example show') !== -1) {
          const resp = { data: { Page: { media: [{ id: 1001, title: { romaji: 'Example Show', english: null, native: 'Example' } , seasonYear: 2024, externalLinks: [] }] } } }
          return Promise.resolve({ statusCode: 200, headers: {}, body: JSON.stringify(resp) })
        }
      } catch (e) {}
      return Promise.resolve({ statusCode: 200, headers: {}, body: JSON.stringify({ data: { Page: { media: [] } } }) })
    }

    server._test = server._test || {}
    server._test._httpRequest = fakeHttpRequest

    // Call metaLookup simulating filename variant that might previously have matched the 3rd season
    const res = await server.metaLookup('Example Show S01E01v2', 'fake-tmdb-key', { season: 1, parentCandidate: 'Example Show' })

    // Expect the parent id (1001) to be selected, not the 3rd season id (3003)
    assert(res && res.raw && res.raw.id === 1001, `Expected parent series id 1001, got ${res && res.raw && res.raw.id}`)

    // cleanup
    if (orig) server._test._httpRequest = orig
  })
})
