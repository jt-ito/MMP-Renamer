(async () => {
  try {
    const { externalEnrich } = require('./server');
  const defaultPath = '/mnt/Tor/[Judas] Jidouhanbaiki ni Umarekawatta Ore wa Meikyuu o Samayou (Reborn as a Vending Machine, I Now Wander the Dungeon) (Season 1) [1080p][HEVC x265 10bit][Dual-Audio][Multi-Subs]/[Judas] Orejihanki - S01E01v2.mkv';
  const p = process.argv[2] || defaultPath;
    // Accept API key as third arg or TMDB_API_KEY env var
    const apiKey = process.argv[3] || process.env.TMDB_API_KEY || null;
    console.log('TEST: calling externalEnrich for path:', p);
    console.log('TEST: tmdb key provided:', apiKey ? 'yes' : 'no');
  const watchdog = setTimeout(() => { console.error('TEST: watchdog timeout (60s)'); process.exit(2); }, 60000);
    const start = Date.now();
    const res = await externalEnrich(p, apiKey, {});
    clearTimeout(watchdog);
    console.log('TEST: externalEnrich completed in', Date.now() - start, 'ms');
    console.log(JSON.stringify(res, null, 2));
  } catch (e) {
    console.error('ERR', e && e.stack ? e.stack : e);
    process.exit(1);
  }
})();
