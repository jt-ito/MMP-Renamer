const s = require('../server');
(async () => {
  console.log('TEST_INVOKE metaLookup parent=86');
  try {
    const res = await s.metaLookup('86', 'FAKE_KEY', { parentCandidate: null, parentPath: 'C:/input/86 S01+SP 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER/86 S01P01+SP 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER' });
    console.log('TEST_RESULT', res);
  } catch (e) {
    console.error('TEST_ERROR', e);
  }
})();
