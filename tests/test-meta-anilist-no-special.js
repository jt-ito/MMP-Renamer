const assert = require('assert');
const server = require('../server.js');

async function run() {
  server._test = server._test || {};
  const originalHttpRequest = server._test._httpRequest;

  server._test._httpRequest = async function fakeHttpRequest(options) {
    const host = (options && options.hostname) ? String(options.hostname) : '';
    if (host.includes('graphql.anilist.co')) {
      const body = {
        data: {
          Page: {
            media: [
              {
                id: 100,
                format: 'ONA',
                seasonYear: 2016,
                title: {
                  english: 'Tawawa on Monday',
                  romaji: 'Getsuyoubi no Tawawa',
                  native: '月曜日のたわわ'
                },
                relations: { nodes: [] }
              },
              {
                id: 200,
                format: 'SPECIAL',
                seasonYear: 2021,
                title: {
                  english: null,
                  romaji: 'Getsuyoubi no Tawawa 2 Special',
                  native: '月曜日のたわわ 2 特典'
                },
                relations: { nodes: [] }
              }
            ]
          }
        }
      };
      return { statusCode: 200, headers: {}, body: JSON.stringify(body) };
    }
    if (host.includes('en.wikipedia.org')) {
      return { statusCode: 200, headers: {}, body: JSON.stringify({ query: { search: [] } }) };
    }
    if (host.includes('api.themoviedb.org')) {
      return { statusCode: 200, headers: {}, body: JSON.stringify({ results: [] }) };
    }
    return { statusCode: 200, headers: {}, body: '{}' };
  };

  try {
    const res = await server.metaLookup('Getsuyoubi no Tawawa', null, { season: 1, episode: 1 });
    assert.ok(res && res.name, 'metaLookup should return a result');
    assert.ok(/tawawa on monday/i.test(res.name), `expected base series title, got '${res.name}'`);
    assert.ok(!/special/i.test(res.name), `should avoid selecting special entry, got '${res.name}'`);
    console.log('metaLookup special regression passed');
  } finally {
    server._test._httpRequest = originalHttpRequest;
  }
}

run().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
