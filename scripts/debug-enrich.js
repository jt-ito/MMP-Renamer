const path = require('path');
const fs = require('fs');
const server = require('../server.js');

const raw = 'C:/Users/ito/Documents/Tor/[CBM] Citrus 1-12 Complete (Dual Audio) [BDRip 1080p x265 10bit]/[CBM]_Citrus_-_01_-_Love_Affair!_[x265_10bit]_[70C69154].mkv';
const canonical = path.resolve(raw).replace(/\\/g, '/');

let enrichCache = {};
try { enrichCache = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'enrich.json'), 'utf8')); } catch (e) { enrichCache = {} }
const cached = enrichCache[canonical] || null;

;(async () => {
  try {
  const forced = await server.externalEnrich(canonical, null);
  console.log(JSON.stringify({ key: canonical, cached, forced, provider: forced && forced.provider ? forced.provider : null }, null, 2));
  } catch (e) {
    console.error('ERROR', e && e.stack ? e.stack : e);
    process.exit(1);
  }
})();
