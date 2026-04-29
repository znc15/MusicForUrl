const test = require('node:test');
const assert = require('node:assert/strict');

const neteaseRouter = require('../routes/playlist');
const qqRouter = require('../routes/qq-playlist');

function getRouteHandler(router, path, method) {
  const layer = router.stack.find((l) => l && l.route && l.route.path === path && l.route.methods && l.route.methods[method]);
  assert.ok(layer, `Route not found: ${method.toUpperCase()} ${path}`);
  const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s.handle) : [];
  // 跳过 auth 中间件，取最后一个 handler
  return handlers[handlers.length - 1];
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

test('网易 /url 返回 lite + mp4 + hls 且 default=lite', async () => {
  const handler = getRouteHandler(neteaseRouter, '/url', 'get');
  const req = createMockReq({ id: '123456', userType: 'netease' });

  const res = await invokeHandler(handler, req);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body && res.body.success, true);

  const data = res.body.data;
  assert.equal(data.default, 'lite');

  const types = (data.urls || []).map((x) => x.type);
  assert.deepEqual(types, ['lite', 'hls']);

  const lite = data.urls.find((x) => x.type === 'lite');
  assert.ok(lite);
  assert.match(lite.url, /\/api\/playlist\/m3u8\/.+\/123456\/stream\.m3u8$/);

  const hls = data.urls.find((x) => x.type === 'hls');
  assert.ok(hls);
  assert.match(hls.url, /\/api\/hls\/.+\/123456\/master\.m3u8$/);

  // data.url 应与 lite url 一致
  assert.equal(data.url, lite.url);
});

test('QQ /url 返回 lite + mp4 + hls 且 default=lite', async () => {
  const handler = getRouteHandler(qqRouter, '/url', 'get');
  const req = createMockReq({ id: '888999', userType: 'qq' });

  const res = await invokeHandler(handler, req);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body && res.body.success, true);

  const data = res.body.data;
  assert.equal(data.default, 'lite');

  const types = (data.urls || []).map((x) => x.type);
  assert.deepEqual(types, ['lite', 'hls']);

  const lite = data.urls.find((x) => x.type === 'lite');
  assert.ok(lite);
  assert.match(lite.url, /\/api\/qq\/playlist\/m3u8\/.+\/888999\/stream\.m3u8$/);

  const hls = data.urls.find((x) => x.type === 'hls');
  assert.ok(hls);
  assert.match(hls.url, /\/api\/qq\/hls\/.+\/888999\/master\.m3u8$/);

  // data.url 应与 lite url 一致
  assert.equal(data.url, lite.url);
});
