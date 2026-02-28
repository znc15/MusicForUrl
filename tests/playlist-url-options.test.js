const test = require('node:test');
const assert = require('node:assert/strict');

const neteaseRouter = require('../routes/playlist');
const qqRouter = require('../routes/qq-playlist');
const bg = require('../lib/lite-video-bg');

function getRouteHandler(router, path, method, indexFromEnd = 1) {
  const layer = router.stack.find((l) => l && l.route && l.route.path === path && l.route.methods && l.route.methods[method]);
  assert.ok(layer, `Route not found: ${method.toUpperCase()} ${path}`);
  const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s.handle) : [];
  assert.ok(handlers.length >= indexFromEnd, `Handler stack too short: ${method.toUpperCase()} ${path}`);
  return handlers[handlers.length - indexFromEnd];
}

function createMockReq({ id, userType }) {
  const req = {
    query: { id: String(id) },
    params: {},
    protocol: 'https',
    get(name) {
      if (String(name).toLowerCase() === 'host') return 'music.example.test';
      return '';
    }
  };

  if (userType === 'qq') {
    req.qqUser = { id: 88 };
  } else {
    req.user = { id: 66 };
  }

  return req;
}

async function invokeHandler(handler, req) {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };

  await handler(req, res);
  return res;
}

test('网易 /url 返回 lite + lite_video + hls 且 default=lite', async () => {
  const oldFetch = global.fetch;
  bg.__resetForTests();
  global.fetch = async () => ({
    ok: true,
    status: 200,
    url: 'https://img.example.com/netease-bg.png',
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'image/png' : null) },
    text: async () => ''
  });
  try {
    const handler = getRouteHandler(neteaseRouter, '/url', 'get');
    const req = createMockReq({ id: '123456', userType: 'netease' });

    const res = await invokeHandler(handler, req);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body && res.body.success, true);

    const data = res.body.data;
    assert.equal(data.default, 'lite');
    assert.equal(data.backgroundImage, 'https://img.example.com/netease-bg.png');

    const types = (data.urls || []).map((x) => x.type);
    assert.deepEqual(types, ['lite', 'lite_video', 'hls']);

    const liteVideo = data.urls.find((x) => x.type === 'lite_video');
    assert.ok(liteVideo);
    assert.match(liteVideo.url, /\/api\/playlist\/m3u8\/.+\/123456\/lite-video\.m3u8$/);
  } finally {
    global.fetch = oldFetch;
    bg.__resetForTests();
  }
});

test('QQ /url 返回 lite + lite_video 且 default=lite', async () => {
  const oldFetch = global.fetch;
  bg.__resetForTests();
  global.fetch = async () => ({
    ok: true,
    status: 200,
    url: 'https://img.example.com/qq-bg.png',
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'image/png' : null) },
    text: async () => ''
  });
  try {
    const handler = getRouteHandler(qqRouter, '/url', 'get');
    const req = createMockReq({ id: '888999', userType: 'qq' });

    const res = await invokeHandler(handler, req);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body && res.body.success, true);

    const data = res.body.data;
    assert.equal(data.default, 'lite');
    assert.equal(data.backgroundImage, 'https://img.example.com/qq-bg.png');

    const types = (data.urls || []).map((x) => x.type);
    assert.deepEqual(types, ['lite', 'lite_video']);

    const liteVideo = data.urls.find((x) => x.type === 'lite_video');
    assert.ok(liteVideo);
    assert.match(liteVideo.url, /\/api\/qq\/playlist\/m3u8\/.+\/888999\/lite-video\.m3u8$/);
  } finally {
    global.fetch = oldFetch;
    bg.__resetForTests();
  }
});
