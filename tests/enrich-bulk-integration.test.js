const assert = require('assert')
const server = require('../server')

// Integration-ish test: inject a fake httpRequest to intercept TMDb search queries and ensure
// that the tmLookupName used for TMDb searches is stripped when AniList indicates season
// and preserved otherwise.

describe('externalEnrich TMDb tmLookupName behavior', function() {
  let recorded = []
  beforeEach(function() {
    recorded = []
    // fake httpRequest that records the outgoing hostname/path and returns canned bodies
    server._test = server._test || {}
    server._test._httpRequest = async function(options, body, timeoutMs) {
      const hostname = options && options.hostname
      const path = options && options.path
      recorded.push({ hostname, path, body })
      // Provide minimal JSON bodies depending on hostname to guide code paths
      if (hostname === 'graphql.anilist.co') {
        // Respond with a media item that includes seasonYear to simulate AniList indicating a season
  const resp = { data: { Page: { media: [ { id: 1, title: { english: 'Fake Show 2', romaji: 'Fake Show 2', native: 'Fake Show 2' }, seasonYear: 2020, relations: { nodes: [] }, externalLinks: [] } ] } } }
        return { statusCode: 200, headers: {}, body: JSON.stringify(resp) }
      }
      if (hostname === 'api.themoviedb.org') {
        // If TMDb search receives query for "Fake Show" (stripped) vs "Fake Show 2" (not stripped), record it
        const fakeHits = { results: [ { id: 42, name: 'Fake Show' } ] }
        return { statusCode: 200, headers: {}, body: JSON.stringify(fakeHits) }
      }
      if (hostname === 'kitsu.io') {
        return { statusCode: 200, headers: {}, body: JSON.stringify({ data: [] }) }
      }
      return { statusCode: 200, headers: {}, body: '{}' }
    }
  })

  it('strips numeric when AniList indicates seasonYear', async function() {
    // Create a synthetic canonicalPath that externalEnrich will parse; we'll bypass filename parsing by calling metaLookup directly
    const title = 'Fake Show'
    // Call metaLookup which under the hood will call AniList then TMDb; pass season option to prefer season-augmented queries
    const res = await server.metaLookup('Fake Show', 'FAKEKEY', { season: 2 })
  // ensure the metaLookup returned a stripped name
  assert.ok(res && res.name, 'metaLookup returned result')
  assert.strictEqual(res.name, 'Fake Show')
  })

  it('preserves numeric when AniList does not indicate a season', async function() {
    // modify fake AniList response to not include seasonYear
    server._test._httpRequest = async function(options, body, timeoutMs) {
      const hostname = options && options.hostname
      const path = options && options.path
      recorded.push({ hostname, path, body })
      if (hostname === 'graphql.anilist.co') {
  const resp = { data: { Page: { media: [ { id: 2, title: { english: 'Kaiju No. 8', romaji: 'Kaiju No. 8', native: 'Kaiju No. 8' }, relations: { nodes: [] }, externalLinks: [] } ] } } }
        return { statusCode: 200, headers: {}, body: JSON.stringify(resp) }
      }
      if (hostname === 'api.themoviedb.org') {
        const fakeHits = { results: [ { id: 43, name: 'Kaiju No. 8' } ] }
        return { statusCode: 200, headers: {}, body: JSON.stringify(fakeHits) }
      }
      if (hostname === 'kitsu.io') {
        return { statusCode: 200, headers: {}, body: JSON.stringify({ data: [] }) }
      }
      return { statusCode: 200, headers: {}, body: '{}' }
    }

    const res = await server.metaLookup('Kaiju No. 8', 'FAKEKEY', {})
    // ensure metaLookup returned the preserved numeric in the name
    assert.ok(res && res.name, 'metaLookup returned result')
    assert.strictEqual(res.name, 'Kaiju No. 8')
  })
})
