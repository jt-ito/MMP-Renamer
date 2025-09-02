(async () => {
  try {
    const args = process.argv.slice(2);
    if (!args || !args[0]) {
      console.error('Usage: node tmp_force_parent_real.js <path> [tmdb_key]');
      process.exit(2);
    }
    const targetPath = args[0];
    const tmdbKey = args[1] || null;
    console.log('TEST: starting externalEnrich for', targetPath, 'tmdbKeyPresent=', !!tmdbKey);
    const srv = require('./server');
    if (!srv || typeof srv.externalEnrich !== 'function') {
      console.error('ERROR: server.externalEnrich not available');
      process.exit(3);
    }
    const res = await srv.externalEnrich(targetPath, tmdbKey, {});
    console.log('TEST: externalEnrich completed; result:');
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  } catch (e) { console.error(e && e.stack ? e.stack : e); process.exit(1); }
})();
