const parse = require('../lib/filename-parser');
const examples = [
  // user example (nested path)
  '86 S01+SP 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER/86 S01P01+SP 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER/S01E01-Undertaker [2F703024].mkv',
  // typical SxxEyy
  'Show.Name.S02E05.1080p.WEB-DL.x264-Group.mkv',
  // 1x02 style
  'Another.Show.1x02.HDTV-LOL.mkv',
  // numeric title
  '86. S01E02.720p.mkv',
  // dash separated
  'Some Show - S01E03 - The Episode Title - 1080p.mkv',
  // special marker
  'Series.Title.S01P01.Special.1080p.mkv',
  // multi-episode
  'Show - 01-02 - Double Ep - 720p.mkv',
  // episode number at end
  'WeirdShow 05 720p.mkv',
  // with year in title
  'Movie.Title.2019.1080p.BluRay.mkv',
  // messy release name
  'Anime.Title.S03E12.1080p.WEBRip.x265.AAC-Group [eng].mkv'
];

for (const e of examples) {
  const parsed = parse(e);
  console.log('---');
  console.log('input:', e);
  console.log(JSON.stringify(parsed, null, 2));
}
// quick test harness for filename parsing in server.js
const path = require('path');
const server = require(path.join(__dirname, '..', 'server.js'));

async function run() {
  const samples = [
    'My.Show.S01E02.1080p.WEB-DL.x264-GROUP.mkv',
    'My_Show_-_1x03_-_Episode_Title_[Fansub]_1080p.mkv',
    'Movie.Title.2019.1080p.BluRay.x265.10bit-GRP.mkv',
    'Anime Title - 12 [720p][FLAC][Subs].mkv',
    'Series.Name.S02E10.720p.HDTV.x264-LOL.mkv',
    'Cool.Show.01.720p.WEBRip.mkv',
    'Weird.Title.(2018).1080p.BluRay.x264-GRP.mkv',
    'Dual.Audio.Movie.2017.1080p.BluRay.Dual-Audio.mkv'
  ];

  // added range sample for parser verification
  samples.push('Some.Show.-.01-02.-.Multi_Episode_Title_[1080p].mkv');

  for (const s of samples) {
    const res = await server.externalEnrich(s);
    console.log('---');
    console.log('input:', s);
    console.log('parsed:', res.extraGuess);
  }
}

run().catch(e => { console.error(e); process.exit(1); });
