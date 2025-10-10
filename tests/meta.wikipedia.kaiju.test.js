const assert = require('assert');
const path = require('path');
const fs = require('fs');

// require the server module which contains the lookup helper
const server = require('../server.js');

describe('Wikipedia episode extractor - Kaiju fixture', function() {
  it('should extract the Season 2 Episode 11 title (Second Wave) from fixture', async function() {
    this.timeout(5000);
    const fixturePath = path.join(__dirname, 'fixtures', 'kaiju-episodes-parse.html');
    const html = fs.readFileSync(fixturePath, 'utf8');

    // stub httpRequest used by the helper to return AniList search and the saved fixture for Wikipedia
    server._test = server._test || {};
    server._test._httpRequest = async function(options, body, timeoutMs) {
      const host = options && options.hostname ? options.hostname : '';
      const p = (options && options.path) ? options.path : '';
      // AniList GraphQL POST
      if (host.includes('anilist.co')) {
        // return a minimal media result with titles
        const resp = { data: { Page: { media: [ { id: 1, title: { english: 'Kaiju No. 8', romaji: 'Kaiju No. 8', native: '怪獣8号' }, relations: { nodes: [] }, externalLinks: [] } ] } } };
        return { statusCode: 200, body: JSON.stringify(resp) };
      }
      // Wikipedia search
      if (host.includes('wikipedia.org') && /list=search/.test(p)) {
        return { statusCode: 200, body: JSON.stringify({ query: { search: [ { pageid: 12345, title: 'List of Kaiju No. 8 episodes' } ] } }) };
      }
      // Wikipedia parse
      if (host.includes('wikipedia.org') && /action=parse/.test(p)) {
        return { statusCode: 200, body: JSON.stringify({ parse: { text: { '*': html }, title: 'List of Kaiju No. 8 episodes' } }) };
      }
      return { statusCode: 200, body: '{}' };
    };

  // Ensure cache is cleared to force fresh parse
  try { server.wikiEpisodeCache = {}; const wcFile = require('path').join(__dirname, '..', 'data', 'wiki-episode-cache.json'); require('fs').writeFileSync(wcFile, JSON.stringify({}), 'utf8') } catch (e) {}
  // Call the exported metaLookup which will use the nested Wikipedia helper
  const res = await server.metaLookup('Kaiju No. 8', null, { season: 2, episode: 11 });
    // metaLookup returns an object with name when found
    assert.ok(res && (res.name || (res.episode && res.episode.name)), 'expected a result with a name');
  const name = (res.episode && (res.episode.name || res.episode.title)) || res.name;
  assert.ok(/Second Wave/i.test(name), `expected 'Second Wave' in '${String(name)}'`);
  });
});
