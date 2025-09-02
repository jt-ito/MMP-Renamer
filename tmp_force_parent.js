(async () => {
  try {
  console.log('TMP_FORCE_PARENT: starting');
  const { externalEnrich } = require('./server');
  const filePath = process.argv[2] || process.env.PATH_ARG;
  const tmdbKey = process.argv[3] || process.env.TMDB_KEY || null;
  if (!filePath) {
    console.error('Usage: node tmp_force_parent.js <path> [TMDB_KEY]');
    process.exit(2);
  }
  console.log('TMP_FORCE_PARENT: calling externalEnrich with path=', filePath, ' tmdbKeyPresent=', !!tmdbKey);
  const res = await externalEnrich(filePath, tmdbKey, {});
  console.log('TMP_FORCE_PARENT: externalEnrich returned:');
  console.log(JSON.stringify(res, null, 2));
  } catch (e) { console.error(e && e.stack ? e.stack : e); process.exit(1); }
})();
