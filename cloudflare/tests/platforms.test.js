import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import policy from '../../lib/player-policy.js';
import { createPlaybackToken, decryptCookie, getPlaybackUser, getSessionUser } from '../src/security.js';
import { adapter, parsePlaylistId, validPlaylistId, validSongId } from '../src/playlists.js';
import { PLATFORMS, capabilityMatrix, guestUser, platformFromPath } from '../src/platforms.js';
import { routeKey } from '../src/telemetry.js';
import { readSiteStats, refreshSiteStats } from '../src/stats.js';
import { upstreamRequest } from '../src/upstream/request.js';

const KUGOU_HASH = 'F460C7B867DCC5F49A0FB9574954CFD7';
const KUGOU_320 = 'EEE71C794B070253D4A51EF8D14FA42F';

function testEnv() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const DB = {
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map(statement => statement.runSync());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() { return sqlite.prepare(sql).get(...args) || null; },
        async all() { return { results: sqlite.prepare(sql).all(...args) }; },
        runSync() {
          const result = sqlite.prepare(sql).run(...args);
          return { meta: { changes: result.changes } };
        },
        async run() { return this.runSync(); },
      };
    },
  };
  return { DB, sqlite, ENCRYPTION_KEY: 'test-secret-7e8c8cf1369f49cdb64ba6dc4d8e8170' };
}

