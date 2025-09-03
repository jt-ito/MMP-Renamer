(async () => {
  const s = require('../server');
  console.log('CALLING externalEnrich with force=true');
  try {
    const res = await s.externalEnrich('/mnt/Tor/[Judas] Jidouhanbaiki ni Umarekawatta Ore wa Meikyuu o Samayou (Reborn as a Vending Machine, I Now Wander the Dungeon) (Season 1) [1080p][HEVC x265 10bit][Dual-Audio][Multi-Subs]/[Judas] Orejihanki - S01E01v2.mkv', null, { force: true, username: null });
    console.log('externalEnrich result:', res && res.title);
  } catch (e) { console.error('externalEnrich error', e); }
})();
