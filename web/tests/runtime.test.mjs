import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PLATFORMS } from '../../cloudflare/src/platforms.js';

const require = createRequire(import.meta.url);
const viteRequire = createRequire(require.resolve('vite'));
const { buildSync } = viteRequire('esbuild');
const code = buildSync({
  stdin: {
    contents: `export { useAuth } from './src/stores/auth';
      export { usePlayer } from './src/stores/player';
      export { api, ApiError } from './src/lib/api';
      export { queryClient, accountQueryKey, removeCachedFavorite } from './src/lib/query-client';
      export * from './src/lib/storage';
      export { PLATFORM_TABLE } from './src/lib/platform-data.js';`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
}).outputFiles[0].text;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function runtime(t, values = {}) {
  const data = new Map(Object.entries(values));
  const localStorage = {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
  };
  const module = { exports: {} };
  const context = vm.createContext({
    module, exports: module.exports, require, localStorage, console,
    Request, Response, Headers, URL, URLSearchParams, AbortController, DOMException, Error,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    process: { env: { NODE_ENV: 'test' } },
    fetch: () => { throw new Error('Unexpected network access'); },
  });
  vm.runInContext(code, context);
  const result = module.exports;
  t.after(() => { result.usePlayer.getState().clear(); result.queryClient.clear(); });
  return { ...result, data, context };
}

const user = id => ({ userId: id, nickname: id, avatar: '', vipType: 0 });
const list = id => ({ id, platform: 'netease', name: id, cover: '', grant: `grant-${id}`,
  tracks: [{ id: `${id}1`, name: 'Track', artist: '', cover: '', duration: 180 }] });
const source = id => ({ mediaUrl: `https://app.test/${id}.mp3`, warnings: [], format: 'mp3', bitrate: 128000 });

test('four platform tokens use independent keys and preserve legacy preferences', t => {
  const r = runtime(t, { token: 'old-netease', qqToken: 'old-qq', theme: 'dark' });
  assert.equal(r.readToken('netease'), 'old-netease');
  assert.equal(r.readToken('qq'), 'old-qq');
  assert.equal(r.readToken('kugou'), '');
  assert.equal(r.readToken('kuwo'), '');
  for (const platform of ['netease', 'qq', 'kugou', 'kuwo']) r.writeToken(platform, `${platform}-token`);
  r.clearToken('kugou');
  assert.equal(r.readToken('netease'), 'netease-token');
  assert.equal(r.readToken('qq'), 'qq-token');
  assert.equal(r.readToken('kugou'), '');
  assert.equal(r.readToken('kuwo'), 'kuwo-token');
  assert.equal(r.data.get('token'), 'netease-token');
  assert.equal(r.data.get('qqToken'), 'qq-token');
  assert.equal(r.readTheme(), 'dark');
});

test('legacy shared token migrates only to its registered active platform', t => {
  const records = [
    { platform: 'kugou', userId: 'g', token: 'active-g', addedAt: 2 },
    { platform: 'kuwo', userId: 'w', token: 'remembered-w', addedAt: 1 },
  ];
  const r = runtime(t, { token: 'active-g', qqToken: 'old-qq', 'mfu:accounts': JSON.stringify(records) });
  assert.equal(r.readToken('kugou'), 'active-g');
  assert.equal(r.readToken('kuwo'), '');
  assert.equal(r.readToken('netease'), '');
  assert.equal(r.readToken('qq'), 'old-qq');
  assert.equal(r.useAuth.getState().users.kugou, null);
  const other = runtime(t, { token: 'unattributed', 'mfu:accounts': JSON.stringify(records) });
  assert.equal(other.readToken('netease'), 'unattributed');
  assert.equal(other.readToken('kugou'), '');
});

test('login capability and guest generation are separate platform choices', t => {
  const r = runtime(t);
  for (const item of r.PLATFORM_TABLE) {
    assert.equal(item.account, true);
    assert.equal(item.requireLogin, ['netease', 'qq'].includes(item.id));
    assert.equal(item.requireLogin, PLATFORMS[item.id].account && !PLATFORMS[item.id].guestPlayback);
  }
});

test('account changes immediately cancel and remove private queries without stale refill', async t => {
  const r = runtime(t);
  r.useAuth.getState().adopt('netease', 'a-token', user('a'));
  const oldKey = r.accountQueryKey('netease', 'a', 'favorites');
  r.queryClient.setQueryData(oldKey, { data: ['private-a'], total: 1 });
  const pending = deferred();
  let signal;
  const request = r.queryClient.fetchQuery({ queryKey: [...oldKey, 1], retry: false,
    queryFn: options => { signal = options.signal; return pending.promise; } }).catch(() => null);
  r.useAuth.getState().adopt('netease', 'b-token', user('b'));
  assert.equal(signal.aborted, true);
  assert.equal(r.queryClient.getQueryData(oldKey), undefined);
  assert.equal(r.queryClient.getQueryCache().findAll({ queryKey: ['account', 'netease'] }).length, 0);
  assert.notDeepEqual([...oldKey], [...r.accountQueryKey('netease', 'b', 'favorites')]);
  pending.resolve({ data: ['late-private-a'], total: 1 });
  await request;
  assert.equal(r.queryClient.getQueryData([...oldKey, 1]), undefined);
});

test('stale auth success and stale 401 never overwrite a newer login', async t => {
  const r = runtime(t);
  for (const rejected of [false, true]) {
    r.useAuth.getState().adopt('netease', 'old-token', user('old'));
    const pending = deferred();
    let options;
    r.api.authStatus = (_platform, request) => { options = request; return pending.promise; };
    const refresh = r.useAuth.getState().refresh('netease');
    r.useAuth.getState().adopt('netease', 'new-token', user('new'));
    assert.equal(options.signal.aborted, true);
    if (rejected) pending.reject(new r.ApiError('Expired', 'login_required', 401));
    else pending.resolve({ logged: true, user: user('old') });
    assert.equal(await refresh, null);
    assert.equal(r.useAuth.getState().users.netease.userId, 'new');
    assert.equal(r.readToken('netease'), 'new-token');
  }
});

test('favorite removal updates every page total only for its owning account', t => {
  const r = runtime(t);
  const key = r.accountQueryKey('netease', 'a', 'favorites');
  const other = r.accountQueryKey('netease', 'b', 'favorites');
  r.queryClient.setQueryData([...key, 0], { data: [{ playlistId: 'keep' }], total: 19 });
  r.queryClient.setQueryData([...key, 1], { data: [{ playlistId: 'remove' }], total: 19 });
  r.queryClient.setQueryData(other, { data: [{ playlistId: 'remove' }], total: 1 });
  r.removeCachedFavorite('netease', 'a', 'remove');
  assert.equal(r.queryClient.getQueryData([...key, 0]).total, 18);
  assert.equal(r.queryClient.getQueryData([...key, 0]).data[0].playlistId, 'keep');
  assert.equal(r.queryClient.getQueryData([...key, 1]).data.length, 0);
  assert.equal(Math.ceil(r.queryClient.getQueryData([...key, 1]).total / 18), 1);
  assert.equal(r.queryClient.getQueryData(other).total, 1);
  assert.equal(r.queryClient.getQueryData(other).data.length, 1);
});

test('refresh distinguishes network errors from expired sessions and deduplicates bootstrap', async t => {
  const r = runtime(t);
  r.useAuth.getState().adopt('qq', 'q-token', user('q'));
  r.api.authStatus = async () => { throw new Error('Offline'); };
  assert.equal(await r.useAuth.getState().refresh('qq'), null);
  assert.equal(r.readToken('qq'), 'q-token');
  assert.equal(r.useAuth.getState().users.qq.userId, 'q');
  let calls = 0;
  const pending = deferred();
  r.api.authStatus = () => { calls++; return pending.promise; };
  const first = r.useAuth.getState().refreshAll();
  const second = r.useAuth.getState().refreshAll();
  assert.equal(calls, 1);
  pending.resolve({ logged: false });
  await Promise.all([first, second]);
  assert.equal(r.readToken('qq'), '');
  assert.equal(r.useAuth.getState().users.qq, null);
  r.useAuth.getState().adopt('qq', 'expired-token', user('q'));
  r.api.authStatus = async () => { throw new r.ApiError('Expired', 'login_required', 401); };
  await r.useAuth.getState().refresh('qq');
  assert.equal(r.readToken('qq'), '');
  assert.equal(r.useAuth.getState().users.qq, null);
});

test('logout clears locally first and its delayed response preserves a new login', async t => {
  const r = runtime(t);
  r.useAuth.getState().adopt('qq', 'old-token', user('old'));
  const pending = deferred();
  let sentToken;
  r.api.logout = (_platform, token) => { sentToken = token; return pending.promise; };
  const logout = r.useAuth.getState().logout('qq');
  assert.equal(sentToken, 'old-token');
  assert.equal(r.readToken('qq'), '');
  r.useAuth.getState().adopt('qq', 'new-token', user('new'));
  pending.resolve(); await logout;
  assert.equal(r.readToken('qq'), 'new-token');
});

test('latest playlist open wins and aborted playlist responses stay discarded', async t => {
  const r = runtime(t);
  const requests = new Map();
  r.api.playerPlaylist = (_platform, id, _grant, signal) => {
    const pending = deferred(); requests.set(id, { ...pending, signal }); return pending.promise;
  };
  r.api.resolve = async (_platform, options) => source(options.songId);
  const old = r.usePlayer.getState().open('netease', 'a');
  const latest = r.usePlayer.getState().open('netease', 'b');
  assert.equal(requests.get('a').signal.aborted, true);
  requests.get('b').resolve(list('b')); assert.equal(await latest, true);
  requests.get('a').resolve(list('a')); assert.equal(await old, false);
  assert.equal(r.usePlayer.getState().playlist.id, 'b');
  assert.match(r.usePlayer.getState().source.mediaUrl, /b1/);
});

test('clear aborts both playlist and media resolution and ignores stale media events', async t => {
  const r = runtime(t);
  const playlist = deferred(); let playlistSignal;
  r.api.playerPlaylist = (_p, _id, _g, signal) => { playlistSignal = signal; return playlist.promise; };
  const opening = r.usePlayer.getState().open('netease', 'a');
  r.usePlayer.getState().clear();
  assert.equal(playlistSignal.aborted, true);
  playlist.resolve(list('a')); assert.equal(await opening, false);
  assert.equal(r.usePlayer.getState().playlist, null);
  r.api.playerPlaylist = async () => list('b');
  const media = deferred(), started = deferred(); let mediaSignal;
  r.api.resolve = (_p, options) => { mediaSignal = options.signal; started.resolve(); return media.promise; };
  const loading = r.usePlayer.getState().open('netease', 'b');
  await started.promise;
  const oldGeneration = r.usePlayer.getState().generation;
  r.usePlayer.getState().clear();
  assert.equal(mediaSignal.aborted, true);
  media.resolve(source('b')); assert.equal(await loading, false);
  r.usePlayer.getState().markPlaying(oldGeneration);
  r.usePlayer.getState().fail('Old error', oldGeneration);
  assert.equal(r.usePlayer.getState().status, 'idle');
  assert.equal(r.usePlayer.getState().source, null);
});

test('opening another playlist aborts an earlier media resolution', async t => {
  const r = runtime(t);
  r.api.playerPlaylist = async (_platform, id) => list(id);
  const oldMedia = deferred(), started = deferred(); let oldSignal;
  r.api.resolve = (_platform, options) => {
    if (options.playlistId === 'a') {
      oldSignal = options.signal; started.resolve(); return oldMedia.promise;
    }
    return Promise.resolve(source(options.songId));
  };
  const old = r.usePlayer.getState().open('netease', 'a');
  await started.promise;
  const latest = r.usePlayer.getState().open('netease', 'b');
  assert.equal(oldSignal.aborted, true);
  assert.equal(await latest, true);
  oldMedia.resolve(source('a1'));
  assert.equal(await old, false);
  assert.equal(r.usePlayer.getState().playlist.id, 'b');
  assert.match(r.usePlayer.getState().source.mediaUrl, /b1/);
});

test('empty playlists and failed resolution return failure for caller feedback', async t => {
  const r = runtime(t);
  r.api.playerPlaylist = async () => ({ ...list('a'), tracks: [] });
  assert.equal(await r.usePlayer.getState().open('netease', 'a'), false);
  assert.equal(r.usePlayer.getState().errorCode, 'empty');
  r.api.playerPlaylist = async () => list('b');
  r.api.resolve = async () => { throw new Error('Offline'); };
  assert.equal(await r.usePlayer.getState().open('netease', 'b'), false);
  assert.equal(r.usePlayer.getState().status, 'error');
});

test('API propagates cancellation and uses explicitly captured private credentials', async t => {
  const r = runtime(t, { token: 'new-token' });
  const controller = new AbortController();
  const requests = [];
  r.context.fetch = async (url, options) => {
    requests.push({ url, options });
    return Response.json({ success: true, data: [], total: 0 });
  };
  await r.api.favorites('netease', 0, 18, { token: 'old-token', signal: controller.signal });
  await r.api.playerPlaylist('netease', '1', '', controller.signal);
  await r.api.resolve('netease', { playlistId: '1', songId: '11', quality: 'low', signal: controller.signal });
  assert.equal(requests[0].options.headers['x-token'], 'old-token');
  for (const request of requests) assert.equal(request.options.signal, controller.signal);
});

// Remote player/storage regressions are consolidated here with the same in-memory runner.
// Existing tests above retain latest-open/clear success and independent-token coverage.
const twoTracks = id => ({ ...list(id), tracks: [list(id).tracks[0], { ...list(id).tracks[0], id: `${id}2` }] });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('clearing any platform leaves the other token keys unchanged', t => {
  const r = runtime(t);
  const platforms = ['netease', 'qq', 'kugou', 'kuwo'];
  for (const target of platforms) {
    for (const platform of platforms) r.writeToken(platform, `fixture-${platform}`);
    r.clearToken(target);
    for (const platform of platforms) assert.equal(r.readToken(platform), platform === target ? '' : `fixture-${platform}`);
  }
  r.writeToken('kugou', 'replacement');
  assert.equal(r.readToken('kugou'), 'replacement');
  assert.equal(r.readToken('netease'), 'fixture-netease');
});

test('all platform API and logout calls carry only that platform credential', async t => {
  const r = runtime(t);
  const headers = { netease: 'x-token', qq: 'x-qq-token', kugou: 'x-kugou-token', kuwo: 'x-kuwo-token' };
  const platforms = Object.keys(headers);
  for (const platform of platforms) r.useAuth.getState().adopt(platform, `fixture-${platform}`, user(platform));
  for (const platform of platforms) {
    r.context.fetch = async (_url, init) => {
      assert.equal(JSON.stringify(init.headers), JSON.stringify({ [headers[platform]]: `fixture-${platform}` }));
      return Response.json({ success: true, data: { logged: true } });
    };
    await r.api.authStatus(platform);
  }
  for (const target of platforms) {
    r.context.fetch = async (_url, init) => {
      assert.equal(JSON.stringify(init.headers), JSON.stringify({ [headers[target]]: `fixture-${target}`, 'content-type': 'application/json' }));
      return Response.json({ success: true });
    };
    await r.useAuth.getState().logout(target);
    assert.equal(r.readToken(target), '');
    assert.equal(r.useAuth.getState().tokens[target], '');
    for (const remaining of platforms.slice(platforms.indexOf(target) + 1)) {
      assert.equal(r.readToken(remaining), `fixture-${remaining}`);
      assert.equal(r.useAuth.getState().tokens[remaining], `fixture-${remaining}`);
    }
  }
});

test('blocked browser storage does not throw for token operations', t => {
  const r = runtime(t);
  const blocked = () => { throw new Error('storage unavailable'); };
  r.context.localStorage = { getItem: blocked, setItem: blocked, removeItem: blocked };
  for (const platform of ['netease', 'qq', 'kugou', 'kuwo']) {
    assert.equal(r.readToken(platform), '');
    assert.doesNotThrow(() => r.writeToken(platform, 'fixture'));
    assert.doesNotThrow(() => r.clearToken(platform));
  }
});

for (const action of ['clear', 'open']) {
  test(`${action} discards late playlist errors`, async t => {
    const r = runtime(t);
    const old = deferred();
    r.api.playerPlaylist = (_platform, id) => id === 'old' ? old.promise : Promise.resolve(list(id));
    r.api.resolve = async (_platform, options) => source(options.playlistId);
    const pending = r.usePlayer.getState().open('netease', 'old');
    if (action === 'clear') r.usePlayer.getState().clear();
    else assert.equal(await r.usePlayer.getState().open('netease', 'new'), true);
    old.reject(new Error('stale playlist failure'));
    assert.equal(await pending, false);
    assert.equal(r.usePlayer.getState().playlist?.id ?? null, action === 'clear' ? null : 'new');
    assert.equal(r.usePlayer.getState().status, action === 'clear' ? 'idle' : 'loading');
    assert.equal(r.usePlayer.getState().message, '');
  });
}

for (const outcome of ['success', 'error']) {
  test(`a pending new playlist discards old resolve ${outcome} immediately`, async t => {
    const r = runtime(t);
    const oldSource = deferred(), newPlaylist = deferred(), started = deferred();
    r.api.playerPlaylist = (_platform, id) => id === 'new' ? newPlaylist.promise : Promise.resolve(twoTracks(id));
    r.api.resolve = (_platform, options) => {
      if (options.playlistId === 'old') { started.resolve(); return oldSource.promise; }
      return Promise.resolve(source('new'));
    };
    const oldOpen = r.usePlayer.getState().open('netease', 'old');
    await started.promise;
    const newOpen = r.usePlayer.getState().open('netease', 'new');
    if (outcome === 'success') oldSource.resolve(source('old'));
    else oldSource.reject(new r.ApiError('stale unavailable', 'unavailable'));
    assert.equal(await oldOpen, false);
    assert.equal(r.usePlayer.getState().source, null);
    assert.equal(r.usePlayer.getState().message, '');
    assert.equal(r.usePlayer.getState().status, 'loading');
    newPlaylist.resolve(twoTracks('new'));
    assert.equal(await newOpen, true);
  });

  for (const action of ['clear', 'switch']) {
    test(`${action} discards late track source ${outcome}`, async t => {
      const r = runtime(t);
      const old = deferred(), started = deferred();
      r.api.playerPlaylist = async () => twoTracks('one');
      r.api.resolve = (_platform, options) => {
        if (options.songId === 'one1') { started.resolve(); return old.promise; }
        return Promise.resolve(source('new-track'));
      };
      const opening = r.usePlayer.getState().open('netease', 'one');
      await started.promise;
      if (action === 'clear') r.usePlayer.getState().clear();
      else await r.usePlayer.getState().playIndex(1);
      if (outcome === 'success') old.resolve(source('stale'));
      else old.reject(new r.ApiError('stale unavailable', 'unavailable'));
      assert.equal(await opening, false);
      assert.equal(r.usePlayer.getState().source?.mediaUrl ?? null, action === 'clear' ? null : source('new-track').mediaUrl);
      assert.equal(r.usePlayer.getState().message, '');
      assert.equal(r.usePlayer.getState().status, action === 'clear' ? 'idle' : 'loading');
    });
  }

  test(`terminal next stays ended after pending source ${outcome}`, async t => {
    const r = runtime(t);
    const last = deferred(); let signal;
    r.api.playerPlaylist = async () => twoTracks('one');
    r.api.resolve = (_platform, options) => {
      if (options.songId === 'one2') { signal = options.signal; return last.promise; }
      return Promise.resolve(source('first'));
    };
    assert.equal(await r.usePlayer.getState().open('netease', 'one'), true);
    const pending = r.usePlayer.getState().playIndex(1);
    const generation = r.usePlayer.getState().generation;
    await r.usePlayer.getState().next();
    assert.equal(signal.aborted, true);
    assert.ok(r.usePlayer.getState().generation > generation);
    if (outcome === 'success') last.resolve(source('last')); else last.reject(new Error('late failure'));
    await pending;
    assert.equal(r.usePlayer.getState().status, 'ended');
    assert.equal(r.usePlayer.getState().message, '歌单播放结束');
    assert.equal(r.usePlayer.getState().autoplay, false);
  });
}

test('fetch receives cancellation across playlist, track switch and clear', async t => {
  const r = runtime(t);
  const requests = [];
  r.context.fetch = (url, init) => {
    const task = deferred(); requests.push({ url, signal: init.signal, task }); return task.promise;
  };
  const respond = (index, data) => requests[index].task.resolve(Response.json({ success: true, data }));
  const first = r.usePlayer.getState().open('netease', 'one');
  assert.ok(requests[0].signal instanceof AbortSignal);
  const second = r.usePlayer.getState().open('netease', 'two');
  assert.equal(requests[0].signal.aborted, true);
  respond(0, twoTracks('one')); assert.equal(await first, false);
  respond(1, twoTracks('two')); await tick();
  assert.ok(requests[2].signal instanceof AbortSignal);
  const switchTrack = r.usePlayer.getState().playIndex(1);
  assert.equal(requests[2].signal.aborted, true);
  respond(2, source('stale')); assert.equal(await second, false);
  r.usePlayer.getState().clear();
  assert.equal(requests[3].signal.aborted, true);
  respond(3, source('cleared')); await switchTrack;
  assert.equal(r.usePlayer.getState().source, null);
  assert.equal(r.usePlayer.getState().status, 'idle');
});

test('quality and retry retain the selected track and pass fresh resolution options', async t => {
  const r = runtime(t), calls = [];
  r.api.playerPlaylist = async () => twoTracks('one');
  r.api.resolve = async (_platform, options) => { calls.push(options); return source(options.songId); };
  assert.equal(await r.usePlayer.getState().open('netease', 'one'), true);
  await r.usePlayer.getState().playIndex(1);
  await r.usePlayer.getState().setQuality('high');
  await r.usePlayer.getState().retry();
  assert.equal(r.usePlayer.getState().index, 1);
  assert.equal(r.usePlayer.getState().playlist.id, 'one');
  assert.equal(calls.at(-1).songId, 'one2');
  assert.equal(calls.at(-1).quality, 'high');
  assert.equal(calls.at(-1).fresh, true);
  assert.equal(r.usePlayer.getState().autoplay, true);
});

test('unavailable tracks advance after the delay and clear cancels the skip', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = runtime(t); let calls = 0;
  r.api.playerPlaylist = async () => twoTracks('one');
  r.api.resolve = async (_platform, options) => {
    calls++;
    if (options.songId === 'one1') throw new r.ApiError('unavailable', 'unavailable');
    return source('second');
  };
  assert.equal(await r.usePlayer.getState().open('netease', 'one'), false);
  assert.equal(r.usePlayer.getState().errorCode, 'unavailable');
  t.mock.timers.tick(1199);
  assert.equal(r.usePlayer.getState().index, 0);
  t.mock.timers.tick(1); await tick();
  assert.equal(r.usePlayer.getState().index, 1);
  assert.equal(r.usePlayer.getState().source.mediaUrl, source('second').mediaUrl);
  await r.usePlayer.getState().playIndex(0);
  const beforeClear = calls;
  r.usePlayer.getState().clear();
  t.mock.timers.tick(1200); await tick();
  assert.equal(calls, beforeClear);
  assert.equal(r.usePlayer.getState().status, 'idle');
});