function stubFetch(routes) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : input.url);
    calls.push(url);
    for (const [pattern, handler] of routes) {
      if (pattern.test(url)) return handler(url, init);
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

const json = value => new Response(JSON.stringify(value), {
  headers: { 'content-type': 'application/json' },
});

test('platform prefixes keep the legacy URL surface intact', () => {
  // 线上 VRChat 里已经签发的链接依赖这两个映射，改动等于全部失效
  assert.deepEqual(platformFromPath('/api/playlist/m3u8/x/1/stream.m3u8'),
    { id: 'netease', path: '/playlist/m3u8/x/1/stream.m3u8' });
  assert.deepEqual(platformFromPath('/api/qq/playlist/m3u8/x/1/stream.m3u8'),
    { id: 'qq', path: '/playlist/m3u8/x/1/stream.m3u8' });
  assert.deepEqual(platformFromPath('/api/kugou/song/t/abc.mp3'), { id: 'kugou', path: '/song/t/abc.mp3' });
  assert.deepEqual(platformFromPath('/api/kuwo/playlist/parse'), { id: 'kuwo', path: '/playlist/parse' });
  // 更长前缀必须优先，否则 /api/qq 会被 /api 抢走
  assert.equal(platformFromPath('/api/qq/health').id, 'qq');
});

test('playlist and song ID shapes are validated per platform', () => {
  assert.equal(parsePlaylistId('https://music.163.com/playlist?id=123456', 'netease'), '123456');
  assert.equal(parsePlaylistId('https://y.qq.com/n/ryqq/playlist/7654321', 'qq'), '7654321');
  assert.equal(parsePlaylistId('https://www.kugou.com/yy/special/single/1234567.html', 'kugou'), '1234567');
  assert.equal(parsePlaylistId('https://m.kugou.com/plist/list/1234567?json=true', 'kugou'), '1234567');
  assert.equal(parsePlaylistId('https://www.kuwo.cn/playlist_detail/3095611894', 'kuwo'), '3095611894');
  assert.equal(parsePlaylistId('3095611894', 'kuwo'), '3095611894');
  // 跨平台的链接不应该被当成合法输入
  assert.equal(parsePlaylistId('https://www.kuwo.cn/playlist_detail/3095611894', 'netease'), null);
  assert.equal(parsePlaylistId('not a url', 'kugou'), null);

  assert.ok(validSongId('555', 'netease'));
  assert.ok(!validSongId(KUGOU_HASH, 'netease'));
  assert.ok(validSongId('001QuJq0Y6YkqN', 'qq'));
  assert.ok(validSongId(KUGOU_HASH, 'kugou'));
  // 酷狗用复合 ID 编码三档音质，缺档位时允许更短
  assert.ok(validSongId(`${KUGOU_HASH}-${KUGOU_320}`, 'kugou'));
  assert.ok(!validSongId('F460C7B', 'kugou'));
  assert.ok(validSongId('293781643', 'kuwo'));
  assert.ok(!validPlaylistId(KUGOU_HASH, 'kuwo'));
});

test('capability matrix declares the account boundary for every platform', () => {
  const matrix = capabilityMatrix();
  assert.deepEqual(matrix.map(item => item.id), ['netease', 'qq', 'kugou', 'kuwo']);
  for (const item of matrix) {
    assert.equal(typeof item.label, 'string');
    // 「我的音乐」必须以账号为前提；反方向不成立：酷狗可以登录，但个人歌单尚未接入
    if (item.library) assert.equal(item.account, true, `${item.id}: library 必须以 account 为前提`);
  }
  assert.equal(PLATFORMS.kugou.account, true);
  assert.equal(PLATFORMS.kugou.library, false);
  assert.equal(PLATFORMS.kugou.guestPlayback, true);
  assert.equal(PLATFORMS.kuwo.account, true);
  assert.equal(PLATFORMS.kuwo.library, false);
  assert.equal(PLATFORMS.kuwo.guestPlayback, true);
  assert.equal(PLATFORMS.kugou.playback, true);
});

test('guest playback tokens verify without touching D1 and cannot cross platforms', async t => {
  const env = testEnv(); t.after(() => env.sqlite.close());
  let reads = 0;
  const DB = {
    prepare(sql) { reads++; return env.DB.prepare(sql); },
    batch: env.DB.batch,
  };
  const guest = guestUser('kugou');
  const token = await createPlaybackToken({ ...env, DB }, guest, '1234567');

  const verified = await getPlaybackUser({ ...env, DB }, token, 'kugou', '1234567');
  assert.equal(verified.platform, 'kugou');
  assert.equal(verified.guest, true);
  assert.equal(verified.id, 0);
  // 游客令牌不查库：每个音频分片请求因此省掉一次 D1 读取
  assert.equal(reads, 0);

  assert.equal(await getPlaybackUser(env, token, 'netease', '1234567'), null);
  assert.equal(await getPlaybackUser(env, token, 'kugou', '7654321'), null);
  assert.equal(await getPlaybackUser(env, `${token}x`, 'kugou', '1234567'), null);

  // 游客平台不接受任何会话令牌
  const session = new Request('https://music.example.test/api/kugou/auth/status',
    { headers: { 'x-kugou-token': token } });
  assert.equal(await getSessionUser(env, session, 'kugou', new URL(session.url)), null);
});

test('audio host allowlists are per platform', () => {
  assert.equal(policy.allowedSource('https://m1.music.126.net/a.mp3', 'netease'), 'https://m1.music.126.net/a.mp3');
  assert.equal(policy.allowedSource('https://m1.music.126.net/a.mp3', 'kugou'), null);
  assert.equal(policy.allowedSource('https://fs.kgimg.com/a.mp3', 'kugou'), 'https://fs.kgimg.com/a.mp3');
  assert.equal(policy.allowedSource('http://kw-lv.kuwo.cn/a.mp3', 'kuwo'), 'https://kw-lv.kuwo.cn/a.mp3');
  assert.equal(policy.allowedSource('https://kw-lv.kuwo.cn/a.mp3', 'qq'), null);
  assert.equal(policy.allowedSource('https://evil.example.com/a.mp3', 'kugou'), null);
});

test('kugou adapter paginates, builds composite song IDs and rewrites cover sizes', async t => {
  const pages = [];
  const restore = stubFetch([
    // 元数据接口：注意它忽略 page/pagesize，永远只返回前 10 首，所以只用来取名称与封面
    [/\/plist\/list\/1234567\?json=true$/, () => json({
      pagesize: 10,
      list: { list: { total: 35, info: [
        { hash: KUGOU_HASH, '320hash': KUGOU_320, sqhash: '', filename: '曲肖冰 - 静悄悄', duration: 184 },
        { hash: '', filename: '坏数据', duration: 10 },
      ] } },
      info: { list: { specialname: '测试歌单', imgurl: 'http://imge.kugou.com/soft/collection/{size}/x.jpg' } },
    })],
    [/mobiles\.kugou\.com\/api\/v3\/special\/song\?/, (url) => {
      const page = Number(url.match(/page=(\d+)/)[1]);
      pages.push(page);
      if (page === 1) return json({ status: 1, data: { total: 35, info: [
        { hash: KUGOU_HASH, '320hash': KUGOU_320, filename: '曲肖冰 - 静悄悄', duration: 184 },
        { hash: '18B2B218E8204596BEBC08844AD4D9E4', filename: '无分隔符歌名' },
        { hash: '', filename: '坏数据' },
      ] } });
      if (page === 2) return json({ status: 1, data: { total: 35, info: [
        // 与第一页重复的条目必须被去重
        { hash: KUGOU_HASH, filename: '曲肖冰 - 静悄悄' },
        { hash: 'FC88533CAD3A0DEA2AA613C124180CBD', filename: '张惠妹 - 我最亲爱的', duration: 284 },
      ] } });
      return json({ status: 1, data: { total: 35, info: [] } });
    }],
  ]);
  t.after(restore.restore);

  const playlist = await adapter('kugou').getPlaylistDetail('1234567', '', {});
  assert.equal(playlist.name, '测试歌单');
  assert.equal(playlist.cover, 'https://imge.kugou.com/soft/collection/240/x.jpg');
  assert.equal(playlist.songCount, 35);
  // 35 首 / 每页 30 = 2 页，两页都拉到；空 hash 的条目被丢掉，重复条目被去重
  assert.deepEqual(pages, [1, 2]);
  assert.deepEqual(playlist.tracks.map(track => track.id), [
    `${KUGOU_HASH}-${KUGOU_320}`,
    '18B2B218E8204596BEBC08844AD4D9E4',
    'FC88533CAD3A0DEA2AA613C124180CBD',
  ]);
  assert.equal(playlist.tracks[0].name, '静悄悄');
  assert.equal(playlist.tracks[0].artist, '曲肖冰');
  assert.equal(playlist.tracks[1].name, '无分隔符歌名');
  assert.equal(playlist.tracks[2].duration, 284);
});

test('kugou adapter falls back to the metadata page when pagination breaks', async t => {
  const restore = stubFetch([
    [/\/plist\/list\/1234567\?json=true$/, () => json({
      list: { list: { total: 35, info: [{ hash: KUGOU_HASH, filename: '曲肖冰 - 静悄悄', duration: 184 }] } },
      info: { list: { specialname: '测试歌单', imgurl: '' } },
    })],
    [/mobiles\.kugou\.com/, () => { throw new Error('network down'); }],
  ]);
  t.after(restore.restore);

  // 分页接口挂掉时退回元数据里的前 10 首，而不是整个歌单不可用
  const playlist = await adapter('kugou').getPlaylistDetail('1234567', '', {});
  assert.equal(playlist.tracks.length, 1);
  assert.equal(playlist.songCount, 35);
});

test('kugou adapter maps quality to the right hash and reports paywalled tracks as unavailable', async t => {
  const seen = [];
  const restore = stubFetch([
    [/getSongInfo\.php\?cmd=playInfo&hash=([A-F0-9]+)$/, (url) => {
      const hash = url.match(/hash=([A-F0-9]+)$/)[1];
      seen.push(hash);
      if (hash === KUGOU_320) return json({ url: '', error: '需要付费' });
      return json({ url: 'https://fs.kgimg.com/a.mp3', bitRate: 128000, extName: 'mp3', timeLength: 184 });
    }],
  ]);
  t.after(restore.restore);

  const composite = `${KUGOU_HASH}-${KUGOU_320}`;
  const high = await adapter('kugou').getSongResource(composite, '', { MUSIC_QUALITY: 'high' });
  // 320 档被付费挡住时回退到基础 hash
  assert.equal(high.url, 'https://fs.kgimg.com/a.mp3');
  assert.deepEqual(seen, [KUGOU_320, KUGOU_HASH]);

  seen.length = 0;
  const low = await adapter('kugou').getSongResource(composite, '', { MUSIC_QUALITY: 'low' });
  assert.equal(low.bitrate, 128000);
  assert.deepEqual(seen, [KUGOU_HASH]);
});

test('kuwo adapter requests the matching bitrate and surfaces upstream blocks', async t => {
  const restore = stubFetch([
    [/antiserver\.kuwo\.cn\/anti\.s\?[^ ]*br=320kmp3/, () => new Response('https://kw-bj.kuwo.cn/a.mp3')],
    [/antiserver\.kuwo\.cn\/anti\.s\?[^ ]*br=128kmp3/, () => new Response('convert_url_error')],
  ]);
  t.after(restore.restore);

  const high = await adapter('kuwo').getSongResource('293781643', '', { MUSIC_QUALITY: 'high' });
  assert.equal(high.url, 'https://kw-bj.kuwo.cn/a.mp3');
  assert.equal(high.bitrate, 320000);
  assert.equal(await adapter('kuwo').getSongResource('293781643', '', { MUSIC_QUALITY: 'low' }), null);
});

test('guest platforms serve a full generate → m3u8 → segment chain without a login', async t => {
  const env = testEnv(); t.after(() => env.sqlite.close());
  const pending = [];
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  const restore = stubFetch([
    [/\/plist\/list\/1234567\?json=true$/, () => json({
      pagesize: 10,
      list: { list: { total: 1, info: [{ hash: KUGOU_HASH, filename: '曲肖冰 - 静悄悄', duration: 184 }] } },
      info: { list: { specialname: '测试歌单', imgurl: '' } },
    })],
    [/mobiles\.kugou\.com\/api\/v3\/special\/song\?/, () => json({
      status: 1, data: { total: 1, info: [{ hash: KUGOU_HASH, filename: '曲肖冰 - 静悄悄', duration: 184 }] },
    })],
    [/getSongInfo\.php/, () => json({ url: 'https://fs.kgimg.com/a.mp3', bitRate: 128000, extName: 'mp3' })],
  ]);
  t.after(restore.restore);

  const generated = await worker.fetch(new Request('https://music.example.test/api/kugou/playlist/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://www.kugou.com/yy/special/single/1234567.html' }),
  }), env, ctx);
  const body = await generated.json();
  assert.equal(generated.status, 200);
  assert.equal(body.data.playlist.name, '测试歌单');
  assert.match(body.data.url, /^https:\/\/music\.example\.test\/api\/kugou\/playlist\/m3u8\/[^/]+\/1234567\/stream\.m3u8$/);

  const stream = await worker.fetch(new Request(body.data.url), env, ctx);
  const m3u8 = await stream.text();
  assert.match(m3u8, /#EXT-X-VERSION:3/);
  assert.match(m3u8, new RegExp(`/api/kugou/song/[^/]+/${KUGOU_HASH}\\.mp3\\?playlist=1234567&hls=1`));
  assert.match(m3u8, /曲肖冰 - 静悄悄/);

  const segment = await worker.fetch(new Request(
    `https://music.example.test/api/kugou/song/${body.data.url.match(/m3u8\/([^/]+)\//)[1]}/${KUGOU_HASH}.mp3?playlist=1234567`,
  ), env, ctx);
  assert.equal(segment.status, 302);
  assert.equal(segment.headers.get('location'), 'https://fs.kgimg.com/a.mp3');
  await Promise.all(pending);

  // 游客没有 users 行，播放记录不会写进 play_stats，但解析数与签发链接数都会累加
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS total FROM play_stats').get().total, 0);
  assert.equal(env.sqlite.prepare("SELECT value FROM site_stats WHERE key = 'parsedSongs'").get().value, 1);
  assert.equal(env.sqlite.prepare("SELECT value FROM site_stats WHERE key = 'generatedLinks'").get().value, 1);
});

