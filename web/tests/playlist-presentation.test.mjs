import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { buildSync } = createRequire(require.resolve('vite'))('esbuild');
const code = buildSync({ entryPoints: [fileURLToPath(new URL('../src/lib/playlist-presentation.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
const module = { exports: {} };
vm.runInNewContext(code, { module, exports: module.exports });
const { playlistCountLabel, partialPlaylistMessage } = module.exports;
test('playlist presentation distinguishes partial, complete, empty and unknown counts', () => {
  assert.equal(playlistCountLabel({ totalCount: 35, includedCount: 30, partialReason: 'upstream_page_failed' }), '已纳入 30 / 35 首');
  assert.equal(playlistCountLabel({ totalCount: 35, includedCount: 35 }), '35 首');
  assert.equal(playlistCountLabel({ totalCount: 0, includedCount: 0 }), '0 首');
  assert.equal(playlistCountLabel({}), '歌曲数量待获取');
  assert.equal(playlistCountLabel({ songCount: 10 }), '10 首');
  assert.match(partialPlaylistMessage({ partialReason: 'upstream_page_failed' }), /重新获取/);
  assert.equal(partialPlaylistMessage({ partialReason: null }), '');
});
