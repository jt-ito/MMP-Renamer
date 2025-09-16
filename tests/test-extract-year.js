const assert = require('assert')
const { extractYear } = require('../server')

function run() {
  // AniList-like structure (startDate.year)
  const metaAni = { title: 'Test', raw: { startDate: { year: 2010 }, source: 'anilist' } }
  assert.strictEqual(extractYear(metaAni, '/tmp/foo'), '2010')

  // TMDb-like series first_air_date
  const metaTmdb = { title: 'Test', first_air_date: '2008-04-05' }
  assert.strictEqual(extractYear(metaTmdb, '/tmp/foo'), '2008')

  // Episode-level air_date
  const metaEp = { episode: { air_date: '2012-07-11' } }
  assert.strictEqual(extractYear(metaEp, '/tmp/foo'), '2012')

  // seasonAirDate present
  const metaSeason = { seasonAirDate: '1999-01-01' }
  assert.strictEqual(extractYear(metaSeason, '/tmp/foo'), '1999')

  // top-level year field
  const metaYear = { year: 1995 }
  assert.strictEqual(extractYear(metaYear, '/tmp/foo'), '1995')

  // fallback to title containing year
  const metaTitle = { title: 'Movie (1997) Special' }
  assert.strictEqual(extractYear(metaTitle, '/tmp/foo'), '1997')

  // nothing found
  const metaNone = { title: 'No Year' }
  assert.strictEqual(extractYear(metaNone, '/tmp/foo'), null)

  console.log('extractYear tests passed')
}

run()
