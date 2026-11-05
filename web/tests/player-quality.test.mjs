import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { buildSync } = createRequire(require.resolve('vite'))('esbuild');
function compile(path, external = []) {
  return buildSync({
    entryPoints: [fileURLToPath(new URL(path, import.meta.url))],
    bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
    external: ['react', 'lucide-react', '@/*', ...external],
    tsconfigRaw: { compilerOptions: { jsx: 'react' } },
  }).outputFiles[0].text;
}
const qualityCode = compile('../src/components/player-controls.tsx');
const tabsCode = compile('../src/components/ui/tabs.tsx', ['@radix-ui/react-select', '@radix-ui/react-tabs']);

function walk(node, predicate) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(child => walk(child, predicate));
  return [...(predicate(node) ? [node] : []), ...walk(node.props?.children, predicate)];
}
function textOf(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(textOf).join('');
  return typeof node === 'object' ? textOf(node.props?.children) : String(node);
}

function fixture({ capabilities = true } = {}) {
  const slots = [], selected = []; let cursor = 0;
  class HTMLElement {}
  const document = { fullscreenElement: null };
  const state = {
    quality: 'high', source: { format: 'aac', bitrate: 256000 },
    setQuality(value) { selected.push(value); state.quality = value; return Promise.resolve(); },
  };
  const qualities = [
    { id: 'low', label: '标准', format: 'MP3', bitrate: 128000, enabled: true, reason: '' },
    { id: 'high', label: '高品质', format: 'MP3', bitrate: 320000, enabled: true, reason: '' },
    { id: 'lossless', label: '无损', format: 'FLAC', bitrate: null, enabled: false, reason: '当前部署仅支持 MP3' },
  ];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
  };
  const selectPrimitives = Object.fromEntries(['Root', 'Value', 'Trigger', 'Icon', 'Portal', 'Content', 'Viewport', 'Item', 'ItemText', 'ItemIndicator']
    .map(key => [key, `Select.${key}`]));
  const mocks = {
    react: React,
    '@radix-ui/react-select': selectPrimitives,
    '@radix-ui/react-tabs': Object.fromEntries(['Root', 'List', 'Trigger', 'Content'].map(key => [key, `Tabs.${key}`])),
    '@/stores/player': { usePlayer: selector => selector(state) },
    '@/hooks/use-capabilities': { useCapabilities: () => ({ data: capabilities ? { qualities } : undefined }) },
    '@/lib/utils': {
      cn: (...values) => values.filter(Boolean).join(' '),
      formatBitrate: value => value ? `${Math.round(value / 1000)} kbps` : '',
    },
  };
  function load(code) {
    const module = { exports: {} };
    vm.runInNewContext(code, {
      module, exports: module.exports, document, HTMLElement,
      require: name => mocks[name] ?? new Proxy({}, { get: (_, key) => key }),
    });
    return module.exports;
  }
  const tabs = load(tabsCode);
  mocks['@/components/ui/tabs'] = tabs;
  const quality = load(qualityCode);
  function render() {
    cursor = 0;
    const tree = quality.PlayerQuality();
    const root = walk(tree, node => node.type === tabs.Select)[0];
    const content = walk(tree, node => node.type === tabs.SelectContent)[0];
    return { tree, root, content,
      value: walk(tree, node => node.type === tabs.SelectValue)[0],
      items: walk(tree, node => node.type === tabs.SelectItem),
      source: walk(tree, node => node.props?.className === 'player-quality-source')[0],
      portal: tabs.SelectContent(content.props),
    };
  }
  return { render, state, selected, qualities, document, HTMLElement, tabs, selectPrimitives };
}

