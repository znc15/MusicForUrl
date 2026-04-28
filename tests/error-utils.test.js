const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildErrorCode,
  normalizeHttpError,
  normalizeCaughtError,
  toDisplayMessage
} = require('../public/js/error-utils');

test('buildErrorCode 生成稳定短错误码', () => {
  assert.equal(buildErrorCode('http', 'auth_login_password', 429), 'E-HTTP-AUTH_LOGIN_PASSWORD-429');
  assert.equal(buildErrorCode('', '', ''), 'E-FE-UNKNOWN-UNKNOWN');
});

test('normalizeHttpError 在 HTTP 错误时输出 HTTP 类别', () => {
  const result = normalizeHttpError({
    scope: 'PLAYLIST_USER',
    status: 500,
    payload: { message: '获取歌单失败' },
    requestPath: '/api/playlist/user'
  });

  assert.equal(result.success, false);
  assert.equal(result.message, '获取歌单失败');
  assert.equal(result.errorCode, 'E-HTTP-PLAYLIST_USER-500');
  assert.equal(result._errorMeta.kind, 'HTTP');
  assert.equal(result._errorMeta.requestPath, '/api/playlist/user');
});

test('normalizeHttpError 在业务失败时输出 BIZ 类别', () => {
  const result = normalizeHttpError({
    scope: 'AUTH_QRCODE_CHECK',
    status: 200,
    payload: { success: false, message: '二维码已过期，请刷新' },
    requestPath: '/api/auth/qrcode/check'
  });

  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'E-BIZ-AUTH_QRCODE_CHECK-RESP');
  assert.equal(result._errorMeta.kind, 'BIZ');
});

test('normalizeCaughtError 识别网络和解析异常', () => {
  const net = normalizeCaughtError({
    scope: 'PLAYLIST_PARSE',
    error: new TypeError('fetch failed'),
    requestPath: '/api/playlist/parse'
  });
  assert.equal(net.errorCode, 'E-NET-PLAYLIST_PARSE-REQ');

  const parseErr = new SyntaxError('Unexpected token <');
  parseErr.__mfuType = 'PARSE';
  const parse = normalizeCaughtError({
    scope: 'PLAYLIST_PARSE',
    error: parseErr,
    requestPath: '/api/playlist/parse'
  });
  assert.equal(parse.errorCode, 'E-PARSE-PLAYLIST_PARSE-RESP');
});

test('toDisplayMessage 输出带错误码文案', () => {
  const msg = toDisplayMessage({
    message: '登录失败',
    errorCode: 'E-HTTP-AUTH_LOGIN_PASSWORD-429'
  }, '默认错误');
  assert.equal(msg, '登录失败 (E-HTTP-AUTH_LOGIN_PASSWORD-429)');
  assert.equal(toDisplayMessage({}, '默认错误'), '默认错误');
});
