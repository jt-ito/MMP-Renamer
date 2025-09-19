const parse = require('./lib/filename-parser');
const examples = [
  '/mnt/Tor/[Hentai] Chuhai Lips - 02 [WEB 1080p x265 AAC][D142559C][Uncensored][Dual Audio].mkv',
  '/mnt/Tor/[Hentai] Chuhai Lips - 03 [WEB 1080p x265 AAC][373596DC][Uncensored][Dual Audio].mkv',
  '/mnt/Tor/[Hentai] Chuhai Lips - 05 [WEB 1080p x264 AAC2.0][Uncensored][Dual Audio].mkv'
];
for (const e of examples) {
  console.log('PATH:', e);
  console.log(parse(e));
  console.log('---');
}
