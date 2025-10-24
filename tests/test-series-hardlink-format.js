const assert = require('assert')
const server = require('../server')

function run() {
  const determineIsMovie = server._test.determineIsMovie
  const renderProviderName = server._test.renderProviderName
  assert.ok(typeof determineIsMovie === 'function', 'determineIsMovie should be exposed for tests')
  assert.ok(typeof renderProviderName === 'function', 'renderProviderName should be exposed for tests')

  const tieMeta = {
    mediaFormat: 'Series',
    raw: {
      format: 'Movie',
      first_air_date: '2025-01-01',
      number_of_episodes: 12
    }
  }
  assert.strictEqual(determineIsMovie(tieMeta), false, 'series classification should win when movie + series signals both present')

  const providerData = {
    title: "A Gatherer's Adventure in Isekai",
    year: '2025',
    season: 1,
    episode: 3,
    episodeTitle: 'Home and Journey',
    raw: {
      first_air_date: '2025-10-01',
      number_of_episodes: 12
    },
    extraGuess: {
      isMovie: false
    }
  }

  const rendered = renderProviderName(providerData, '/mnt/Tor/Sozai Saishuka no Isekai Ryokouki - 03.mkv', null)
  assert(rendered.includes('S01E03'), 'rendered name should include episode label')
  assert(rendered.includes('Home and Journey'), 'rendered name should include episode title')
  assert(!rendered.includes('(2025)'), 'series provider render should not include year in parentheses')
  assert(!rendered.includes('()'), 'rendered name should not contain empty parentheses')

  console.log('series hardlink format tests passed')
}

run()
