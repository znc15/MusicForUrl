import test from 'node:test';
import assert from 'node:assert/strict';
import { getSongUrl } from '../src/netease.js';

test('Netease uses the v1 player URL for supported quality levels', async () => {
  const originalFetch = globalThis.fetch;
  const paths = [];
  globalThis.fetch = async (url) => {
    paths.push(new URL(url).pathname);
    return Response.json({ code: 200, data: [{ url: 'https://music.126.net/song.mp3' }] });
  };
  try {
    const url = await getSongUrl('123', 'MUSIC_U=test', { MUSIC_QUALITY: 'high' });
    assert.equal(url, 'https://music.126.net/song.mp3');
    assert.deepEqual(paths, ['/eapi/song/enhance/player/url/v1']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Netease falls back to bitrate endpoint when v1 has no playable URL', async () => {
  const originalFetch = globalThis.fetch;
  const paths = [];
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    paths.push(path);
    return Response.json({ code: 200, data: [{ url: path.endsWith('/v1')
      ? null : 'https://music.126.net/fallback.mp3' }] });
  };
  try {
    const url = await getSongUrl('123', '', { MUSIC_QUALITY: 'low' });
    assert.equal(url, 'https://music.126.net/fallback.mp3');
    assert.deepEqual(paths, [
      '/eapi/song/enhance/player/url/v1',
      '/eapi/song/enhance/player/url',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Netease keeps the 192 kbps endpoint for medium quality', async () => {
  const originalFetch = globalThis.fetch;
  const paths = [];
  globalThis.fetch = async (url) => {
    paths.push(new URL(url).pathname);
    return Response.json({ code: 200, data: [{ url: 'https://music.126.net/medium.mp3' }] });
  };
  try {
    assert.equal(await getSongUrl('123', '', { MUSIC_QUALITY: 'medium' }),
      'https://music.126.net/medium.mp3');
    assert.deepEqual(paths, ['/eapi/song/enhance/player/url']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
