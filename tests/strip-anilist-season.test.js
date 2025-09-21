const assert = require('assert')
const server = require('../server')

// server.exports._test contains test hooks; helper is exported as _test.stripAniListSeasonSuffix
const strip = server._test && server._test.stripAniListSeasonSuffix ? server._test.stripAniListSeasonSuffix : (s, r) => { throw new Error('stripAniListSeasonSuffix not exported at server._test.stripAniListSeasonSuffix') }

describe('stripAniListSeasonSuffix', function() {
  it('keeps numeric part when part of title and removes explicit season token', function() {
    const inStr = 'Kaiju No. 8 Season 2'
    const out = strip(inStr, { season: 2 })
    assert.strictEqual(out, 'Kaiju No. 8')
  })

  it('removes explicit season token (Season 1)', function() {
    const inStr = 'Some Show Season 1'
    const out = strip(inStr, { season: 1 })
    assert.strictEqual(out, 'Some Show')
  })

  it('preserves ambiguous trailing number when not an explicit season token', function() {
    const inStr = 'Show 2'
    const out = strip(inStr, {})
    assert.strictEqual(out, 'Show 2')
  })

  it('removes textual ordinal season tokens (Third Season)', function() {
    const inStr = 'The Great Tale Third Season'
    const out = strip(inStr, {})
    assert.strictEqual(out, 'The Great Tale')
  })

  it('removes S## pattern at end', function() {
    const inStr = 'Manga Saga S02'
    const out = strip(inStr, {})
    assert.strictEqual(out, 'Manga Saga')
  })
})
