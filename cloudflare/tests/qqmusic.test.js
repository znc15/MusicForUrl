import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import qqmusic from '../../lib/qqmusic.js';

const QR_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0xfe, 0xff, 0x42,
]);

test('QQ QR code generation works without Node globals', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(QR_PNG, {
    headers: { 'set-cookie': 'qrsig=test-signature; Path=/; HttpOnly' },
  });
  try {
    const result = await qqmusic.createQRCode();
    assert.equal(result.qrsig, 'test-signature');
    assert.match(result.qrimg, /^data:image\/png;base64,/);
    assert.equal(
      Buffer.from(result.qrimg.split(',')[1], 'base64').toString('hex'),
      Buffer.from(QR_PNG).toString('hex'),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('QQ profile lookup fails closed and only enriches an independently confirmed QR identity', async t => {
  const cookie = 'uin=12345; qm_keyst=fixture';
  let payload;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (payload instanceof Error) throw payload;
    return Response.json(payload);
  });
  assert.deepEqual(await qqmusic.checkLoginStatus(cookie), { logged: false });
  assert.deepEqual(await qqmusic.checkLoginStatus(cookie, '99999'), { logged: false });
  assert.equal(calls, 0, 'a client-provided uin and key alone are never authentication');
  const profile = { uin: 12345, nick: 'Trusted nickname', headurl: '', isvip: 1 };
  for (const response of [
    new Error('upstream offline'), {}, { code: 0, req_0: { code: 1000 } },
    { code: 0, req_0: { code: 0, data: { code: 0, map_userinfo: { '12345': { ...profile, uin: 99999 } } } } },
  ]) {
    payload = response;
    assert.deepEqual(await qqmusic.checkLoginStatus(cookie, '12345'), { logged: false });
  }
  payload = { code: 0, req_0: { code: 0, data: { code: 0, map_userinfo: { '12345': profile } } } };
  const result = await qqmusic.checkLoginStatus(cookie, '12345');
  assert.equal(result.logged, true);
  assert.equal(result.userId, '12345');
  assert.equal(result.nickname, 'Trusted nickname');
});

// The Worker runs without nodejs_compat, so a stray Node global is a runtime 500
// that no other test would catch. Walk the Worker's own import graph and refuse
// any Node-only global in a file that ships inside the bundle.
const NODE_GLOBAL_PATTERNS = [
  [/\bBuffer\.(?:from|alloc|allocUnsafe|concat)\b/, 'Buffer.*'],
  [/\bprocess\.env\b/, 'process.env'],
  [/require\(\s*['"]node:/, "require('node:...')"],
  [/\bfrom\s+['"]node:/, "import from 'node:...'"],
];

function resolveRelative(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [`${base}.js`, base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function firstPartySources(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from|require\()\s*['"](\.[^'"]+)['"]/g)) {
      const resolved = resolveRelative(file, match[1]);
      if (resolved) queue.push(resolved);
    }
  }
  return seen;
}

test('Worker sources do not reference Node-only globals', () => {
  const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const entry = path.join(root, 'cloudflare', 'src', 'index.js');
  const sources = firstPartySources(entry);
  assert.ok(sources.size >= 8, `expected to walk the Worker import graph, found ${sources.size} files`);

  const violations = [];
  for (const file of sources) {
    const source = readFileSync(file, 'utf8');
    for (const [pattern, label] of NODE_GLOBAL_PATTERNS) {
      if (pattern.test(source)) violations.push(`${path.relative(root, file)} uses ${label}`);
    }
  }
  assert.deepEqual(violations, [], 'Node-only globals would throw at runtime without nodejs_compat');

  // Enabling the compatibility flag would silently re-admit these globals, so the
  // guard above is only meaningful while the flag stays off.
  const config = readFileSync(path.join(root, 'cloudflare', 'wrangler.jsonc'), 'utf8');
  assert.equal(config.includes('nodejs_compat'), false,
    'wrangler.jsonc must not enable nodejs_compat while this guard is in place');
});
