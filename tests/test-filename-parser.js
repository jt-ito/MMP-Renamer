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

  console.log('filename-parser tests passed')
}

run()

// Additional test for user-provided example: trailing numeric should be episode
try {
  const example = '/mnt/Tor/[Hentai] Chuhai Lips - 08 [WEB 1080p x264 AAC2.0][Uncensored][Dual Audio].mkv'
  const r2 = parse(example)
  console.log('example parse:', r2)
  if (!(r2.title && /Chuhai Lips/i.test(r2.title))) throw new Error('title mismatch')
  if (Number(r2.episode) !== 8) throw new Error('episode mismatch: ' + String(r2.episode))
  console.log('additional test passed')
} catch (e) { console.error('additional test failed', e && e.message); process.exit(1) }
