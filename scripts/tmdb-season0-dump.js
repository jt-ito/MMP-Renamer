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
    const tvId = 100565;
    console.log('Fetching season 0 for tv_id=', tvId);
    const s0 = await getJSON(`/3/tv/${tvId}/season/0?api_key=${key}`);
    console.log('season0.name=', s0.name, 'episodes:', (s0.episodes||[]).length);
    const eps = (s0.episodes||[]).map(e=>({episode_number: e.episode_number, name: e.name, air_date: e.air_date, id: e.id, overview: e.overview, runtime: e.runtime}));
    console.log(JSON.stringify(eps, null, 2));
  }catch(e){ console.error('error', e && e.message || e); }
}

run();
