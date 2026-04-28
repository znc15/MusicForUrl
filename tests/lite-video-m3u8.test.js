const test = require('node:test');
const assert = require('node:assert/strict');

const playlistRouter = require('../routes/playlist');
const qqPlaylistRouter = require('../routes/qq-playlist');

const { buildLiteM3u8: buildNeteaseLiteM3u8 } = playlistRouter.__testHooks;
const { buildLiteM3u8: buildQQLiteM3u8 } = qqPlaylistRouter.__testHooks;

test('网易 lite-video m3u8 包含背景标签与统一 bg 参数，且不包含 HLS 分片地址', () => {
  const bg = 'https://img.example.com/background-a.png';
  const out = buildNeteaseLiteM3u8('https://music.example.com', 'token123', '987654', [
    { id: '11', duration: 180, artist: 'A', name: 'SongA' },
    { id: '22', duration: 200, artist: 'B', name: 'SongB' }
  ], { backgroundImage: bg });

  assert.match(out, /#EXT-X-MFU-MODE:audio-only-lite-video/);
  assert.match(out, /#EXT-X-MFU-BACKGROUND:https:\/\/img\.example\.com\/background-a\.png/);
  assert.match(out, /\/api\/song\/token123\/11\?playlist=987654&bg=https%3A%2F%2Fimg\.example\.com%2Fbackground-a\.png/);
  assert.match(out, /\/api\/song\/token123\/22\?playlist=987654&bg=https%3A%2F%2Fimg\.example\.com%2Fbackground-a\.png/);
  assert.equal(/\/api\/hls\/.+\/seg\//.test(out), false);
});

test('QQ lite-video m3u8 包含背景标签与统一 bg 参数，且不包含 HLS 分片地址', () => {
  const bg = 'https://img.example.com/background-b.png';
  const out = buildQQLiteM3u8('https://music.example.com', 'tokenqq', '556677', [
    { mid: 'MID_A', duration: 210, artist: 'Q', name: 'QSongA' },
    { id: 'MID_B', duration: 230, artist: 'W', name: 'QSongB' }
  ], { backgroundImage: bg });

  assert.match(out, /#EXT-X-MFU-MODE:audio-only-lite-video/);
  assert.match(out, /#EXT-X-MFU-BACKGROUND:https:\/\/img\.example\.com\/background-b\.png/);
  assert.match(out, /\/api\/qq\/song\/tokenqq\/MID_A\?playlist=556677&bg=https%3A%2F%2Fimg\.example\.com%2Fbackground-b\.png/);
  assert.match(out, /\/api\/qq\/song\/tokenqq\/MID_B\?playlist=556677&bg=https%3A%2F%2Fimg\.example\.com%2Fbackground-b\.png/);
  assert.equal(/\/api\/hls\/.+\/seg\//.test(out), false);
});
