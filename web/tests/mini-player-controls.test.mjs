import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { buildSync } = createRequire(require.resolve('vite'))('esbuild');
const code = buildSync({
  entryPoints: [fileURLToPath(new URL('../src/components/mini-player.tsx', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'lucide-react', '@/*'], tsconfigRaw: { compilerOptions: { jsx: 'react' } },
}).outputFiles[0].text;

function mount() {
  const refs = []; let cursor = 0;
  const failures = [];
  const source = { mediaUrl: '/audio.mp3', format: 'mp3', bitrate: 128000 };
  const state = {
    playlist: { id: '1', platform: 'netease', name: 'Fixture', tracks: [{ id: '2', name: 'Track' }] },
    index: 0, source, status: 'paused', quality: 'low', generation: 1, autoplay: false,
    fail: (...args) => failures.push(args),
  };
  const volume = { volume: 0.2, muted: false };
  const usePlayer = Object.assign(select => select(state), { getState: () => state });
  const useVolume = Object.assign(select => select(volume), { getState: () => volume });
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useRef: initial => { const index = cursor++; return refs[index] ??= { current: initial }; },
    useCallback: callback => callback,
    useEffect() {},
    useState: initial => [initial, () => {}],
  };
  const mocks = {
    react: React,
    '@/stores/player': { usePlayer },
    '@/stores/volume': { useVolume, effectiveVolume: ({ volume, muted }) => muted ? 0 : volume },
    '@/hooks/use-capabilities': { useCapabilities: () => ({ data: { qualities: [] } }) },
    '@/lib/utils': { cn: (...values) => values.join(' '), formatBitrate: String, formatDuration: String },
  };
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, DOMException,
    require: name => mocks[name] ?? new Proxy({}, { get: (_, key) => key }),
  });
  function render() {
    cursor = 0;
    const tree = module.exports.MiniPlayer();
    const all = [];
    function walk(node) { if (!node || typeof node !== 'object') return; if (Array.isArray(node)) return node.forEach(walk); all.push(node); walk(node.props?.children); }
    walk(tree);
    return { audio: all.find(node => node.type === 'audio'), play: all.find(node => node.props?.['aria-label'] === '播放') };
  }
  return { render, state, volume, failures };
}

test('a recreated media element receives the current mute/volume before playback', () => {
  const r = mount();
  for (const muted of [true, false]) {
    r.volume.muted = muted;
    for (const generation of [1, 2]) {
      r.state.generation = generation;
      const audio = { volume: 1 };
      r.render().audio.props.ref(audio);
      assert.equal(audio.volume, muted ? 0 : 0.2);
    }
  }
});

for (const stale of [true, false]) test(`manual play failure ${stale ? 'ignores an old media generation' : 'reports the current generation'}`, async () => {
  const r = mount();
  let reject;
  const pending = new Promise((_, no) => { reject = no; });
  const audio = { volume: 1, paused: true, play: () => pending };
  const controls = r.render();
  controls.audio.props.ref(audio);
  controls.play.props.onClick();
  if (stale) {
    r.state.generation++;
    r.state.source = { ...r.state.source, mediaUrl: '/new.mp3' };
    r.render().audio.props.ref({ volume: 1 });
  }
  reject(new DOMException('blocked', 'NotAllowedError'));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(r.failures.length, stale ? 0 : 1);
  if (!stale) assert.equal(r.failures[0][1], 1);
});
