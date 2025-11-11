/**
 * Test: Extras Folder Skip Logic
 * 
 * Verifies that the parent candidate logic correctly skips extras/bonus folders
 * when determining the series title, and instead uses the actual series folder.
 */

const assert = require('assert');
const path = require('path');

console.log('\n=== Testing Extras Folder Skip Logic ===\n');

// Mock parseFilename function
function parseFilename(basename) {
  // Simple mock - just return the basename as title
  const cleaned = basename
    .replace(/\.(mkv|mp4|avi)$/i, '')
    .replace(/[\.\-_]+/g, ' ')
    .trim();
  return { title: cleaned };
}

// Copy the isSeasonFolderToken function from server.js
function isSeasonFolderToken(value) {
  if (!value) return false;
  const norm = String(value).replace(/[\._\-]+/g, ' ').trim().toLowerCase();
  if (!norm) return false;
  if (/^(season|seasons|series)\s*\d{1,2}$/.test(norm)) return true;
  if (/^(season|series)\s*\d{1,2}\b/.test(norm) && norm.split(/\s+/).length <= 3) return true;
  if (/^s0*\d{1,2}$/.test(norm)) return true;
  return false;
}

// Copy the isExtrasFolderToken function from server.js
function isExtrasFolderToken(value) {
  if (!value) return false;
  const norm = String(value).replace(/[\._\-]+/g, ' ').trim().toLowerCase();
  if (!norm) return false;
  const EXTRAS_KEYWORDS = [
    'featurettes', 'featurette', 'extras', 'extra', 'bonus', 'bonuses',
    'behind the scenes', 'bts', 'interviews', 'interview', 'deleted scenes',
    'making of', 'specials', 'special features', 'documentary', 'documentaries',
    'trailers', 'trailer', 'promos', 'promo', 'clips', 'outtakes', 'bloopers'
  ];
  for (const keyword of EXTRAS_KEYWORDS) {
    if (norm === keyword) return true;
    if (norm.startsWith(keyword + ' ')) return true;
  }
  return false;
}

// Simulate the parent candidate logic from server.js
function extractParentCandidate(filePath) {
  let parentCandidate = null;
  try {
    let parent = path.dirname(filePath);
    let parentNorm = String(parent).replace(/\\/g, '/');
    let parts = parentNorm.split('/').filter(Boolean);
    const segments = parts;
    
    for (let i = segments.length - 1; i >= 0; i--) {
      try {
        const seg = segments[i];
        if (!seg) continue;
        
        // Check if it's a season folder
        if (isSeasonFolderToken(seg)) {
          console.log(`  Skipping season folder: "${seg}"`);
          continue;
        }
        
        // Check if it's an extras folder
        if (isExtrasFolderToken(seg)) {
          console.log(`  Skipping extras folder: "${seg}"`);
          continue;
        }
        
        const pParsed = parseFilename(seg);
        let cand = pParsed && pParsed.title ? String(pParsed.title).trim() : '';
        if (!cand) continue;
        
        parentCandidate = cand;
        console.log(`  Found parent candidate: "${cand}"`);
        break;
      } catch (e) {
        // ignore per-segment parse errors
      }
    }
  } catch (e) {
    // ignore parent derivation errors
  }
  
  return parentCandidate;
}

// Test cases
const tests = [
  {
    name: 'Breaking Bad with Featurettes folder',
    path: '/mnt/Tor/Breaking Bad (2008) Season 1-5 S01-S05 (1080p BluRay x265 HEVC 10bit AAC 5.1 Silence)/Featurettes/Season 1/AMC Shootout Interview.mkv',
    expected: 'Breaking Bad (2008) Season 1 5 S01 S05 (1080p BluRay x265 HEVC 10bit AAC 5 1 Silence)'
  },
  {
    name: 'Series with Extras folder',
    path: '/media/The Office (US) (2005)/Extras/Behind the Scenes.mkv',
    expected: 'The Office (US) (2005)'
  },
  {
    name: 'Series with Bonus folder',
    path: '/media/Game of Thrones/Season 1/Bonus/Making of Episode 1.mkv',
    expected: 'Game of Thrones'
  },
  {
    name: 'Series with Deleted Scenes folder',
    path: '/media/Friends (1994)/Deleted Scenes/Season 2/Funny Outtake.mkv',
    expected: 'Friends (1994)'
  },
  {
    name: 'Regular episode (should not skip parent)',
    path: '/media/Breaking Bad (2008)/Season 1/S01E01 - Pilot.mkv',
    expected: 'Breaking Bad (2008)'
  },
  {
    name: 'Extras with interviews subfolder',
    path: '/media/Stranger Things/Extras/Interviews/Cast Interview.mkv',
    expected: 'Stranger Things'
  }
];

let passed = 0;
let failed = 0;

for (const test of tests) {
  console.log(`\nTest: ${test.name}`);
  console.log(`Path: ${test.path}`);
  
  const result = extractParentCandidate(test.path);
  
  if (result === test.expected) {
    console.log(`✓ PASS - Got expected: "${result}"`);
    passed++;
  } else {
    console.log(`✗ FAIL - Expected: "${test.expected}", Got: "${result}"`);
    failed++;
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(60)}\n`);

if (failed > 0) {
  process.exit(1);
}

console.log('extras folder skip tests passed');
