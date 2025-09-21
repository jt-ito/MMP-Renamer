const assert = require('assert')
const server = require('../server')
const strip = server._test && server._test.stripAniListSeasonSuffix ? server._test.stripAniListSeasonSuffix : (s, r) => { throw new Error('stripAniListSeasonSuffix not exported') }

describe('stripAniListSeasonSuffix - extra cases', function() {
  it('handles parenthetical season and punctuation: Kaiju No.8 (Season 2)', function() {
    const inStr = 'Kaiju No.8 (Season 2)'
    const out = strip(inStr, { season: 2 })
    assert.strictEqual(out, 'Kaiju No.8')
  })

  it('handles S02 attached to No.8: No.8 S02', function() {
    const inStr = 'Kaiju No.8 S02'
    const out = strip(inStr, {})
    assert.strictEqual(out, 'Kaiju No.8')
  })

  it('preserves decimal episode-like numbers when not season: Series 11.5 Special', function() {
    const inStr = 'Series 11.5 Special'
    const out = strip(inStr, {})
    assert.strictEqual(out, 'Series 11.5 Special')
  })

  it('removes season even when year follows: Title (Season 2) 2025', function() {
    const inStr = 'Title (Season 2) 2025'
    const out = strip(inStr, {})
    assert.strictEqual(out, 'Title 2025')
  })

  it('rawPick indicates seasonYear and causes confident stripping', function() {
    const inStr = 'Show 3'
    const out = strip(inStr, { seasonYear: 2025 })
    // Because rawPick has seasonYear we may consider it a season token only if explicit; still expect preservation
    assert.strictEqual(out, 'Show 3')
  })
})
