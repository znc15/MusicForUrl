const { readdirSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const tests = readdirSync(path.join(__dirname, '..', 'tests'))
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join(__dirname, '..', 'tests', name));

if (!tests.length) {
  console.error('No test files found in tests/');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
process.exit(result.status ?? 1);
