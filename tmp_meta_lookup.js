(async () => {
  try {
    const srv = require('./server');
    const metaLookup = srv.metaLookup || srv.metaLookup || (srv && srv.default && srv.default.metaLookup);
    if (!metaLookup) { console.error('metaLookup not found on server module'); process.exit(2); }
    const apiKey = process.argv[2] || process.env.TMDB_API_KEY || null;
    const title = process.argv[3] || 'Orejihanki';
    const parent = process.argv[4] || '/mnt/Tor/[Judas] Jidouhanbaiki ni Umarekawatta Ore wa Meikyuu o Samayou (Reborn as a Vending Machine, I Now Wander the Dungeon) (Season 1) [1080p][HEVC x265 10bit][Dual-Audio][Multi-Subs]';
    console.log('RUN: metaLookup title="' + title + '" keyPresent=' + (apiKey ? 'yes' : 'no'));
    const start = Date.now();
    const res = await metaLookup(title, apiKey, { season: 1, episode: 1, parentPath: parent, parsedEpisodeTitle: '' });
    console.log('RESULT in', Date.now()-start, 'ms:\n', JSON.stringify(res, null, 2));
    // try parent
    console.log('\nRUN: metaLookup parent title from parentCandidate');
    const pRes = await metaLookup('Jidouhanbaiki ni Umarekawatta Ore wa Meikyuu o Samayou', apiKey, { parentPath: parent });
    console.log('PARENT RESULT:\n', JSON.stringify(pRes, null, 2));
  } catch (e) {
    console.error('ERR', e && e.stack ? e.stack : e);
    process.exit(1);
  }
})();
