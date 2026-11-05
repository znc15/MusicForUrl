import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { buildSync } = createRequire(require.resolve('vite'))('esbuild');
const code = buildSync({
  entryPoints: [fileURLToPath(new URL('../src/components/playback-engine.tsx', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', '@/*'], tsconfigRaw: { compilerOptions: { jsx: 'react' } },
}).outputFiles[0].text;

function mount({ unsupportedAction } = {}) {
  const hooks = []; let cursor = 0, pending = [], currentAudio = null, currentGeneration, controller;
  const failures = [], retries = [], positions = [], actionCalls = [];
  const handlers = new Map();
  const source = { mediaUrl: '/audio.mp3', format: 'mp3', bitrate: 128000 };
  const state = {
    playlist: { id: '1', platform: 'netease', name: 'Fixture', tracks: [{ id: '2', name: 'Track', artist: 'Artist', cover: '' }] },
    index: 0, source, status: 'paused', quality: 'low', generation: 1, restartKey: 1, retryKey: 0, autoplay: false,
    fail: (...args) => { failures.push(args); state.status = 'error'; },
    retry: (...args) => { retries.push(args); return Promise.resolve(); },
    markPlaying: () => { state.status = 'playing'; },
    markPaused: () => { state.status = 'paused'; },
    ended: () => { state.status = 'ended'; },
    prev: () => { state.index--; }, next: () => { state.index++; },
  };
  const volume = { volume: 0.2, muted: false };
  const playback = { time: 0, duration: 0, buffered: 0, busy: false };
  for (const key of ['play','pause','toggle','seek']) playback[key] = (...args) => controller?.[key](...args);
  const usePlayer = Object.assign(select => select(state), { getState: () => state, setState: next => Object.assign(state, next) });
  const useVolume = Object.assign(select => select(volume), { getState: () => volume });
  const usePlayback = Object.assign(select => select(playback), { getState: () => playback, setState: next => Object.assign(playback, next) });
  const equalDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useRef: initial => { const index = cursor++; return hooks[index] ??= { current: initial }; },
    useCallback: (callback, deps) => {
      const index = cursor++;
      if (!equalDeps(hooks[index]?.deps, deps)) hooks[index] = { deps, callback };
      return hooks[index].callback;
    },
    useEffect(effect, deps) {
      const index = cursor++;
      if (!equalDeps(hooks[index]?.deps, deps)) pending.push(() => {
        hooks[index]?.cleanup?.(); hooks[index] = { deps, cleanup: effect() };
      });
    },
  };
  const session = {
    metadata: null, playbackState: 'none',
    setActionHandler(action, handler) {
      if (action === unsupportedAction) throw new Error('unsupported');
      actionCalls.push([action, handler]); handlers.set(action, handler);
    },
    setPositionState(value) { positions.push(value); },
  };
  const mocks = {
    react: React,
    '@/stores/player': { usePlayer },
    '@/stores/volume': { useVolume, effectiveVolume: ({ volume, muted }) => muted ? 0 : volume },
    '@/stores/playback': { usePlayback, bindPlaybackController(next) { controller = next; return () => { if (controller === next) controller = null; }; } },
  };
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, DOMException, navigator: { mediaSession: session },
    MediaMetadata: class { constructor(value) { Object.assign(this, value); } },
    require: name => mocks[name],
  });
  function audio() {
    const listeners = new Map();
    return { volume: 1, duration: 100, currentTime: 0, playbackRate: 1, paused: true, ended: false, srcWrites: 0,
      buffered: { length: 1, start: () => 0, end: () => 80 },
      set src(value) { this.srcValue = value; this.srcWrites++; }, get src() { return this.srcValue; },
      play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; }, load() {}, removeAttribute() {},
      addEventListener: (event, handler) => listeners.set(event, handler),
      removeEventListener: (event, handler) => { if (listeners.get(event) === handler) listeners.delete(event); },
      metadata: () => listeners.get('loadedmetadata')?.(),
    };
  }
  function render() {
    cursor = 0; pending = [];
    const tree = module.exports.PlaybackEngine();
    if (!currentAudio || currentGeneration !== state.generation) { currentAudio = audio(); currentGeneration = state.generation; }
    tree.props.ref(currentAudio);
    pending.forEach(effect => effect());
    return { audio: currentAudio, props: tree.props };
  }
  return { render, state, volume, playback, failures, retries, session, handlers, positions,
    cleanup: () => hooks.forEach(hook => hook?.cleanup?.()) };
}

test('recreated media receives the current mute/volume before playback', () => {
  const r = mount();
  for (const muted of [true, false]) {
    r.volume.muted = muted;
    for (let n = 0; n < 2; n++) {
      r.state.generation++;
      assert.equal(r.render().audio.volume, muted ? 0 : 0.2);
    }
  }
});

for (const stale of [true, false]) test(`manual play failure ${stale ? 'ignores old media' : 'reports current generation'}`, async () => {
  const r = mount(); const old = r.render(); let reject;
  old.audio.play = () => new Promise((_, no) => { reject = no; });
  r.playback.play();
  if (stale) { r.state.generation++; r.state.source = { ...r.state.source }; r.render(); }
  reject(new DOMException('blocked', 'NotAllowedError'));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(r.failures.length, stale ? 0 : 1);
  if (!stale) assert.equal(r.failures[0][1], 1);
});

test('progress, buffered range, seeking and buffering are shared by every view', () => {
  const r = mount(), { audio, props } = r.render();
  audio.currentTime = 30; props.onTimeUpdate({ currentTarget: audio });
  assert.equal(r.playback.time, 30); assert.equal(r.playback.duration, 100); assert.equal(r.playback.buffered, 80);
  r.playback.seek(200); assert.equal(audio.currentTime, 100);
  r.playback.seek(-4); assert.equal(audio.currentTime, 0);
  props.onWaiting({ currentTarget: audio }); assert.equal(r.playback.busy, true);
  props.onCanPlay({ currentTarget: audio }); assert.equal(r.playback.busy, false);
});

test('quality/renewal restores progress despite early duration events; explicit replay resets', () => {
  const r = mount(), first = r.render();
  first.audio.currentTime = 38; first.props.onTimeUpdate({ currentTarget: first.audio });
  r.state.generation++; r.state.source = null; r.render();
  r.state.source = { mediaUrl: '/renewed.mp3' }; const renewed = r.render();
  renewed.props.onDurationChange({ currentTarget: renewed.audio }); renewed.audio.metadata();
  assert.equal(renewed.audio.currentTime, 38);
  r.state.restartKey++; r.state.generation++; const replay = r.render(); replay.audio.metadata();
  assert.equal(replay.audio.currentTime, 0);
});

test('ordinary view re-render keeps the audio and does not reload or pause playback', () => {
  const r = mount(), first = r.render(); r.playback.play();
  const second = r.render();
  assert.equal(first.audio, second.audio); assert.equal(second.audio.srcWrites, 1); assert.equal(second.audio.paused, false);
});

test('stale media events never change the current progress or status', () => {
  const r = mount(), first = r.render();
  r.state.generation++; r.state.restartKey++; const current = r.render();
  current.audio.currentTime = 9; current.props.onTimeUpdate({ currentTarget: current.audio });
  first.audio.currentTime = 80; first.props.onTimeUpdate({ currentTarget: first.audio }); first.props.onEnded({ currentTarget: first.audio });
  assert.equal(r.playback.time, 9); assert.equal(r.state.status, 'paused');
});

test('media recovery is attempted once, and explicit retry restores the recovery budget', () => {
  const r = mount(), first = r.render();
  first.props.onError({ currentTarget: first.audio }); first.props.onError({ currentTarget: first.audio });
  assert.deepEqual(r.retries, [[true]]); assert.equal(r.failures.length, 1);
  r.state.retryKey++; const retry = r.render(); retry.props.onError({ currentTarget: retry.audio });
  assert.equal(r.retries.length, 2);
});

test('MediaSession registers supported transport/seek actions and releases them on clear', () => {
  const r = mount({ unsupportedAction: 'seekto' }); const { audio } = r.render();
  assert.equal(r.session.metadata.title, 'Track');
  r.handlers.get('play')(); assert.equal(audio.paused, false);
  r.handlers.get('pause')(); assert.equal(audio.paused, true);
  r.handlers.get('seekforward')({ seekOffset: 20 }); assert.equal(audio.currentTime, 20);
  r.handlers.get('nexttrack')(); assert.equal(r.state.index, 1);
  r.state.playlist = null; r.state.source = null; r.render();
  assert.equal(r.session.metadata, null); assert.equal(r.session.playbackState, 'none');
  for (const handler of r.handlers.values()) assert.equal(handler, null);
  r.cleanup();
});

test('a pause during source resolution suppresses later autoplay without reassigning the loaded source', () => {
  const r = mount(); r.state.source = null; r.state.status = 'loading'; r.state.autoplay = true;
  r.render(); r.playback.pause();
  assert.equal(r.state.autoplay, false);
  r.state.source = { mediaUrl: '/resolved.mp3' }; const resolved = r.render();
  assert.equal(resolved.audio.paused, true); assert.equal(r.state.status, 'paused');
  r.playback.play(); r.render();
  assert.equal(resolved.audio.paused, false); assert.equal(resolved.audio.srcWrites, 1);
});

test('unsupported MediaSession position reporting leaves playback/progress usable', () => {
  const r = mount(); r.session.setPositionState = () => { throw new DOMException('unsupported', 'NotSupportedError'); };
  const { audio, props } = r.render(); audio.currentTime = 12;
  assert.doesNotThrow(() => props.onTimeUpdate({ currentTarget: audio }));
  assert.equal(r.playback.time, 12);
  assert.doesNotThrow(() => r.cleanup());
});

test('playback bridge ignores detached controllers and rejects non-finite seeks', () => {
  const bundled = buildSync({ entryPoints: [fileURLToPath(new URL('../src/stores/playback.ts', import.meta.url))],
    bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent' }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(bundled, { module, exports: module.exports, require, process: { env: { NODE_ENV: 'test' } } });
  const { usePlayback, bindPlaybackController } = module.exports;
  const calls = []; const make = name => ({ play: () => calls.push(name), pause() {}, toggle() {}, seek: value => calls.push(value) });
  usePlayback.getState().play();
  const old = bindPlaybackController(make('old'));
  const latest = bindPlaybackController(make('current')); old();
  usePlayback.getState().play(); usePlayback.getState().seek(NaN); usePlayback.getState().seek(5);
  assert.deepEqual(calls, ['current', 5]);
  latest(); usePlayback.getState().play();
  assert.deepEqual(calls, ['current', 5]); assert.equal(usePlayback.getState().time, 0);
});
