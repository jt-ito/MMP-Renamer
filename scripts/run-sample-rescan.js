const server = require('../server.js');
(async ()=>{
  try {
    // Construct a synthetic provider result that mimics AniList returning a title
    // that includes an ordinal-season suffix and a fallback provider supplying a year.
    const data = {
      title: 'The Eminence in Shadow 2nd Season',
      year: 2023,
      season: 2,
      episode: 1,
      episodeTitle: 'Pilot',
      seriesTitleEnglish: 'The Eminence in Shadow 2nd Season',
      source: 'test'
    };
    const key = 'C:\\input\\The Eminence in Shadow 2nd Season\\Season 02\\file.mkv';
    const rendered = server._test && server._test.renderProviderName ? server._test.renderProviderName(data, key, null) : '(renderProviderName unavailable)';
    console.log('renderedName:', rendered);

    // Also show ensureRenderedNameHasYear applied to a base provider name
    const providerRawName = 'The Eminence in Shadow 2nd Season - S02E01 - Pilot';
    const withYear = server._test && server._test.ensureRenderedNameHasYear ? server._test.ensureRenderedNameHasYear(providerRawName, String(data.year)) : '(ensureRenderedNameHasYear unavailable)';
    console.log('providerRawName -> withYear:', withYear);

    process.exit(0);
  } catch (e) {
    console.error('ERROR', e && e.stack || e);
    process.exit(1);
  }
})();
