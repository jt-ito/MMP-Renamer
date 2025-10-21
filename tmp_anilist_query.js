const https = require('https');
const query = `query ($search: String) { Page(page:1, perPage:8) { media(search: $search, type: ANIME) { id title { romaji english native } season seasonYear startDate { year } } } }`;
const search = process.argv[2] || 'hojo mahou';
const body = JSON.stringify({ query, variables: { search } });
const opt = { hostname: 'graphql.anilist.co', path: '/', method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' } };
const req = https.request(opt, res => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      const items = json && json.data && json.data.Page && Array.isArray(json.data.Page.media) ? json.data.Page.media : [];
      for (const it of items) {
        console.log(`${it.id}\t${(it.title && it.title.english) || ''}\t${(it.title && it.title.romaji) || ''}`);
      }
    } catch (err) {
      console.error('PARSE_FAIL', err.message, data.slice(0, 200));
    }
  });
});
req.on('error', err => console.error('REQ_ERR', err.message));
req.write(body);
req.end();
