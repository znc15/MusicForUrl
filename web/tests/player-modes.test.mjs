import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { buildSync } = createRequire(require.resolve('vite'))('esbuild');
const code = buildSync({
  stdin: {
    contents: `export { usePlayer } from './src/stores/player';
      export { api, ApiError } from './src/lib/api';`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
}).outputFiles[0].text;

function runtime(t, count = 4) {
  const values = new Map();
  const module = { exports: {} };
  const context = vm.createContext({
    module, exports: module.exports, require, console,
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key),
    },
    Request, Response, Headers, URL, URLSearchParams, AbortController, DOMException, Error,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    process: { env: { NODE_ENV: 'test' } },
    fetch: () => { throw new Error('Unexpected network access'); },
  });
  vm.runInContext(code, context);
  const { usePlayer, api, ApiError } = module.exports;
  const playlist = { id: 'fixture', name: 'Mode fixture', platform: 'netease', grant: 'fixture-grant', cover: '',
    tracks: Array.from({ length: count }, (_, index) => ({ id: String(index + 1), name: `Track ${index + 1}`, artist: 'Fixture', cover: '', duration: 180 })),
  };
  const calls = [];
  api.playerPlaylist = async () => playlist;
  api.resolve = async (_platform, options) => {
    calls.push(options);
    return { mediaUrl: `https://app.test/${options.songId}.mp3`, warnings: [], format: 'mp3', bitrate: 128000 };
  };
  t.after(() => usePlayer.getState().clear());
  return { usePlayer, api, ApiError, playlist, calls, context, state: () => usePlayer.getState() };
}

async function tick() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

test('playback modes default to sequential playback and repeat cycles through all, one, off', async t => {
  const r = runtime(t);
  assert.equal(r.state().shuffle, false);
  assert.equal(r.state().repeat, 'off');
  for (const repeat of ['all', 'one', 'off']) {
    r.state().cycleRepeat();
    assert.equal(r.state().repeat, repeat);
  }
  assert.equal(await r.state().open('netease', 'fixture'), true);
  assert.deepEqual([...r.state().order], [0, 1, 2, 3]);
  assert.equal(r.state().orderIndex, 0);
  await r.state().next();
  assert.equal(r.state().index, 1);
  assert.equal(r.state().orderIndex, 1);
  await r.state().prev();
  assert.equal(r.state().index, 0);
});

test('natural end without repeat retains the terminal ended state', async t => {
  const r = runtime(t, 2);
  await r.state().open('netease', 'fixture');
  await r.state().ended();
  assert.equal(r.state().index, 1);
  const count = r.calls.length;
  await r.state().ended();
  assert.equal(r.state().status, 'ended');
  assert.equal(r.state().autoplay, false);
  assert.equal(r.calls.length, count);
});

test('repeat one replays a naturally ended song while manual next advances', async t => {
  const r = runtime(t, 3);
  await r.state().open('netease', 'fixture');
  r.state().cycleRepeat();
  r.state().cycleRepeat();
  const restart = r.state().restartKey;
  await r.state().ended();
  assert.equal(r.state().index, 0);
  assert.ok(r.state().restartKey > restart);
  assert.equal(r.calls.at(-1).songId, '1');
  assert.equal(r.state().autoplay, true);
  await r.state().next();
  assert.equal(r.state().index, 1);
  assert.equal(r.calls.at(-1).songId, '2');
});

test('repeat all wraps the last sequential song to the first', async t => {
  const r = runtime(t, 3);
  await r.state().open('netease', 'fixture');
  r.state().cycleRepeat();
  await r.state().playIndex(2);
  await r.state().ended();
  assert.equal(r.state().index, 0);
  assert.equal(r.calls.at(-1).songId, '1');
  assert.equal(r.state().autoplay, true);
});

test('shuffle visits every song once in a round and previous follows that order', async t => {
  const r = runtime(t, 7);
  await r.state().open('netease', 'fixture');
  r.state().toggleShuffle();
  assert.equal(r.state().shuffle, true);
  assert.equal(r.state().index, 0);
  const order = [...r.state().order];
  assert.deepEqual([...order].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6]);
  const visited = [r.state().index];
  for (let index = 1; index < r.playlist.tracks.length; index++) {
    await r.state().next();
    visited.push(r.state().index);
  }
  assert.deepEqual(visited, order);
  assert.equal(new Set(visited).size, r.playlist.tracks.length);
  await r.state().prev();
  assert.equal(r.state().index, visited.at(-2));
  await r.state().prev();
  assert.equal(r.state().index, visited.at(-3));
  await r.state().next();
  assert.equal(r.state().index, visited.at(-2));
});

