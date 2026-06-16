const cp = require('child_process');
const fs = require('fs');
const out = cp.execSync('git show 973f92d~1:server.js', {encoding: 'utf8'});
const lines = out.split('\n');
const start = lines.findIndex(l => l.includes('function generatePlanForItem'));
let end = start;
for(let i=start+1; i<lines.length; i++) {
  if(lines[i].includes('app.post(\'/api/rename/preview\', requireAuth')) {
    end = i;
    break;
  }
}
fs.writeFileSync('plan.js', lines.slice(start, end).join('\n'));
