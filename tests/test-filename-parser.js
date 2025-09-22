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
  // Per project policy: do NOT infer season/episode from filename for regular
  // numbered episodes. Only season 0 or decimal (e.g. 11.5) episodes are
  // considered. Therefore this filename should NOT produce a parsed episode.
  assert.strictEqual(res.season, null, `expected season null got ${res.season}`)
  assert.strictEqual(res.episode, null, `expected episode null got ${res.episode}`)

  // parsedName should not contain the episode title 'Clover Is Born'
  assert.ok(!/Clover Is Born/i.test(res.parsedName), `parsedName should not include episode title, got '${res.parsedName}'`)

  console.log('filename-parser tests passed')
}

run()
