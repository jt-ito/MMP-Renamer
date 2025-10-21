const fs = require('fs');
const path = require('path');

const file = path.resolve(__dirname, '../server.js');
const code = fs.readFileSync(file, 'utf8');

const stack = [];
let state = 'code'; // code, single, double, template, lineComment, blockComment
for (let i = 0; i < code.length; i++) {
  const ch = code[i];
  const next = code[i + 1];
  const prev = code[i - 1];

  if (state === 'lineComment') {
    if (ch === '\n') state = 'code';
    continue;
  }
  if (state === 'blockComment') {
    if (ch === '*' && next === '/') {
      state = 'code';
      i++;
    }
    continue;
  }
  if (state === 'single') {
    if (ch === '\\') { i++; continue; }
    if (ch === "'") state = 'code';
    continue;
  }
  if (state === 'double') {
    if (ch === '\\') { i++; continue; }
    if (ch === '"') state = 'code';
    continue;
  }
  if (state === 'template') {
    if (ch === '\\') { i++; continue; }
    if (ch === '`') state = 'code';
    continue;
  }

  // state === 'code'
  if (ch === '/' && next === '/') {
    state = 'lineComment';
    i++;
    continue;
  }
  if (ch === '/' && next === '*') {
    state = 'blockComment';
    i++;
    continue;
  }
  if (ch === "'") { state = 'single'; continue; }
  if (ch === '"') { state = 'double'; continue; }
  if (ch === '`') { state = 'template'; continue; }

  // look for try/catch/finally
  const aheadTry = code.slice(i, i + 3);
  const aheadCatch = code.slice(i, i + 5);
  const aheadFinally = code.slice(i, i + 7);

  const isWordChar = (c) => /[A-Za-z0-9_$]/.test(c || '');

  if (aheadTry === 'try' && !isWordChar(prev) && !isWordChar(code[i + 3])) {
    stack.push({ pos: i });
    i += 2;
    continue;
  }
  if (aheadCatch === 'catch' && !isWordChar(prev) && !isWordChar(code[i + 5])) {
    if (stack.length) stack.pop();
    i += 4;
    continue;
  }
  if (aheadFinally === 'finally' && !isWordChar(prev) && !isWordChar(code[i + 7])) {
    if (stack.length) stack.pop();
    i += 6;
    continue;
  }
}

if (!stack.length) {
  console.log('All try blocks matched.');
} else {
  console.log('Unmatched try blocks at positions:', stack.map(s => s.pos));
  for (const entry of stack) {
    const before = code.slice(0, entry.pos);
    const line = before.split('\n').length;
    console.log('  approx line:', line);
  }
}
