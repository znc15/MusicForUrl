import { allowedAudioUrl } from './playlists.js';
import { trackMediaTransfer } from './media-transfer.js';

const encoder = new TextEncoder();
const TIMESTAMP_OWNER = 'com.apple.streaming.transportStreamTimestamp';

function synchsafe(bytes, offset, value) {
  for (let index = 3; index >= 0; index--) {
    bytes[offset + index] = value & 0x7f;
    value >>>= 7;
  }
}

// RFC 8216 section 3.4: every packed audio segment begins with a 33-bit PES timestamp.
function packedAudioTimestamp(timestamp = 0n) {
  if (typeof timestamp !== 'bigint' || timestamp < 0n || timestamp >= (1n << 33n)) {
    throw new RangeError('The packed audio timestamp must be an unsigned 33-bit integer');
  }
  const owner = encoder.encode(TIMESTAMP_OWNER);
  const payloadLength = owner.length + 1 + 8;
  const tag = new Uint8Array(20 + payloadLength);
  tag.set([0x49, 0x44, 0x33, 4, 0, 0]);
  synchsafe(tag, 6, 10 + payloadLength);
  tag.set(encoder.encode('PRIV'), 10);
  synchsafe(tag, 14, payloadLength);
  tag.set(owner, 20);
  new DataView(tag.buffer).setBigUint64(21 + owner.length, timestamp, false);
  return tag;
}

function audioLength(headers) {
  if (headers.has('content-encoding') && headers.get('content-encoding') !== 'identity') return null;
  const range = headers.get('content-range')?.match(/^bytes \d+-\d+\/(\d+)$/);
  const value = range?.[1] || headers.get('content-length');
  return value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

async function fetchAudio(destination, platform, head, fetchImpl, signal) {
  let url = allowedAudioUrl(destination, platform);
  for (let redirect = 0; redirect <= 3 && url; redirect++) {
    const response = await fetchImpl(url, {
      method: 'GET', redirect: 'manual', signal,
      headers: { 'accept-encoding': 'identity', ...(head ? { range: 'bytes=0-4095' } : {}) },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    try { url = location ? allowedAudioUrl(new URL(location, url).href, platform) : null; }
    catch (_) { url = null; }
  }
  return null;
}

function audioError(message, status) {
  return new Response(message, { status, headers: {
    'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  } });
}

async function packedAudioResponse(request, destination, platform, fetchImpl = fetch, onComplete = () => {}, onFailure = () => {}) {
  const head = request.method === 'HEAD';
  let upstream;
  try {
    upstream = await fetchAudio(destination, platform, head, fetchImpl, request.signal);
  } catch (_) {
    return audioError(request.signal.aborted ? 'Playback cancelled' : 'Audio source is unavailable', request.signal.aborted ? 499 : 502);
  }
  if (!upstream?.ok || !upstream.body) {
    await upstream?.body?.cancel();
    return audioError('Audio source is unavailable', 502);
  }
  const reader = upstream.body.getReader();
  const leading = [];
  let leadingLength = 0;
  try {
    while (leadingLength < 3) {
      const chunk = await reader.read();
      if (chunk.done) break;
      leading.push(chunk.value);
      leadingLength += chunk.value.length;
    }
  } catch (_) {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    return audioError(request.signal.aborted ? 'Playback cancelled' : 'Audio source is unavailable', request.signal.aborted ? 499 : 502);
  }
  const bytes = leading.length === 1 ? leading[0] : new Uint8Array(leadingLength);
  if (leading.length > 1) {
    let offset = 0;
    for (const chunk of leading) { bytes.set(chunk, offset); offset += chunk.length; }
  }
  const id3 = bytes?.[0] === 0x49 && bytes?.[1] === 0x44 && bytes?.[2] === 0x33;
  const mp3 = bytes?.[0] === 0xff && (bytes?.[1] & 0xe0) === 0xe0 && (bytes?.[1] & 6) === 2;
  if (!id3 && !mp3) {
    await reader.cancel();
    reader.releaseLock();
    return audioError('Packed audio requires an MP3 source', 415);
  }
  // Each song has EXT-X-DISCONTINUITY, so its media timeline can start at zero.
  const timestamp = packedAudioTimestamp();
  const headers = new Headers({
    'content-type': 'audio/mpeg', 'cache-control': 'no-store',
    'access-control-allow-origin': '*', 'access-control-expose-headers': 'Content-Length',
    // These resources are whole HLS segments, not byte-range segments.
    'accept-ranges': 'none',
  });
  const length = audioLength(upstream.headers);
  if (length !== null) headers.set('content-length', String(length + timestamp.length));
  if (head) {
    await reader.cancel();
    reader.releaseLock();
    return new Response(null, { headers });
  }
  const body = new ReadableStream({
    start(controller) { controller.enqueue(timestamp); controller.enqueue(bytes); },
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) { reader.releaseLock(); controller.close(); }
        else controller.enqueue(chunk.value);
      } catch (error) { reader.releaseLock(); controller.error(error); }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
      reader.releaseLock();
    },
  }, { highWaterMark: 0 });
  return trackMediaTransfer(new Response(body, { headers }), onComplete,
    failure => onFailure(request.signal.aborted ? 'cancelled' : failure));
}

export { packedAudioResponse, packedAudioTimestamp };
