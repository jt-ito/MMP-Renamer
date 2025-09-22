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
  // The filename contains an explicit S01E01 marker; we should preserve
  // explicit markers (but still avoid pulling the episode title from the RHS).
  assert.strictEqual(res.season, 1, `expected season 1 got ${res.season}`)
  assert.strictEqual(res.episode, 1, `expected episode 1 got ${res.episode}`)

  // parsedName should not contain the episode title 'Clover Is Born', but
  // should include an S01E01 label constructed from the explicit marker.
  assert.ok(!/Clover Is Born/i.test(res.parsedName), `parsedName should not include episode title, got '${res.parsedName}'`)
  assert.ok(/S01E01/.test(res.parsedName), `parsedName should include S01E01, got '${res.parsedName}'`)

  console.log('filename-parser tests passed')
}

run()
