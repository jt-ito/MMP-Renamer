#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, '..', 'data');
const cacheFile = path.join(DATA_DIR, 'wiki-episode-cache.json');

function isMeaningfulTitle(s) {
  if (!s) return false
  const t = String(s).trim()
  if (!/[A-Za-z\p{L}]/u.test(t)) return false
  const dateLike = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,\s*\d{4})?/i
  if (dateLike.test(t)) return false
  if (/\b\d{4}\b/.test(t) && /^[\d\s\-:,\/]+$/.test(t.replace(/\(.*?\)/g,''))) return false
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return false
  const alphaCount = (t.match(/[A-Za-z\p{L}]/gu) || []).length
  const totalCount = t.length
  if (totalCount > 0 && alphaCount / totalCount < 0.2) return false
  return true
}

function isPlaceholderTitle(s) {
  if (!s) return false
  const t = String(s).trim()
  if (/^(?:e(?:p(?:isode)?)?|episode|ep)\b[\s\.\:\/\-]*\d+$/i.test(t)) return true
  const stripped = t.replace(/\b(?:episode|ep|ep\.|no|number)\b/ig, '').replace(/[^0-9]/g, '').trim()
  if (stripped && /^[0-9]+$/.test(stripped) && stripped.length <= 4 && t.length < 30) return true
  return false
}

let apply = false
const args = process.argv.slice(2)
if (args.includes('--apply')) apply = true

let cache = {}
try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8') || '{}') } catch (e) { console.error('Could not read cache file:', e.message); process.exit(2) }

const keys = Object.keys(cache)
if (!keys.length) { console.log('No cache entries'); process.exit(0) }

const problematic = []
for (const k of keys) {
  const entr = cache[k]
  const name = entr && entr.name ? String(entr.name) : ''
  if (!isMeaningfulTitle(name) || isPlaceholderTitle(name)) {
    problematic.push({ key: k, name, ts: entr.ts || null, raw: entr.raw || null })
  }
}

if (!problematic.length) {
  console.log('No problematic cache entries found (dry-run)')
  process.exit(0)
}

console.log('Problematic cache entries:')
for (const p of problematic) {
  console.log('-', p.key, 'name="' + p.name + '"', 'ts=' + (p.ts || '<none>'))
}

if (apply) {
  for (const p of problematic) {
    delete cache[p.key]
    console.log('Deleted', p.key)
  }
  try { fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), 'utf8'); console.log('Cache file updated') } catch (e) { console.error('Failed to write cache file:', e.message); process.exit(3) }
}

console.log('\nDry-run complete. Use --apply to remove listed entries.')
