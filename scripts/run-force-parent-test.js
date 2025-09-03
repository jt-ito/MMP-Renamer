(async () => {
  const s = require('../server');
  const users = require('../data/users.json');
  const key = (users && users.admin && users.admin.settings && users.admin.settings.tmdb_api_key) || 'd33feebc0ec280d7399e942f56c6c385';
  console.log('CALLING metaLookup with force parent');
  try {
    const res = await s.metaLookup('Orejihanki', key, { parentPath: '/mnt/Tor/[Judas] Jidouhanbaiki ni Umarekawatta Ore wa Meikyuu o Samayou (Reborn as a Vending Machine, I Now Wander the Dungeon) (Season 1) [1080p][HEVC x265 10bit][Dual-Audio][Multi-Subs]', parentCandidate: 'Jidouhanbaiki ni Umarekawatta Ore wa Meikyuu o Samayou', force: true });
    console.log('metaLookup result:', res);
  } catch (e) { console.error('metaLookup error', e); }
})();
