const fs = require('fs');
let renameCode = fs.readFileSync('routes/rename.js', 'utf8');

// 1. Add require at top
renameCode = "const buildPlanGenerator = require('../lib/plan');\n" + renameCode;

// 2. Add properties to ctx destructuring in createRenameRoutes
renameCode = renameCode.replace(
  'isProviderComplete\n} = ctx;',
  'isProviderComplete,\n  determineIsMovie,\n  ensureRenderedNameHasYear,\n  titleCase\n} = ctx;\n\n  const generatePlanForItem = buildPlanGenerator(ctx);\n'
);

fs.writeFileSync('routes/rename.js', renameCode);
