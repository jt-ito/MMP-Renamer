const server = require('../server.js');
(async ()=>{
  try {
    const testPath = '/mnt/Tor/The Eminence in Shadow S02 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER/S02E01-The Lawless City [0DBC6786].mkv';
    console.log('Invoking externalEnrich for path:', testPath);
    const res = await server.externalEnrich(testPath, null, { username: null, force: true });
    console.log('externalEnrich result (top-level):');
    console.log(JSON.stringify(res, null, 2));
    try {
      const rendered = server._test && server._test.renderProviderName ? server._test.renderProviderName(res, testPath, null) : null;
      console.log('\nrenderProviderName output:');
      console.log(rendered);
    } catch (e) {
      console.error('renderProviderName failed', e && e.message ? e.message : e);
    }
    process.exit(0);
  } catch (e) {
    console.error('ERROR', e && e.stack || e);
    process.exit(1);
  }
})();
