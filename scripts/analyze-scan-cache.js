const fs = require('fs');
const path = require('path');
const parse = require('../lib/filename-parser');

function pushSample(map, key, sample) {
  if (!map.has(key)) map.set(key, { count: 0, samples: [] });
  const entry = map.get(key);
  entry.count += 1;
  if (entry.samples.length < 3) entry.samples.push(sample);
}

function main() {
  const scanPath = path.resolve(__dirname, '..', 'scan-cache-temp.json');
  const raw = fs.readFileSync(scanPath, 'utf8');
  const data = JSON.parse(raw);
  const files = data.files || {};

  const trailingNumeralSeason1 = new Map();
  const missingSeasonWithDash = new Map();
  const missingEpisodesLikely = new Map();
  const tawawaEntries = [];
  const tawawa2Entries = [];

  let total = 0;

  for (const filePath of Object.keys(files)) {
    total += 1;
    const parsed = parse(filePath);

    const entry = {
      filePath,
      parsedName: parsed.parsedName,
      season: parsed.season,
      episode: parsed.episode
    };

    if (/Getsuyoubi no Tawawa/i.test(parsed.title)) {
      tawawaEntries.push(entry);
      if (/Getsuyoubi no Tawawa\s*2/i.test(parsed.title)) tawawa2Entries.push(entry);
    }

    if (parsed.season === 1) {
      const m = parsed.title.match(/(\d{1,2})$/);
      if (m) {
        const num = parseInt(m[1], 10);
        if (!Number.isNaN(num) && num >= 2) {
          pushSample(trailingNumeralSeason1, parsed.title, entry);
        }
      }
    }

    if (parsed.season == null) {
      const base = path.basename(filePath);
      if (/[-–—]\s*0*\d{1,3}\b/.test(base)) {
        pushSample(missingSeasonWithDash, parsed.title || '(unknown)', entry);
      }
    }

    if (parsed.episode == null) {
      const base = path.basename(filePath);
      const looksSerial = /S\d{1,2}[EPp]\d{1,3}|Episode\s*\d{1,3}|[-–—]\s*\d{1,3}\b|\b\d{2,3}\b/.test(base);
      const isBonus = /(NCOP|NCED|OP|ED|PV|ONA|SP|Special|Featurette|Extras?|Menu|OVA)/i.test(filePath);
      if (looksSerial && !isBonus) {
        pushSample(missingEpisodesLikely, parsed.title || '(unknown)', entry);
      }
    }
  }

  console.log(`Scanned ${total} files from scan-cache-temp.json`);

  console.log('\nTawawa entries (up to 5 samples):');
  tawawaEntries.slice(0, 5).forEach(e => {
    console.log(`  ${e.parsedName} :: season=${e.season} episode=${e.episode}`);
  });
  if (tawawa2Entries.length) {
    console.log('\nTawawa 2 entries (up to 5 samples):');
    tawawa2Entries.slice(0, 5).forEach(e => {
      console.log(`  ${e.parsedName} :: season=${e.season} episode=${e.episode}`);
    });
  }

  const showMap = (label, map) => {
    if (!map.size) return;
    console.log(`\n${label} (${map.size} groups):`);
    let shown = 0;
    for (const [title, info] of map.entries()) {
      console.log(`- ${title} (count=${info.count})`);
      info.samples.forEach(s => console.log(`    ${s.parsedName} <- ${s.filePath}`));
      shown += 1;
      if (shown >= 15) {
        console.log('  ...');
        break;
      }
    }
  };

  showMap('Trailing numerals still defaulting to season 1', trailingNumeralSeason1);
  showMap('Dash-separated filenames missing season', missingSeasonWithDash);
  showMap('Likely episodic files missing episode detection', missingEpisodesLikely);
}

main();