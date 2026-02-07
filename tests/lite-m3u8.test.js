const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeDurationSeconds,
  buildLiteM3u8
} = require('../lib/lite-m3u8');

test('normalizeDurationSeconds supports ms input and clamps invalid values', () => {
  assert.equal(normalizeDurationSeconds(185000), 185);
  assert.equal(normalizeDurationSeconds('200'), 200);
  assert.equal(normalizeDurationSeconds(0), 180);
  assert.equal(normalizeDurationSeconds(-1), 180);
});

test('buildLiteM3u8 inserts discontinuity between independent tracks', () => {
  const m3u8 = buildLiteM3u8({
    segments: [
      { url: 'https://example.com/a.mp3', duration: 120, title: 'A' },
      { url: 'https://example.com/b.mp3', duration: 180, title: 'B' },
      { url: 'https://example.com/c.mp3', duration: 90, title: 'C' }
    ]
  });

  const lines = m3u8.trim().split('\n');
  const discontinuityCount = lines.filter((line) => line === '#EXT-X-DISCONTINUITY').length;
  assert.equal(discontinuityCount, 2);
  assert.ok(lines.includes('#EXT-X-TARGETDURATION:180'));
  assert.ok(lines.includes('#EXTINF:180.000,B'));
});

test('buildLiteM3u8 ignores invalid segment url and keeps valid ones', () => {
  const m3u8 = buildLiteM3u8({
    segments: [
      { url: '', duration: 10, title: 'invalid' },
      { url: 'https://example.com/ok.mp3', duration: 12, title: 'ok' }
    ]
  });

  assert.ok(!m3u8.includes('invalid'));
  assert.ok(m3u8.includes('https://example.com/ok.mp3'));
});
