const test = require('node:test');
const assert = require('node:assert/strict');

const { createPlaybackToken } = require('../lib/playback-token');
const bg = require('../lib/lite-video-bg');

function mockResponse({ ok = true, status = 200, url = '', contentType = '', body = '' }) {
  return {
    ok,
    status,
    url,
    headers: {
      get(name) {
        if (String(name).toLowerCase() === 'content-type') return contentType;
        return null;
      }
    },
    text: async () => body
  };
}

test('同 token 二次请求返回同图', async () => {
  const oldFetch = global.fetch;
  const oldApi = process.env.LITE_VIDEO_BG_API_URL;
  let calls = 0;

  process.env.LITE_VIDEO_BG_API_URL = 'https://example.com/random';
  bg.__resetForTests();

  global.fetch = async () => {
    calls += 1;
    return mockResponse({
      ok: true,
      url: 'https://img.example.com/a.png',
      contentType: 'image/png',
      body: ''
    });
  };

  try {
    const token = createPlaybackToken({ userId: 1, playlistId: '1001', ttlSeconds: 60 });
    const first = await bg.getOrBindBg({ token, playlistId: '1001', source: 'netease', fallbackUrl: 'https://fallback.test/f.png' });
    const second = await bg.getOrBindBg({ token, playlistId: '1001', source: 'netease', fallbackUrl: 'https://fallback.test/f2.png' });

    assert.equal(first, 'https://img.example.com/a.png');
    assert.equal(second, 'https://img.example.com/a.png');
    assert.equal(calls, 1);
  } finally {
    global.fetch = oldFetch;
    if (oldApi == null) delete process.env.LITE_VIDEO_BG_API_URL;
    else process.env.LITE_VIDEO_BG_API_URL = oldApi;
    bg.__resetForTests();
  }
});

test('支持 302/重定向后的最终图片 URL', async () => {
  const oldFetch = global.fetch;
  bg.__resetForTests();

  global.fetch = async () => mockResponse({
    ok: true,
    url: 'https://i1.mcobj.com/uploads/abc.png',
    contentType: 'image/png'
  });

  try {
    const token = createPlaybackToken({ userId: 2, playlistId: '2002', ttlSeconds: 60 });
    const picked = await bg.getOrBindBg({ token, playlistId: '2002', source: 'qq', fallbackUrl: 'https://fallback.test/f.png' });
    assert.equal(picked, 'https://i1.mcobj.com/uploads/abc.png');
  } finally {
    global.fetch = oldFetch;
    bg.__resetForTests();
  }
});

test('API 失败时回退 fallback 图', async () => {
  const oldFetch = global.fetch;
  bg.__resetForTests();

  global.fetch = async () => {
    throw new Error('network failed');
  };

  try {
    const token = createPlaybackToken({ userId: 3, playlistId: '3003', ttlSeconds: 60 });
    const picked = await bg.getOrBindBg({ token, playlistId: '3003', source: 'netease', fallbackUrl: 'https://fallback.test/f.png' });
    assert.equal(picked, 'https://fallback.test/f.png');
  } finally {
    global.fetch = oldFetch;
    bg.__resetForTests();
  }
});

test('过期后重新绑定新图', async () => {
  const oldFetch = global.fetch;
  const oldNow = Date.now;
  bg.__resetForTests();

  let currentNow = 2_000_000;
  let calls = 0;
  Date.now = () => currentNow;

  global.fetch = async () => {
    calls += 1;
    return mockResponse({
      ok: true,
      url: calls === 1 ? 'https://img.example.com/old.png' : 'https://img.example.com/new.png',
      contentType: 'image/png'
    });
  };

  try {
    const token = createPlaybackToken({
      userId: 4,
      playlistId: '4004',
      ttlSeconds: 1,
      nowMs: currentNow
    });

    const first = await bg.getOrBindBg({ token, playlistId: '4004', source: 'netease', fallbackUrl: 'https://fallback.test/f.png' });
    currentNow += 1500;
    const second = await bg.getOrBindBg({ token, playlistId: '4004', source: 'netease', fallbackUrl: 'https://fallback.test/f.png' });

    assert.equal(first, 'https://img.example.com/old.png');
    assert.equal(second, 'https://img.example.com/new.png');
    assert.equal(calls, 2);
  } finally {
    Date.now = oldNow;
    global.fetch = oldFetch;
    bg.__resetForTests();
  }
});
