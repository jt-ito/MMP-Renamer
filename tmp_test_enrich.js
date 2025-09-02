(async () => {
  try {
    const { externalEnrich } = require('./server');
    const p = '/mnt/Tor/86 S01+SP 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER/86 S01P01+SP 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER/S01E11.5 [SP]-The Poppies Bloom Red on the Battlefield [E614C7DC].mkv';
  console.log('TEST: calling externalEnrich for path:', p);
  const watchdog = setTimeout(() => { console.error('TEST: watchdog timeout (10s)'); process.exit(2); }, 10000);
  const start = Date.now();
  const res = await externalEnrich(p, null, {});
  clearTimeout(watchdog);
  console.log('TEST: externalEnrich completed in', Date.now() - start, 'ms');
  console.log(JSON.stringify(res, null, 2));
  } catch (e) {
    console.error('ERR', e && e.stack ? e.stack : e);
    process.exit(1);
  }
})();
