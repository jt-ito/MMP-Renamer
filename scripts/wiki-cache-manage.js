#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const cacheFile = path.join(DATA_DIR, 'wiki-episode-cache.json');

function normalizeForCache(s) {
  try {
    if (!s) return ''
    return String(s).toLowerCase().replace(/[\._\-:]+/g,' ').replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim()
  } catch (e) { return String(s || '').toLowerCase().trim() }
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8') || '{}') } catch (e) { return {} }
}

function saveCache(c) {
  try { fs.writeFileSync(cacheFile, JSON.stringify(c, null, 2), 'utf8'); return true } catch (e) { return false }
}

async function main() {
  const argv = process.argv.slice(2)
  if (!argv.length) {
    console.log('Usage: node scripts/wiki-cache-manage.js [list|show|delete] <title> <season> <episode>')
    process.exit(1)
  }
  const cmd = argv[0]
  const title = argv[1]
  const season = argv[2]
  const episode = argv[3]
  if ((cmd === 'show' || cmd === 'delete') && (!title || !season || !episode)) {
    console.error('show/delete requires title, season and episode')
    process.exit(2)
  }
  const cache = loadCache()
  if (cmd === 'list') {
    const keys = Object.keys(cache)
    if (!keys.length) { console.log('cache empty') ; return }
    for (const k of keys) console.log(k)
    return
  }
  const key = `${normalizeForCache(String(title))}|s${Number(season)}|e${Number(episode)}`
  if (cmd === 'show') {
    if (cache[key]) console.log(JSON.stringify(cache[key], null, 2))
    else console.log('not found')
    return
  }
  if (cmd === 'delete') {
    if (!cache[key]) { console.log('not found'); return }
    delete cache[key]
    if (saveCache(cache)) console.log('deleted', key)
    else console.error('failed to write cache')
    return
  }
  console.error('unknown command')
}

main().catch(e => { console.error(e); process.exit(99) })
