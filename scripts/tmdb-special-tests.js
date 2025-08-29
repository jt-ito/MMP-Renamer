const https = require('https');
const key = 'd33feebc0ec280d7399e942f56c6c385';
const base = 'api.themoviedb.org';
function getJSON(path){
  return new Promise((resolve, reject)=>{
    const opts = { hostname: base, path: path, method: 'GET', headers: { 'Accept': 'application/json' }, timeout: 10000 };
    const req = https.request(opts, (res)=>{
      let b=''; res.on('data', d=>b+=d); res.on('end', ()=>{
        try{ resolve(JSON.parse(b||'{}')); }catch(e){ reject(e); }
      });
    });
    req.on('error', reject); req.on('timeout', ()=>{ req.destroy(); reject(new Error('timeout')) }); req.end();
  });
}

async function run(){
  try{
    console.log('1) Search TV by query "86"');
    let q = encodeURIComponent('86');
    let res = await getJSON(`/3/search/tv?api_key=${key}&query=${q}`);
    console.log('search.total_results=', res.total_results || 0);
    const hits = (res.results||[]).slice(0,5).map(h=>({ id: h.id, name:h.name || h.original_name, first_air_date: h.first_air_date }));
    console.log('top hits:', hits);

    // pick candidate id if found; fallback to known id
    const candidate = (res.results||[]).find(r => String(r.id) === '100565' || /86/i.test(r.name || r.original_name));
    const tvId = candidate ? candidate.id : ((res.results&&res.results[0]&&res.results[0].id) || 100565);
    console.log('using tv_id=', tvId);

    // Try episode endpoint with decimal on season 1
    console.log('\n2) Try episode endpoint: season=1 episode=11.5');
    try{
      const ep = await getJSON(`/3/tv/${tvId}/season/1/episode/11.5?api_key=${key}`);
      console.log('season1 ep 11.5 ->', { name: ep.name, episode_number: ep.episode_number, air_date: ep.air_date, id: ep.id });
    } catch(e){ console.log('season1 11.5 failed:', e.message); }

    // Try season 0 episode 11
    console.log('\n3) Try season=0 episode=11');
    try{
      const ep0 = await getJSON(`/3/tv/${tvId}/season/0/episode/11?api_key=${key}`);
      console.log('season0 ep11 ->', { name: ep0.name, episode_number: ep0.episode_number, air_date: ep0.air_date, id: ep0.id });
    } catch(e){ console.log('season0 ep11 failed:', e.message); }

    // Try season 0 list
    console.log('\n4) Fetch season 0 list');
    try{
      const s0 = await getJSON(`/3/tv/${tvId}/season/0?api_key=${key}`);
      console.log('season0.name=', s0.name, 'episodes:', (s0.episodes||[]).length);
      // list any episodes matching decimal or known title
      const found = (s0.episodes||[]).filter(e=> (String(e.episode_number||'')==='11' || String(e.episode_number||'').includes('.') || /Here We Go/i.test(e.name||'')) ).map(e=>({ ep: e.episode_number, name: e.name, id: e.id }));
      console.log('matches in season0:', found.slice(0,10));
    } catch(e){ console.log('season0 fetch failed:', e.message); }

    // Try fetch season 1 list
    console.log('\n5) Fetch season 1 list');
    const s1 = await getJSON(`/3/tv/${tvId}/season/1?api_key=${key}`);
    console.log('season1.name=', s1.name, 'episodes:', (s1.episodes||[]).length);
    const found1 = (s1.episodes||[]).filter(e=> (String(e.episode_number||'')==='11.5' || String(e.episode_number||'')==='11' || /Here We Go/i.test(e.name||'') )).map(e=>({ ep: e.episode_number, name: e.name, id: e.id }));
    console.log('matches in season1:', found1.slice(0,10));

    // As fallback search episodes by name via season lists
    console.log('\n6) Search episodes by name heuristically across seasons 0..(s1.season_number)');
    const seasonsToCheck = [0,1];
    for(const sn of seasonsToCheck){
      try{
        const s = await getJSON(`/3/tv/${tvId}/season/${sn}?api_key=${key}`);
        for(const e of (s.episodes||[])){
          if (/here we go/i.test(e.name||'')) console.log(`found in season ${sn} ep ${e.episode_number}: ${e.name}`);
        }
      }catch(e){ /* ignore */ }
    }

    console.log('\nDone');
  }catch(e){ console.error('error', e); }
}

run();
