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
