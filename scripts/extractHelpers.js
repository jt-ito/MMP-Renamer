const fs = require('fs');
const lines = fs.readFileSync('pure_old_server.js', 'utf8').split('\n');

let start = -1;
let end = -1;

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('function getMaxFilenameLengthForOS(')) {
    start = i;
    // Walk up to grab any comments if they exist
    while(start > 0 && lines[start-1].startsWith('//')) start--;
  }
  if (lines[i].includes('function generatePlanForItem(')) {
    // Wait, generatePlanForItem was extracted already, but maybe we should grab the whole block!
    // We want from getMaxFilenameLengthForOS all the way to the end of generatePlanForItem.
  }
  if (lines[i].includes('app.post(\'/api/rename/preview\'')) {
    end = i;
  }
}

if (start !== -1 && end !== -1) {
  const extracted = lines.slice(start, end).join('\n');
  fs.writeFileSync('plan_helpers_full.js', extracted);
  console.log('Extracted lines', start, 'to', end);
} else {
  console.log('Could not find start or end', start, end);
}
