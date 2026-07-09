#!/usr/bin/env node
// Compat stub: this validator was renamed to scripts/mavp-validator.js (T-329).
// Kept so already-bootstrapped projects' hooks/wrappers referencing the old
// filename keep working. Re-exports the new module and forwards CLI runs.
module.exports = require('./mavp-validator.js');

if (require.main === module) {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, 'mavp-validator.js'), ...process.argv.slice(2)],
    { stdio: 'inherit' }
  );
  process.exit(result.status === null ? 1 : result.status);
}
