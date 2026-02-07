const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createPlaybackToken,
  verifyPlaybackToken,
  getPlaybackTokenTtlSeconds
} = require('../lib/playback-token');

test('creates and verifies token for playlist', () => {
  const nowMs = Date.now();
  const token = createPlaybackToken({
    userId: 12,
    playlistId: '998877',
    ttlSeconds: 300,
    nowMs
  });

  const verified = verifyPlaybackToken(token, {
    playlistId: '998877',
    nowMs: nowMs + 5_000
  });

  assert.equal(verified.ok, true);
  assert.equal(verified.userId, 12);
});

test('rejects token on playlist mismatch', () => {
  const token = createPlaybackToken({
    userId: 7,
    playlistId: '12345',
    ttlSeconds: 300
  });

  const verified = verifyPlaybackToken(token, { playlistId: '54321' });

  assert.equal(verified.ok, false);
});

test('ignores empty playlist constraint when verifying token', () => {
  const token = createPlaybackToken({
    userId: 7,
    playlistId: '12345',
    ttlSeconds: 300
  });

  const verified = verifyPlaybackToken(token, { playlistId: '' });

  assert.equal(verified.ok, true);
  assert.equal(verified.playlistId, '12345');
});

test('rejects expired token', () => {
  const nowMs = Date.now();
  const token = createPlaybackToken({
    userId: 9,
    playlistId: '555',
    ttlSeconds: 10,
    nowMs
  });

  const verified = verifyPlaybackToken(token, {
    playlistId: '555',
    nowMs: nowMs + 11_000
  });

  assert.equal(verified.ok, false);
});

test('caps playback token ttl at 48 hours', () => {
  const previous = process.env.PLAYBACK_TOKEN_TTL_SECONDS;
  process.env.PLAYBACK_TOKEN_TTL_SECONDS = '999999';

  try {
    assert.equal(getPlaybackTokenTtlSeconds(), 172800);
  } finally {
    if (previous == null) {
      delete process.env.PLAYBACK_TOKEN_TTL_SECONDS;
    } else {
      process.env.PLAYBACK_TOKEN_TTL_SECONDS = previous;
    }
  }
});
