const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { spawn } = require('node:child_process');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      server.close((err) => {
        if (err) return reject(err);
        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function waitForHealth(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return res.json();
    } catch (_) {
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Server did not become healthy in time');
}

function isNativeBinaryIncompatible(stderr) {
  const text = String(stderr || '').toLowerCase();
  return text.includes('invalid elf header') || text.includes('err_dlopen_failed');
}

test('health endpoint returns ok status', async (t) => {
  const port = await getFreePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const childExitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const healthPromise = waitForHealth(port)
    .then((body) => ({ type: 'health', body }))
    .catch((error) => ({ type: 'health-error', error }));

  try {
    const first = await Promise.race([
      childExitPromise.then((exit) => ({ type: 'exit', exit })),
      healthPromise
    ]);

    if (first.type === 'exit') {
      if (isNativeBinaryIncompatible(stderr)) {
        t.skip('当前运行环境与 better-sqlite3 原生模块不兼容，跳过健康检查');
        return;
      }
      const exitDetail = `code=${first.exit.code}, signal=${first.exit.signal}`;
      const detail = stderr.trim() || '(empty stderr)';
      throw new Error(`Server exited before healthy (${exitDetail}): ${detail}`);
    }

    if (first.type === 'health-error') {
      throw first.error;
    }

    const body = first.body;
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.timestamp, 'number');
    assert.equal(stderr.includes('Error:'), false);

    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') || '', /text\/html/);

    const fallback = await fetch(`http://127.0.0.1:${port}/missing-page`);
    assert.equal(fallback.status, 200);
    assert.match(fallback.headers.get('content-type') || '', /text\/html/);

    const missingApi = await fetch(`http://127.0.0.1:${port}/api/missing`);
    assert.equal(missingApi.status, 404);
    assert.equal((await missingApi.json()).success, false);
  } finally {
    if (!child.killed) child.kill('SIGTERM');
    await new Promise((resolve) => {
      child.once('exit', () => resolve());
      setTimeout(resolve, 2000);
    });
  }
});
