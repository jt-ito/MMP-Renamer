const assert = require('assert')
const parse = require('../lib/filename-parser')

function run() {
  // Example path from the user
  const path = '/mnt/Tor/Aparida S01 1080p Dual Audio WEBRip DD+ x265-EMBER/S01E01-Clover Is Born [76538209].mkv'
  const res = parse(path)

  // We expect the series title NOT to be the episode title 'Clover Is Born'.
  // The parser should preserve the left-side series title (from the folder name) like 'Aparida S01' -> cleaned to 'Aparida'.
  assert.ok(res.title && res.title.toLowerCase().includes('aparida'), `expected title to contain 'aparida', got '${res.title}'`)

  // Season/Episode should be parsed
  assert.strictEqual(res.season, 1, `expected season 1 got ${res.season}`)
  assert.strictEqual(res.episode, 1, `expected episode 1 got ${res.episode}`)

  // parsedName should not contain the episode title 'Clover Is Born'
  assert.ok(!/Clover Is Born/i.test(res.parsedName), `parsedName should not include episode title, got '${res.parsedName}'`)

  // Sequels with trailing numerals should keep the number in the title and parse the episode correctly.
  const tawawa = parse('[RoS] Getsuyoubi no Tawawa 2 - 01 [E1C925F2].mkv')
  assert.strictEqual(tawawa.title, 'Getsuyoubi no Tawawa 2', `expected sequel title to retain "2", got '${tawawa.title}'`)
  assert.strictEqual(tawawa.season, 2, `expected inferred season 2 got ${tawawa.season}`)
  assert.strictEqual(tawawa.episode, 1, `expected episode 1 got ${tawawa.episode}`)
  assert.strictEqual(tawawa.parsedName, 'Getsuyoubi no Tawawa 2 - S02E01', `expected parsedName to reflect S02E01, got '${tawawa.parsedName}'`)

  // Titles where trailing numerals are part of the name should continue to default to season 1.
  const area88 = parse('Area 88 - 01.mkv')
  assert.strictEqual(area88.season, 1, `expected season 1 for numeric title got ${area88.season}`)
  assert.strictEqual(area88.episode, 1, `expected episode 1 got ${area88.episode}`)

  const partSequel = parse('My Movie Part 2 - 01.mkv')
  assert.strictEqual(partSequel.season, 1, `expected to ignore "Part 2" as season, got season ${partSequel.season}`)

  console.log('filename-parser tests passed')
}

run()
