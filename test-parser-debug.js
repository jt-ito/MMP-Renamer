const parse = require('./lib/filename-parser');

const testCases = [
  // Multi-part movies (should have season/episode = null)
  'Harry.Potter.and.the.Deathly.Hallows.Part.1.2010.1080p.10bit.BluRay.6CH.x265.HEVC-PSA.mkv',
  'Harry.Potter.and.the.Deathly.Hallows.Part.2.2011.1080p.10bit.BluRay.6CH.x265.HEVC-PSA.mkv',
  'Kill.Bill.Vol.1.2003.1080p.BluRay.x264.mkv',
  
  // TV shows with normal episodes (should have season/episode)
  'Breaking.Bad.S01E01.1080p.BluRay.x264.mkv',
  'Game.of.Thrones.S05E10.1080p.WEB-DL.mkv',
  
  // TV shows with "Part 1/2" in episode title (should still be treated as TV episodes!)
  'Breaking.Bad.S05E15.Granite.State.Part.1.1080p.BluRay.mkv',
  'Game.of.Thrones.S06E10.The.Winds.of.Winter.Part.2.1080p.mkv',
  'The.Walking.Dead.S04E08.Too.Far.Gone.Part.1.720p.mkv',
];

for (const filename of testCases) {
  console.log('\n' + '='.repeat(80));
  console.log('Input:', filename);
  const result = parse(filename);
  console.log('Title:', result.title);
  console.log('Season:', result.season, 'Episode:', result.episode);
  console.log('ParsedName:', result.parsedName);
}
