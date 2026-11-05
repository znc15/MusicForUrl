const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const version = JSON.parse(read('package.json')).version;

test('product packages and lockfiles use one release version', () => {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  for (const directory of ['', 'web', 'cloudflare']) {
    const manifestPath = path.join(directory, 'package.json');
    const lockPath = path.join(directory, 'package-lock.json');
    const manifest = JSON.parse(read(manifestPath));
    const lock = JSON.parse(read(lockPath));
    assert.equal(manifest.version, version, manifestPath);
    assert.equal(lock.version, version, `${lockPath} top-level version`);
    assert.equal(lock.packages[''].version, version, `${lockPath} root package version`);
  }
});

test('the latest changelog entry matches the product release version', () => {
  const latest = read('CHANGELOG.md').match(/^## (\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2})$/m);
  assert.ok(latest, 'CHANGELOG.md starts with a dated release entry');
  assert.equal(latest[1], version);
});