test('guest platforms reject the account-only routes with an actionable message', async () => {
  const env = testEnv();
  const ctx = { waitUntil() {} };
  for (const path of ['/api/kugou/playlist/user', '/api/kuwo/favorites', '/api/kugou/history/recent']) {
    const response = await worker.fetch(new Request(`https://music.example.test${path}`), env, ctx);
    assert.equal(response.status, 403, path);
    assert.match((await response.json()).message, /暂不支持个人歌单/);
  }
  const auth = await worker.fetch(new Request('https://music.example.test/api/kuwo/auth/status'), env, ctx);
  const body = await auth.json();
  assert.equal(body.data.logged, false);
  // 酷我支持账号密码 / 短信登录，但没有扫码
  assert.equal(body.data.supported, undefined);
  const login = await worker.fetch(new Request('https://music.example.test/api/kuwo/auth/qrcode'), env, ctx);
  assert.equal(login.status, 501);
});

test('kugou QR login signs requests, maps poll states and stores the session', async t => {
  const env = testEnv(); t.after(() => env.sqlite.close());
  const ctx = { waitUntil() {} };
  let poll = { status: 1 };
  const restore = stubFetch([
    [/login-user\.kugou\.com\/v2\/qrcode\?/, () => json({
      status: 1, error_code: 0,
      data: { qrcode: 'QRKEY123', qrcode_img: 'data:image/png;base64,AAA' },
    })],
    [/login-user\.kugou\.com\/v2\/get_userinfo_qrcode\?/, () => json({ status: 1, error_code: 0, data: poll })],
  ]);
  t.after(restore.restore);

  const created = await worker.fetch(new Request('https://music.example.test/api/kugou/auth/qrcode'), env, ctx);
  const createdBody = await created.json();
  assert.equal(created.status, 200);
  assert.equal(createdBody.data.key, 'QRKEY123');
  assert.match(createdBody.data.qrimg, /^data:image\/png;base64,/);

  // 用 node:crypto 独立复算签名，锁住「salt + 排序参数 + salt」的算法
  const url = new URL(restore.calls[0]);
  const params = Object.fromEntries(url.searchParams);
  const received = params.signature;
  delete params.signature;
  const expected = createHash('md5')
    .update(`NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt${Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('')}NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt`)
    .digest('hex');
  assert.equal(received, expected);
  assert.equal(params.appid, '1001');
  assert.equal(params.qrcode_txt, 'https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=1005&');

  const check = () => worker.fetch(
    new Request('https://music.example.test/api/kugou/auth/qrcode/check?key=QRKEY123'), env, ctx,
  );
  assert.equal((await (await check()).json()).code, 801);
  poll = { status: 2 };
  assert.equal((await (await check()).json()).code, 802);
  poll = { status: 0 };
  assert.equal((await (await check()).json()).code, 800);

  poll = { status: 4, token: 'kugou-token', userid: '424242' };
  const success = await (await check()).json();
  assert.equal(success.code, 803);
  assert.equal(success.data.user.userId, '424242');

  const sessionRequest = new Request('https://music.example.test/api/kugou/auth/status', {
    headers: { 'x-kugou-token': success.data.token },
  });
  const user = await getSessionUser(env, sessionRequest, 'kugou');
  assert.equal(user.platform_user_id, '424242');
  assert.equal(user.guest, undefined);
  const cookie = await decryptCookie(env, user);
  assert.match(cookie, /token=kugou-token/);
  assert.match(cookie, /userid=424242/);

  // 二维码确认后立即失效
  assert.equal((await check()).status, 400);
});

