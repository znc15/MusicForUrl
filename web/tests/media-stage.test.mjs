import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { buildSync } = createRequire(require.resolve('vite'))('esbuild');
const code = buildSync({
  entryPoints: [fileURLToPath(new URL('../src/components/media-stage.tsx', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'lucide-react', '@/*', 'hls.js'], loader: { '.css': 'empty' },
  supported: { 'dynamic-import': false },
  tsconfigRaw: { compilerOptions: { jsx: 'react' } },
}).outputFiles[0].text;

class Media extends EventTarget {
  volume = 1; paused = true; currentTime = 0; duration = 120; ended = false;
  videoWidth = 0; readyState = 4; src = ''; loadCalls = 0;
  canPlayType() { return ''; }
  play() { this.paused = false; this.dispatchEvent(new Event('play')); return Promise.resolve(); }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  load() { this.loadCalls++; }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
}

function mount({ muted = false, isHls = false, hlsError = false } = {}) {
  const slots = []; let cursor = 0; let queued = [];
  const volume = { volume: 0.2, muted };
  const media = new Media();
  const instances = [];
  class Hls {
    static isSupported() { return true; }
    static Events = { ERROR: 'error' };
    static ErrorTypes = { MEDIA_ERROR: 'media' };
    recoveries = 0; stopped = 0; destroyed = 0;
    constructor() { instances.push(this); }
    on(event, callback) { this.callback = callback; }
    loadSource(src) { this.src = src; }
    attachMedia(video) { this.video = video; }
    recoverMediaError() { this.recoveries++; }
    stopLoad() { this.stopped++; }
    destroy() { this.destroyed++; }
  }
  const useVolume = Object.assign(select => select(volume), { getState: () => volume });
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useRef: initial => { const index = cursor++; return slots[index] ??= { current: initial }; },
    useState: initial => {
      const index = cursor++; if (!(index in slots)) slots[index] = initial;
      return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    useCallback: callback => callback,
    useEffect(effect, deps) {
      const index = cursor++;
      const old = slots[index];
      if (!old || deps.some((value, i) => value !== old.deps[i])) {
        queued.push(() => { old?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; });
      }
    },
  };
  const mocks = {
    react: React,
    '@/stores/volume': { useVolume, effectiveVolume: ({ volume, muted }) => muted ? 0 : volume },
    '@/lib/utils': { cn: (...values) => values.filter(Boolean).join(' '), formatDuration: value => String(value) },
  };
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, DOMException,
    require: name => {
      if (name === 'hls.js') { if (hlsError) throw new Error('chunk failed'); return Hls; }
      return mocks[name] ?? new Proxy({}, { get: (_, key) => key });
    },
  });
  let props = { src: '/fixture.wav', isHls, title: '测试音频' };
  function render(next = {}) {
    props = { ...props, ...next }; cursor = 0;
    const wrapper = module.exports.MediaStage(props);
    const tree = wrapper.type(wrapper.props);
    const all = [];
    const walk = node => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      all.push(node); walk(node.props?.children);
    };
    walk(tree);
    const video = all.find(node => node.type === 'video'); video.props.ref(media);
    const effects = queued; queued = []; effects.forEach(fn => fn());
    return {
      all, video, key: wrapper.props.key,
      play: all.find(node => /^(播放|暂停)媒体$/.test(node.props?.['aria-label'] || '')),
      progress: all.find(node => node.props?.['aria-label'] === '媒体播放进度'),
      alert: all.find(node => node.props?.role === 'alert'),
    };
  }
  function cleanup() { slots.forEach(slot => slot?.cleanup?.()); }
  return { render, media, volume, instances, cleanup };
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test('external media applies global volume at attachment, distinguishes audio/video and keeps one element', () => {
  for (const muted of [false, true]) {
    const m = mount({ muted }); const initial = m.render();
    assert.equal(m.media.volume, muted ? 0 : 0.2);
    assert.equal(initial.play.props.disabled, true);
    m.media.dispatchEvent(new Event('loadedmetadata'));
    let view = m.render();
    assert.equal(view.play.props.disabled, false);
    assert.equal(view.video.props.controls, false);
    assert.equal(view.all.filter(node => node.type === 'video' || node.type === 'audio').length, 1);
    m.media.videoWidth = 1920; m.media.dispatchEvent(new Event('resize'));
    view = m.render();
    assert.equal(view.video.props.controls, true);
    assert.equal(view.play, undefined);
    m.cleanup();
  }
});

test('custom audio controls play, pause, seek and replay an ended source', async () => {
  const m = mount(); m.render(); m.media.dispatchEvent(new Event('loadedmetadata'));
  let view = m.render(); view.play.props.onClick(); await flush();
  assert.equal(m.media.paused, false);
  view = m.render(); assert.equal(view.play.props['aria-label'], '暂停媒体');
  view.progress.props.onChange({ target: { value: '37' } });
  assert.equal(m.media.currentTime, 37);
  view.play.props.onClick(); await flush(); assert.equal(m.media.paused, true);
  m.media.ended = true; m.render().play.props.onClick(); await flush();
  assert.equal(m.media.currentTime, 0);
  m.cleanup();
});

test('late play rejection after source cleanup is ignored and listeners are detached', async () => {
  const m = mount(); m.render(); m.media.dispatchEvent(new Event('loadedmetadata'));
  let reject;
  m.media.play = () => new Promise((_, no) => { reject = no; });
  m.render().play.props.onClick();
  m.cleanup();
  reject(new DOMException('old request', 'NotAllowedError')); await flush();
  m.media.dispatchEvent(new Event('error'));
  assert.equal(m.render().alert, undefined);
  assert.equal(m.media.src, '');
  assert.equal(m.media.loadCalls, 1);
});

test('current autoplay restriction keeps the manual play control available', async () => {
  const m = mount(); m.render(); m.media.dispatchEvent(new Event('loadedmetadata'));
  m.media.play = () => Promise.reject(new DOMException('blocked', 'NotAllowedError'));
  m.render().play.props.onClick(); await flush();
  const view = m.render();
  assert.ok(view.alert);
  assert.equal(view.play.props.disabled, false);
  m.cleanup();
});

test('HLS recovers one media error, stops after a second and destroys on cleanup', async () => {
  const m = mount({ isHls: true }); m.render(); await flush();
  assert.equal(m.instances.length, 1);
  const hls = m.instances[0];
  hls.callback('error', { fatal: true, type: 'media' });
  assert.equal(hls.recoveries, 1); assert.equal(m.render().alert, undefined);
  hls.callback('error', { fatal: true, type: 'media' });
  assert.equal(hls.recoveries, 1); assert.equal(hls.stopped, 1); assert.ok(m.render().alert);
  m.cleanup(); assert.equal(hls.destroyed, 1);
});

test('failed HLS chunk import reports retryable feedback, and late imports do not attach', async () => {
  const broken = mount({ isHls: true, hlsError: true }); broken.render(); await flush();
  assert.ok(broken.render().alert); broken.cleanup();
  const stale = mount({ isHls: true }); stale.render(); stale.cleanup(); await flush();
  assert.equal(stale.instances.length, 0);
});

test('media wrapper keys each source and HLS mode as a separate session', () => {
  const m = mount(); const first = m.render();
  const second = m.render({ src: '/new.mp4' });
  const third = m.render({ isHls: true });
  assert.notEqual(first.key, second.key);
  assert.notEqual(second.key, third.key);
  m.cleanup();
});
