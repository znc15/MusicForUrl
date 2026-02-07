function sanitizeM3uTitle(text) {
  return String(text || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDurationSeconds(rawDuration, fallback = 180) {
  let value = Number(rawDuration);
  if (!Number.isFinite(value) || value <= 0) return fallback;

  if (value > 10000) {
    value = value / 1000;
  }

  value = Math.round(value);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.min(1800, value));
}

function buildLiteM3u8({ segments }) {
  const source = Array.isArray(segments) ? segments : [];
  const list = source
    .map((item) => {
      const url = String(item?.url || '').trim();
      if (!url) return null;
      return {
        url,
        title: sanitizeM3uTitle(item?.title || ''),
        duration: normalizeDurationSeconds(item?.duration)
      };
    })
    .filter(Boolean);

  const durations = list.map((item) => item.duration).filter((n) => Number.isFinite(n) && n > 0);
  const target = Math.max(10, ...(durations.length ? durations : [10]));

  let out = '';
  out += '#EXTM3U\n';
  out += '#EXT-X-VERSION:3\n';
  out += `#EXT-X-TARGETDURATION:${target}\n`;
  out += '#EXT-X-MEDIA-SEQUENCE:0\n';
  out += '#EXT-X-PLAYLIST-TYPE:VOD\n';

  list.forEach((item, index) => {
    if (index > 0) out += '#EXT-X-DISCONTINUITY\n';
    out += `#EXTINF:${item.duration.toFixed(3)},${item.title}\n`;
    out += `${item.url}\n`;
  });

  out += '#EXT-X-ENDLIST\n';
  return out;
}

module.exports = {
  sanitizeM3uTitle,
  normalizeDurationSeconds,
  buildLiteM3u8
};
