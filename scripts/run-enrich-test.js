const path = require('path');
(async ()=>{
  try {
    const server = require('../server.js');
    const testPath = '/input/86 S01+SP 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER/86 S01P01+SP 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER/S01E01-Undertaker [2F703024].mkv';
    const res = await server.externalEnrich(testPath, null, { username: null });
    console.log(JSON.stringify(res, null, 2));
  } catch (e) {
    console.error('ERROR', e && e.stack || e);
    process.exitCode = 1;
  }
})();
