#!/usr/bin/env node

const path = require('node:path');
const { ROOT, collectOperatorData, generateProcessStateMd, renderThinSnapshot } = require('./mavp-operator-lib');

const PROCESS_STATE_JSON = path.join(ROOT, 'PROCESS_STATE.json');
const PROCESS_STATE_MD = path.join(ROOT, 'PROCESS_STATE.md');

generateProcessStateMd(PROCESS_STATE_JSON, PROCESS_STATE_MD);
console.log(renderThinSnapshot(collectOperatorData()));
