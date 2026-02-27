const test = require('node:test');
const assert = require('node:assert/strict');

const qqmusic = require('../lib/qqmusic');

function createMockResponse({ text = '', setCookies = [], location = null }) {
  return {
    ok: true,
    headers: {
      getSetCookie: () => setCookies,
      get: (name) => (String(name).toLowerCase() === 'location' ? location : null),
    },
    text: async () => text,
  };
}

test('parsePtuiCallbackPayload 解析未扫码状态', () => {
  const raw = "ptuiCB('66','0','','0','二维码未失效。', '')";
  const parsed = qqmusic.parsePtuiCallbackPayload(raw);

  assert.ok(parsed);
  assert.equal(parsed.code, 66);
  assert.equal(parsed.redirectUrl, '');
  assert.equal(parsed.message, '二维码未失效。');
  assert.equal(parsed.nickname, '');
});

test('parsePtuiCallbackPayload 解析已扫码未确认状态', () => {
  const raw = "ptuiCB('67','0','','0','二维码认证中。', '')";
  const parsed = qqmusic.parsePtuiCallbackPayload(raw);

  assert.ok(parsed);
  assert.equal(parsed.code, 67);
  assert.equal(parsed.message, '二维码认证中。');
});

test('parsePtuiCallbackPayload 解析二维码过期状态', () => {
  const raw = "ptuiCB('65','0','','0','二维码已失效。', '')";
  const parsed = qqmusic.parsePtuiCallbackPayload(raw);

  assert.ok(parsed);
  assert.equal(parsed.code, 65);
  assert.equal(parsed.message, '二维码已失效。');
});

test('parsePtuiCallbackPayload 支持长URL、中文与额外字段', () => {
  const raw = "ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?pttype=1&uin=1503255237&service=ptqrlogin&nodirect=0&ptsigx=abc123&s_url=https%3A%2F%2Fgraph.qq.com%2Foauth2.0%2Flogin_jump&f_url=&ptlang=2052&ptredirect=100&aid=716027609&daid=383&j_later=0&low_login_hour=0&regmaster=0&pt_login_type=3&pt_aid=0&pt_aaid=16&pt_light=0&pt_3rd_aid=100497308','0','登录成功！', '啊咩啊咩！', '')";
  const parsed = qqmusic.parsePtuiCallbackPayload(raw);

  assert.ok(parsed);
  assert.equal(parsed.code, 0);
  assert.equal(parsed.message, '登录成功！');
  assert.equal(parsed.nickname, '啊咩啊咩！');
  assert.match(parsed.redirectUrl, /uin=1503255237/);
});

test('parsePtuiCallbackPayload 对 malformed 输入返回 null', () => {
  const raw = 'ptuiCB(abc)';
  const parsed = qqmusic.parsePtuiCallbackPayload(raw);

  assert.equal(parsed, null);
});

test('extractUinFromRedirectUrl 可从 redirect URL 提取 uin', () => {
  const redirectUrl = 'https://ssl.ptlogin2.graph.qq.com/check_sig?pttype=1&uin=1503255237&service=ptqrlogin';
  assert.equal(qqmusic.extractUinFromRedirectUrl(redirectUrl), '1503255237');
});

test('buildQQAvatarUrl 生成稳定的 QQ 头像地址', () => {
  assert.equal(
    qqmusic.buildQQAvatarUrl('1503255237'),
    'https://q1.qlogo.cn/g?b=qq&nk=1503255237&s=100'
  );
});

test('checkQRCode 在成功响应中回填 uin（来自 redirect URL）', async () => {
  const originalFetch = global.fetch;
  let callCount = 0;

  global.fetch = async () => {
    callCount += 1;
    if (callCount === 1) {
      return createMockResponse({
        text: "ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?pttype=1&uin=1503255237&service=ptqrlogin','0','登录成功！', '啊咩啊咩！', '')",
      });
    }

    if (callCount === 2) {
      return createMockResponse({ text: '' });
    }

    throw new Error('unexpected fetch call');
  };

  try {
    const result = await qqmusic.checkQRCode('mock-qrsig');
    assert.equal(result.code, 0);
    assert.equal(result.uin, '1503255237');
    assert.equal(result.nickname, '啊咩啊咩！');
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(callCount, 2);
});

test('checkQRCode 对无法解析的响应返回 code=-1', async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => createMockResponse({ text: 'invalid payload' });

  try {
    const result = await qqmusic.checkQRCode('mock-qrsig');
    assert.equal(result.code, -1);
    assert.equal(result.message, '解析响应失败');
  } finally {
    global.fetch = originalFetch;
  }
});

test('getPlaylistDetail 在上游返回异常 code 时透传详细错误信息', async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => createMockResponse({
    text: JSON.stringify({ code: -1, subcode: 0, cdlist: [] })
  });

  try {
    await assert.rejects(
      () => qqmusic.getPlaylistDetail('12345'),
      /QQ歌单不存在或无访问权限 \(code=-1\)/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('getPlaylistDetail 支持任意回调名的 JSONP 响应', async () => {
  const originalFetch = global.fetch;

  const payload = {
    code: 0,
    cdlist: [
      {
        dissname: '测试歌单',
        logo: 'https://example.com/cover.jpg',
        songnum: 0,
        songlist: []
      }
    ]
  };

  global.fetch = async () => createMockResponse({
    text: `playlistinfoCallback(${JSON.stringify(payload)})`
  });

  try {
    const result = await qqmusic.getPlaylistDetail('12345');
    assert.equal(result.id, '12345');
    assert.equal(result.name, '测试歌单');
    assert.equal(Array.isArray(result.tracks), true);
  } finally {
    global.fetch = originalFetch;
  }
});
