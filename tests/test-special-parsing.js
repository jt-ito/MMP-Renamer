// Test special episode parsing
const parseFilename = require('../lib/filename-parser');

const testCases = [
  // SP## patterns
  { input: 'Series Name SP01.mkv', expected: { season: 0, episode: 1, title: 'Series Name' } },
  { input: 'Series Name SP 01.mkv', expected: { season: 0, episode: 1, title: 'Series Name' } },
  { input: 'Series Name Special 01.mkv', expected: { season: 0, episode: 1, title: 'Series Name' } },
  
  // S##SP## patterns  
  { input: 'Series Name S01SP01.mkv', expected: { season: 1, episode: 1, title: 'Series Name' } },
  { input: 'Series Name S02SP03.mkv', expected: { season: 2, episode: 3, title: 'Series Name' } },
  
  // OVA patterns
  { input: 'Series Name OVA01.mkv', expected: { season: 0, episode: 1, title: 'Series Name' } },
  { input: 'Series Name OVA 1.mkv', expected: { season: 0, episode: 1, title: 'Series Name' } },
  { input: 'Series Name OAD01.mkv', expected: { season: 0, episode: 1, title: 'Series Name' } },
  { input: 'Series Name ONA 01.mkv', expected: { season: 0, episode: 1, title: 'Series Name' } },
  
  // Existing patterns (ensure we didn't break them)
  { input: 'Series Name S01E01.mkv', expected: { season: 1, episode: 1, title: 'Series Name' } },
  { input: 'Series Name S00E01.mkv', expected: { season: 0, episode: 1, title: 'Series Name' } },
  { input: 'Series Name S01E11.5.mkv', expected: { season: 1, episode: 11.5, title: 'Series Name' } },
];

let passed = 0;
let failed = 0;

console.log('Testing special episode parsing...\n');

for (const test of testCases) {
  const result = parseFilename(test.input);
  const match = 
    result.season === test.expected.season &&
    result.episode === test.expected.episode &&
    result.title === test.expected.title;
  
  if (match) {
    passed++;
    console.log(`✓ ${test.input}`);
  } else {
    failed++;
    console.log(`✗ ${test.input}`);
    console.log(`  Expected: season=${test.expected.season}, episode=${test.expected.episode}, title="${test.expected.title}"`);
    console.log(`  Got:      season=${result.season}, episode=${result.episode}, title="${result.title}"`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}

console.log('\nSpecial parsing tests passed!');
