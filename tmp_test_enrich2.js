(async () => {
  try {
    const { externalEnrich } = require('./server');
    const p = process.argv[2];
    const apiKey = process.argv[3] || process.env.TMDB_API_KEY || null;
    if (!p) { console.error('usage: node tmp_test_enrich2.js <path> <tmdb_key>'); process.exit(2); }
    console.log('RUN: externalEnrich path="' + p + '"');
    const start = Date.now();
    const res = await externalEnrich(p, apiKey, {});
    console.log('DONE in', Date.now()-start, 'ms');
    const outPath = require('path').join(__dirname, 'tmp_test_enrich2_out.json');
    require('fs').writeFileSync(outPath, JSON.stringify(res, null, 2), 'utf8');
    console.log('WROTE:', outPath);
    console.log(JSON.stringify(res, null, 2));
  } catch (e) {
    console.error('ERR', e && e.stack ? e.stack : e);
    process.exit(1);
  }
})();
