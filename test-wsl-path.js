const path = require('path');

function translateWSLPath(p) {
  try {
    if (process.platform !== 'win32') return p;
    const str = String(p || '');
    // Match /mnt/X/... where X is a single letter (drive)
    const match = str.match(/^\/mnt\/([a-z])(?:\/|$)(.*)/i);
    if (match) {
      const driveLetter = match[1].toUpperCase();
      const remainder = match[2] || '';
      return `${driveLetter}:/${remainder}`;
    }
    return p;
  } catch (e) {
    return p;
  }
}

const tests = [
  '/mnt/sda1/Misc/test.mkv',
  '/mnt/c/Users/test.txt',
  '/mnt/d/folder/file.mp4',
  'C:/Users/normal.txt'
];

console.log('WSL Path Translation Test:');
console.log('Platform:', process.platform);
console.log('');

for (const test of tests) {
  const translated = translateWSLPath(test);
  const resolved = path.resolve(translated);
  console.log('Original:   ', test);
  console.log('Translated: ', translated);
  console.log('Resolved:   ', resolved);
  console.log('');
}
