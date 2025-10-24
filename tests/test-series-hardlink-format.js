const assert = require('assert')
const server = require('../server')

function run() {
  const determineIsMovie = server._test.determineIsMovie
  const renderProviderName = server._test.renderProviderName
  const ensureRenderedNameHasYear = server._test.ensureRenderedNameHasYear
  assert.ok(typeof determineIsMovie === 'function', 'determineIsMovie should be exposed for tests')
  assert.ok(typeof renderProviderName === 'function', 'renderProviderName should be exposed for tests')
  assert.ok(typeof ensureRenderedNameHasYear === 'function', 'ensureRenderedNameHasYear should be exposed for tests')

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
  assert(rendered.includes('(2025)'), 'rendered name should include year in parentheses for filenames')
  assert(!rendered.includes('()'), 'rendered name should not contain empty parentheses')

  const injected = ensureRenderedNameHasYear('Example Show - S01E01 - Pilot', '2025')
  assert.strictEqual(injected, 'Example Show (2025) - S01E01 - Pilot', 'helper should inject year before first separator')
  const untouched = ensureRenderedNameHasYear('Example Show (2024) - S01E01 - Pilot', '2024')
  assert.strictEqual(untouched, 'Example Show (2024) - S01E01 - Pilot', 'helper should avoid duplicating an existing year token')

  console.log('series hardlink format tests passed')
}

run()
