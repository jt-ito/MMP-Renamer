const server = require('../server');
(async ()=>{
  try {
    const tmdbKey = 'd33feebc0ec280d7399e942f56c6c385';
    const testPath = '/input/86 S01+SP 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER/86 S01P01+SP 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER/S01E11.5-Something.mkv';
    // Call externalEnrich with the TMDb key. The script will not print the key.
    const res = await server.externalEnrich(testPath, tmdbKey, { username: null });
    const out = {
      title: res.title || null,
      year: res.year || null,
      parsedName: res.parsedName || null,
      season: res.season != null ? res.season : null,
      episode: res.episode != null ? res.episode : null,
      episodeTitle: res.episodeTitle || null,
      provider: res.provider || null,
      tvdb: res.tvdb || null
    };
    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    console.error('ERROR', e && e.message || e);
    process.exitCode = 1;
  }
})();