test('kuwo password and SMS login map upstream cookies into a session', async t => {
  const env = testEnv(); t.after(() => env.sqlite.close());
  const ctx = { waitUntil() {} };
  const bodies = [];
  const restore = stubFetch([
    [/www\.kuwo\.cn\/api\/common\/captcha\/getcode$/, () => new Response(JSON.stringify({
      code: 200, data: { img: 'data:image/png;base64,AAA', token: 'captcha-token' },
    }), { headers: { 'content-type': 'application/json', 'set-cookie': 'Hm_Iuvt_x=anon; path=/; HttpOnly' } })],
    [/wapi\.kuwo\.cn\/api\/www\/login\/loginByKw\?/, (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.uname === 'bad') return json({ code: -10001, msg: '用户名或密码错误' });
      return json({ code: 200, data: { cookies: {
        userid: '777', uname3: '%E5%B0%8F%E6%98%8E', pic3: 'https%3A%2F%2Fimg.example%2Fa.png', sid: 'S1',
      } } });
    }],
    [/www\.kuwo\.cn\/api\/sms\/mobileLoginCode\?/, () => json({ code: 200, data: { tm: 'TM1' } })],
    [/wapi\.kuwo\.cn\/api\/www\/login\/loginByMobile\?/, (url, init) => {
      bodies.push(JSON.parse(init.body));
      return json({ code: 200, data: { cookies: { userid: '888', uname3: 'kw-user', sid: 'S2' } } });
    }],
  ]);
  t.after(restore.restore);

  const captcha = await worker.fetch(new Request('https://music.example.test/api/kuwo/auth/captcha'), env, ctx);
  const captchaBody = await captcha.json();
  assert.equal(captcha.status, 200);
  assert.equal(captchaBody.data.token, 'captcha-token');
  assert.equal(captchaBody.data.cookie, 'Hm_Iuvt_x=anon');

  const call = (path, body) => worker.fetch(new Request(`https://music.example.test/api/kuwo${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), env, ctx);

  const bad = await call('/auth/login/password', {
    uname: 'bad', password: 'x', verifyCode: 'ab12', verifyCodeToken: 'captcha-token', cookie: 'Hm_Iuvt_x=anon',
  });
  assert.equal(bad.status, 401);
  assert.match((await bad.json()).message, /用户名或密码错误/);

  const login = await call('/auth/login/password', {
    uname: 'good', password: 'secret', verifyCode: 'ab12', verifyCodeToken: 'captcha-token', cookie: 'Hm_Iuvt_x=anon',
  });
  const loginBody = await login.json();
  assert.equal(login.status, 200);
  assert.equal(loginBody.data.user.userId, '777');
  assert.equal(loginBody.data.user.nickname, '小明');
  assert.equal(loginBody.data.user.avatar, 'https://img.example/a.png');
  assert.equal(bodies[1].verifyCodeToken, 'captcha-token');
  assert.equal(bodies[1].verifyCode, 'ab12');

  const session = new Request('https://music.example.test/api/kuwo/auth/status', {
    headers: { 'x-kuwo-token': loginBody.data.token },
  });
  const user = await getSessionUser(env, session, 'kuwo');
  assert.equal(user.platform_user_id, '777');
  assert.match(await decryptCookie(env, user), /sid=S1/);

  const sent = await call('/auth/sms/send', {
    mobile: '13800138000', verifyCode: 'cd34', verifyCodeToken: 'captcha-token', cookie: 'Hm_Iuvt_x=anon',
  });
  assert.equal((await sent.json()).data.tm, 'TM1');
  const smsLogin = await call('/auth/login/sms', {
    mobile: '13800138000', verifyCode: 'cd34', smsCode: '123456', tm: 'TM1', cookie: 'Hm_Iuvt_x=anon',
  });
  const smsBody = await smsLogin.json();
  assert.equal(smsLogin.status, 200);
  assert.equal(smsBody.data.user.userId, '888');
  assert.equal(smsBody.data.user.nickname, 'kw-user');
  assert.equal(bodies.at(-1).tm, 'TM1');
});

test('site stats are aggregated from play history and account count', async t => {
  const env = testEnv(); t.after(() => env.sqlite.close());
  const now = Date.now();
  const user = await env.DB.prepare(`
    INSERT INTO users (platform, platform_user_id, nickname, avatar, vip_type, cookie_cipher,
      token_hash, token_expires_at_ms, created_at_ms, last_login_at_ms)
    VALUES ('netease', '1001', '', '', 0, '', 'h', ?, ?, ?) RETURNING id
  `).bind(now + 1000, now, now).first();
  await env.DB.prepare(`
    INSERT INTO play_stats (user_id, playlist_id, song_id, song_name, artist, duration_ms, play_count, last_played_at_ms)
    VALUES (?, '1', 'a', 'A', '', 200000, 3, ?), (?, '2', 'b', 'B', '', 100000, 1, ?)
  `).bind(user.id, now, user.id, now).run();

  const stats = await readSiteStats(env);
  assert.equal(stats.plays, 4);
  assert.equal(stats.playDurationMs, 700000);
  assert.equal(stats.songs, 2);
  assert.equal(stats.playlists, 2);
  assert.equal(stats.listeners, 1);
  assert.ok(stats.updatedAt > 0);

  // 未过期的缓存不重复扫描
  const again = await readSiteStats(env);
  assert.equal(again.updatedAt, stats.updatedAt);

  await refreshSiteStats(env);
  assert.equal((await readSiteStats(env)).plays, 4);
});

test('telemetry classifies every platform prefix', () => {
  assert.equal(routeKey('/api/qq/playlist/generate'), 'playlist.generate');
  assert.equal(routeKey('/api/kugou/playlist/generate'), 'playlist.generate');
  assert.equal(routeKey('/api/kuwo/playlist/m3u8/t/1/stream.m3u8'), 'playlist.stream');
  assert.equal(routeKey('/api/kugou/song/t/hash.mp3'), 'song.segment');
  assert.equal(routeKey('/api/stats'), 'stats');
  assert.equal(routeKey('/api/unknown'), 'other');
});

test('upstream deadlines include stalled response bodies and cancel the reader', async t => {
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
      cancel() { cancelled = true; },
    }));
  });
  await assert.rejects(upstreamRequest('https://example.test/', {}, { timeoutMs: 10 }),
    error => error.status === 504 && /超时/.test(error.message));
  assert.equal(cancelled, true);
});

test('upstream body limits measure actual bytes and preserve valid responses and cookies', async t => {
  let cancelled = 0;
  let response;
  t.mock.method(globalThis, 'fetch', async () => response);
  for (const declared of [undefined, '1', '100']) {
    response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(17)); },
      cancel() { cancelled++; },
    }), { headers: declared ? { 'content-length': declared } : {} });
    await assert.rejects(upstreamRequest('https://example.test/', {}, { maxBytes: 16 }), error => error.status === 502);
  }
  assert.equal(cancelled, 3);
  response = new Response('{"ok":true}', { headers: { 'set-cookie': 'anon=fixture; Path=/', 'content-type': 'application/json' } });
  const valid = await upstreamRequest('https://example.test/');
  assert.deepEqual(await valid.json(), { ok: true });
  assert.match(valid.headers.get('set-cookie'), /anon=fixture/);
  response = new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'set-cookie': 'anon=header-only' } });
  const headerOnly = await upstreamRequest('https://example.test/', {}, { headersOnly: true });
  assert.equal(headerOnly.body, null);
  assert.equal(cancelled, 4);
});

test('upstream calls respect a caller deadline without retrying login operations', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', (_url, options) => {
    calls++;
    return new Promise((_resolve, reject) => {
      if (options.signal.aborted) reject(options.signal.reason);
      else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  });
  const controller = new AbortController();
  const pending = upstreamRequest('https://example.test/login', { method: 'POST', signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => error.status === 504);
  assert.equal(calls, 1);
});
