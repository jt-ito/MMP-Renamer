(async function(){
  const server = require('./server')
  server._test = server._test || {}
  server._test._httpRequest = async function(options, body, timeoutMs){
    console.log('HTTPREQ', options.hostname, options.path)
    if (options.hostname === 'graphql.anilist.co') {
      return { statusCode:200, headers:{}, body: JSON.stringify({ data: { Page: { media: [ { id:1, title:{ english:'Fake Show 2', romaji:'Fake Show 2', native:'Fake Show 2' }, seasonYear:2020, relations:{ nodes:[] } } ] } } }) }
    }
    if (options.hostname === 'api.themoviedb.org') {
      console.log('TMDB CALLED', options.path)
      return { statusCode:200, headers:{}, body: JSON.stringify({ results:[{ id:42, name:'Fake Show' }] }) }
    }
    if (options.hostname === 'kitsu.io') {
      return { statusCode:200, headers:{}, body: JSON.stringify({ data: [] }) }
    }
    return { statusCode:200, headers:{}, body: '{}' }
  }

  const r = await server.metaLookup('Fake Show', 'FAKEKEY', { season: 2 })
  console.log('RESULT', r)
})()
