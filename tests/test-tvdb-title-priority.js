const assert = require('assert')
const { extractEpisodeTitle } = require('../lib/tvdb')

function run() {
  const episodeWithEnglish = {
    name: '故郷と旅路',
    translations: [
      { language: 'jpn', name: '故郷と旅路' },
      { language: 'eng', name: 'Home and Journey' },
      { language: 'x-jat', name: 'Furusato to Tabiji' }
    ]
  }
  assert.strictEqual(extractEpisodeTitle(episodeWithEnglish), 'Home and Journey')

  const episodeWithRomajiOnly = {
    name: '故郷と旅路',
    translations: [
      { language: 'x-jat', name: 'Furusato to Tabiji' },
      { language: 'jpn', name: '故郷と旅路' }
    ]
  }
  assert.strictEqual(extractEpisodeTitle(episodeWithRomajiOnly), 'Furusato to Tabiji')

  const episodeNativeOnly = {
    name: '故郷と旅路'
  }
  assert.strictEqual(extractEpisodeTitle(episodeNativeOnly), '故郷と旅路')

  const episodeWithLangCodes = {
    name: '故郷と旅路',
    nameTranslations: ['jpn', 'eng', 'deu']
  }
  assert.strictEqual(extractEpisodeTitle(episodeWithLangCodes), '故郷と旅路')

  console.log('extractEpisodeTitle tests passed')
}

run()
