import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { buildSync } = createRequire(require.resolve('vite'))('esbuild');
const code = buildSync({
  entryPoints: [fileURLToPath(new URL('../src/components/announcement-dialog.tsx', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', '@/*', './ui/*'], tsconfigRaw: { compilerOptions: { jsx: 'react' } },
}).outputFiles[0].text;

function mount({ fullscreen = false, pending = true, loginOpen = false, open = false } = {}) {
  const slots = [], timers = new Map(), listeners = new Set();
  let cursor = 0, timerId = 0, queued = [], shown = 0, removed = 0;
  const ui = {
    announcementOpen: open, announcementPending: pending, loginOpen,
    showAnnouncement() { shown++; ui.announcementOpen = true; ui.announcementPending = false; },
    closeAnnouncement() { ui.announcementOpen = false; ui.announcementPending = false; },
  };
  const document = {
    fullscreenElement: fullscreen ? {} : null,
    addEventListener(name, listener) {
      assert.equal(name, 'fullscreenchange'); listeners.add(listener);
    },
    removeEventListener(name, listener) {
      assert.equal(name, 'fullscreenchange');
      assert.ok(listeners.delete(listener), 'cleanup removes the registered listener'); removed++;
    },
  };
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    useEffect(effect, deps) {
      const index = cursor++, previous = slots[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        queued.push(() => { previous?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; });
      }
    },
  };
  const mocks = {
    react: React,
    '@/stores/ui': { useUi: select => select(ui) },
    '@/lib/announcements': { activeAnnouncement: () => ({ id: 'fixture', title: '更新', date: '2026-11-05', paragraphs: ['播放体验更新'] }) },
  };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, document,
    window: {
      setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    require: name => mocks[name] ?? new Proxy({}, { get: (_, key) => key }),
  });
  function render() {
    cursor = 0;
    const view = module.exports.AnnouncementDialog();
    const effects = queued; queued = []; effects.forEach(effect => effect());
    return view;
  }
  function changeFullscreen(value) {
    document.fullscreenElement = value ? {} : null;
    for (const listener of listeners) listener();
    return render();
  }
  function fireTimers() {
    for (const [id, { callback }] of [...timers]) { timers.delete(id); callback(); }
  }
  function cleanup() { slots.forEach(slot => slot?.cleanup?.()); }
  return { ui, timers, listeners, render, changeFullscreen, fireTimers, cleanup,
    shown: () => shown, removed: () => removed };
}

test('a pending announcement waits through fullscreen and schedules after exit', () => {
  const m = mount({ fullscreen: true });
  assert.equal(m.render().props.open, false);
  assert.equal(m.timers.size, 0);
  assert.equal(m.ui.announcementPending, true);
  m.fireTimers(); assert.equal(m.shown(), 0);

  m.changeFullscreen(false);
  assert.equal(m.timers.size, 1);
  assert.equal([...m.timers.values()][0].delay, 220);
  m.fireTimers();
  assert.equal(m.shown(), 1);
  assert.equal(m.render().props.open, true);
  assert.equal(m.timers.size, 0);
  m.cleanup();
});

test('entering fullscreen cancels an already scheduled announcement', () => {
  const m = mount(); m.render();
  assert.equal(m.timers.size, 1);
  m.changeFullscreen(true);
  assert.equal(m.timers.size, 0);
  m.fireTimers(); assert.equal(m.shown(), 0);
  assert.equal(m.ui.announcementPending, true);

  m.changeFullscreen(false);
  assert.equal(m.timers.size, 1);
  m.fireTimers(); assert.equal(m.shown(), 1);
  m.cleanup();
});

test('login keeps priority after fullscreen exit and cancels a pending display timer', () => {
  const m = mount({ fullscreen: true, loginOpen: true, open: true });
  assert.equal(m.render().props.open, false);
  m.changeFullscreen(false);
  assert.equal(m.timers.size, 0);

  m.ui.loginOpen = false; m.render();
  assert.equal(m.timers.size, 1);
  m.ui.loginOpen = true;
  assert.equal(m.render().props.open, false);
  assert.equal(m.timers.size, 0);
  m.fireTimers(); assert.equal(m.shown(), 0);

  m.ui.loginOpen = false; m.render(); m.fireTimers();
  assert.equal(m.shown(), 1);
  assert.equal(m.render().props.open, true);
  m.cleanup();
});

test('fullscreen changes keep read or unqueued announcements closed', () => {
  const m = mount({ pending: false });
  m.render(); m.changeFullscreen(true); m.changeFullscreen(false);
  assert.equal(m.timers.size, 0);
  m.fireTimers(); assert.equal(m.shown(), 0);
  assert.equal(m.render().props.open, false);
  m.cleanup();
});

test('unmount clears the display timer and removes the fullscreen listener', () => {
  const m = mount(); m.render(); m.render();
  assert.equal(m.listeners.size, 1);
  assert.equal(m.timers.size, 1);
  m.cleanup();
  assert.equal(m.listeners.size, 0);
  assert.equal(m.removed(), 1);
  assert.equal(m.timers.size, 0);
  m.fireTimers(); assert.equal(m.shown(), 0);
});
