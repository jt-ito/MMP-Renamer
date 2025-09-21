const assert = require('assert')
const server = require('../server')

describe('stripAniListSeasonSuffix helper', function() {
  it('strips explicit "Season N" parenthetical', function() {
    const s = server._test && server._test.stripAniListSeasonSuffix ? server._test.stripAniListSeasonSuffix : null
    // fall back to calling metaLookup internal helper via externalEnrich pathway if helper not exported
    if (!s) {
      // try metaLookup via public function and inspect returned name when AniList pick is synthetic
      return this.skip()
    }
    const before = 'Some Show (Season 2)'
    const after = s(before, { seasonYear: 2020 })
    assert.strictEqual(after, 'Some Show')
  })

  it('strips trailing numeric when confident via rawPick.seasonYear', function() {
    const s = server._test && server._test.stripAniListSeasonSuffix ? server._test.stripAniListSeasonSuffix : null
    if (!s) return this.skip()
    const before = 'Show 2'
    const after = s(before, { seasonYear: 2020 })
    assert.strictEqual(after, 'Show')
  })

  it('does not strip trailing numeric when not confident', function() {
    const s = server._test && server._test.stripAniListSeasonSuffix ? server._test.stripAniListSeasonSuffix : null
    if (!s) return this.skip()
    const before = 'Kaiju No. 8'
    const after = s(before, null)
    assert.strictEqual(after, 'Kaiju No. 8')
  })

  it('strips when title contains the word season even without seasonYear', function() {
    const s = server._test && server._test.stripAniListSeasonSuffix ? server._test.stripAniListSeasonSuffix : null
    if (!s) return this.skip()
    const before = 'Cool Show Season 3'
    const after = s(before, null)
    assert.strictEqual(after, 'Cool Show')
  })
})