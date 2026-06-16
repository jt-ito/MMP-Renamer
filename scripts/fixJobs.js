const fs = require('fs');
let jobsCode = fs.readFileSync('routes/jobs.js', 'utf8');

// 1. Add require at top
jobsCode = "const buildPlanGenerator = require('../lib/plan');\n" + jobsCode;

// 2. Add properties to ctx destructuring
jobsCode = jobsCode.replace(
  'isProviderComplete\n} = ctx;',
  'isProviderComplete,\n  determineIsMovie,\n  ensureRenderedNameHasYear,\n  titleCase\n} = ctx;\n\n  const generatePlanForItem = buildPlanGenerator(ctx);\n'
);

fs.writeFileSync('routes/jobs.js', jobsCode);
