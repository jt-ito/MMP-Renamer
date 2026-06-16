const fs = require('fs');
const helpers = fs.readFileSync('plan_helpers_full.js', 'utf8');

const wrapped = `const path = require('path');

module.exports = function buildPlanGenerator(ctx) {
  const {
    enrichCache, users, serverSettings, canonicalize, extractYear, determineIsMovie, ensureRenderedNameHasYear, titleCase
  } = ctx;

  const sanitize = (name) => {
    if (!name) return name;
    return String(name).replace(/[\\\\/:*?"<>|]/g, '');
  };

${helpers}

  return generatePlanForItem;
};
`;

fs.writeFileSync('lib/plan.js', wrapped);
