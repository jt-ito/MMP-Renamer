const parse = require('../lib/filename-parser');
const samples = [
  '/mnt/Tor/Breaking Bad (2008) Season 1-5 S01-S05 (1080p BluRay x265 HEVC 10bit AAC 5.1 Silence)/Season 2/Breaking Bad (2008) - S02E03 - Bit by a Dead Bee (1080p BluRay x265 Silence).mkv',
  '/mnt/Tor/Breaking Bad (2008) Season 1-5 S01-S05 (1080p BluRay x265 HEVC 10bit AAC 5.1 Silence)/Season 2/Breaking Bad (2008) - S02E04 - Down (1080p BluRay x265 Silence).mkv',
  '/mnt/Tor/Breaking Bad (2008) Season 1-5 S01-S05 (1080p BluRay x265 HEVC 10bit AAC 5.1 Silence)/Season 2/Breaking Bad (2008) - S02E07 - Negro Y Azul (1080p BluRay x265 Silence).mkv'
];
for (const s of samples) {
  console.log('---');
  console.log('path:', s);
  try {
    const out = parse(s);
    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    console.error('parse error', e && e.message);
  }
}
