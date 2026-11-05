const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

test('root commands use Cloudflare without Node server production dependencies', () => {
  const manifest = JSON.parse(read('package.json'));
  assert.deepEqual(Object.keys(manifest.dependencies || {}), []);
  assert.deepEqual(Object.keys(manifest.optionalDependencies || {}), []);
  for (const name of ['start', 'dev']) {
    assert.match(manifest.scripts[name], /\bnpm\s+--prefix\s+cloudflare\s+(?:run\s+)?dev\b/);
  }
});

test('Cloudflare retains its shared modules and excludes Node deployment entry points', () => {
  for (const name of ['player-api.js', 'player-policy.js', 'player-cache.js', 'qqmusic.js']) {
    assert.equal(fs.statSync(path.join(root, 'lib', name)).isFile(), true, name);
  }
  for (const name of ['server.js', 'routes', 'deploy', 'public']) {
    assert.equal(fs.existsSync(path.join(root, name)), false, name);
  }
});

test('Pages serves the React build output', () => {
  const configuration = read('cloudflare/wrangler.pages.jsonc');
  const output = configuration.match(/"pages_build_output_dir"\s*:\s*"([^"]+)"/);
  assert.ok(output, 'Pages output directory is configured');
  assert.equal(output[1], '../web/dist');
});

test('website publishing is restricted to the Cloudflare branch', () => {
  const workflow = read('.github/workflows/website.yml');
  const push = workflow.match(/^  push:\s*\r?\n([\s\S]*?)(?=^  \w+:|^\w)/m);
  assert.ok(push, 'Website workflow defines a push trigger');
  const branches = push[1].match(/^\s+branches:\s*\[([^\]]+)\]/m);
  assert.ok(branches, 'Website push trigger explicitly selects branches');
  assert.deepEqual(branches[1].split(',').map(value => value.trim().replace(/^['"]|['"]$/g, '')), ['codex/cloudflare']);
  const deploy = workflow.match(/^  deploy:\s*\r?\n([\s\S]*?)(?=^  [\w-]+:|$(?![\s\S]))/m);
  assert.ok(deploy, 'Website workflow defines a deployment job');
  const condition = deploy[1].match(/^\s+if:\s*(.+)$/m);
  assert.ok(condition, 'Deployment has an explicit branch condition');
  assert.match(condition[1], /github\.ref\s*==\s*['"]refs\/heads\/codex\/cloudflare['"]/);
  assert.match(condition[1], /github\.event_name\s*!=\s*['"]pull_request['"]/);
});
