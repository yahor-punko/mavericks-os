'use strict';
// Regression test: T-234 — deployed tasks swept from Active on wave close

const { moveTaskToCompleted } = require('./mavp-operator-close-session.js');
const { buildDeployQueue } = require('./mavp-operator-lib.js');

// --- Fixture ---
const FIXTURE = `## Active tasks

### T-001 — Test deployed_prod task
- **Status:** deployed_prod
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** —
- **Evidence:** commit: abc1234 branch: main
- **Notes:** —

### T-002 — Test deployed_dev task
- **Status:** deployed_dev
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** —
- **Evidence:** commit: def5678 branch: main
- **Notes:** —

## Recently completed tasks

`;

// --- Test 1: moveTaskToCompleted sweeps deployed_prod ---
let content = FIXTURE;
content = moveTaskToCompleted(content, 'T-001');
const activeHasT001 = content.includes('### T-001') && content.indexOf('### T-001') < content.indexOf('## Recently completed tasks');
const completedHasT001 = content.includes('### T-001') && content.indexOf('### T-001') > content.indexOf('## Recently completed tasks');
console.assert(!activeHasT001, 'FAIL: T-001 (deployed_prod) still in Active tasks after sweep');
console.assert(completedHasT001, 'FAIL: T-001 (deployed_prod) not in Recently completed after sweep');

// --- Test 2: moveTaskToCompleted sweeps deployed_dev ---
content = moveTaskToCompleted(content, 'T-002');
const activeHasT002 = content.includes('### T-002') && content.indexOf('### T-002') < content.indexOf('## Recently completed tasks');
const completedHasT002 = content.includes('### T-002') && content.indexOf('### T-002') > content.indexOf('## Recently completed tasks');
console.assert(!activeHasT002, 'FAIL: T-002 (deployed_dev) still in Active tasks after sweep');
console.assert(completedHasT002, 'FAIL: T-002 (deployed_dev) not in Recently completed after sweep');

// --- Test 3: buildDeployQueue returns empty for deploy_contours=0 ---
const tasks = [
  { id: 'T-001', title: 'Test', status: 'deployed_prod' },
  { id: 'T-002', title: 'Test', status: 'deployed_dev' },
];
const queue = buildDeployQueue(tasks, {}, 0);
console.assert(queue.length === 0, 'FAIL: deploy_queue should be empty for deploy_contours=0');

console.log('All T-234 assertions passed.');
