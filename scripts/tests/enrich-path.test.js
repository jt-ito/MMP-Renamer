const assert = require('assert');
const server = require('../../server');
(async ()=>{
  const testPath = '/input/86 S01+SP 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER/86 S01P01+SP 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER/S01E01-Undertaker [2F703024].mkv';
  try {
    const res = await server.externalEnrich(testPath, null, { username: null });
    console.log('enrich result:', JSON.stringify(res, null, 2));
    assert.strictEqual(res.title, '86', 'expected title to be "86"');
    assert.strictEqual(res.season, 1, 'expected season 1');
    assert.strictEqual(res.episode, 1, 'expected episode 1');
    console.log('TEST PASSED');
    process.exit(0);
  } catch (e) {
    console.error('TEST FAILED', e && e.message || e);
    process.exit(2);
  }
})();
