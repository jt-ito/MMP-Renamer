const fs = require('fs');
const path = require('path');
const https = require('https');

function readKey() {
  try {
    const users = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'users.json'), 'utf8'))
    for (const u of Object.values(users)) {
      if (u && u.settings && (u.settings.tmdb_api_key || u.settings.tvdb_api_key)) return u.settings.tmdb_api_key || u.settings.tvdb_api_key
    }
  } catch (e) {}
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'settings.json'), 'utf8'))
    if (settings && (settings.tmdb_api_key || settings.tvdb_api_key)) return settings.tmdb_api_key || settings.tvdb_api_key
  } catch (e) {}
  return null
}

const key = readKey()
if (!key) { console.log('NO_KEY_FOUND'); process.exit(0) }

// Validate TMDb key by calling the configuration endpoint
const opts = { hostname: 'api.themoviedb.org', path: `/3/configuration?api_key=${encodeURIComponent(key)}`, method: 'GET', timeout: 7000 }
const req = https.request(opts, (res) => {
  if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) { console.log('KEY_PRESENT_AND_VALID'); process.exit(0) }
  else if (res.statusCode === 401) { console.log('KEY_PRESENT_BUT_INVALID'); process.exit(0) }
  else { console.log('KEY_PRESENT_UNKNOWN_STATUS', res.statusCode); process.exit(0) }
})
req.on('error', (e) => { console.log('NETWORK_ERROR', e.message) })
req.on('timeout', () => { req.destroy(); console.log('NETWORK_TIMEOUT') })
req.end()
