import test from 'node:test';
import assert from 'node:assert/strict';
import { packedAudioResponse, packedAudioTimestamp } from '../src/packed-audio.js';

const mediaUrl = 'https://m1.music.126.net/test.mp3';
const media = new Uint8Array([0xff, 0xfb, 0x90, 0, 1, 2, 3, 4]);
const request = (method = 'GET', headers = {}) => new Request('https://music.example.test/song.mp3?hls=1', { method, headers });
const source = () => new Response(media, { headers: { 'content-length': String(media.length), 'content-type': 'audio/mpeg' } });
const decodeSynchsafe = (bytes) => bytes.reduce((size, byte) => size * 128 + byte, 0);

test('packed audio includes a valid ID3 PRIV timestamp with the full unsigned 33-bit range', () => {
  for (const value of [0n, 90000n, (1n << 33n) - 1n]) {
    const tag = packedAudioTimestamp(value);
    assert.equal(new TextDecoder().decode(tag.slice(0, 3)), 'ID3');
    assert.equal(tag[3], 4);
    assert.equal(decodeSynchsafe(tag.slice(6, 10)), tag.length - 10);
    assert.equal(new TextDecoder().decode(tag.slice(10, 14)), 'PRIV');
    assert.equal(decodeSynchsafe(tag.slice(14, 18)), tag.length - 20);
    assert.equal(new TextDecoder().decode(tag.slice(20, -9)), 'com.apple.streaming.transportStreamTimestamp');
    assert.equal(tag[tag.length - 9], 0);
    assert.equal(new DataView(tag.buffer).getBigUint64(tag.length - 8), value);
  }
  assert.throws(() => packedAudioTimestamp(1n << 33n), RangeError);
  assert.throws(() => packedAudioTimestamp(-1n), RangeError);
});

test('packed audio preserves every source byte and returns a complete HLS segment for Range requests', async () => {
  const response = await packedAudioResponse(request('GET', { range: 'bytes=0-3' }), mediaUrl, 'netease', source);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('location'), null);
  assert.equal(response.headers.get('accept-ranges'), 'none');
  assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  const body = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual(body.slice(-media.length), media);
  assert.equal(Number(response.headers.get('content-length')), body.length);
  assert.deepEqual(body.slice(0, body.length - media.length), packedAudioTimestamp());
});

test('HEAD probes a small source range and reports the same length as GET without a response body', async () => {
  let options;
  const response = await packedAudioResponse(request('HEAD'), mediaUrl, 'netease', (_url, input) => {
    options = input;
    return new Response(media.slice(0, 4), { status: 206, headers: { 'content-range': `bytes 0-3/${media.length}`, 'content-length': '4' } });
  });
  assert.equal(options.method, 'GET');
  assert.equal(options.headers.range, 'bytes=0-4095');
  assert.equal(await response.text(), '');
  assert.equal(Number(response.headers.get('content-length')), media.length + packedAudioTimestamp().length);
});

test('small upstream chunks are preserved while identifying the audio format', async () => {
  const response = await packedAudioResponse(request(), mediaUrl, 'netease', () => new Response(new ReadableStream({
    start(controller) {
      for (const byte of media) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  })));
  assert.equal(response.status, 200);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual(bytes.slice(packedAudioTimestamp().length), media);
});

test('canceling playback cancels the upstream stream instead of downloading the remaining track', async () => {
  let canceled = false;
  const response = await packedAudioResponse(request(), mediaUrl, 'netease', () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(media); },
    cancel() { canceled = true; },
  })));
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(canceled, true);
});

test('audio redirects cannot leave the platform CDN allowlist', async () => {
  const calls = [];
  const response = await packedAudioResponse(request(), mediaUrl, 'netease', url => {
    calls.push(url);
    return new Response(null, { status: 302, headers: { location: 'https://outside.example/private' } });
  });
  assert.equal(response.status, 502);
  assert.equal(calls.length, 1);
});

test('a failed audio stream never calls the playback completion hook', async () => {
  let completed = 0;
  let sent = false;
  const response = await packedAudioResponse(request(), mediaUrl, 'netease', () => new Response(new ReadableStream({
    pull(controller) {
      if (!sent) { sent = true; controller.enqueue(media); }
      else controller.error(new Error('fixture download failed'));
    },
  })), () => { completed++; });
  await assert.rejects(response.arrayBuffer(), /fixture download failed/);
  assert.equal(completed, 0);
});

test('unsupported media and unavailable tracks are reported as errors instead of mislabeled MP3 segments', async () => {
  const unsupported = await packedAudioResponse(request(), mediaUrl, 'netease', () => new Response('fLaCdata'));
  assert.equal(unsupported.status, 415);
  const unavailable = await packedAudioResponse(request(), mediaUrl, 'netease', () => new Response('not found', { status: 404 }));
  assert.equal(unavailable.status, 502);
});
