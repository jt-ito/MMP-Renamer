const path = require('path');
const parseFilename = require('../lib/filename-parser');
const testPath = '/input/86 S01+SP 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER/86 S01P01+SP 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER/S01E01-Undertaker [2F703024].mkv';
console.log('TEST PATH:', testPath);
const base = path.basename(testPath, path.extname(testPath));
console.log('\nBASE:');
console.log(base);
console.log(parseFilename(base));
const parent = path.dirname(testPath);
console.log('\nPARENT:', parent);
const parts = String(parent).replace(/\\/g, '/').split('/').filter(Boolean);
console.log('\nPARTS:');
for (let i = 0; i < parts.length; i++) {
  const seg = parts[i];
  console.log(`\nSEG[${i}]: ${seg}`);
  try { console.log(parseFilename(seg)); } catch (e) { console.log('parse error', e.message) }
}
