import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { trackMediaTransfer } from '../src/media-transfer.js';
import { packedAudioResponse, packedAudioTimestamp } from '../src/packed-audio.js';
import { recordMediaFailure, recordRequestEvent } from '../src/telemetry.js';

const media = new Uint8Array([0xff, 0xfb, 0x90, 0, 1, 2, 3, 4]);
const mediaUrl = 'https://m1.music.126.net/fixture.mp3';
const request = () => new Request('https://fixture.test/api/song/private-signature/5.mp3?token=private-token');

function fixedLengthFixture(t) {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'FixedLengthStream');
  Object.defineProperty(globalThis, 'FixedLengthStream', { configurable: true, value: class {
    constructor(expected) {
      let received = 0;
      const stream = new TransformStream({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > expected) throw new Error('fixture fixed-length overflow');
          controller.enqueue(chunk);
        },
        flush() { if (received !== expected) throw new Error('fixture fixed-length underflow'); },
      });
      this.readable = stream.readable;
      this.writable = stream.writable;
    }
  } });
  t.after(() => {
    if (old) Object.defineProperty(globalThis, 'FixedLengthStream', old);
    else delete globalThis.FixedLengthStream;
  });
}

for (const fixed of [false, true]) {
  test(`media completion requires the declared byte length (FixedLengthStream=${fixed})`, async t => {
    if (fixed) fixedLengthFixture(t);
    for (const length of [media.length, media.length - 1, media.length + 1]) {
      let completed = 0;
      const failures = [];
      const response = trackMediaTransfer(new Response(media, { headers: { 'content-length': String(length) } }),
        () => completed++, failure => failures.push(failure));
      if (length === media.length) {
        assert.deepEqual(new Uint8Array(await response.arrayBuffer()), media);
        await setImmediate();
        assert.equal(completed, 1);
        assert.deepEqual(failures, []);
        assert.equal(response.headers.get('content-length'), String(length));
      } else {
        await assert.rejects(response.arrayBuffer(), /length mismatch/);
        await setImmediate();
        assert.equal(completed, 0);
        assert.deepEqual(failures, ['stream_read']);
      }
    }
  });

  test(`media read errors and consumer cancellation have distinct terminal states (FixedLengthStream=${fixed})`, async t => {
    if (fixed) fixedLengthFixture(t);
    for (const cancel of [false, true]) {
      let completed = 0, sourceCancelled = 0, count = 0;
      const failures = [];
      const source = new ReadableStream({
        pull(controller) {
          if (++count === 1 || cancel) controller.enqueue(media);
          else controller.error(new Error('private upstream address must not be recorded'));
        },
        cancel() { sourceCancelled++; },
      }, { highWaterMark: 0 });
      const response = trackMediaTransfer(new Response(source, { headers: { 'content-length': '1000' } }),
        () => completed++, failure => failures.push(failure));
      if (cancel) {
        const reader = response.body.getReader();
        await reader.read();
        await reader.cancel('private cancel detail');
      } else await assert.rejects(response.arrayBuffer(), /private upstream/);
      await setImmediate();
      assert.equal(completed, 0);
      assert.deepEqual(failures, [cancel ? 'cancelled' : 'stream_read']);
      if (cancel) assert.equal(sourceCancelled, 1);
    }
  });
}

test('packed audio counts bytes after timestamp insertion and reports truncated reads', async () => {
  let completed = 0;
  const failures = [];
  const response = await packedAudioResponse(request(), mediaUrl, 'netease', () => new Response(media, {
    headers: { 'content-length': String(media.length + 1) },
  }), () => completed++, reason => failures.push(reason));
  assert.equal(response.headers.get('content-length'), String(media.length + 1 + packedAudioTimestamp().length));
  await assert.rejects(response.arrayBuffer(), /length mismatch/);
  assert.equal(completed, 0);
  assert.deepEqual(failures, ['stream_read']);
});

