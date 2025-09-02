(async () => {
  try {
    const { externalEnrich } = require('./server');
    const metaLookup = require('./server').metaLookup || require('./server').meta_lookup || null;
    if (!metaLookup) {
      console.error('metaLookup not exported directly; invoking externalEnrich with parentCandidate instead');
      const p = process.argv[2];
      const key = process.argv[3];
      const res = await externalEnrich(p, key, { parentCandidate: 'Jidouhanbaiki ni Umarekawatta Ore wa Meikyuu o Samayou' });
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    const key = process.argv[2];
    const title = process.argv[3] || 'Orejihanki';
    const res = await metaLookup(title, key, { parentCandidate: 'Jidouhanbaiki ni Umarekawatta Ore wa Meikyuu o Samayou' });
    console.log(JSON.stringify(res, null, 2));
  } catch (e) { console.error(e && e.stack ? e.stack : e); process.exit(1); }
})();
