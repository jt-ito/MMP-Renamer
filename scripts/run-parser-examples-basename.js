const parse = require('../lib/filename-parser');
const path = require('path');

const examples = [
  '/mnt/Tor/[Hentai] Chuhai Lips - 08 [WEB 1080p x264 AAC2.0][Uncensored][Dual Audio].mkv',
  '/mnt/Tor/[Hentai] Chuhai Lips - 07 [WEB 1080p x264 AAC2.0][Uncensored][Dual Audio].mkv',
  '/mnt/Tor/[Hentai] Chuhai Lips - 06 [WEB 1080p x264 AAC2.0][Uncensored][Dual Audio].mkv',
  '/mnt/Tor/[Hentai] Chuhai Lips - 05 [WEB 1080p x264 AAC2.0][Uncensored][Dual Audio].mkv',
  '/mnt/Tor/[Hentai] Chuhai Lips - 04 [WEB 1080p x264 AAC2.0][Uncensored][Dual Audio].mkv',
  '/mnt/Tor/[Hentai] Chuhai Lips - 03 [WEB 1080p x265 AAC][373596DC][Uncensored][Dual Audio].mkv',
  '/mnt/Tor/[Hentai] Chuhai Lips - 02 [WEB 1080p x265 AAC][D142559C][Uncensored][Dual Audio].mkv',
  '/mnt/Tor/[Hentai] Chuhai Lips - 01v2 [WEB 1080p x265 AAC][6410BE90][Uncensored][Dual Audio].mkv'
];

for (const p of examples) {
  const base = path.basename(p);
  const parsed = parse(base);
  console.log('BASENAME:', base);
  console.log('  title:', parsed.title);
  console.log('  parsedName:', parsed.parsedName);
  console.log('  season:', parsed.season, 'episode:', parsed.episode, 'episodeRange:', parsed.episodeRange);
  console.log('  episodeTitle:', parsed.episodeTitle);
  console.log('');
}
