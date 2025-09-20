const assert = require('assert');
const server = require('../server.js');

describe('metaLookup AniList season-augmented search', function() {
  it('should attempt season-augmented query and select season-specific media', async function() {
    // We'll stub httpRequest used inside server.metaLookup -> searchAniList
    // Backup original httpRequest if present
    const origHttpRequest = server._test && server._test._httpRequest ? server._test._httpRequest : null

    // Create fake AniList responses: first call (season-augmented) returns a media list with a 3rd season item
    // but second call (base query) would return parent. We expect metaLookup to prefer the season-augmented when season present.
    let calls = [];
    function fakeHttpRequest(options, body, timeoutMs) {
      calls.push({ options, body })
      // parse body to inspect search variable
      try {
        const j = JSON.parse(body)
        const q = (j && j.variables && j.variables.search) ? j.variables.search : ''
        if (String(q).toLowerCase().indexOf('season 1') !== -1 || String(q).toLowerCase().indexOf('(season 1)') !== -1) {
          // return a season-specific media
          const resp = { data: { Page: { media: [{ id: 9999, title: { romaji: 'Test Show Season 1', english: null, native: 'Test Show S1' }, seasonYear: 2024 }] } } }
          return Promise.resolve({ statusCode: 200, headers: {}, body: JSON.stringify(resp) })
        }
      } catch (e) {}
      // default: return empty Page
      const resp = { data: { Page: { media: [] } } }
      return Promise.resolve({ statusCode: 200, headers: {}, body: JSON.stringify(resp) })
    }

    // Inject fake httpRequest into server._test helpers if available
    server._test = server._test || {}
    server._test._httpRequest = server._test._httpRequest || null
    // Monkey-patch internal httpRequest by attaching to metaLookup's closure via exported reference
    // We expose a temporary hook expected by the tests: server._test.injectHttpRequest
    server._test.injectHttpRequest = function(fake) {
      // The server implementation uses a local httpRequest function inside metaLookup; to influence it in tests
      // we rely on the exported metaLookup using server._test._httpRequest if present.
      server._test._httpRequest = fake
    }

    // Setup injection
    server._test.injectHttpRequest(fakeHttpRequest)

    // Call metaLookup with season=1
    const res = await server.metaLookup('Test Show', 'fake-tmdb-key', { season: 1 })

    // Ensure the result corresponds to season-augmented media
    assert(res && res.raw && res.raw.id === 9999, 'Expected season-specific media to be selected')

    // cleanup
    if (origHttpRequest) server._test._httpRequest = origHttpRequest
  })
})