test('packed audio cancellation reports once, while HEAD and status errors leave counting to the request layer', async () => {
  let completed = 0;
  const failures = [];
  const response = await packedAudioResponse(request(), mediaUrl, 'netease', () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(media); },
  })), () => completed++, reason => failures.push(reason));
  await response.body.cancel();
  assert.equal(completed, 0);
  assert.deepEqual(failures, ['cancelled']);
  failures.length = 0;
  const head = await packedAudioResponse(new Request(request(), { method: 'HEAD' }), mediaUrl, 'netease',
    () => new Response(media), () => completed++, reason => failures.push(reason));
  assert.equal(head.body, null);
  const unavailable = await packedAudioResponse(request(), mediaUrl, 'netease',
    () => { throw new Error('private upstream failure'); }, () => completed++, reason => failures.push(reason));
  assert.equal(unavailable.status, 502);
  assert.equal(completed, 0);
  assert.deepEqual(failures, []);
});

test('packed audio forwards request cancellation before headers and classifies it as 499', async () => {
  const controller = new AbortController();
  controller.abort();
  const req = new Request(request(), { signal: controller.signal });
  const response = await packedAudioResponse(req, mediaUrl, 'netease', (_url, options) => {
    assert.equal(options.signal.aborted, true);
    options.signal.throwIfAborted();
  });
  assert.equal(response.status, 499);
  assert.equal(await response.text(), 'Playback cancelled');
});

test('media failure events use standard routes and safe categories, with no signatures or error messages', () => {
  const points = [];
  const env = { REQUEST_TELEMETRY_SAMPLE: '1', ANALYTICS_REQUESTS: { writeDataPoint: point => points.push(point) } };
  const req = request(), url = new URL(req.url);
  assert.equal(recordRequestEvent(env, req, url, 200, 10), false);
  assert.equal(recordRequestEvent(env, req, url, 206, 10), false);
  const cases = [[401, 'authorization'], [403, 'authorization'], [502, 'upstream'], [415, 'format'], [429, 'rate_limit'], [499, 'cancelled']];
  for (const [status, category] of cases) {
    assert.equal(recordRequestEvent(env, req, url, status, 10), true);
    assert.equal(points.at(-1).blobs[6], category);
    assert.deepEqual(points.at(-1).indexes, ['song.segment']);
    assert.equal(points.at(-1).doubles[0], status);
  }
  assert.equal(recordMediaFailure(env, req, url, 'stream_read', { platform: 'qq' }), true);
  assert.equal(points.at(-1).blobs[3], 'qq');
  assert.equal(points.at(-1).blobs[0], 'media_failure');
  assert.equal(recordMediaFailure(env, req, url, 'cancelled'), true);
  assert.equal(recordMediaFailure(env, req, url, 'private exception text'), false);
  const playerUrl = new URL('https://fixture.test/api/player/media/private?platform=qq&grant=private');
  assert.equal(recordRequestEvent(env, req, playerUrl, 502, 10), true);
  assert.equal(points.at(-1).blobs[3], 'qq');
  playerUrl.searchParams.set('platform', 'private');
  recordRequestEvent(env, req, playerUrl, 401, 10);
  assert.equal(points.at(-1).blobs[3], 'unknown');
  assert.doesNotMatch(JSON.stringify(points), /private|https:|token=|\/api\/|fixture\.test/);
});

test('failure events obey configured sampling and missing/failing bindings remain harmless', t => {
  const req = request(), url = new URL(req.url), points = [];
  const env = { REQUEST_TELEMETRY_SAMPLE: '10', ANALYTICS_REQUESTS: { writeDataPoint: point => points.push(point) } };
  t.mock.method(Math, 'random', () => 0.5);
  assert.equal(recordRequestEvent(env, req, url, 502, 1), false);
  assert.equal(recordMediaFailure(env, req, url, 'stream_read'), false);
  assert.equal(points.length, 0);
  assert.equal(recordMediaFailure({}, req, url, 'cancelled'), false);
  env.REQUEST_TELEMETRY_SAMPLE = '1';
  env.ANALYTICS_REQUESTS.writeDataPoint = () => { throw new Error('fixture binding failure'); };
  assert.equal(recordMediaFailure(env, req, url, 'cancelled'), false);
});