test('requested quality, advertised options and actual source format remain distinct', () => {
  const m = fixture(); const view = m.render();
  assert.equal(view.root.props.value, 'high');
  assert.equal(textOf(view.value), '高品质');
  assert.equal(textOf(view.source), '当前音源AAC · 256 kbps');
  const high = view.items.find(item => item.props.value === 'high');
  assert.equal(textOf(high), '高品质MP3 · 320 kbps');
  assert.equal(high.props.textValue, '高品质');
  assert.equal(textOf(view.value).includes('AAC'), false);

  m.state.source = { format: 'mp3', bitrate: 128000 };
  const downgraded = m.render();
  assert.equal(textOf(downgraded.value), '高品质');
  assert.equal(textOf(downgraded.source), '当前音源MP3 · 128 kbps');
});

test('disabled qualities and selection values reach the actual Radix wrappers', () => {
  const m = fixture(); const view = m.render();
  const disabled = view.items.find(item => item.props.value === 'lossless');
  assert.equal(disabled.props.disabled, true);
  assert.equal(disabled.props.title, m.qualities[2].reason);
  assert.equal(textOf(disabled), '无损当前不可用');
  const primitive = m.tabs.SelectItem(disabled.props);
  assert.equal(primitive.type, m.selectPrimitives.Item);
  assert.equal(primitive.props.disabled, true);
  assert.equal(primitive.props.value, 'lossless');
  assert.equal(view.items.find(item => item.props.value === 'low').props.disabled, false);

  view.root.props.onValueChange('low');
  assert.deepEqual(m.selected, ['low']);
  assert.equal(m.render().root.props.value, 'low');
  assert.equal(textOf(m.render().value), '标准');
});

test('missing capabilities retain the selected label without inventing source bitrate', () => {
  const m = fixture({ capabilities: false });
  m.state.source = { format: 'aac', bitrate: null };
  let view = m.render();
  assert.equal(textOf(view.value), '高品质');
  assert.equal(textOf(view.source), '当前音源AAC');
  assert.equal(textOf(view.items[0]), '高品质AAC');
  m.state.source = null;
  view = m.render();
  assert.equal(view.source, undefined);
  assert.equal(textOf(view.value), '高品质');
});

test('quality menu portals only into an HTMLElement fullscreen root and resets after exit', () => {
  const m = fixture(); let view = m.render();
  assert.equal(view.portal.type, m.selectPrimitives.Portal);
  assert.equal(view.portal.props.container, undefined);

  const fullscreen = new m.HTMLElement();
  m.document.fullscreenElement = fullscreen;
  view.root.props.onOpenChange(true); view = m.render();
  assert.equal(view.content.props.container, fullscreen);
  assert.equal(view.portal.props.container, fullscreen);

  view.root.props.onOpenChange(false);
  m.document.fullscreenElement = null;
  m.render().root.props.onOpenChange(true); view = m.render();
  assert.equal(view.portal.props.container, undefined);

  m.document.fullscreenElement = { nodeType: 1 };
  view.root.props.onOpenChange(true);
  assert.equal(m.render().portal.props.container, undefined);
});

test('SelectContent preserves default Portal and popper props for existing callers', () => {
  const m = fixture();
  const content = m.tabs.SelectContent({ children: 'option' });
  assert.equal(content.type, m.selectPrimitives.Portal);
  assert.equal(content.props.container, undefined);
  const popup = walk(content, node => node.type === m.selectPrimitives.Content)[0];
  assert.equal(popup.props.position, 'popper');
  assert.equal(popup.props.sideOffset, 4);
  assert.equal('container' in popup.props, false);
  assert.equal(textOf(content), 'option');

  const fullscreen = new m.HTMLElement();
  const custom = m.tabs.SelectContent({ container: fullscreen, side: 'top', sideOffset: 10, children: 'quality' });
  const customPopup = walk(custom, node => node.type === m.selectPrimitives.Content)[0];
  assert.equal(custom.props.container, fullscreen);
  assert.equal(customPopup.props.side, 'top');
  assert.equal(customPopup.props.sideOffset, 10);
  assert.equal('container' in customPopup.props, false);
});
