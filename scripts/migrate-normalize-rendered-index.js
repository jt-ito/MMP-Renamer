#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const titleCase = require('../lib/title-case');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const ENRICH_FILE = path.join(DATA_DIR, 'enrich-store.json');
const RENDERED_FILE = path.join(DATA_DIR, 'rendered-index.json');
const ALIASES_FILE = path.resolve(__dirname, '..', 'config', 'series-aliases.json');

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8') || '{}'); } catch (e) { return {}; }
}

function writeBackup(p) {
  try {
    const buf = fs.readFileSync(p);
    const bak = p + '.bak.' + Date.now();
    fs.writeFileSync(bak, buf);
    console.log('Backup written:', bak);
  } catch (e) { console.warn('Backup failed for', p, e && e.message); }
}

function normalizeKey(s) {
  try {
    if (!s) return '';
    let out = String(s).trim();
    out = out.replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\u275B\u275C\uFF07]/g, "'");
    out = out.replace(/[\u201C\u201D\u201E\u201F]/g, '"');
    out = out.replace(/\s+/g, ' ');
    return out.trim();
  } catch (e) { return String(s || ''); }
}

function normalizeLookupKey(s) {
  return normalizeKey(s).toLowerCase();
}

function canonicalFor(name, aliasesMap) {
  if (!name) return name;
  const orig = String(name).trim();
  if (aliasesMap && Object.prototype.hasOwnProperty.call(aliasesMap, orig)) return aliasesMap[orig];
  const norm = normalizeLookupKey(orig);
  for (const k of Object.keys(aliasesMap || {})) {
    if (normalizeLookupKey(k) === norm) return aliasesMap[k];
  }
  // fallback: normalize apostrophes and collapse spaces, then title-case
  const fixed = normalizeKey(orig);
  try { return titleCase(fixed); } catch (e) { return fixed; }
}

function replaceLeadingTitle(renderedName, oldTitle, newTitle) {
  try {
    if (!renderedName || !oldTitle || !newTitle) return renderedName;
    // Attempt to replace only the leading occurrence of the title (case-insensitive)
    const esc = oldTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // match oldTitle optionally followed by space and a year in parentheses
    const re = new RegExp('^' + esc + '(?=\s*\(|\s*-|\s|$)', 'i');
    if (re.test(renderedName)) return renderedName.replace(re, newTitle);
    // fallback: replace first token match
    const parts = renderedName.split(' - ');
    if (parts.length) {
      parts[0] = parts[0].replace(new RegExp(esc, 'i'), newTitle);
      return parts.join(' - ');
    }
    return renderedName.replace(new RegExp(esc, 'i'), newTitle);
  } catch (e) { return renderedName; }
}

function migrate() {
  const aliases = readJsonSafe(ALIASES_FILE || '');
  const enrich = readJsonSafe(ENRICH_FILE || '');
  const rendered = readJsonSafe(RENDERED_FILE || '');

  console.log('Loaded', Object.keys(enrich).length, 'enrich entries and', Object.keys(rendered).length, 'rendered-index entries');

  writeBackup(ENRICH_FILE);
  writeBackup(RENDERED_FILE);

  const metaNameRemap = {};

  // Update enrich entries
  for (const key of Object.keys(enrich || {})) {
    try {
      const e = enrich[key] || {};
      const seriesName = e.seriesTitle || e.title || null;
      if (!seriesName) continue;
      const canonical = canonicalFor(seriesName, aliases);
      if (!canonical) continue;
      if (canonical !== seriesName) {
        console.log('Canonicalizing enrich entry:', seriesName, '->', canonical);
        e.seriesTitle = canonical;
        // if renderedName exists, update the leading title
        if (e.renderedName) {
          const newRendered = replaceLeadingTitle(e.renderedName, seriesName, canonical);
          if (newRendered !== e.renderedName) {
            // update metadataFilename mapping later
            const oldMeta = e.metadataFilename || null;
            e.renderedName = newRendered;
            if (oldMeta) {
              const newMeta = oldMeta.replace(seriesName, canonical);
              e.metadataFilename = newMeta;
              metaNameRemap[oldMeta] = newMeta;
            }
          }
        }
      }
    } catch (e) { console.warn('enrich entry update failed', key, e && e.message); }
  }

  // Update rendered-index entries
  const updates = {};
  for (const rk of Object.keys(rendered || {})) {
    try {
      const entry = rendered[rk] || {};
      const rn = entry.renderedName || null;
      if (!rn) continue;
      // try to extract leading series title (up to ' (YYYY)' or before ' - ')
      const m = rn.match(/^(.+?)(?:\s*\(\d{4}\))?\s*-\s*/);
      const candidateTitle = m ? m[1] : rn.split(' - ')[0];
      const canonical = canonicalFor(candidateTitle, aliases);
      if (canonical && canonical !== candidateTitle) {
        const newRendered = replaceLeadingTitle(rn, candidateTitle, canonical);
        console.log('Canonicalizing rendered-index:', candidateTitle, '->', canonical, 'for', rk);
        entry.renderedName = newRendered;
        if (entry.metadataFilename) {
          const oldMeta = entry.metadataFilename;
          const newMeta = oldMeta.replace(candidateTitle, canonical);
          entry.metadataFilename = newMeta;
          // maintain mapping from old meta name -> targetKey
          metaNameRemap[oldMeta] = newMeta;
        }
        updates[rk] = entry;
      }
    } catch (e) { console.warn('rendered-index update failed', rk, e && e.message); }
  }

  // Apply updates
  for (const k of Object.keys(updates)) rendered[k] = updates[k];

  // For metadata name remaps, adjust top-level mapping (metadataFilename -> targetKey)
  for (const oldMeta of Object.keys(metaNameRemap)) {
    try {
      const newMeta = metaNameRemap[oldMeta];
      if (rendered[oldMeta]) {
        rendered[newMeta] = rendered[oldMeta];
        delete rendered[oldMeta];
        console.log('Remapped rendered-index key:', oldMeta, '->', newMeta);
      }
    } catch (e) { console.warn('meta remap failed', oldMeta, e && e.message); }
  }

  // Persist changes
  try { fs.writeFileSync(ENRICH_FILE, JSON.stringify(enrich, null, 2), 'utf8'); console.log('Wrote', ENRICH_FILE); } catch (e) { console.error('Write enrich failed', e && e.message); }
  try { fs.writeFileSync(RENDERED_FILE, JSON.stringify(rendered, null, 2), 'utf8'); console.log('Wrote', RENDERED_FILE); } catch (e) { console.error('Write rendered-index failed', e && e.message); }

  console.log('Migration complete. Please restart the server if running.');
}

if (require.main === module) migrate();