test('turning shuffle off preserves the selected song and restores sequential next', async t => {
  const r = runtime(t, 5);
  await r.state().open('netease', 'fixture');
  await r.state().playIndex(2);
  r.state().toggleShuffle();
  assert.equal(r.state().index, 2);
  r.state().toggleShuffle();
  assert.equal(r.state().shuffle, false);
  assert.equal(r.state().index, 2);
  assert.deepEqual([...r.state().order], [0, 1, 2, 3, 4]);
  await r.state().next();
  assert.equal(r.state().index, 3);
});

test('shuffle previous follows listening history after a manual queue selection', async t => {
  const r = runtime(t, 5);
  await r.state().open('netease', 'fixture');
  r.state().toggleShuffle();
  await r.state().next();
  const previous = r.state().index;
  const selected = [1, 2, 3, 4].find(index => index !== previous);
  await r.state().playIndex(selected);
  await r.state().prev();
  assert.equal(r.state().index, previous);
  await r.state().next();
  assert.equal(r.state().index, selected);
});

test('sequential previous and next retain adjacent-index behavior after manual queue selection', async t => {
  const r = runtime(t, 5);
  await r.state().open('netease', 'fixture');
  await r.state().playIndex(3);
  await r.state().prev();
  assert.equal(r.state().index, 2);
  await r.state().next();
  assert.equal(r.state().index, 3);
  await r.state().next();
  assert.equal(r.state().index, 4);
});

test('explicit replay restarts the same song; quality changes and retries retain its position key', async t => {
  const r = runtime(t);
  await r.state().open('netease', 'fixture');
  const first = r.state().restartKey;
  assert.equal(typeof first, 'number');
  await r.state().playIndex(0);
  const replay = r.state().restartKey;
  assert.ok(replay > first);
  await r.state().setQuality('high');
  assert.equal(r.state().restartKey, replay);
  await r.state().retry();
  assert.equal(r.state().restartKey, replay);
  assert.equal(r.calls.at(-1).fresh, true);
  assert.equal(r.calls.at(-1).quality, 'high');
});

for (const repeat of ['off', 'all', 'one']) test(`unavailable shuffle tracks stop after one pass with repeat ${repeat}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = runtime(t, 4);
  const attempted = [];
  r.api.resolve = async (_platform, options) => {
    attempted.push(options.songId);
    throw new r.ApiError('Track unavailable', 'unavailable');
  };
  r.state().toggleShuffle();
  while (r.state().repeat !== repeat) r.state().cycleRepeat();
  await r.state().open('netease', 'fixture');
  for (let index = 0; index < r.playlist.tracks.length + 1; index++) {
    t.mock.timers.tick(1200);
    await tick();
  }
  assert.equal(attempted.length, r.playlist.tracks.length);
  assert.equal(new Set(attempted).size, r.playlist.tracks.length);
  const count = attempted.length;
  t.mock.timers.tick(60000);
  await tick();
  assert.equal(attempted.length, count);
  assert.ok(['error', 'ended'].includes(r.state().status));
});

test('single-song repeat all and repeat one can continue; next without repeat ends', async t => {
  const r = runtime(t, 1);
  await r.state().open('netease', 'fixture');
  r.state().cycleRepeat();
  await r.state().ended();
  assert.equal(r.state().index, 0);
  assert.equal(r.state().autoplay, true);
  r.state().cycleRepeat();
  await r.state().ended();
  assert.equal(r.state().index, 0);
  assert.equal(r.state().autoplay, true);
  r.state().cycleRepeat();
  await r.state().next();
  assert.equal(r.state().status, 'ended');
});

test('shuffle history forward remains enabled at the end of the current shuffled order', async t => {
  const r = runtime(t, 3);
  vm.runInContext('Math.random = () => 0', r.context);
  await r.state().open('netease', 'fixture');
  r.state().toggleShuffle();
  await r.state().playIndex(2);
  assert.deepEqual([...r.state().order], [2, 1, 0]);
  await r.state().prev();
  assert.equal(r.state().index, 0);
  assert.equal(r.state().orderIndex, 2);
  assert.equal(r.state().canNext, true);
  await r.state().next();
  assert.equal(r.state().index, 2);
});

test('navigation availability follows sequence boundaries and repeat mode immediately', async t => {
  const r = runtime(t, 2);
  await r.state().open('netease', 'fixture');
  assert.equal(r.state().canPrevious, false); assert.equal(r.state().canNext, true);
  await r.state().next();
  assert.equal(r.state().canPrevious, true); assert.equal(r.state().canNext, false);
  r.state().cycleRepeat(); assert.equal(r.state().canNext, true);
  r.state().cycleRepeat(); assert.equal(r.state().canNext, false);
  r.state().clear(); assert.equal(r.state().canNext, false); assert.equal(r.state().canPrevious, false);
});
