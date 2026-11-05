import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { buildSync, transformSync } = createRequire(require.resolve('vite'))('esbuild');
const code = buildSync({
  stdin: { contents: `export { api, parseStreamUrl } from './src/lib/api';
    export { useUi } from './src/stores/ui';
    export * from './src/lib/announcements';
    export { createRequestScope } from './src/lib/request-scope';`,
  loader: 'ts', resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
}).outputFiles[0].text;

function fixture(values = {}) {
  const saved = new Map(Object.entries(values));
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, require, console, Error,
    process: { env: { NODE_ENV: 'test' } }, AbortController, DOMException, URL, URLSearchParams,
    localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) },
    fetch: async () => Response.json({ success: true, data: {} }),
  });
  vm.runInContext(code, context);
  return { ...module.exports, context, saved };
}

test('request replacement and cancellation invalidate delayed success and error callbacks', () => {
  const r = fixture(), scope = r.createRequestScope();
  const first = scope.begin();
  const second = scope.begin();
  assert.equal(first.signal.aborted, true);
  assert.equal(first.isCurrent(), false);
  assert.equal(second.isCurrent(), true);
  scope.cancel();
  assert.equal(second.signal.aborted, true);
  assert.equal(second.isCurrent(), false);
});

test('login task hook cancels immediately on close or session replacement', () => {
  const r = fixture();
  const source = readFileSync(new URL('../src/hooks/use-login-task.ts', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace('export function', 'function');
  const cleanups = [];
  const context = vm.createContext({
    createRequestScope: r.createRequestScope, useUi: Object.assign(selector => selector(r.useUi.getState()), r.useUi),
    useMemo: fn => fn(), useCallback: fn => fn, useEffect: fn => cleanups.push(fn()),
  });
  vm.runInContext(transformSync(source, { loader: 'ts' }).code, context);
  r.useUi.getState().openLogin('netease');
  const task = context.useLoginTask()();
  r.useUi.getState().closeLogin();
  assert.equal(task.signal.aborted, true);
  assert.equal(task.isCurrent(), false);
  r.useUi.getState().openLogin('netease');
  const another = context.useLoginTask()();
  r.useUi.getState().restartLogin();
  assert.equal(another.signal.aborted, true);
  assert.equal(another.isCurrent(), false);
  for (const cleanup of cleanups) cleanup?.();
});

test('all login API calls forward their cancellation signal', async () => {
  const r = fixture(), controller = new AbortController(), calls = [];
  r.context.fetch = async (_url, options) => { calls.push(options); return Response.json({ success: true, data: {} }); };
  const signal = controller.signal;
  await r.api.qrcode('qq', signal);
  await r.api.qrcodeCheck('qq', 'key', signal);
  await r.api.sendCaptcha('netease', 'fixture', signal);
  await r.api.loginCaptcha('netease', 'fixture', 'fixture', signal);
  await r.api.loginPassword('netease', 'fixture', 'fixture', signal);
  await r.api.loginCookie('netease', 'fixture', signal);
  await r.api.authCaptcha('kuwo', signal);
  await r.api.loginByPassword('kuwo', {}, signal);
  await r.api.sendLoginSms('kuwo', {}, signal);
  await r.api.loginBySms('kuwo', {}, signal);
  assert.equal(calls.length, 10);
  for (const request of calls) assert.equal(request.signal, signal);
});

const loginCode = buildSync({
  stdin: {
    contents: readFileSync(new URL('../src/components/login-dialog.tsx', import.meta.url), 'utf8')
      + '\nexport { PasswordPanel, CaptchaPanel, CookiePanel };',
    loader: 'tsx', resolveDir: fileURLToPath(new URL('../', import.meta.url)),
  },
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
  external: ['react', 'sonner', '@/*'], tsconfigRaw: { compilerOptions: { jsx: 'react' } },
}).outputFiles[0].text;

function mountLoginForm(panel) {
  const r = fixture(), successes = [], errors = [], cleanups = [], updates = [];
  r.useUi.getState().openLogin('netease');
  const hooks = {
    useMemo: callback => callback(), useCallback: callback => callback,
    useEffect: callback => cleanups.push(callback()),
  };
  const hookSource = readFileSync(new URL('../src/hooks/use-login-task.ts', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace('export function', 'function');
  const hookContext = vm.createContext({ ...hooks, createRequestScope: r.createRequestScope,
    useUi: Object.assign(selector => selector(r.useUi.getState()), r.useUi),
  });
  vm.runInContext(transformSync(hookSource, { loader: 'ts' }).code, hookContext);
  let resolve, reject, requestSignal;
  const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
  const request = (...args) => { requestSignal = args.at(-1); return pending; };
  const mocks = {
    react: { ...hooks,
      useState: initial => [initial, value => updates.push(value)],
      createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    },
    sonner: { toast: { error: value => errors.push(value) } },
    '@/lib/api': { api: { loginPassword: request, loginCaptcha: request, loginCookie: request } },
    '@/hooks/use-login-task': { useLoginTask: hookContext.useLoginTask },
  };
  const module = { exports: {} };
  vm.runInNewContext(loginCode, { module, exports: module.exports, Error,
    require: name => mocks[name] ?? new Proxy({}, { get: (_, key) => key }),
  });
  const form = module.exports[panel]({ platform: 'netease', onSuccess: (...args) => successes.push(args) });
  return { ...r, successes, errors, updates, resolve, reject,
    submit: () => form.props.onSubmit({ preventDefault() {} }),
    signal: () => requestSignal,
    cleanup: () => cleanups.forEach(cleanup => cleanup?.()),
  };
}

test('form login ignores delayed success and errors after close, mode change or platform change', async () => {
  for (const panel of ['PasswordPanel', 'CaptchaPanel', 'CookiePanel']) {
    for (const replace of [ui => ui.closeLogin(), ui => ui.restartLogin(), ui => ui.openLogin('qq')]) {
      for (const fail of [false, true]) {
        const r = mountLoginForm(panel), submitted = r.submit();
        replace(r.useUi.getState());
        assert.equal(r.signal().aborted, true);
        if (fail) r.reject(new Error('Delayed failure'));
        else r.resolve({ token: 'old-account', user: { userId: 'old' } });
        await submitted;
        assert.equal(r.successes.length, 0);
        assert.equal(r.errors.length, 0);
        assert.deepEqual(r.updates, [true]);
        r.cleanup();
      }
    }
  }
});

test('current form failures remain visible and release the submit state', async () => {
  const r = mountLoginForm('PasswordPanel'), submitted = r.submit();
  r.reject(new Error('Network unavailable'));
  await submitted;
  assert.deepEqual(r.errors, ['Network unavailable']);
  assert.deepEqual(r.updates, [true, false]);
  r.cleanup();
});

test('site top songs preserve freshness and period metadata', async () => {
  const r = fixture();
  r.context.fetch = async path => {
    assert.equal(path, '/api/stats/top');
    return Response.json({ success: true, data: [{ platform: 'qq', songId: '1', playCount: 2 }],
      stale: true, updatedAt: 123, windowDays: 30, startedAt: 100, since: 110 });
  };
  const result = await r.api.statsTop();
  assert.equal(result.data[0].platform, 'qq');
  assert.equal(result.stale, true);
  assert.equal(result.updatedAt, 123);
  assert.equal(result.windowDays, 30);
  assert.equal(result.startedAt, 100);
  assert.equal(result.since, 110);
});

test('damaged playback URL encodings fail safely and valid grants still decode', () => {
  const r = fixture();
  for (const grant of ['%', '%ZZ', '%E4%B8']) {
    assert.equal(r.parseStreamUrl(`https://app.test/api/playlist/m3u8/${grant}/123/stream.m3u8`), null);
  }
  const valid = r.parseStreamUrl('https://app.test/api/qq/playlist/m3u8/abc%2Edef/123/stream.m3u8');
  assert.equal(valid.platform, 'qq');
  assert.equal(valid.grant, 'abc.def');
  assert.equal(valid.playlistId, '123');
});

test('unread announcements defer to login, dismiss once and reopen manually', () => {
  const r = fixture();
  r.useUi.getState().openLogin('qq');
  r.useUi.getState().queueAnnouncement();
  r.useUi.getState().showAnnouncement();
  assert.equal(r.useUi.getState().announcementOpen, false);
  assert.equal(r.useUi.getState().announcementPending, true);
  r.useUi.getState().closeLogin();
  r.useUi.getState().showAnnouncement();
  assert.equal(r.useUi.getState().announcementOpen, true);
  r.useUi.getState().closeAnnouncement();
  assert.equal(r.hasReadAnnouncement(r.CURRENT_ANNOUNCEMENT.id), true);
  r.useUi.getState().queueAnnouncement();
  assert.equal(r.useUi.getState().announcementPending, false);
  r.useUi.getState().showAnnouncement();
  assert.equal(r.useUi.getState().announcementOpen, true);
  r.useUi.getState().openLogin('netease');
  assert.equal(r.useUi.getState().announcementOpen, false);
  assert.equal(r.useUi.getState().announcementPending, true);
  assert.equal(r.hasReadAnnouncement('next-release-id'), false);
});

test('announcement read markers survive reload and unavailable storage stays session-only', () => {
  const r = fixture();
  r.markAnnouncementRead(r.CURRENT_ANNOUNCEMENT.id);
  const next = fixture(Object.fromEntries(r.saved));
  assert.equal(next.useUi.getState().announcementUnread, false);
  const blocked = fixture();
  blocked.context.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  blocked.markAnnouncementRead('current');
  assert.equal(blocked.hasReadAnnouncement('current'), true);
  assert.equal(blocked.hasReadAnnouncement('new'), false);
  assert.equal(blocked.activeAnnouncement(null), null);
  assert.equal(blocked.activeAnnouncement({ id: '', title: 'Title', date: '', paragraphs: ['Text'] }), null);
  assert.equal(blocked.activeAnnouncement({ id: 'x', title: 'Title', date: '', paragraphs: [' '] }), null);
});
